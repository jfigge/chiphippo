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
// A PRIMARY click on a card's head does nothing: it is a readout, not a
// shortcut, and a stray click beside the tags waiting under it must not throw
// a dialog over the desk. Right-clicking it (or a tag on the desk) opens the
// element's menu, which leads with Properties… — the controller owns it.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { TRIGGER_KEY, pinCount, tagKeys } from "../model/integration.js";
import { tagLabel } from "./integration-layer.js";

export class IntegrationRail {
  #doc;
  #root;
  #cards = new Map(); // element id → card element
  #selected = null;
  #onContextMenu;
  #onTagPointerDown;
  #connectionName;

  /**
   * @param {HTMLElement} column the signal rail's root (`.signal-rail`)
   * @param {object} doc the DeskDoc
   * @param {object} callbacks
   * @param {(id: string, e: MouseEvent) => void} callbacks.onContextMenu
   * @param {(id: string, key: string, e: PointerEvent) => void} callbacks.onTagPointerDown
   * @param {(connectionId: string|null) => string|null} [callbacks.connectionName]
   */
  constructor(
    column,
    doc,
    { onContextMenu, onTagPointerDown, connectionName } = {},
  ) {
    this.#doc = doc;
    this.#onContextMenu = onContextMenu;
    this.#onTagPointerDown = onTagPointerDown;
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
    const conn = this.#connectionName(element.connection);
    const kindLabel = t(`integration.kind.${element.kind}`);
    const head = el(
      "button",
      {
        type: "button",
        class: "integration-card-head",
        title: [
          `${kindLabel} — ${conn ?? t("integration.card.noConnection")}`,
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
          text: element.kind === "output" ? "→" : "←",
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

    const waiting = tagKeys(element).filter((key) => !element.tags?.[key]);
    const chips = waiting.map((key) =>
      el("span", {
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
      }),
    );

    const card = el(
      "div",
      {
        class:
          "integration-card" +
          (element.connection ? "" : " integration-card--unassigned") +
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

  /** Tear the cards out (a scene rebuild). */
  remove() {
    this.#root.remove();
    this.#cards.clear();
  }

  get element() {
    return this.#root;
  }
}
