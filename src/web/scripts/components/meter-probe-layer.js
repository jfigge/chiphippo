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

// meter-probe-layer.js — every multimeter's two probes and the leads that
// run to them from its jacks (catalog/meter.js). The same layer div as the
// signal flags (a third SVG, after the flags' and the tags'): a probe is a
// bench lead touching one hole, drawn over the wires and parts it reaches
// across, below the interaction overlay.
//
// A probe is drawn from its TIP, on the hole it touches (or where it lies on
// the desk), its body along the line back towards its jack — the way a
// probe held to a board points back at the meter — and its lead a sagging
// cable from the body's end to the jack. The probe's BODY is the hit target
// (the sanctioned per-item event exception, as a flag's polygon is); the
// lead takes no press. A live drag moves one probe in place (`setPreview`),
// never through a rebuild, which would destroy the node the press captured.

import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { PROBES } from "../catalog/meter.js";
import {
  jackOf,
  jackWorld,
  meters,
  probeWorld,
} from "../model/meter-probes.js";

/** A probe's dimensions (pitch): the needle, the finger guard, the body,
    and the needle's half-width at its rounded end (about a hole's) — and
    where a drag HOLDS it (`grip`): the top of the body, just behind the
    guard, so the hand is clear of what the tip touches. */
const PROBE = Object.freeze({ guard: 2.1, length: 7.5, body: 0.9, guardWidth: 1.7, tip: 0.24, grip: 2.9 }); // prettier-ignore

/** How many straight pieces round the needle's end. */
const NEEDLE_CAP_STEPS = 6;

/** How far a lead runs straight out of its jack and out of its probe before
    it sags between them, pitch. */
const LEAD_OUT = 7;

const px = (v) => v * PX_PER_UNIT;

/** The unit vector a probe's body runs along, tip → its jack. */
function axisOf(tip, jack) {
  const dx = jack.x - tip.x;
  const dy = jack.y - tip.y;
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 0, y: -1 };
}

/** Where a probe is held (`PROBE.grip` up its body) with its tip at `tip`
    and its lead running to `jack`. World pitch. */
export function gripOf(tip, jack) {
  const u = axisOf(tip, jack);
  return { x: tip.x + u.x * PROBE.grip, y: tip.y + u.y * PROBE.grip };
}

/** Where the tip is of a probe held at `grip` — `gripOf` backwards: the
    grip lies between the tip and the jack, so the body's axis from the
    grip is the axis from the tip, and the tip is `PROBE.grip` back down
    it. World pitch. */
export function tipFromGrip(grip, jack) {
  const u = axisOf(grip, jack);
  return { x: grip.x - u.x * PROBE.grip, y: grip.y - u.y * PROBE.grip };
}

/**
 * A probe's outline (the hit target) and its lead's path, for a tip at
 * `tip` whose lead runs to `jack` — world pitch in, SVG px out.
 * @returns {{body: string, needle: string, guard: string, lead: string}}
 */
export function probeShape(tip, jack) {
  const u = axisOf(tip, jack);
  const n = { x: -u.y, y: u.x };
  const at = (along, across = 0) => ({
    x: tip.x + u.x * along + n.x * across,
    y: tip.y + u.y * along + n.y * across,
  });
  const pts = (list) => list.map((p) => `${px(p.x)},${px(p.y)}`).join(" ");
  const w = PROBE.body / 2;
  const g = PROBE.guardWidth / 2;
  const body = pts([at(PROBE.guard, -w), at(PROBE.length, -w), at(PROBE.length, w), at(PROBE.guard, w)]); // prettier-ignore
  const guard = pts([at(PROBE.guard - 0.35, -g), at(PROBE.guard + 0.35, -g), at(PROBE.guard + 0.35, g), at(PROBE.guard - 0.35, g)]); // prettier-ignore
  // The needle's rounded end is CENTRED on the point it touches — the
  // hole's middle — so the tip sits in the hole, not beside it.
  const cap = [];
  for (let k = 0; k <= NEEDLE_CAP_STEPS; k++) {
    const a = Math.PI / 2 + (k * Math.PI) / NEEDLE_CAP_STEPS;
    cap.push(at(Math.cos(a) * PROBE.tip, Math.sin(a) * PROBE.tip));
  }
  const needle = pts([...cap, at(PROBE.guard, -PROBE.tip - 0.04), at(PROBE.guard, PROBE.tip + 0.04)]); // prettier-ignore
  const back = at(PROBE.length);
  const c1 = { x: back.x + u.x * LEAD_OUT, y: back.y + u.y * LEAD_OUT };
  const c2 = { x: jack.x, y: jack.y + LEAD_OUT };
  const lead = `M ${px(back.x)} ${px(back.y)} C ${px(c1.x)} ${px(c1.y)} ${px(c2.x)} ${px(c2.y)} ${px(jack.x)} ${px(jack.y)}`; // prettier-ignore
  return { body, needle, guard, lead };
}

export class MeterProbeLayer {
  #doc;
  #svg;
  #leads; // every lead…
  #probes; // …and, above them all, every probe
  #els = new Map(); // `${meterId}:${which}` → {lead, body, needle, guard}
  #onPointerDown;
  #onContextMenu;

  /**
   * @param {HTMLElement} layer - the `.layer-signals` element
   * @param {object} doc - the DeskDoc
   * @param {object} [callbacks] - `onPointerDown(meterId, which, e)`,
   *   `onContextMenu(meterId, which, e)`
   */
  constructor(layer, doc, { onPointerDown, onContextMenu } = {}) {
    this.#doc = doc;
    this.#onPointerDown = onPointerDown;
    this.#onContextMenu = onContextMenu;
    // A zero-size <svg> renders nothing (the zero-size-anchor rule).
    this.#svg = svgEl("svg", { class: "meter-probe-svg", width: 1, height: 1 });
    this.#leads = svgEl("g");
    this.#probes = svgEl("g");
    this.#svg.append(this.#leads, this.#probes);
    layer.append(this.#svg);
    window.addEventListener("chiphippo:doc-changed", () => this.render());
    this.render();
  }

  /**
   * Rebuild every probe and lead from the document — `moving` (id → {x, y})
   * a live drag's boards and bricks where they are drawn now, so a dragged
   * meter's leads, and a probe on a dragged strip, follow it.
   * @param {Map<string, {x: number, y: number}>|null} [moving]
   */
  render(moving = null) {
    this.#leads.replaceChildren();
    this.#probes.replaceChildren();
    this.#els.clear();
    const doc = { boards: this.#doc.boards, components: this.#doc.components };
    if (moving?.size) {
      const at = (item) => {
        const pos = moving.get(item.id);
        return pos ? { ...item, x: pos.x, y: pos.y } : item;
      };
      doc.boards = doc.boards.map(at);
      doc.components = doc.components.map((c) => (c.board == null ? at(c) : c)); // prettier-ignore
    }
    for (const meter of meters(doc)) {
      for (const which of PROBES) {
        const entry = this.#build(meter.id, which);
        this.#leads.append(entry.lead);
        this.#probes.append(entry.group);
        this.#els.set(`${meter.id}:${which}`, entry);
        this.#draw(entry, probeWorld(doc, meter, which), jackWorld(meter, jackOf(meter.params, which))); // prettier-ignore
      }
    }
  }

  /** One probe's nodes, undrawn. */
  #build(meterId, which) {
    const lead = svgEl("path", { class: `meter-lead meter-lead--${which}` });
    const group = svgEl("g", { class: `meter-probe meter-probe--${which}` });
    const needle = svgEl("polygon", { class: "meter-probe-needle" });
    const guard = svgEl("polygon", { class: "meter-probe-guard" });
    const body = svgEl("polygon", {
      class: "meter-probe-body",
      "data-meter-id": meterId,
      "data-probe": which,
    });
    // The whole probe takes the press, needle and guard included.
    for (const node of [needle, guard, body]) {
      node.addEventListener("pointerdown", (e) => this.#onPointerDown?.(meterId, which, e)); // prettier-ignore
      node.addEventListener("contextmenu", (e) => this.#onContextMenu?.(meterId, which, e)); // prettier-ignore
    }
    group.append(needle, guard, body);
    return { lead, group, needle, guard, body };
  }

  #draw(entry, tip, jack) {
    const shape = probeShape(tip, jack);
    entry.lead.setAttribute("d", shape.lead);
    entry.body.setAttribute("points", shape.body);
    entry.guard.setAttribute("points", shape.guard);
    entry.needle.setAttribute("points", shape.needle);
  }

  /**
   * Live-redraw ONE probe with its tip at a world point the document does
   * not hold yet — the drag preview, in place. `illegal` tints it.
   */
  setPreview(meterId, which, { at, illegal = false }) {
    const entry = this.#els.get(`${meterId}:${which}`);
    const meter = this.#doc.getComponent(meterId);
    if (!entry || !meter || !at) return;
    this.#draw(entry, at, jackWorld(meter, jackOf(meter.params, which)));
    entry.group.classList.toggle("meter-probe--illegal", Boolean(illegal));
    entry.group.classList.add("meter-probe--dragging");
  }

  /** Put a probe back where the DOCUMENT has it (a reverted or ended drag). */
  clearPreview(meterId, which) {
    const entry = this.#els.get(`${meterId}:${which}`);
    const meter = this.#doc.getComponent(meterId);
    if (!entry || !meter) return;
    entry.group.classList.remove("meter-probe--illegal", "meter-probe--dragging"); // prettier-ignore
    const doc = { boards: this.#doc.boards, components: this.#doc.components };
    this.#draw(entry, probeWorld(doc, meter, which), jackWorld(meter, jackOf(meter.params, which))); // prettier-ignore
  }
}
