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

// value-combobox.js — the ONE editable combo box a component's value is
// picked or typed in (a resistor's Resistance, a capacitor's Capacitance, an
// inductor's Inductance, a Zener's voltage, a transistor's part number): a
// text box that also drops a list of the common choices. It knows nothing
// about values — the caller hands it the options and a `read` that turns text
// into a commit or a message (part-properties-dialog.js's `"combo"` field,
// over catalog/value-fields.js) — so every one of them behaves alike.
//
// The rules, all of them load-bearing:
//   · what is typed is READ on Enter and on leaving the box (the `change`
//     event), never on each keystroke — "4." is half a value, not a mistake;
//   · a read that fails keeps the text, says why under it in the field-error
//     red, and commits nothing: the part keeps its last good value;
//   · a read that succeeds replaces the text with its tidy form and commits;
//   · typing FILTERS the list to the entries that contain what was typed
//     (`4` → 4.7k, 47k …; `u` and `µ` alike); the ▾ button, or ↓, shows all of
//     it with the current one marked;
//   · ↑/↓ move through the list, Enter takes the marked entry, Escape shuts
//     the list — and only the list: a native <dialog> closes on Escape, so the
//     key is stopped here while there is a list to shut.
// The list is `position: fixed` against the box, so a card that scrolls its
// body never clips it, and it shuts on any scroll or resize outside itself.

import { el } from "../dom.js";

let nextId = 0;

/** Text as the filter compares it: spaces gone, case and micro folded. */
const fold = (text) =>
  String(text ?? "")
    .replace(/\s+/gu, "")
    .replace(/[µμ]/gu, "u")
    .toLowerCase();

/** The ▾ — the app's line-icon chevron (palette-panel.js draws its own the
    same way), turned down. */
const CHEVRON_DOWN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="6 9 12 15 18 9"/></svg>';

/**
 * Build a value combo box.
 *
 * @param {object} opts
 * @param {string} opts.text - the box's starting text.
 * @param {string|null} [opts.message] - a message to show under it from the
 *   start: why a stored value does not read, or is out of range — or a
 *   warning about a value that stands (a part number of another type).
 * @param {boolean} [opts.invalid] - whether that message is a refusal, which
 *   marks the box invalid; a warning does not.
 * @param {Array<{label: string, text: string, search?: string, commit: any}>}
 *   opts.options - the list: what each entry reads, what the box shows once it
 *   is taken, extra text the filter matches, and what taking it commits.
 * @param {(text: string) => ({ok: true, text: string, commit: any,
 *   warning?: string} | {ok: false, message: string})} opts.read
 * @param {(commit: any) => void} opts.onCommit
 * @param {string} opts.ariaLabel - the field's name.
 * @param {string} opts.toggleLabel - the ▾ button's name.
 * @returns {HTMLElement}
 */
export function buildValueCombobox({
  text,
  message = null,
  invalid = false,
  options,
  read,
  onCommit,
  ariaLabel,
  toggleLabel,
}) {
  const id = `value-combobox-${++nextId}`;
  const input = el("input", {
    type: "text",
    class: "properties-text-input properties-combo-input",
    value: text,
    spellcheck: false,
    autocomplete: "off",
    role: "combobox",
    "aria-label": ariaLabel,
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": `${id}-list`,
  });
  const toggle = el("button", {
    type: "button",
    class: "properties-combo-toggle",
    tabindex: -1,
    "aria-label": toggleLabel,
    title: toggleLabel,
  });
  toggle.innerHTML = CHEVRON_DOWN;
  const list = el("ul", {
    class: "properties-combo-list",
    id: `${id}-list`,
    role: "listbox",
    "aria-label": ariaLabel,
    hidden: true,
  });
  const note = el("span", {
    class: "properties-field-error",
    role: "alert",
    hidden: true,
  });
  const root = el("span", { class: "properties-combo" }, [
    el("span", { class: "properties-combo-field" }, [input, toggle]),
    note,
    list,
  ]);

  let committed = text; // the text of the value the part holds
  let shown = []; // the entries the open list holds
  let active = -1; // the marked entry, an index into `shown`

  const say = (text, invalid) => {
    note.textContent = text ?? "";
    note.hidden = !text;
    if (invalid) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };
  say(message, Boolean(message) && invalid);

  const isOpen = () => !list.hidden;

  const mark = (index) => {
    active = index;
    shown.forEach((entry, i) => {
      const on = i === index;
      entry.node.classList.toggle("properties-combo-option--active", on);
      entry.node.setAttribute("aria-selected", String(on));
    });
    if (index >= 0) {
      input.setAttribute("aria-activedescendant", shown[index].node.id);
      shown[index].node.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const place = () => {
    const box = input.parentElement.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - 8;
    const above = box.top - 8;
    const up = below < 140 && above > below;
    list.style.left = `${box.left}px`;
    list.style.width = `${box.width}px`;
    list.style.maxHeight = `${Math.max(80, Math.min(240, up ? above : below))}px`;
    list.style.top = up ? "" : `${box.bottom + 2}px`;
    list.style.bottom = up ? `${window.innerHeight - box.top + 2}px` : "";
  };

  const onOutside = (e) => {
    if (!root.isConnected) return close();
    if (e.type === "scroll" && list.contains(e.target)) return;
    close();
  };

  function close() {
    if (!isOpen()) return;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    mark(-1);
    window.removeEventListener("scroll", onOutside, true);
    window.removeEventListener("resize", onOutside);
  }

  /** Open the list: every entry, or those matching `query`. Shuts it when
      nothing matches — an empty list is not an answer. */
  function open(query = null) {
    const q = query == null ? "" : fold(query);
    const entries = options.filter(
      (o) => !q || fold(`${o.label} ${o.search ?? ""}`).includes(q),
    );
    if (!entries.length) return close();
    shown = entries.map((option, i) => {
      const node = el("li", {
        class: "properties-combo-option",
        id: `${id}-option-${i}`,
        role: "option",
        "aria-selected": "false",
        text: option.label,
        // Keep the focus in the box: the press would otherwise blur it, and
        // the blur would read the half-typed text before the entry is taken.
        onMousedown: (e) => e.preventDefault(),
        onClick: () => take(option),
      });
      return { option, node };
    });
    list.replaceChildren(...shown.map((s) => s.node));
    if (!isOpen()) {
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      window.addEventListener("scroll", onOutside, true);
      window.addEventListener("resize", onOutside);
    }
    place();
    const current = shown.findIndex((s) => s.option.text === input.value);
    mark(query == null ? current : -1);
  }

  function take(option) {
    close();
    input.value = option.text;
    committed = option.text;
    say(null, false);
    onCommit(option.commit);
  }

  function commitTyped() {
    const typed = input.value;
    if (typed === committed && note.hidden) return;
    const result = read(typed);
    if (!result.ok) {
      say(result.message, true);
      return;
    }
    input.value = result.text;
    committed = result.text;
    // A warning stands under a value that was taken: said, but not invalid.
    say(result.warning ?? null, false);
    onCommit(result.commit);
  }

  input.addEventListener("input", () => open(input.value));
  input.addEventListener("change", commitTyped);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) {
        open(input.value === committed ? null : input.value);
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next =
        active < 0 ? (step > 0 ? 0 : shown.length - 1) : active + step;
      mark(Math.max(0, Math.min(shown.length - 1, next)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isOpen() && active >= 0) take(shown[active].option);
      else {
        close();
        commitTyped();
      }
    } else if (e.key === "Escape" && isOpen()) {
      // Shut the list, not the dialog around it.
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close();
    }
  });
  input.addEventListener("blur", () => close());
  toggle.addEventListener("mousedown", (e) => e.preventDefault());
  toggle.addEventListener("click", () => {
    if (isOpen()) close();
    else {
      input.focus();
      open();
    }
  });
  return root;
}
