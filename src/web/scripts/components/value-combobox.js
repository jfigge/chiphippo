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
//
// A box with no list at all (a transistor's Custom figures) drops the ▾: it
// is the same reading and committing, with nothing to pick.
//
// THE NEAREST-VALUE HINT (features/component-value-entry-spec.md §6): when
// the caller's `hint` names standard values near the one the part holds, an
// amber (i) stands to the right of the box — the app's own (i),
// info-button.js, which already dismisses itself on a click outside or on
// Escape (caught before the surrounding <dialog> closes). Its card offers
// each neighbour as a link; taking one is taking that entry from the list,
// and the (i) goes, since the value is now standard. The hint is re-asked
// after every commit, and stands down while the box is red — a value that
// does not read has to be fixed before it can be near anything.

import { el } from "../dom.js";
import { buildInfoButton } from "./info-button.js";

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
 * @param {() => (Array<{label: string, text: string, commit: any}>|null)}
 *   [opts.hint] - the standard values near the one the part holds now, or
 *   null when it is one (see the note at the top).
 * @param {string} [opts.hintLabel] - the (i)'s name and tooltip.
 * @param {string} [opts.hintTitle] - the line heading its card.
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
  hint = null,
  hintLabel = "",
  hintTitle = "",
}) {
  const id = `value-combobox-${++nextId}`;
  const bare = options.length === 0;
  const input = el("input", {
    type: "text",
    class: bare
      ? "properties-text-input properties-combo-input properties-combo-input--bare"
      : "properties-text-input properties-combo-input",
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
    hidden: bare,
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
  const field = el("span", { class: "properties-combo-field" }, [input, toggle]); // prettier-ignore
  const hinting = typeof hint === "function";
  const hintCard = hinting
    ? el("div", {
        class: "info-card properties-hint",
        id: `${id}-hint`,
        role: "group",
        "aria-label": hintTitle,
        hidden: true,
      })
    : null;
  const hintButton = hinting
    ? buildInfoButton({
        target: hintCard,
        label: hintLabel,
        onToggle: (shown) => shown && placeHint(),
      })
    : null;
  hintButton?.classList.add("info-btn--advisory", "properties-hint-btn");
  const root = el("span", { class: "properties-combo" }, [
    hinting
      ? el("span", { class: "properties-combo-line" }, [field, hintButton])
      : field,
    note,
    list,
    ...(hinting ? [hintCard] : []),
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

  /** The hint's card, under its (i) and kept on screen. */
  function placeHint() {
    const at = hintButton.getBoundingClientRect();
    const width = hintCard.offsetWidth || 0;
    const left = Math.max(8, Math.min(at.right - width, window.innerWidth - width - 8)); // prettier-ignore
    hintCard.style.left = `${left}px`;
    hintCard.style.top = `${at.bottom + 4}px`;
  }

  /** Shut the hint's card the way its (i) does, so its dismissal listeners
      go with it. */
  const shutHint = () => {
    if (hintCard && !hintCard.hidden) hintButton.click();
  };

  /** Re-ask the hint: the (i) and its links, or neither. */
  function refreshHint() {
    if (!hinting) return;
    const entries =
      input.getAttribute("aria-invalid") === "true" ? null : hint();
    const show = Array.isArray(entries) && entries.length > 0;
    if (!show) shutHint();
    hintButton.hidden = !show;
    if (!show) return;
    hintCard.replaceChildren(
      el("span", { class: "properties-hint-title", text: hintTitle }),
      el(
        "span",
        { class: "properties-hint-values" },
        entries.map((entry) =>
          el("button", {
            type: "button",
            class: "properties-hint-value",
            text: entry.label,
            onClick: () => {
              shutHint();
              take(entry);
            },
          }),
        ),
      ),
    );
  }

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
    refreshHint();
  }

  function commitTyped() {
    const typed = input.value;
    if (typed === committed && note.hidden) return;
    const result = read(typed);
    if (!result.ok) {
      say(result.message, true);
      refreshHint();
      return;
    }
    input.value = result.text;
    committed = result.text;
    // A warning stands under a value that was taken: said, but not invalid.
    say(result.warning ?? null, false);
    onCommit(result.commit);
    refreshHint();
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
  refreshHint();
  return root;
}
