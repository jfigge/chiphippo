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

// integration-tools.js — everything the user does TO the Arduino serial
// integration's Output and Input elements on the desk: dropping one (and
// picking its width), dragging a tag off its card onto a hole or from hole to
// hole, R to turn a tag, Delete to unplug it, the element's context menu, and
// its Properties card. Pulled out of DeskController the way WireTools and
// BusTools are, sharing the controller's `#mode` through a host object so the
// viewport dispatcher's arbitration is unchanged.
//
// THE TAG DRAG IS THE SIGNAL FLAG'S (desk-controller.js `drag-signal-flag`),
// one item over, and for the same reasons: ONE gesture serves "drag it off the
// card" and "move it to another hole"; the tag never leaves the cursor, snaps
// to the nearest hole in reach it can have (ringed, as a wire end's is), and
// reddens when there is none; a drop clear of every hole UNPLUGS a planted tag
// (back to its card); a drop that spans Run reverts. Its
// kind is `drag-integration-tag` — the `drag…` prefix is load-bearing, since
// "is a drag in flight?" is derived from it.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { SIGNAL_COLORS } from "../model/signals.js";
import {
  DROP_WIDTHS,
  MAX_ELEMENTS,
  TRIGGER_EDGES,
  elementSeq,
  nextTagRotation,
  tagId,
} from "../model/integration.js";
import { isMockId } from "../model/mock-connection.js";
import { nearestLegalPoint } from "../model/part-geometry.js";
import { isToggleSelectEvent } from "../model/selection-toggle.js";
import { PartPropertiesDialog } from "./part-properties-dialog.js";
import { beginPointerGesture, releaseWorld } from "./pointer-gesture.js";
import { aimRing } from "./hole-rings.js";

/** Pointer travel (px) below which a press stays a click. */
const DRAG_THRESHOLD = 4;

const IS_MAC = globalThis.window?.chiphippo?.platform === "darwin";

/** The trigger's choices — Auto, then the three edges — as functions, never
    consts: `t()` must not run at module scope. */
const edgeOptions = () =>
  TRIGGER_EDGES.map((value) => ({
    value,
    label: t(`integration.edge.${value}`),
  }));

const initOptions = () => [
  { value: "low", label: t("properties.option.low") },
  { value: "high", label: t("properties.option.high") },
];

export class IntegrationTools {
  #host;

  /**
   * @param {object} host - the controller: `mode` (get/set), `editingLocked`,
   *   `probeArmed`, `doc`, `deskView`, `viewport`, `layer` (IntegrationLayer),
   *   `ring` (the shared hover ring), `holeAtWorld(w)`, `selectTag(id)`, `selectedTag` (get), `forgetTag()`,
   *   `emitDocChanged(label, opts)`, `hideHover()`, `connections()`,
   *   `openSettings(tab)`, `addNetToAnalyzer(address, opts)`,
   *   `openConnectionWindow(connectionId)`.
   */
  constructor(host) {
    this.#host = host;
  }

  // ── Adding ──────────────────────────────────────────────────────────────

  /**
   * A placement click landed: ask for the width, at the click, then add. The
   * desk position itself is discarded (an element's card goes on the rail,
   * like a signal's button), so the popover is the whole placement.
   */
  promptWidth(kind, clientX, clientY) {
    const pick = (width) => {
      PopupManager.close();
      this.add(kind, width);
    };
    const options = el(
      "div",
      {
        class: "integration-width-options",
        role: "radiogroup",
        "aria-label": t("integration.widthLabel"),
      },
      DROP_WIDTHS.map((width) =>
        el("button", {
          type: "button",
          class: "integration-width-option",
          text: String(width),
          title: t("integration.widthOption", { count: width }),
          "aria-label": t("integration.widthOption", { count: width }),
          ...(width === 8 ? { dataset: { autofocus: "true" } } : {}),
          onClick: () => pick(width),
        }),
      ),
    );
    PopupManager.popover({
      x: clientX,
      y: clientY,
      element: el("div", { class: "integration-width-popover" }, [
        el("div", {
          class: "integration-width-title",
          text: t(`integration.widthTitle.${kind}`),
        }),
        options,
      ]),
    });
  }

  /**
   * Add an Output or Input, `width` pins wide. Named from its own id (never
   * the rail's length — the `Signal N` argument), and given the connection
   * the desk already talks over, or failing that the first ARDUINO configured
   * (the Mock only when there is none), so the common case of one Arduino
   * needs no Properties visit at all.
   * @returns {object|null} the element, or null (running, or the rail full)
   */
  add(kind, width) {
    const h = this.#host;
    if (h.editingLocked) return null;
    let element;
    try {
      element = h.doc.addIntegration({
        kind,
        width,
        connection: this.#defaultConnection(),
      });
    } catch {
      return null; // INTEGRATIONS_FULL
    }
    h.doc.setIntegrationMeta(element.id, {
      name: t(`integration.defaultName.${kind}`, { n: elementSeq(element.id) }),
    });
    h.emitDocChanged(`add ${kind}`);
    return h.doc.getIntegration(element.id);
  }

  #defaultConnection() {
    const list = this.#host.connections() ?? [];
    const known = new Set(list.map((c) => c.id));
    for (const e of this.#host.doc.integrations) {
      if (e.connection && known.has(e.connection)) return e.connection;
    }
    // The Mock leads every connection list (`knownConnections`), so "the
    // first" would always be it — never the board the user set up.
    return (list.find((c) => !isMockId(c.id)) ?? list[0])?.id ?? null;
  }

  /** Is the rail full? (The palette disables both rows then.) */
  get full() {
    return this.#host.doc.integrations.length >= MAX_ELEMENTS;
  }

  // ── The tag drag ────────────────────────────────────────────────────────

  /** A press on a card's waiting chip — the drag starts OFF the rail. */
  beginDragFromCard(elementId, key, e) {
    this.onTagPointerDown(elementId, key, e, { fromCard: true });
  }

  /** A press on a planted tag, or (fromCard) on its card's chip. */
  onTagPointerDown(elementId, key, e, { fromCard = false } = {}) {
    const h = this.#host;
    if (e.button !== 0) return;
    if (e.shiftKey) return; // the viewport's marquee
    if (h.mode || h.probeArmed || h.editingLocked) return;
    if (isToggleSelectEvent(e, IS_MAC)) {
      e.stopPropagation();
      return; // a tag joins no multi-selection
    }
    const element = h.doc.getIntegration(elementId);
    if (!element) return;
    e.stopPropagation();
    h.hideHover();
    const origin = element.tags?.[key] ? { ...element.tags[key] } : null;
    if (origin) h.selectTag(tagId(elementId, key));
    const start = h.deskView.worldFromEvent(e);
    const elem = fromCard ? h.viewport : e.currentTarget;
    const d = {
      kind: "drag-integration-tag",
      elementId,
      key,
      elem,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastWorld: start,
      origin,
      rot: origin?.rot ?? 0,
      active: fromCard, // a drag off the card shows the tag at once
      address: null,
      holeFree: false,
      inReach: false,
      refused: false,
      teardown: null,
    };
    h.mode = d;
    h.viewport.classList.add("desk-viewport--dragging");
    d.teardown = beginPointerGesture(elem, e.pointerId, {
      onMove: this.#onMove,
      onEnd: this.#onUp,
    });
    if (fromCard) this.#resolve(d, start);
  }

  /** Where the tag would land — shared by the live drag and the release: the
      nearest free hole in reach; with none, a MISS when aimed at a board and
      the UNPLUG clear of every hole (the signal flag's rule). */
  #resolve(d, world) {
    const h = this.#host;
    const { point, inReach } = nearestLegalPoint(
      h.doc.boards,
      null,
      world,
      (p) => h.doc.canPlaceIntegrationTag(d.elementId, d.key, p.address),
    );
    d.address = point?.address ?? null;
    d.holeFree = Boolean(point);
    d.inReach = inReach;
    const at = point ? { x: point.x, y: point.y } : world;
    // Red where a drop would achieve nothing: a board with no free hole in
    // reach, or bare desk with no planted tag to pull out (see the signal flag).
    d.refused = inReach ? !point : !d.origin;
    // The ring marks the hole it lands in — or, on a miss, the taken hole under
    // the cursor, in red.
    const under = point || !inReach ? null : h.holeAtWorld(world);
    aimRing(h.ring, point ?? under, Boolean(point));
    h.layer.setPreview(d.elementId, d.key, {
      at,
      rot: d.rot,
      illegal: d.refused,
    });
  }

  #onMove = (e) => {
    const d = this.#host.mode;
    if (d?.kind !== "drag-integration-tag" || e.pointerId !== d.pointerId) {
      return;
    }
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      d.active = true;
    }
    const w = this.#host.deskView.worldFromEvent(e);
    d.lastWorld = w;
    this.#resolve(d, w);
  };

  #onUp = (e) => {
    const h = this.#host;
    const d = h.mode;
    if (d?.kind !== "drag-integration-tag" || e.pointerId !== d.pointerId) {
      return;
    }
    h.mode = null;
    h.viewport.classList.remove("desk-viewport--dragging");
    d.teardown?.();
    aimRing(h.ring, null);
    if (!d.active) {
      h.layer.clearPreview(d.elementId, d.key);
      return;
    }
    const cancelled = e.type === "pointercancel" || h.editingLocked;
    if (cancelled) {
      h.layer.clearPreview(d.elementId, d.key);
      return;
    }
    // What the last move SHOWED (snapped and ringed): a release that would
    // achieve nothing lands there instead — the signal flag's rule.
    const shown = d.holeFree ? d.address : null;
    this.#resolve(d, releaseWorld(h.deskView, e, d.lastWorld));
    aimRing(h.ring, null); // the re-resolve aimed it again
    const miss = !d.holeFree && (d.inReach || !d.origin);
    if (miss && shown) {
      d.address = shown;
      d.holeFree = true;
    }
    try {
      if (d.address && d.holeFree) {
        const same = d.origin?.anchor === d.address && d.origin?.rot === d.rot;
        if (same) {
          h.layer.clearPreview(d.elementId, d.key);
          return;
        }
        h.doc.plantIntegrationTag(d.elementId, d.key, d.address, d.rot);
        h.selectTag(tagId(d.elementId, d.key));
        h.emitDocChanged("connect tag");
      } else if (!d.inReach && d.origin) {
        this.unplugTag(d.elementId, d.key);
      } else {
        h.layer.clearPreview(d.elementId, d.key);
      }
    } catch {
      h.layer.clearPreview(d.elementId, d.key);
    }
  };

  /** Cancel a tag drag in flight (Escape, a scene rebuild). */
  cancelDrag() {
    const h = this.#host;
    const d = h.mode;
    if (d?.kind !== "drag-integration-tag") return false;
    h.mode = null;
    h.viewport.classList.remove("desk-viewport--dragging");
    d.teardown?.();
    aimRing(h.ring, null);
    h.layer.clearPreview(d.elementId, d.key);
    return true;
  }

  /** R: turn the tag in hand, or the selected one. Returns whether consumed. */
  rotate() {
    const h = this.#host;
    const d = h.mode;
    if (d?.kind === "drag-integration-tag") {
      d.rot = nextTagRotation(d.rot);
      this.#resolve(d, d.lastWorld);
      return true;
    }
    const sel = h.selectedTag;
    if (!sel || h.editingLocked) return false;
    const element = h.doc.getIntegration(sel.elementId);
    if (!element?.tags?.[sel.key]) return false;
    h.doc.rotateIntegrationTag(sel.elementId, sel.key);
    h.emitDocChanged("rotate tag");
    return true;
  }

  // ── Document actions ────────────────────────────────────────────────────

  /** Unplug one tag — back to its card. */
  unplugTag(elementId, key) {
    const h = this.#host;
    if (h.editingLocked) return;
    if (!h.doc.getIntegration(elementId)?.tags?.[key]) return;
    h.doc.unplantIntegrationTag(elementId, key);
    const sel = h.selectedTag;
    if (sel?.elementId === elementId && sel.key === key) h.forgetTag();
    h.emitDocChanged("disconnect tag");
  }

  /** Unplug every tag an element has. */
  unplugAll(elementId) {
    const h = this.#host;
    if (h.editingLocked) return;
    if (!h.doc.getIntegration(elementId)?.tags) return;
    h.doc.unplantIntegrationTags(elementId);
    if (h.selectedTag?.elementId === elementId) h.forgetTag();
    h.emitDocChanged("disconnect tags");
  }

  /** Delete an element outright — card, tags and all. */
  remove(elementId) {
    const h = this.#host;
    if (h.editingLocked) return;
    const kind = h.doc.getIntegration(elementId)?.kind;
    try {
      h.doc.removeIntegration(elementId);
    } catch {
      return;
    }
    if (h.selectedTag?.elementId === elementId) h.forgetTag();
    h.emitDocChanged(`delete ${kind}`);
  }

  // ── Menus & Properties ──────────────────────────────────────────────────

  /** Right-click on a planted tag. */
  onTagContextMenu(elementId, key, e) {
    e.preventDefault();
    e.stopPropagation();
    this.openMenu(elementId, e.clientX, e.clientY, key);
  }

  /**
   * The element's menu — ONE shape wherever it is opened (a tag on the desk,
   * or its card on the rail): Properties… · Open Connection Window · Add to
   * analyzer · Remove Tag · Remove All Tags · rule-free Delete. Like the
   * signal menu, an item that does not apply stays present but disabled, so
   * the shape never changes.
   *
   * It opens while the circuit RUNS too — that is when a connection window is
   * most worth opening — with every item that would edit the desk disabled,
   * as the part menu disables Delete.
   * @param {string|null} key the tag right-clicked, or null from the card
   */
  openMenu(elementId, x, y, key = null) {
    const h = this.#host;
    if (h.probeArmed || h.mode) return;
    const element = h.doc.getIntegration(elementId);
    if (!element) return;
    const locked = Boolean(h.editingLocked);
    const tag = key ? element.tags?.[key] : null;
    if (tag && !locked) h.selectTag(tagId(elementId, key));
    const known = (h.connections() ?? []).some(
      (c) => c.id === element.connection,
    );
    PopupManager.menu({
      x,
      y,
      items: [
        {
          label: t("desk.menu.properties"),
          disabled: locked,
          onSelect: () => this.openProperties(elementId),
        },
        {
          label: t("integration.menu.openWindow"),
          disabled: !element.connection || !known,
          onSelect: () => h.openConnectionWindow?.(element.connection),
        },
        {
          label: t("probe.addToAnalyzer"),
          disabled: !tag,
          onSelect: () =>
            h.addNetToAnalyzer?.(tag.anchor, {
              color: element.color,
              label: `${element.name || element.id} ${key}`,
            }),
        },
        {
          label: t("integration.menu.removeTag"),
          disabled: !tag || locked,
          onSelect: () => this.unplugTag(elementId, key),
        },
        {
          label: t("integration.menu.removeAllTags"),
          disabled: !element.tags || locked,
          onSelect: () => this.unplugAll(elementId),
        },
        {
          label: t(`integration.menu.delete.${element.kind}`),
          danger: true,
          disabled: locked,
          onSelect: () => this.remove(elementId),
        },
      ],
    });
  }

  /**
   * The shared Properties card, hand-built like a signal's: Name and
   * Description, then Colour, Connection (and a way to Settings to make one),
   * the trigger's condition and initial state, and the Pins — the field list.
   */
  openProperties(elementId) {
    const h = this.#host;
    const element = h.doc.getIntegration(elementId);
    if (!element) return;
    const connections = h.connections() ?? [];
    const connectionOptions = [
      { value: "", label: t("integration.properties.noConnection") },
      ...connections.map((c) => ({ value: c.id, label: c.name })),
    ];
    // A connection the element names that this machine does not know (a
    // project from elsewhere, before it was merged) still shows as itself.
    if (
      element.connection &&
      !connections.some((c) => c.id === element.connection)
    ) {
      connectionOptions.push({
        value: element.connection,
        label: t("integration.properties.unknownConnection"),
      });
    }
    PartPropertiesDialog.open({
      title: t(`integration.properties.title.${element.kind}`, {
        name: element.name || element.id,
      }),
      fields: [
        { key: "color", type: "color", options: SIGNAL_COLORS },
        {
          key: "connection",
          label: t("integration.properties.connection"),
          type: "select",
          options: connectionOptions,
          action: {
            key: "manageConnections",
            label: t("integration.properties.manageConnections"),
            icon: "settings",
          },
        },
        {
          key: "triggerEdge",
          label: t("integration.properties.triggerEdge"),
          type: "segmented",
          options: edgeOptions(),
        },
        {
          key: "triggerInit",
          label: t("integration.properties.triggerInit"),
          type: "segmented",
          options: initOptions(),
          // What a trigger LINE was before the run: Auto watches none.
          disabledWhen: (values) => values.triggerEdge === "auto",
        },
        {
          key: "fields",
          label: t("integration.properties.pins"),
          type: "pin-fields",
        },
      ],
      values: {
        name: element.name,
        description: element.description,
        color: element.color,
        connection: element.connection ?? "",
        triggerEdge: element.triggerEdge,
        triggerInit: element.triggerInit,
        fields: element.fields,
      },
      onChange: (key, value) => this.#setProperty(elementId, key, value),
      onAction: (key) => {
        if (key === "manageConnections") h.openSettings?.("integration");
      },
    });
  }

  #setProperty(elementId, key, value) {
    const h = this.#host;
    if (h.editingLocked) return;
    try {
      if (key === "name" || key === "description") {
        h.doc.setIntegrationMeta(elementId, { [key]: value });
      } else if (key === "fields") {
        h.doc.setIntegrationFields(elementId, value);
      } else if (key === "connection") {
        h.doc.updateIntegration(elementId, { connection: value || null });
      } else {
        h.doc.updateIntegration(elementId, { [key]: value });
      }
    } catch {
      return;
    }
    // A change here can take a tag off the board — the trigger, parked by a
    // switch to Auto, or a pin past a narrower field list — and a selection
    // left on it would light nothing and answer Delete and R for nothing.
    const sel = h.selectedTag;
    if (
      sel?.elementId === elementId &&
      !h.doc.getIntegration(elementId)?.tags?.[sel.key]
    ) {
      h.forgetTag();
    }
    h.emitDocChanged("set element properties", { coalesce: true });
  }
}
