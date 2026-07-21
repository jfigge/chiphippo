/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// probe-inspector.js — the connectivity probe (Feature 70): arm it, and a
// hover highlights the net under the cursor while a click PINS one so it
// survives edits/switch flips. Owns its own netlist cache, the net-highlight
// overlay, and the net-status readout; borrows the shared hover ring and asks
// the host to resolve world geometry + coordinate with the other tools.
//
// It renders from the netlist and the live SimOverlay (for level tints) — never
// the engine directly. Pulled out of DeskController so "what net is this, and
// draw it" lives in one place instead of threaded through the controller.

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { summarizeNet } from "../sim/netlist.js";
import { RESERVED_NET_NAMES } from "../model/desk-doc.js";
import { NetlistCache } from "./netlist-cache.js";
import { NetHighlight } from "./net-highlight.js";

/** Radius of the shared hover ring (pitch units — a shade over one hole). */
const RING_RADIUS = 0.45;

export class ProbeInspector {
  #doc;
  #viewport;
  #ring; // the shared hover-ring element (owned by the controller)
  #simOverlay;
  #hitTest; // (world) → { address, x, y } | null
  #addressWorld; // (address) → { x, y } | null
  #onStateChange; // ({ armed }) → void
  #onNameNet; // (address, name, staleAddresses) → void
  #onClearNetNames; // (addresses) → void
  #coord; // { cancelPlacement, disarmWireTool, deselect, hideHover }

  #netlist;
  #highlight;
  #netStatus;

  #armed = false;
  #anchor = null; // pinned point address, or null

  constructor({
    doc,
    overlay,
    viewport,
    ring,
    simOverlay,
    hitTest,
    addressWorld,
    onStateChange,
    onNameNet,
    onClearNetNames,
    coordinate,
  }) {
    this.#doc = doc;
    this.#viewport = viewport;
    this.#ring = ring;
    this.#simOverlay = simOverlay;
    this.#hitTest = hitTest;
    this.#addressWorld = addressWorld;
    this.#onStateChange = onStateChange;
    this.#onNameNet = onNameNet;
    this.#onClearNetNames = onClearNetNames;
    this.#coord = coordinate;

    this.#netlist = new NetlistCache(doc);
    this.#highlight = new NetHighlight(overlay);
    this.#netStatus = el("div", { class: "net-status", hidden: true });
    viewport.append(this.#netStatus);
  }

  get armed() {
    return this.#armed;
  }

  /** Arm probe mode: hover highlights a net, click pins it. */
  arm() {
    if (this.#armed) return;
    this.#coord.cancelPlacement();
    this.#coord.disarmWireTool();
    this.#coord.disarmBusTool?.();
    this.#coord.deselect();
    this.#coord.hideHover();
    this.#armed = true;
    this.#anchor = null;
    this.#viewport.classList.add("desk-viewport--probing");
    this.#onStateChange?.({ armed: true });
  }

  disarm() {
    if (!this.#armed) return;
    this.#armed = false;
    this.#anchor = null;
    this.#viewport.classList.remove("desk-viewport--probing");
    this.#highlight.clear();
    this.#ring.hidden = true;
    this.#ring.classList.remove("hole-ring--illegal");
    this.#netStatus.hidden = true;
    this.#onStateChange?.({ armed: false });
  }

  toggle() {
    if (this.#armed) this.disarm();
    else this.arm();
  }

  /** Escape while armed: first unpin, then disarm. True when it consumed it. */
  handleEscape() {
    if (!this.#armed) return false;
    if (this.#anchor) {
      this.#anchor = null;
      this.#highlight.clear();
      this.#netStatus.hidden = true;
    } else {
      this.disarm();
    }
    return true;
  }

  /** Rebuild the pinned highlight from its anchor (e.g. after a switch flip). */
  refreshPinned() {
    if (!this.#anchor) return;
    // The anchor may vanish (its board/PSU deleted) — drop the pin then.
    if (!this.#netlist.netOf(this.#anchor)) {
      this.#anchor = null;
      this.#highlight.clear();
      this.#netStatus.hidden = true;
      return;
    }
    this.#showNetFor(this.#anchor, true);
  }

  /** Probe pointermove: highlight the hovered point's net (unless pinned). */
  trackMove(world) {
    if (this.#anchor) return; // pinned — hover doesn't disturb it
    const hit = this.#hitTest(world);
    if (!hit?.address) {
      this.#ring.hidden = true;
      this.#highlight.clear();
      this.#netStatus.hidden = true;
      return;
    }
    const r = RING_RADIUS * PX_PER_UNIT;
    this.#ring.style.left = `${hit.x * PX_PER_UNIT - r}px`;
    this.#ring.style.top = `${hit.y * PX_PER_UNIT - r}px`;
    this.#ring.hidden = false;
    this.#showNetFor(hit.address, false);
  }

  /** Probe click: pin the hovered net, or unpin if already pinned. */
  commitClick(world) {
    if (this.#anchor) {
      this.#anchor = null; // re-click unpins
      this.trackMove(world); // fall back to hover highlight at the cursor
      return;
    }
    const hit = this.#hitTest(world);
    if (!hit?.address || !this.#netlist.netOf(hit.address)) return;
    this.#anchor = hit.address;
    this.#showNetFor(hit.address, true);
  }

  /** A wire hovered under the probe (via the wire hit stroke). */
  onWireHover(wireId) {
    if (!this.#armed || this.#anchor) return;
    const wire = wireId ? this.#doc.getWire(wireId) : null;
    if (!wire) {
      this.#highlight.clear();
      this.#netStatus.hidden = true;
      return;
    }
    this.#ring.hidden = true;
    this.#showNetFor(wire.from, false);
  }

  /** Geometry the highlight overlay draws by (world px). */
  #highlightGeometry() {
    return {
      positionOf: (address) => {
        const w = this.#addressWorld(address);
        return w ? { x: w.x * PX_PER_UNIT, y: w.y * PX_PER_UNIT } : null;
      },
      wireEndpointsOf: (wireId) => {
        const wire = this.#doc.getWire(wireId);
        if (!wire) return null;
        const a = this.#addressWorld(wire.from);
        const b = this.#addressWorld(wire.to);
        if (!a || !b) return null;
        return {
          a: { x: a.x * PX_PER_UNIT, y: a.y * PX_PER_UNIT },
          b: { x: b.x * PX_PER_UNIT, y: b.y * PX_PER_UNIT },
        };
      },
    };
  }

  /** Show the net containing `address`, pinned or transient. */
  #showNetFor(address, pinned) {
    const netId = this.#netlist.netOf(address);
    const net = netId ? this.#netlist.netInfo(netId) : null;
    // While running, tint the highlight + lead the summary with the level.
    const level = this.#simOverlay.levelOfNet(netId);
    this.#highlight.show(net, this.#highlightGeometry(), pinned, level);
    if (net) {
      // The readout leads with the user NAME (Feature 120), then the level
      // while running, then the connectivity summary.
      const name = this.#netlist.nameOf(netId);
      const parts = [name, level, summarizeNet(net)].filter(Boolean);
      this.#netStatus.textContent = parts.join(" · ");
      this.#netStatus.classList.toggle("net-status--named", Boolean(name));
      if (level) this.#netStatus.dataset.level = level;
      else delete this.#netStatus.dataset.level;
      this.#netStatus.classList.toggle("net-status--pinned", pinned);
      this.#netStatus.hidden = false;
    } else {
      this.#netStatus.hidden = true;
    }
  }

  /**
   * Right-click while probing: name / rename / clear the net under the cursor
   * (or the pinned net when the cursor is over nothing). Returns true when it
   * showed a menu (the caller then suppresses the default desk menu).
   */
  onContextMenu(world, e) {
    if (!this.#armed) return false;
    const hit = this.#hitTest(world);
    const address = hit?.address ?? this.#anchor;
    const netId = address ? this.#netlist.netOf(address) : null;
    if (!netId) return false;
    const current = this.#netlist.nameOf(netId);
    const items = [
      {
        label: current ? "Rename net…" : "Name this net…",
        onSelect: () => this.#promptName(address, netId, current),
      },
    ];
    if (current) {
      items.push({
        label: "Clear name",
        onSelect: () => this.#clearName(netId),
      });
    }
    PopupManager.menu({ x: e.clientX, y: e.clientY, items });
    return true;
  }

  /** The bound addresses that currently resolve to a net (0, 1, or a merge). */
  #bindingsOnNet(netId) {
    return this.#doc.netNames
      .filter((n) => this.#netlist.netOf(n.address) === netId)
      .map((n) => n.address);
  }

  #promptName(address, netId, current) {
    PopupManager.prompt({
      title: current ? "Rename net" : "Name this net",
      label: "Net name",
      value: current ?? "",
      placeholder: "e.g. VCC, GND, CLK, D0…",
      quickPicks: RESERVED_NET_NAMES,
      onConfirm: (name) => {
        if (!name) return;
        // Replace any OTHER bindings on this net so a rename never becomes a
        // self-conflict; the name binds to the point the user pointed at.
        const stale = this.#bindingsOnNet(netId).filter((a) => a !== address);
        this.#onNameNet?.(address, name, stale);
      },
    });
  }

  #clearName(netId) {
    const addresses = this.#bindingsOnNet(netId);
    if (addresses.length) this.#onClearNetNames?.(addresses);
  }
}
