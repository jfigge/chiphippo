/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// chip-design-bridge.js — the MAIN renderer's side of the chip designer
// window (custom chips). The window is its own OS window and its own
// sandboxed renderer, so it reaches this one only through main's
// `chipdesign:*` relay; this bridge is what answers it.
//
// It owns no chips and no debugger: the project's chips are the workspace's
// (ProjectWorkspace.putCustomChip & co.) and the debugger's session is
// ChipDebugger's. What it owns is the WINDOW's state — which designs are open
// as tabs and which has the focus — and the one message that tells the window
// everything (`state`), sent whenever any of it changes: the designs, the
// debugger's view, the transport (stopped: the designer; running: the
// debugger). The window draws that and reports back what the user did.

import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { partDef } from "../catalog/index.js";
import { duplicateCustomChip, newCustomChip } from "../model/custom-chip.js";

export class ChipDesignBridge {
  #bridge;
  #workspace;
  #debugger;
  #notifications;
  #ready = false; // the window has announced itself since it last closed
  #open = []; // the open design tabs (chip ids), in order
  #focus = null; // the design in view
  #tokens = {}; // chip id → the last edit token applied (the window's echo)
  #notice = null; // a one-off message for the next state
  #queued = false;
  #debug = null; // the debugger's latest view

  /**
   * @param {object} opts
   * @param {object} opts.bridge - window.chiphippo (`chipDesign.*`).
   * @param {() => import('./project-workspace.js').ProjectWorkspace} opts.workspace
   * @param {import('./chip-debugger.js').ChipDebugger} opts.chipDebug
   * @param {import('./notification-stack.js').NotificationStack} [opts.notifications]
   */
  constructor({ bridge, workspace, chipDebug, notifications }) {
    this.#bridge = bridge;
    this.#workspace = workspace;
    this.#debugger = chipDebug;
    this.#notifications = notifications;
    this.#debug = chipDebug?.state ?? null;
    window.addEventListener("chiphippo:chipdesign-host-inbound", (e) =>
      this.#receive(e.detail),
    );
    // A custom chip's pin-assignments window has a button for its designer;
    // that window knows only the chip's ref, so main relays the ask here.
    window.addEventListener("chiphippo:pinout-host-inbound", (e) => {
      if (e.detail?.kind === "open-designer") this.openForRef(e.detail.ref);
    });
    window.addEventListener("chiphippo:custom-chips-changed", () => {
      this.#prune();
      this.#send();
    });
    window.addEventListener("chiphippo:chip-debug", (e) => {
      const was = this.#debug;
      const wasPaused = Boolean(was?.paused);
      if (was?.running && !e.detail?.running) this.#keepDebugged(was);
      this.#debug = e.detail;
      this.#send();
      // Run pressed with a design on screen: the window shows that chip on
      // the desk (its first instance), so it does not go blank under the
      // user. Its tab is idle until it is armed and changes.
      if (!was?.running && e.detail?.running && this.#ready && this.#focus) {
        const [first] = this.#debugger?.instancesOf(this.#focus) ?? [];
        if (first) this.#debugger.focusChip(first);
      }
      // A breakpoint that fires brings the debugger up, as an IDE comes
      // forward on a break: the board is stalled, and the window holds the
      // only controls that move it on. Only the moment it PAUSES — a step
      // inside a pause must not keep pulling the window over the desk.
      if (e.detail?.paused && !wasPaused) this.openWindow();
    });
    // A window already open (this renderer reloaded under it) announced
    // itself to the renderer that went away: ask again. With no window, main
    // drops the message.
    Promise.resolve(bridge?.chipDesign?.toWindow?.({ kind: "hello" })).catch(
      () => {},
    );
  }

  // ── Entry points (the tray, the desk's menus) ──────────────────────────

  /** Open (or raise) the window. */
  openWindow() {
    Promise.resolve(this.#bridge?.chipDesign?.open?.()).catch((err) =>
      console.error("[renderer] chipdesign:open failed:", err),
    );
  }

  /** Open a design in the window, as a tab with the focus. */
  openDesign(id) {
    if (!this.#chips().some((c) => c.id === id)) return;
    if (!this.#open.includes(id)) this.#open.push(id);
    this.#focus = id;
    this.openWindow();
    this.#send();
  }

  /**
   * A placed chip's "Open in Chip Designer": while the circuit runs, its
   * DEBUGGER tab; stopped, its design.
   * @param {string} compId
   */
  openForComponent(compId) {
    const ref = this.#refOf(compId);
    if (!ref) return;
    if (this.#debug?.running) {
      this.#debugger?.focusChip(compId);
      this.openWindow();
      return;
    }
    this.openDesign(ref);
  }

  /**
   * A custom chip's pin-assignments window asking for its designer. That
   * window is about the CHIP, not one instance of it, so while the circuit
   * runs it is the first instance's debugger tab (as Run with the design on
   * screen shows); stopped, its design.
   * @param {string} ref
   */
  openForRef(ref) {
    if (!partDef(ref)?.custom) return;
    if (this.#debug?.running) {
      const [first] = this.#debugger?.instancesOf(ref) ?? [];
      if (first) {
        this.#debugger.focusChip(first);
        this.openWindow();
        return;
      }
    }
    this.openDesign(ref);
  }

  /** A chip selected on the desk: its tab takes the focus, if the window is
      open (selecting never opens it). */
  focusComponent(compId) {
    if (!this.#ready) return;
    const ref = this.#refOf(compId);
    if (!ref) return;
    if (this.#debug?.running) {
      this.#debugger?.focusChip(compId);
      return;
    }
    // Its tab, not the window: a click on the desk must not pull the
    // designer over the desk it was made on.
    if (!this.#open.includes(ref)) this.#open.push(ref);
    this.#focus = ref;
    this.#send();
  }

  /** "New chip…": a fresh design, opened. */
  newDesign() {
    const ws = this.#workspace();
    if (!ws) return;
    if (this.#debug?.running) {
      this.#warn(t("chipdesign.notice.running"));
      return;
    }
    const chip = newCustomChip(ws.customChips);
    const res = ws.putCustomChip(chip);
    if (!res.ok) {
      this.#warn(t(`chipdesign.notice.${res.code}`, { count: res.count ?? 0 }));
      return;
    }
    this.openDesign(chip.id);
  }

  /** A copy of a design, opened. */
  duplicateDesign(id) {
    const ws = this.#workspace();
    const chip = ws?.customChips.find((c) => c.id === id);
    if (!chip) return;
    const copy = duplicateCustomChip(chip, ws.customChips);
    const res = ws.putCustomChip(copy);
    if (!res.ok) {
      this.#warn(t(`chipdesign.notice.${res.code}`, { count: res.count ?? 0 }));
      return;
    }
    this.openDesign(copy.id);
  }

  /** Delete a design — asked first, and refused while it is placed. */
  deleteDesign(id) {
    const ws = this.#workspace();
    const chip = ws?.customChips.find((c) => c.id === id);
    if (!chip) return;
    const uses = ws.customChipUses(id);
    if (uses > 0) {
      this.#warn(t("chipdesign.notice.deletePlaced", { name: chip.name, count: uses })); // prettier-ignore
      return;
    }
    PopupManager.confirm({
      title: t("chipdesign.deleteTitle", { name: chip.name }),
      message: t("chipdesign.deleteMessage"),
      confirmLabel: t("common.delete"),
      confirmClass: "btn--danger",
      onConfirm: () => {
        const res = ws.deleteCustomChip(id);
        if (!res.ok) {
          this.#warn(t(`chipdesign.notice.${res.code}`, { count: res.count ?? 0, name: chip.name })); // prettier-ignore
        }
      },
    });
  }

  // ── The window ──────────────────────────────────────────────────────────

  #receive(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.kind) {
      case "ready":
        // A window announcing itself is a fresh renderer (or this host is
        // fresh), whose edit tokens count from 0 again — the last window's
        // would otherwise read as already applied, and retire its edits
        // before they land.
        this.#ready = true;
        this.#tokens = {};
        this.#send();
        return;
      case "closed":
        this.#ready = false;
        return;
      case "update":
        this.#update(msg.chip, msg.token);
        return;
      case "new":
        this.newDesign();
        return;
      case "focus-design":
        if (this.#open.includes(msg.id)) this.#focus = msg.id;
        this.#send();
        return;
      case "close-design":
        this.#open = this.#open.filter((id) => id !== msg.id);
        if (this.#focus === msg.id) this.#focus = this.#open[0] ?? null;
        this.#send();
        return;
      case "debug": {
        const cmd = { step: "step", stepOut: "stepOut", continue: "continue", toSettled: "toSettled", detach: "detach" }[msg.cmd]; // prettier-ignore
        if (cmd) this.#debugger?.[cmd](msg.compId);
        return;
      }
      case "arm":
        if (typeof msg.settled === "boolean") {
          this.#debugger?.setArmed(msg.compId, { settled: msg.settled });
        }
        return;
      // A line number clicked in the gutter: a breakpoint on the design's
      // line (from a debugger tab, `compId` is the chip being looked at).
      case "breakpoint":
        if (typeof msg.ref === "string" && Number.isInteger(msg.line)) {
          this.#debugger?.toggleBreakpoint(msg.ref, msg.line, typeof msg.compId === "string" ? msg.compId : null); // prettier-ignore
        }
        return;
      case "focus-chip":
        this.#debugger?.focusChip(msg.compId);
        return;
      case "close-chip":
        this.#debugger?.closeTab(msg.compId);
        return;
      case "unit":
        if (Number.isInteger(msg.unit)) this.#debugger?.setUnit(msg.compId, msg.unit); // prettier-ignore
        return;
      // The memory view scrolled, or the state it shows moved on: the words
      // it has on screen, answered to it alone (a memory is never part of
      // the state message).
      case "memory-range":
        this.#memoryRange(msg);
        return;
      default:
    }
  }

  #memoryRange(msg) {
    if (typeof msg.compId !== "string") return;
    if (![msg.slot, msg.from, msg.count].every(Number.isInteger)) return;
    const range = this.#debugger?.memoryRange(msg.compId, msg.slot, msg.from, msg.count) ?? null; // prettier-ignore
    if (!this.#ready) return;
    const reply = { kind: "memory-range", compId: msg.compId, slot: msg.slot, req: msg.req ?? null, range }; // prettier-ignore
    Promise.resolve(this.#bridge?.chipDesign?.toWindow?.(reply)).catch(() => {}); // prettier-ignore
  }

  /** An edit from the window: the project takes it, or says why not. */
  #update(chip, token) {
    const ws = this.#workspace();
    if (!ws || !chip?.id) return;
    if (Number.isInteger(token)) {
      this.#tokens[chip.id] = Math.max(this.#tokens[chip.id] ?? 0, token);
    }
    const res = this.#debug?.running
      ? { ok: false, code: "running" }
      : ws.putCustomChip(chip);
    if (!res.ok) {
      this.#notice = {
        code: res.code,
        args: { count: res.count ?? ws.customChipUses(chip.id) },
      };
    }
    this.#send();
  }

  /**
   * The run ended: the window turns back into the designer, and the chips it
   * was debugging stay in front of the user as their DESIGNS — one window,
   * the same chips, now editable — rather than leaving it empty.
   * @param {object} debug - the debugger's last view of the run.
   */
  #keepDebugged(debug) {
    const focusRef = debug.tabs?.find((tab) => tab.compId === debug.focus)?.ref;
    for (const tab of debug.tabs ?? []) {
      if (partDef(tab.ref)?.custom && !this.#open.includes(tab.ref)) {
        this.#open.push(tab.ref);
      }
    }
    if (focusRef && this.#open.includes(focusRef)) this.#focus = focusRef;
    else if (!this.#focus) this.#focus = this.#open[0] ?? null;
  }

  /** Close the tabs of designs the project no longer holds. */
  #prune() {
    const ids = new Set(this.#chips().map((c) => c.id));
    this.#open = this.#open.filter((id) => ids.has(id));
    if (!ids.has(this.#focus)) this.#focus = this.#open[0] ?? null;
  }

  #chips() {
    return this.#workspace()?.customChips ?? [];
  }

  /** A placed component's ref, when it is a custom chip's. */
  #refOf(compId) {
    const ref = this.#debugger?.refOf(compId) ?? null;
    return partDef(ref)?.custom ? ref : null;
  }

  /** Tell the window everything — once per turn, however many changes. */
  #send() {
    if (!this.#ready || this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (!this.#ready) return;
      const ws = this.#workspace();
      const chips = this.#chips();
      const uses = {};
      const counts = ws?.customChipCounts?.() ?? null;
      for (const c of chips) {
        uses[c.id] = counts ? (counts.get(c.id) ?? 0) : (ws?.customChipUses(c.id) ?? 0); // prettier-ignore
      }
      const debug = this.#debug ?? this.#debugger?.state ?? null;
      const msg = {
        kind: "state",
        mode: debug?.running ? "debug" : "design",
        designs: chips,
        open: this.#open,
        focus: this.#focus,
        uses,
        tokens: { ...this.#tokens },
        notice: this.#notice,
        debug,
      };
      this.#notice = null;
      Promise.resolve(this.#bridge?.chipDesign?.toWindow?.(msg)).catch(
        () => {},
      );
    });
  }

  #warn(message) {
    this.#notifications?.notify({
      variant: "warning",
      title: t("chipdesign.windowTitle"),
      message,
    });
  }
}
