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

// mock-panel.js — the SEND PANEL docked under the built-in Mock connection's
// window (docs/chiphippo-mock-connection.md §5–§6): the controls a sketch
// would have, for the device Chip Hippo plays itself.
//
//   · one row per Input on the Mock, in wire order, with its own Send, and
//     Send all (only with two or more). A caret by the name folds the row
//     down to that one line. Each FIELD is a line of its own — its name, a toggle per bit,
//     and for a byte or a word a hex field too (editing either updates the
//     other) — on one grid shared by every row, so names, bits, hex fields
//     and Send buttons line up down the panel;
//   · a line of log text and Log, shown only while the window shows log
//     lines (`setLogShown`, the Log filter);
//   · the one-shot FAULTS, collapsed on Send all's line: each arms the Mock
//     to spoil the next frame it applies to, and shows armed until it has.
//
// The window holds each Input's value the way a sketch holds its state:
// starting at 0, kept across runs while the layout stays the same, and sent
// WHOLE — there are no partial updates on the wire. Everything the panel does
// goes through main's Mock device (`bridge.serial.mock`), so the bytes take
// the same path a real board's do; the panel itself decides nothing about
// the protocol. It knows the layout only from the last run, since main hears
// of the design only when a run opens the Mock.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { fieldSpans, pinCount } from "../model/integration.js";

/** The faults, in the order the Mock's device defines them. */
const FAULTS = ["drop-ack", "corrupt", "ignore-hello", "wrong-signature"];

/** How long "Sent" stays up. A failure stays until the next send. */
const SENT_MS = 1000;

/** `0x65` for a byte, `0x0A5C` for a word. */
const hex = (v, type) =>
  `0x${v
    .toString(16)
    .toUpperCase()
    .padStart(type === "word" ? 4 : 2, "0")}`;

export class MockPanel {
  #bridge;
  #state = { open: false, connected: false, faults: [], layout: null };
  #values = new Map(); // Input index → its whole value
  #layoutKey = null;
  #status;
  #rows;
  #sendAll;
  #logRow;
  #logInput;
  #logButton;
  #faultButtons = new Map();
  #collapsed = new Set(); // the NAMES of the Inputs folded shut
  #resultTimers = new WeakMap(); // result element → its "Sent" timeout

  /**
   * @param {HTMLElement} host - the window's root; the panel is appended.
   * @param {{bridge: object, state?: object}} opts
   */
  constructor(host, { bridge, state } = {}) {
    this.#bridge = bridge;
    this.#status = el("p", { class: "mock-status", role: "status" });
    this.#rows = el("div", { class: "mock-inputs" });
    this.#sendAll = el("button", {
      class: "settings-action mock-send-all",
      type: "button",
      text: t("integration.mock.sendAll"),
      onClick: () => void this.#sendEvery(),
    });
    this.#logInput = el("input", {
      class: "settings-text-input mock-log-input",
      type: "text",
      spellcheck: false,
      placeholder: t("integration.mock.logPlaceholder"),
      "aria-label": t("integration.mock.logPlaceholder"),
      onKeydown: (e) => {
        if (e.key === "Enter") void this.#log();
      },
    });
    this.#logButton = el("button", {
      class: "settings-action",
      type: "button",
      text: t("integration.mock.log"),
      onClick: () => void this.#log(),
    });
    const faults = el("details", { class: "mock-faults" }, [
      el("summary", {}, [
        el("span", { class: "mock-caret", "aria-hidden": "true" }),
        el("span", { text: t("integration.mock.faults") }),
      ]),
      el("p", {
        class: "mock-hint",
        text: t("integration.mock.faultsHint"),
      }),
      el(
        "div",
        { class: "mock-fault-list" },
        FAULTS.map((fault) => {
          const button = el("button", {
            class: "settings-action mock-fault",
            type: "button",
            text: t(`integration.mock.fault.${fault}`),
            title: t(`integration.mock.faultTitle.${fault}`),
            "aria-pressed": "false",
            dataset: { fault },
            onClick: () => void this.#toggleFault(fault),
          });
          this.#faultButtons.set(fault, button);
          return button;
        }),
      ),
    ]);
    this.#logRow = el("div", { class: "mock-log-row" }, [
      this.#logInput,
      this.#logButton,
    ]);
    this.root = el("section", { class: "mock-panel" }, [
      this.#status,
      this.#rows,
      // Faults and Send all share a line; Send all comes second so it sits
      // over the disclosure's full-width summary rather than under it.
      el("div", { class: "mock-actions" }, [faults, this.#sendAll]),
      this.#logRow,
    ]);
    host.append(this.root);
    this.setState(state ?? this.#state);
  }

  /** Main's word on the Mock: open, connected, armed faults, layout. */
  setState(state) {
    this.#state = {
      open: state?.open === true,
      connected: state?.connected === true,
      faults: Array.isArray(state?.faults) ? state.faults : [],
      layout: state?.layout ?? null,
    };
    const key = JSON.stringify(this.#state.layout?.inputs ?? null);
    if (key !== this.#layoutKey) {
      // A different set of Inputs: values belong to the old ones.
      this.#layoutKey = key;
      this.#values.clear();
      this.#renderRows();
    }
    this.#refresh();
  }

  /** The log field is offered only while the window shows log lines. */
  setLogShown(shown) {
    this.#logRow.hidden = !shown;
  }

  /** The value an Input's row holds (tests). */
  value(index) {
    return this.#values.get(index) ?? 0;
  }

  get #inputs() {
    return this.#state.layout?.inputs ?? [];
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  #refresh() {
    const { open, connected, faults } = this.#state;
    this.#status.textContent = t(
      connected
        ? "integration.mock.status.connected"
        : open
          ? "integration.mock.status.waiting"
          : "integration.mock.status.idle",
    );
    this.#status.className = `mock-status mock-status--${connected ? "connected" : open ? "waiting" : "idle"}`;
    for (const button of this.#rows.querySelectorAll(".mock-send")) {
      button.disabled = !connected;
    }
    this.#sendAll.disabled = !connected || this.#inputs.length === 0;
    // With one Input it would be a second Send for the same row.
    this.#sendAll.hidden = this.#inputs.length < 2;
    this.#logInput.disabled = !open;
    this.#logButton.disabled = !open;
    for (const [fault, button] of this.#faultButtons) {
      const armed = faults.includes(fault);
      button.setAttribute("aria-pressed", armed ? "true" : "false");
      button.classList.toggle("mock-fault--armed", armed);
    }
  }

  #renderRows() {
    const layout = this.#state.layout;
    if (!layout) {
      this.#rows.replaceChildren(
        el("p", { class: "mock-hint", text: t("integration.mock.noLayout") }),
      );
      return;
    }
    if (this.#inputs.length === 0) {
      this.#rows.replaceChildren(
        el("p", { class: "mock-hint", text: t("integration.mock.noInputs") }),
      );
      return;
    }
    this.#rows.replaceChildren(
      ...this.#inputs.map((input, index) => this.#row(input, index)),
    );
  }

  #row(input, index) {
    const result = el("span", { class: "mock-result", role: "status" });
    const fields = el(
      "span",
      { class: "mock-fields" },
      fieldSpans(input.fields).map((span) => this.#field(index, span)),
    );
    // Folding hides the fields and nothing else: Send still sends the value
    // they hold. Kept by NAME, so a run that brings the same Inputs back
    // finds them as they were left.
    const toggle = el(
      "button",
      {
        class: "mock-input-toggle",
        type: "button",
        title: input.name,
        onClick: () => {
          if (this.#collapsed.has(input.name)) {
            this.#collapsed.delete(input.name);
          } else {
            this.#collapsed.add(input.name);
          }
          fold();
        },
      },
      [
        el("span", { class: "mock-caret", "aria-hidden": "true" }),
        el("span", { class: "mock-input-name", text: input.name }),
      ],
    );
    const fold = () => {
      const shut = this.#collapsed.has(input.name);
      fields.hidden = shut;
      toggle.setAttribute("aria-expanded", shut ? "false" : "true");
    };
    fold();
    const row = el("div", { class: "mock-input", dataset: { index } }, [
      toggle,
      fields,
      // The result goes BEFORE Send, so every Send keeps the panel's right
      // edge with Send all and Log whether or not it has anything to say.
      result,
      el("button", {
        class: "settings-action mock-send",
        type: "button",
        text: t("integration.mock.send"),
        disabled: !this.#state.connected,
        onClick: () => void this.#send(index, result),
      }),
    ]);
    return row;
  }

  /** One field's controls, redrawn in place when its value changes. */
  #field(index, span) {
    const box = el("span", { class: `mock-field mock-field--${span.type}` });
    const shift = span.first - 1;
    const bits = span.last - span.first + 1;
    const mask = (1 << bits) - 1;
    const read = () => (this.value(index) >>> shift) & mask;
    const write = (v) => {
      const whole = this.value(index) & ~(mask << shift);
      this.#values.set(index, (whole | ((v & mask) << shift)) >>> 0);
      draw();
    };
    const draw = () => {
      const v = read();
      const toggle = (b, nibble) => {
        const on = (v >> b) & 1;
        const label =
          span.type === "bit"
            ? span.name
            : t("integration.mock.bit", { name: span.name, bit: b });
        return el("button", {
          class: `mock-bit${nibble ? " mock-bit--nibble" : ""}`,
          type: "button",
          text: on ? "1" : "0",
          title: label,
          "aria-label": label,
          "aria-pressed": on ? "true" : "false",
          onClick: () => write(v ^ (1 << b)),
        });
      };
      const name = el("span", {
        class: "mock-field-name",
        text: span.name,
        title: span.name,
      });
      if (span.type === "bit") {
        box.replaceChildren(
          name,
          el("span", { class: "mock-bits" }, [toggle(0, false)]),
        );
        return;
      }
      // MSB first, one group per byte: a word stacks its high byte over its
      // low one.
      const bytes = [];
      for (let top = bits - 1; top >= 0; top -= 8) {
        const toggles = [];
        for (let b = top; b > top - 8; b--) {
          toggles.push(toggle(b, b % 4 === 3 && b !== top));
        }
        bytes.push(el("span", { class: "mock-byte" }, toggles));
      }
      const field = el("input", {
        class: "settings-text-input mock-hex",
        type: "text",
        spellcheck: false,
        value: hex(v, span.type),
        "aria-label": span.name,
        onChange: (e) => {
          const text = e.target.value.trim().replace(/^0x/i, "");
          const n = /^[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : NaN;
          if (Number.isFinite(n)) write(n);
          else draw(); // not a number: put the old one back
        },
      });
      box.replaceChildren(
        name,
        el("span", { class: "mock-bits" }, bytes),
        field,
      );
    };
    draw();
    return box;
  }

  // ── Doing ────────────────────────────────────────────────────────────────

  async #send(index, result) {
    const input = this.#inputs[index];
    if (!input) return false;
    const width = pinCount(input.fields);
    const value = this.value(index) & ((1 << width) - 1);
    clearTimeout(this.#resultTimers.get(result));
    result.textContent = "";
    result.title = "";
    let r;
    try {
      r = await this.#bridge?.serial?.mock?.send?.(index, width, value);
    } catch (err) {
      r = { ok: false, code: "closed" };
      console.error("[mock] send failed:", err);
    }
    const code = r?.ok ? "sent" : `failed.${r?.code ?? "closed"}`;
    result.textContent = t(`integration.mock.${code}`);
    result.title = result.textContent;
    result.className = `mock-result${r?.ok ? "" : " mock-result--failed"}`;
    if (r?.ok) {
      this.#resultTimers.set(
        result,
        setTimeout(() => {
          result.textContent = "";
          result.title = "";
        }, SENT_MS),
      );
    }
    return r?.ok === true;
  }

  async #sendEvery() {
    const rows = [...this.#rows.querySelectorAll(".mock-input")];
    for (const row of rows) {
      await this.#send(
        Number(row.dataset.index),
        row.querySelector(".mock-result"),
      );
    }
  }

  async #log() {
    const text = this.#logInput.value;
    if (!text || !this.#state.open) return;
    try {
      const sent = await this.#bridge?.serial?.mock?.log?.(`${text}\n`);
      if (sent) this.#logInput.value = "";
    } catch (err) {
      console.error("[mock] log failed:", err);
    }
  }

  async #toggleFault(fault) {
    const armed = this.#state.faults.includes(fault);
    try {
      await this.#bridge?.serial?.mock?.fault?.(fault, !armed);
    } catch (err) {
      console.error("[mock] fault failed:", err);
    }
  }
}
