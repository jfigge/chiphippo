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

// integration-rail.js — the Arduino serial integration's element CARDS, down
// the desk viewport's right edge under the signal buttons.
//
// A card is the element's home, as a signal's button is the signal's: its
// head names it (a direction arrow — → an Output leaves the board, ← an Input
// comes in — its colour, its name, and how many pins it has), and under it sit
// the tags that are NOT on the board yet, as chips to drag onto a hole. A
// placed tag leaves its card; unplugging it brings it back. So the card is the
// whole placement readout: an element with nothing under its name is fully
// wired.
//
// It lives INSIDE the signal rail's column (signal-rail.js), after the signal
// rows, so the two stack as one column between the padlock and the zoom
// cluster with no second set of layout rules. A doc change rebuilds it (a
// handful of cards); nothing else does.
//
// A DATA bus's card keeps all eight places in its row: a pin still waiting is
// its chip, and a planted pin's place becomes a same-size BOX showing the
// level it drives — Z, 0 or 1 — that a click steps on (Z → 0 → 1 → Z), even
// while the circuit runs. Pin 1 is leftmost, bit 0, as on an Output's card.
//
// A PRIMARY click on a card's head does nothing: it is a readout, not a
// shortcut, and a stray click beside the tags waiting under it must not throw
// a dialog over the desk. Right-clicking it (or a tag on the desk) opens the
// element's menu, which leads with Properties… — the controller owns it.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import {
  DATA_GLYPH,
  TRIGGER_KEY,
  pinCount,
  tagKeys,
} from "../model/integration.js";
import { tagLabel } from "./integration-layer.js";

export class IntegrationRail {
  #doc;
  #root;
  #cards = new Map(); // element id → card element
  #selected = null;
  #onContextMenu;
  #onTagPointerDown;
  #onDataPinClick;
  #connectionName;

  /**
   * @param {HTMLElement} column the signal rail's root (`.signal-rail`)
   * @param {object} doc the DeskDoc
   * @param {object} callbacks
   * @param {(id: string, e: MouseEvent) => void} callbacks.onContextMenu
   * @param {(id: string, key: string, e: PointerEvent) => void} callbacks.onTagPointerDown
   * @param {(id: string, key: string) => void} [callbacks.onDataPinClick] a
   *   data bus's planted pin clicked — step its level
   * @param {(connectionId: string|null) => string|null} [callbacks.connectionName]
   */
  constructor(
    column,
    doc,
    { onContextMenu, onTagPointerDown, onDataPinClick, connectionName } = {},
  ) {
    this.#doc = doc;
    this.#onContextMenu = onContextMenu;
    this.#onTagPointerDown = onTagPointerDown;
    this.#onDataPinClick = onDataPinClick;
    this.#connectionName = connectionName ?? (() => null);
    this.#root = el("div", { class: "integration-rail" });
    column.append(this.#root);
    window.addEventListener("chiphippo:doc-changed", () => this.render());
    this.render();
  }

  /** Rebuild every card from the document, in rail (document) order. */
  render() {
    this.#root.replaceChildren();
    this.#cards.clear();
    for (const element of this.#doc.integrations) {
      const card = this.#buildCard(element);
      this.#root.append(card);
      this.#cards.set(element.id, card);
    }
  }

  /** Re-apply the language (the arrows and numbers need none). */
  relocalize() {
    this.render();
  }

  /** Light the card whose tag is selected on the desk (null clears it). */
  setSelected(id) {
    this.#selected = id ?? null;
    for (const [eid, card] of this.#cards) {
      card.classList.toggle(
        "integration-card--selected",
        eid === this.#selected,
      );
    }
  }

  #buildCard(element) {
    const name = element.name || element.id;
    const isData = element.kind === "data";
    const conn = this.#connectionName(element.connection);
    const kindLabel = t(`integration.kind.${element.kind}`);
    const head = el(
      "button",
      {
        type: "button",
        class: "integration-card-head",
        title: [
          isData
            ? kindLabel
            : `${kindLabel} — ${conn ?? t("integration.card.noConnection")}`,
          element.description || t("integration.card.menuHint"),
        ].join("\n"),
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.#onContextMenu?.(element.id, e);
        },
      },
      [
        el("span", {
          class: "integration-card-dir",
          "aria-hidden": "true",
          // Beside the name, as in the palette: an Output's arrow points
          // out of it (←), an Input's in (→), a data bus's several in (⇉).
          text: isData ? DATA_GLYPH : element.kind === "output" ? "←" : "→",
        }),
        el("span", { class: "integration-card-dot", "aria-hidden": "true" }),
        el("span", { class: "integration-card-name", text: name }),
        el("span", {
          class: "integration-card-width",
          title: t("integration.card.width", {
            count: pinCount(element.fields),
          }),
          text: String(pinCount(element.fields)),
        }),
      ],
    );
    head.setAttribute("aria-label", `${kindLabel}: ${name}`);

    // A data bus keeps every pin's place — a planted one shows its level;
    // anything else lists only the tags still waiting.
    const shown = isData
      ? tagKeys(element)
      : tagKeys(element).filter((key) => !element.tags?.[key]);
    const chips = shown.map((key) =>
      element.tags?.[key]
        ? this.#dataPinBox(element, key)
        : this.#waitingChip(element, key),
    );

    const card = el(
      "div",
      {
        class:
          "integration-card" +
          (element.connection || isData
            ? ""
            : " integration-card--unassigned") +
          (element.id === this.#selected ? " integration-card--selected" : ""),
        dataset: { elementId: element.id },
      },
      [
        head,
        ...(chips.length
          ? [el("div", { class: "integration-card-tags" }, chips)]
          : []),
      ],
    );
    card.style.setProperty(
      "--signal-color",
      `var(--color-wire-${element.color})`,
    );
    return card;
  }

  /** A tag still waiting on its card: drag it onto a hole. */
  #waitingChip(element, key) {
    return el("span", {
      class:
        "integration-tag-chip" +
        (key === TRIGGER_KEY ? " integration-tag-chip--trigger" : ""),
      dataset: { key },
      title:
        key === TRIGGER_KEY
          ? t("integration.card.triggerHint")
          : t("integration.card.pinHint", { pin: key }),
      text: tagLabel(element, key),
      onpointerdown: (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.#onTagPointerDown?.(element.id, key, e);
      },
    });
  }

  /** A planted data pin's place on the card: the level it drives, which a
      click steps on. A button, so the keyboard reaches it too. */
  #dataPinBox(element, key) {
    const level = element.drive?.[Number(key) - 1] ?? "z";
    const shown = level === "z" ? "Z" : level;
    const hint = t("integration.card.dataPinHint", { pin: key, level: shown });
    return el("button", {
      type: "button",
      class: `integration-data-pin integration-data-pin--${level}`,
      dataset: { key },
      title: hint,
      "aria-label": hint,
      text: shown,
      onpointerdown: (e) => e.stopPropagation(),
      onClick: () => this.#onDataPinClick?.(element.id, key),
    });
  }

  /** Tear the cards out (a scene rebuild). */
  remove() {
    this.#root.remove();
    this.#cards.clear();
  }

  get element() {
    return this.#root;
  }
}
