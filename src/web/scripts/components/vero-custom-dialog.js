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

// vero-custom-dialog.js — the parts tray's Veroboard ▸ Custom size… card: a
// width and a height in millimetres, checked against VERO_LIMITS, answered with
// the board's type key (`vero-<w>x<h>`) for the tray to arm placement with. A
// custom board is the same model as a preset (vero-presets.js), so nothing
// past this card knows it was typed.

import { el } from "../dom.js";
import { formatNumber, t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import {
  VERO_LIMITS,
  mmText,
  parseVeroKey,
  veroTypeKey,
} from "../model/vero-presets.js";

/** What the card offers first: the size typed last this session, else a
    Eurocard. */
let lastSize = { widthMm: 100, heightMm: 160 };

/**
 * The size two typed fields name, or null: each a number (a decimal comma is
 * read as a point) inside VERO_LIMITS, kept to one decimal as a key states it.
 */
export function customVeroKey(widthText, heightText) {
  const mm = (text) => {
    const n = Number(
      String(text ?? "")
        .trim()
        .replace(",", "."),
    );
    return Number.isFinite(n) ? Number(mmText(n)) : NaN;
  };
  const key = veroTypeKey(mm(widthText), mm(heightText));
  return parseVeroKey(key) ? key : null;
}

/**
 * Open the card. `onPlace(key)` fires with the board's type key once the
 * card has closed; a cancel fires nothing.
 * @param {{ onPlace: (key: string) => void }} opts
 */
export function openVeroCustomDialog({ onPlace }) {
  const field = (label, value) => {
    const input = el("input", {
      class: "popup-input vero-custom-input",
      type: "text",
      inputmode: "decimal",
      value: mmText(value),
    });
    return {
      input,
      row: el("label", { class: "vero-custom-field" }, [
        el("span", { class: "popup-label", text: label }),
        input,
      ]),
    };
  };
  const width = field(t("vero.custom.width"), lastSize.widthMm);
  const height = field(t("vero.custom.height"), lastSize.heightMm);
  width.input.dataset.autofocus = "true";
  const range = t("vero.custom.range", {
    min: formatNumber(VERO_LIMITS.minMm),
    max: formatNumber(VERO_LIMITS.maxMm),
  });
  // The limits are always stated; a refused size turns the line red rather
  // than adding a second one saying the same thing.
  const note = el("p", { class: "popup-note vero-custom-range", text: range });
  const refuse = (on) =>
    note.classList.toggle("vero-custom-range--refused", on);

  const submit = () => {
    const key = customVeroKey(width.input.value, height.input.value);
    if (!key) {
      refuse(true);
      return;
    }
    lastSize = parseVeroKey(key);
    PopupManager.close();
    onPlace?.(key);
  };
  for (const { input } of [width, height]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    input.addEventListener("input", () => refuse(false));
  }

  const element = el(
    "div",
    {
      class: "popup popup-prompt vero-custom",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": t("vero.custom.title"),
    },
    [
      el("div", { class: "popup-header" }, [
        el("span", { class: "popup-title", text: t("vero.custom.title") }),
      ]),
      el("div", { class: "popup-body" }, [
        el("p", { class: "popup-message", text: t("vero.custom.note") }),
        el("div", { class: "vero-custom-fields" }, [width.row, height.row]),
        note,
      ]),
      el("div", { class: "popup-footer" }, [
        el("button", {
          class: "btn popup-btn btn--secondary",
          type: "button",
          text: t("common.cancel"),
          onClick: () => PopupManager.close(),
        }),
        el("button", {
          class: "btn popup-btn btn--primary",
          type: "button",
          text: t("vero.custom.place"),
          onClick: submit,
        }),
      ]),
    ],
  );
  PopupManager.open({ element, onMaskClick: () => PopupManager.close() });
}
