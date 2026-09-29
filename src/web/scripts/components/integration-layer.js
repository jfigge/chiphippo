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

// integration-layer.js — the planted TAGS of the Arduino serial integration's
// Output and Input elements, on the desk.
//
// The signal layer's arrangement exactly (components/signal-layer.js), one
// item over: one `<polygon>` per planted tag, point in its anchor hole, in its
// element's colour; the polygon is the hit target and carries the tag's id;
// a pointer-inert label rides beside it — the PIN NUMBER, or for the trigger
// tag the edge it waits for (↑ ↓ ↕), in dark ink on a plate of the element's
// colour (the flag's key disc, one item over). A tag lives in the same `.layer-signals`
// div as the flags, as a second SVG after theirs: it is the same kind of
// thing, a lead from the bench plugged into a hole.
//
// A tag is wider than one pitch, so tags in adjacent holes overlap. Every
// body goes in one group and every label in a second group above it, so no
// number is ever under the translucent body of the tag beside it.
//
// Colours cycle and repeat, so what names a tag is its label plus its TOOLTIP
// (an SVG <title>: the element, the pin, and what that pin is), and selecting
// one lights its card on the rail.
//
// A live drag never comes through `render` — `setPreview` moves ONE tag in
// place, for the reason SignalLayer gives: a rebuild would destroy the very
// polygon the press captured.

import { svgEl } from "../dom.js";
import { t } from "../i18n.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import {
  TAG_KEY_R,
  TRIGGER_KEY,
  parseTagId,
  pinRole,
  tagId,
  tagLabelPoint,
  tagPolygon,
  triggerGlyph,
} from "../model/integration.js";
import { worldOfAddress } from "../model/occupancy.js";

/** The polygon `points` for a tag whose point is at a world position. */
export function tagPointsAt(at, rot) {
  return tagPolygon(at, rot)
    .map((v) => `${v.x * PX_PER_UNIT},${v.y * PX_PER_UNIT}`)
    .join(" ");
}

/** A digit of the label's type (0.975 pitch, tabular) is about this wide. */
const LABEL_CHAR_W = 0.6;

/**
 * The width (pitch units) of the plate a label sits on: a disc for one
 * character, stretched into a pill for a two-digit pin (10–16) so the number
 * never runs off it. An ESTIMATE from the character count rather than a
 * measurement, because nothing lays out text before it is on screen.
 */
export function tagPlateWidth(label) {
  const chars = [...String(label ?? "")].length;
  return Math.max(2 * TAG_KEY_R, chars * LABEL_CHAR_W + 0.2);
}

/** What a tag prints: its pin number, or the trigger's edge. */
export function tagLabel(element, key) {
  return key === TRIGGER_KEY ? triggerGlyph(element?.triggerEdge) : key;
}

/** A tag's tooltip: whose it is, and what the pin means. */
export function tagTitle(element, key) {
  const name = element?.name || element?.id || "";
  if (key === TRIGGER_KEY) {
    return t("integration.tag.triggerTitle", {
      name,
      edge: t(`integration.edge.${element?.triggerEdge ?? "rising"}`),
    });
  }
  const role = pinRole(element?.fields, Number(key));
  if (!role)
    return t("integration.tag.pinTitle", { name, pin: key, field: "" });
  const field = role.type === "bit" ? role.name : `${role.name}[${role.bit}]`;
  return t("integration.tag.pinTitle", { name, pin: key, field });
}

export class IntegrationLayer {
  #doc;
  #svg;
  #bodies;
  #labels;
  #els = new Map(); // tag id → { poly, label, title }
  #selected = null;
  #onPointerDown;
  #onContextMenu;
  #onSelect;

  /**
   * @param {HTMLElement} layer the `.layer-signals` element
   * @param {object} doc the DeskDoc
   * @param {object} [callbacks] `onPointerDown(elementId, key, e)`,
   *   `onContextMenu(elementId, key, e)`, `onSelect(elementId|null)` — the
   *   last hears every change of the highlighted tag, so the rail can light
   *   that element's card
   */
  constructor(layer, doc, { onPointerDown, onContextMenu, onSelect } = {}) {
    this.#doc = doc;
    this.#onPointerDown = onPointerDown;
    this.#onContextMenu = onContextMenu;
    this.#onSelect = onSelect;
    // The zero-size-anchor rule: a 1×1 box plus overflow: visible.
    this.#svg = svgEl("svg", { class: "tag-svg", width: 1, height: 1 });
    this.#bodies = svgEl("g");
    this.#labels = svgEl("g");
    this.#svg.append(this.#bodies, this.#labels);
    layer.append(this.#svg);
    window.addEventListener("chiphippo:doc-changed", () => this.render());
    this.render();
  }

  /** Rebuild every planted tag from the document. */
  render() {
    this.#bodies.replaceChildren();
    this.#labels.replaceChildren();
    this.#els.clear();
    for (const element of this.#doc.integrations) {
      for (const [key, tag] of Object.entries(element.tags ?? {})) {
        const at = worldOfAddress(this.#doc.boards, tag.anchor);
        if (!at) continue;
        const entry = this.#build(element, key);
        this.#moveTo(entry, at, tag.rot ?? 0);
        this.#bodies.append(entry.poly);
        this.#labels.append(entry.label);
        this.#els.set(tagId(element.id, key), entry);
      }
    }
  }

  #build(element, key) {
    const id = tagId(element.id, key);
    const color = `var(--color-wire-${element.color})`;
    const title = svgEl("title");
    title.textContent = tagTitle(element, key);
    const poly = svgEl(
      "polygon",
      {
        class:
          "integration-tag" +
          (key === TRIGGER_KEY ? " integration-tag--trigger" : "") +
          (element.kind === "input" ? " integration-tag--input" : ""),
        points: "",
        "data-tag-id": id,
      },
      [title],
    );
    poly.style.setProperty("--signal-color", color);
    if (id === this.#selected) poly.classList.add("integration-tag--selected");
    poly.addEventListener("pointerdown", (e) =>
      this.#onPointerDown?.(element.id, key, e),
    );
    poly.addEventListener("contextmenu", (e) =>
      this.#onContextMenu?.(element.id, key, e),
    );
    // The label: a plate in the element's colour with the number on it, drawn
    // about its own origin so ONE translate places both (the flag's key).
    const text = tagLabel(element, key);
    const number = svgEl("text", { class: "integration-tag-number" });
    number.textContent = text;
    const r = TAG_KEY_R * PX_PER_UNIT;
    const w = tagPlateWidth(text) * PX_PER_UNIT;
    const label = svgEl(
      "g",
      { class: "integration-tag-label", "aria-hidden": "true" },
      [
        svgEl("rect", {
          class: "integration-tag-plate",
          x: -w / 2,
          y: -r,
          width: w,
          height: 2 * r,
          rx: r,
        }),
        number,
      ],
    );
    label.style.setProperty("--signal-color", color);
    return { poly, label };
  }

  #moveTo(entry, at, rot) {
    entry.poly.setAttribute("points", tagPointsAt(at, rot));
    const p = tagLabelPoint(at, rot);
    entry.label.setAttribute(
      "transform",
      `translate(${p.x * PX_PER_UNIT} ${p.y * PX_PER_UNIT})`,
    );
  }

  /**
   * Live-redraw ONE tag at a world point the document does not hold yet —
   * the drag preview. A tag dragged off its card has no polygon yet, so this
   * MINTS one; the commit (or `clearPreview`) disposes of it.
   */
  setPreview(elementId, key, { at, rot = 0, illegal = false }) {
    if (!at) {
      this.clearPreview(elementId, key);
      return;
    }
    const id = tagId(elementId, key);
    let entry = this.#els.get(id);
    if (!entry) {
      const element = this.#doc.getIntegration(elementId);
      if (!element) return;
      entry = this.#build(element, key);
      this.#bodies.append(entry.poly);
      this.#labels.append(entry.label);
      this.#els.set(id, entry);
    }
    this.#moveTo(entry, at, rot);
    entry.poly.classList.toggle("integration-tag--illegal", Boolean(illegal));
  }

  /** Put one tag back where the DOCUMENT has it (a reverted or ended drag). */
  clearPreview(elementId, key) {
    const id = tagId(elementId, key);
    const entry = this.#els.get(id);
    entry?.poly.classList.remove("integration-tag--illegal");
    const tag = this.#doc.getIntegration(elementId)?.tags?.[key];
    if (!tag) {
      entry?.poly.remove();
      entry?.label.remove();
      this.#els.delete(id);
      return;
    }
    const at = worldOfAddress(this.#doc.boards, tag.anchor);
    if (at && entry) this.#moveTo(entry, at, tag.rot ?? 0);
    else this.render();
  }

  /** Highlight one tag (or none) — a class toggle, never a re-render. */
  setSelected(id) {
    if (this.#selected === id) return;
    this.#selected = id;
    for (const [tid, { poly }] of this.#els) {
      poly.classList.toggle("integration-tag--selected", tid === id);
    }
    this.#onSelect?.(parseTagId(id)?.elementId ?? null);
  }

  /** The highlighted tag's id (`<element>:<key>`), or null. */
  get selected() {
    return this.#selected;
  }
}
