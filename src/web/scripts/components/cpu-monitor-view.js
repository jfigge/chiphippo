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

// cpu-monitor-view.js — the CPU monitor window's one view: a thin
// renderer of the summary the host sends (sim/cpu-monitor.js `cpuSummary`,
// relayed by components/cpu-monitor-bridge.js). It works nothing out; it lays
// the picture out the way the bench monitor it is modelled on did:
//
//   memory around PC          │ flags · inputs · step · clock
//                             │ instructions (5 before, the one in flight,
//                             │   5 after)        │ registers, one a line
//
// There is no bus-cycle breakdown and no buses panel: the cores emulate an
// instruction's RESULT, not the silicon's insides, so a cycle-by-cycle
// picture would be the emulator's bookkeeping dressed up as the chip's.
//
// Above it, the chip designer's debugger chrome: a TAB per CPU on the
// desktop (the shown one carrying the run's Running/Paused badge), then a bar
// in the toolbar's pill shape — Continue · Step — with a one-line status.
//
// Everything it draws is built from the message, so a redraw is the whole
// body at once (a few hundred nodes, ten times a second at most). The tabs
// and the bar are built once and touched only where they change, so a click
// being made is not torn down under the pointer.
//
// What is interactive:
//   · CONTINUE and STEP (the buttons, or F8 and F6 — the chip debugger's
//     keys) while the run is PAUSED, at a breakpoint or by Pause. Continue
//     resumes the run, to the next breakpoint; Step runs the board on, edge
//     by edge, to where this CPU's next operation begins and pauses there
//     again (SimController `stepCpu`). A key is a PRESS of its button, so it
//     does nothing when the button is greyed out. The keys are this window's
//     own: they reach it only while it has the focus.
//   · EDITING a byte while the circuit runs or is paused — click it, type two
//     hex digits (type-through moves on to the next byte, as the memory
//     inspector's grid does; Enter writes a lone digit, Escape drops it,
//     arrows move). The digits are kept by the VIEW, never in an <input>: the
//     body is rebuilt on every message, and an input rebuilt under the caret
//     loses keystrokes. A written byte shows at once and stays shown until a
//     board carries it. The host writes it into the run image (`poke`).
//   · BREAKPOINTS — F9 on the selected byte, its right-click menu, or a click
//     in an instruction line's margin (the chip designer's gutter). A byte
//     with one is red, and so is the margin dot of a line at its address.

import { t, formatNumber } from "../i18n.js";
import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";

/** How long a byte just written is shown before a board must carry it, ms. */
const OPTIMISTIC_MS = 1500;

const hex = (v, digits) =>
  v == null ? "-".repeat(digits) : v.toString(16).toUpperCase().padStart(digits, "0"); // prettier-ignore

/** The status line's words for a core's status. */
const STATUS_KEYS = new Set(["running", "reset", "irq", "nmi", "int", "wai", "stp", "halt", "busack"]); // prettier-ignore

/** The steps shown as boxes (more, if an operation runs longer). */
const STEP_BOXES = 8;

/** Each function key → the bar button it presses (the chip debugger's
    `DEBUG_KEYS`, for the two this window has). */
export const MONITOR_KEYS = Object.freeze({ F8: "continue", F6: "step" });

export class CpuMonitorView {
  #root;
  #send;
  #tabs;
  #tabsKey = null; // what the tabs were last drawn from
  #buttons;
  #statusLine;
  #count;
  #body;
  #keep;
  #keepLabel;
  #state = null; // the last message drawn
  #sel = null; // the selected address (absolute, as the CPU sees it)
  #digit = ""; // the first hex digit typed over it, pending
  #written = new Map(); // address → {value, at}: written, not yet on a board
  #now;

  /**
   * @param {HTMLElement} root
   * @param {{send: (msg: object) => void}} opts - to the host
   */
  constructor(root, { send, now = () => Date.now() }) {
    this.#root = root;
    this.#send = send;
    this.#now = now;
    root.classList.add("cpumon-root");
    this.#tabs = el("div", {
      class: "cpumon-tabs",
      role: "tablist",
      "aria-label": t("cpumonitor.cpu"),
    });
    this.#count = el("span", { class: "cpumon-count" });
    // In the header, which is built once: the body is rebuilt on every
    // message, and a box rebuilt between press and release loses the click.
    this.#keep = el("input", {
      type: "checkbox",
      class: "cpumon-keep-box",
      onChange: () => this.#send?.({ kind: "keep-edits", on: this.#keep.checked }), // prettier-ignore
    });
    // Hidden until a ROM has been edited this run (`romEdited`).
    this.#keepLabel = el(
      "label",
      {
        class: "cpumon-keep",
        title: t("cpumonitor.keepEditsHint"),
        hidden: true,
      },
      [this.#keep, el("span", { text: t("cpumonitor.keepEdits") })],
    );
    const button = (kind, label, title) =>
      el("button", {
        class: "toolbar-pill-btn cpumon-bar-btn",
        type: "button",
        text: t(label),
        title: t(title),
        disabled: true,
        dataset: { action: kind },
        onClick: () => this.#send?.({ kind, compId: this.#state?.compId }),
      });
    this.#buttons = {
      continue: button("continue", "cpumonitor.continue", "cpumonitor.continueTitle"), // prettier-ignore
      step: button("step", "cpumonitor.stepOp", "cpumonitor.stepOpTitle"),
    };
    this.#statusLine = el("span", {
      class: "cpumon-bar-status",
      role: "status",
    });
    this.#body = el("div", { class: "cpumon-body" });
    root.replaceChildren(
      this.#tabs,
      el("div", { class: "cpumon-bar" }, [
        el("div", { class: "toolbar-pill" }, Object.values(this.#buttons)),
        this.#statusLine,
        this.#keepLabel,
        this.#count,
      ]),
      this.#body,
    );
    this.#body.addEventListener("mousedown", (e) => this.#onPress(e));
    this.#body.addEventListener("contextmenu", (e) => this.#onContextMenu(e));
    (root.ownerDocument?.defaultView ?? window).addEventListener("keydown", (e) => this.#onKey(e)); // prettier-ignore
    this.render({ cpus: [], compId: null, running: false, mode: "stopped", summary: null }); // prettier-ignore
  }

  /** A message from the host. */
  receive(msg) {
    if (msg?.kind === "state") this.render(msg);
  }

  /**
   * Draw a `state` message.
   * @param {{cpus: Array<{id: string, label: string}>, compId: string|null,
   *   running: boolean, mode: string, summary: object|null}} state
   */
  render(state) {
    if (state.compId !== this.#state?.compId) this.#select(null);
    this.#state = state;
    const s = state.summary;
    const mode = state.running ? state.mode : "stopped";
    this.#renderTabs(state.cpus ?? [], state.compId, mode);
    this.#keep.checked = state.keepEdits === true;
    // Offered only once a ROM has been edited this run: until then there is
    // nothing for it to keep.
    this.#keepLabel.hidden = state.romEdited !== true;
    this.#buttons.continue.disabled = mode !== "paused";
    this.#buttons.step.disabled = mode !== "paused" || !state.compId || !s;
    this.#statusLine.textContent = this.#statusText(mode, s);
    this.#root.classList.toggle("cpumon-root--stale", !state.running && s != null); // prettier-ignore
    this.#count.replaceChildren(
      ...(s
        ? [
            el("span", { class: "cpumon-label", text: t(`cpumonitor.count.${s.countUnit === "tstates" ? "tstates" : "cycles"}`) }), // prettier-ignore
            el("span", { class: "cpumon-count-value", text: formatNumber(s.cycles) }), // prettier-ignore
          ]
        : []),
    );

    if (!state.cpus?.length) return this.#empty(t("cpumonitor.noCpu"));
    if (!s) {
      return this.#empty(t(state.running ? "cpumonitor.waiting" : "cpumonitor.notRunning")); // prettier-ignore
    }
    this.#body.replaceChildren(
      this.#memory(s),
      this.#status(s),
      this.#pipeline(s),
      this.#registers(s),
    );
  }

  #empty(message) {
    this.#body.replaceChildren(el("p", { class: "cpumon-empty", text: message })); // prettier-ignore
  }

  /** A tab per CPU, the one shown carrying the run's mode — redrawn only
      when one of those changes. */
  #renderTabs(cpus, compId, mode) {
    const key = JSON.stringify([cpus, compId, mode]);
    if (key === this.#tabsKey) return;
    this.#tabsKey = key;
    this.#tabs.replaceChildren(
      ...cpus.map((c) => {
        const active = c.id === compId;
        const badge = active && mode !== "stopped" ? mode : null;
        return el(
          "div",
          { class: `cpumon-tab${active ? " cpumon-tab--active" : ""}` },
          [
            // prettier-ignore
            el(
            "button",
            {
              class: "cpumon-tab-label",
              type: "button",
              role: "tab",
              "aria-selected": String(active),
              dataset: { compId: c.id },
              onClick: () => {
                if (!active) this.#send?.({ kind: "select", compId: c.id });
              },
            },
            [
              el("span", { text: c.label }),
              badge ? el("span", { class: `cpumon-tab-badge cpumon-tab-badge--${badge}`, text: t(`cpumonitor.mode.${badge}`) }) : null, // prettier-ignore
            ],
          ),
          ],
        );
      }),
    );
  }

  /** The bar's one line: where a paused CPU is, or what the run is doing. */
  #statusText(mode, s) {
    if (mode === "running") return t("cpumonitor.statusRunning");
    if (mode !== "paused" || !s) return "";
    const cur = s.pipeline?.current;
    if (!cur) return "";
    if (cur.kind !== "instr") return t(`cpumonitor.event.${cur.kind}`);
    const addr = `$${hex(cur.addr, 4)}`;
    const atBreak = s.view?.step?.index === 1 && this.#breaks().has(cur.addr);
    return t(atBreak ? "cpumonitor.statusBreak" : "cpumonitor.statusAt", { addr, text: cur.text }); // prettier-ignore
  }

  // ── The panels ─────────────────────────────────────────────────────────────

  #section(cls, title, children) {
    return el("section", { class: `cpumon-panel ${cls}` }, [
      el("h2", { class: "cpumon-title", text: title }),
      ...children,
    ]);
  }

  /** Sixteen rows of sixteen bytes around PC. */
  #memory(s) {
    const { base, bytes } = s.memory;
    const breaks = this.#breaks();
    const current = s.op === "instr" ? s.pipeline.current : null;
    const inOp = (a) =>
      current != null && a >= current.addr && a < current.addr + current.length; // prettier-ignore
    const access = s.view.access;
    const head = el("div", { class: "cpumon-mem-row cpumon-mem-head" }, [
      el("span", { class: "cpumon-mem-addr" }),
      ...Array.from(
        { length: 16 },
        (_, i) =>
        el("span", { class: `cpumon-byte${i === 8 ? " cpumon-byte--gap" : ""}`, text: hex(i, 1) }), // prettier-ignore
      ),
    ]);
    const rows = [];
    for (let r = 0; r < 16; r++) {
      const at = base + r * 16;
      const cells = [];
      for (let i = 0; i < 16; i++) {
        const a = at + i;
        const v = this.#shown(a, bytes[r * 16 + i]);
        let cls = "cpumon-byte";
        if (i === 8) cls += " cpumon-byte--gap";
        if (v == null) cls += " cpumon-byte--unknown";
        if (a === s.pc && current) cls += " cpumon-byte--pc";
        else if (inOp(a)) cls += " cpumon-byte--op";
        if (access && access.addr === a) cls += access.write ? " cpumon-byte--write" : " cpumon-byte--access"; // prettier-ignore
        if (breaks.has(a)) cls += " cpumon-byte--break";
        if (a === this.#sel) cls += " cpumon-byte--selected";
        const text = a === this.#sel && this.#digit ? `${this.#digit}_` : v == null ? "--" : hex(v, 2); // prettier-ignore
        cells.push(el("span", { class: cls, text, dataset: { addr: String(a) } })); // prettier-ignore
      }
      rows.push(
        el("div", { class: "cpumon-mem-row" }, [
          el("span", { class: "cpumon-mem-addr", text: hex(at, 4) }),
          ...cells,
        ]),
      );
    }
    return this.#section("cpumon-memory", t("cpumonitor.memory"), [
      el("div", { class: "cpumon-mem" }, [head, ...rows]),
      el("p", { class: "cpumon-hint", text: t(this.#state?.running ? "cpumonitor.memoryHint" : "cpumonitor.memoryHintStopped") }), // prettier-ignore
    ]);
  }

  /** Flags, inputs, step, clock and what the CPU is doing. */
  #status(s) {
    const v = s.view;
    const flags = el(
      "div",
      { class: "cpumon-flags" },
      v.flags.names.map((name, i) => {
        const on = ((v.flags.value >> (7 - i)) & 1) === 1;
        return el("span", { class: `cpumon-flag${on ? " cpumon-flag--on" : ""}`, text: name }); // prettier-ignore
      }),
    );
    const boxes = Math.max(STEP_BOXES, v.step.index);
    const step = el("div", { class: "cpumon-steps" }, [
      ...Array.from(
        { length: boxes },
        (_, i) =>
        el("span", { class: `cpumon-step${i + 1 === v.step.index ? " cpumon-step--on" : ""}`, text: String(i + 1) }), // prettier-ignore
      ),
      v.step.label ? el("span", { class: "cpumon-step-label", text: v.step.label }) : null, // prettier-ignore
    ]);
    const clock = el(
      "span",
      { class: `cpumon-pin cpumon-level--${v.clock.level}` },
      [
        // prettier-ignore
        el("span", { class: "cpumon-pin-name", text: v.clock.name }),
        el("span", { class: "cpumon-pin-value", text: v.clock.label }),
      ],
    );
    const inputs = el(
      "div",
      { class: "cpumon-pins" },
      v.inputs.map((p) => this.#pin(p)),
    );
    const status = STATUS_KEYS.has(v.status) ? v.status : "running";
    return this.#section("cpumon-status", t("cpumonitor.state"), [
      el("div", { class: "cpumon-grid" }, [
        el("span", { class: "cpumon-label", text: t("cpumonitor.flags") }),
        flags,
        el("span", { class: "cpumon-label", text: t("cpumonitor.step") }),
        step,
        el("span", { class: "cpumon-label", text: t("cpumonitor.clock") }),
        clock,
        el("span", { class: "cpumon-label", text: t("cpumonitor.inputs") }),
        inputs,
        el("span", { class: "cpumon-label", text: t("cpumonitor.doing") }),
        el("span", { class: `cpumon-doing cpumon-doing--${status}`, text: t(`cpumonitor.status.${status}`) }), // prettier-ignore
      ]),
    ]);
  }

  #pin(p) {
    return el(
      "span",
      {
        class: `cpumon-pin cpumon-level--${p.level}${p.active ? " cpumon-pin--active" : ""}`, // prettier-ignore
        title: t(p.active ? "cpumonitor.asserted" : "cpumonitor.released"),
      },
      [el("span", { class: "cpumon-pin-name", text: p.name })],
    );
  }

  /** The 11-line pipeline: recorded, in flight, decoded ahead. */
  #pipeline(s) {
    const { previous, current, ahead } = s.pipeline;
    const pad = Array.from({ length: Math.max(0, 5 - previous.length) }, () =>
      el("div", { class: "cpumon-line cpumon-line--blank" }, " "),
    );
    const line = (l, where) => {
      if (l.kind !== "instr") {
        return el(
          "div",
          { class: `cpumon-line cpumon-line--${where} cpumon-line--event` },
          [
            // prettier-ignore
            el("span", { class: "cpumon-line-mark", text: where === "current" ? ">" : "" }), // prettier-ignore
            el("span", { class: "cpumon-line-addr" }),
            el("span", { class: "cpumon-line-text", text: t(`cpumonitor.event.${l.kind}`) }), // prettier-ignore
          ],
        );
      }
      return el(
        "div",
        {
          class: `cpumon-line cpumon-line--${where}${l.illegal ? " cpumon-line--illegal" : ""}`,
        },
        [
          // prettier-ignore
          this.#lineMark(l.addr, where),
          el("span", {
            class: "cpumon-line-addr",
            text: `$${hex(l.addr, 4)}:`,
          }),
          el("span", { class: "cpumon-line-bytes", text: l.bytes.map((b) => hex(b, 2)).join(" ") }), // prettier-ignore
          el("span", { class: "cpumon-line-text", text: l.text }),
          el("span", { class: "cpumon-line-mode", text: l.mode }),
        ],
      );
    };
    return this.#section("cpumon-pipeline", t("cpumonitor.instructions"), [
      el("div", { class: "cpumon-lines" }, [
        ...pad,
        ...previous.map((l) => line(l, "previous")),
        line(current, "current"),
        ...ahead.map((l) => line(l, "ahead")),
      ]),
    ]);
  }

  /** An instruction line's margin: `>` for the one in flight, a red dot for
      a breakpoint at its address; a click there sets or clears one. */
  #lineMark(addr, where) {
    const on = this.#breaks().has(addr);
    return el("span", {
      class: `cpumon-line-mark cpumon-line-mark--gutter${on ? " cpumon-line-mark--break" : ""}`, // prettier-ignore
      text: on ? "●" : where === "current" ? ">" : "",
      title: t(on ? "cpumonitor.breakpointRemove" : "cpumonitor.breakpointAdd"),
      dataset: { breakAddr: String(addr) },
    });
  }

  /** The registers, one a line. */
  #registers(s) {
    const regs = el(
      "div",
      { class: "cpumon-regs" },
      s.view.registers.map((r) =>
        el("span", { class: "cpumon-reg" }, [
          el("span", { class: "cpumon-reg-name", text: r.name }),
          el("span", { class: "cpumon-reg-value", text: r.digits === 1 ? String(r.value) : hex(r.value, r.digits) }), // prettier-ignore
        ]),
      ),
    );
    return this.#section("cpumon-registers", t("cpumonitor.registers"), [regs]); // prettier-ignore
  }

  // ── Editing and breakpoints ────────────────────────────────────────────────

  /** The breakpoints of the CPU shown. */
  #breaks() {
    return new Set(this.#state?.breakpoints ?? []);
  }

  /** A byte as shown: one just written wins until a board carries it. */
  #shown(addr, value) {
    const w = this.#written.get(addr);
    if (!w) return value;
    if (value === w.value || this.#now() - w.at > OPTIMISTIC_MS) {
      this.#written.delete(addr);
      return value;
    }
    return w.value;
  }

  /** May the selected byte be typed over? While the run is live, and where
      the CPU reads memory a chip answers. */
  #editable() {
    const st = this.#state;
    if (!st?.running || !st.summary || this.#sel == null) return false;
    const { base, bytes } = st.summary.memory;
    const i = this.#sel - base;
    return i < 0 || i >= bytes.length || bytes[i] != null;
  }

  #select(addr) {
    this.#sel = addr == null ? null : addr & 0xffff;
    this.#digit = "";
  }

  #redraw() {
    if (this.#state) this.render(this.#state);
  }

  #onPress(e) {
    if (e.button !== 0) return;
    const mark = e.target.closest?.("[data-break-addr]");
    if (mark) {
      e.preventDefault();
      this.#toggleBreakpoint(Number(mark.dataset.breakAddr));
      return;
    }
    const cell = e.target.closest?.("[data-addr]");
    if (!cell) return;
    e.preventDefault();
    this.#select(Number(cell.dataset.addr));
    this.#redraw();
  }

  #onContextMenu(e) {
    const cell = e.target.closest?.("[data-addr]");
    if (!cell) return;
    e.preventDefault();
    const addr = Number(cell.dataset.addr);
    this.#select(addr);
    this.#redraw();
    const breaks = this.#breaks();
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: t("cpumonitor.breakpoint"),
          checked: breaks.has(addr),
          onSelect: () => this.#toggleBreakpoint(addr),
        },
        {
          label: t("cpumonitor.clearBreakpoints"),
          disabled: breaks.size === 0,
          onSelect: () => {
            for (const a of breaks) this.#setBreakpoint(a, false);
          },
        },
      ],
    });
  }

  #onKey(e) {
    if (PopupManager.isOpen()) return;
    const press = MONITOR_KEYS[e.key];
    if (press && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
      e.preventDefault();
      const btn = this.#buttons[press];
      if (!btn.disabled) btn.click();
      return;
    }
    if (this.#sel == null) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const handled = () => {
      e.preventDefault();
      this.#redraw();
    };
    if (e.key === "F9") {
      this.#toggleBreakpoint(this.#sel);
      return handled();
    }
    if (e.key === "Escape") {
      if (this.#digit) this.#digit = "";
      else this.#select(null);
      return handled();
    }
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -16, ArrowDown: 16 }[e.key]; // prettier-ignore
    if (move) {
      this.#select(this.#sel + move);
      return handled();
    }
    if (!this.#editable()) return;
    if (/^[0-9a-f]$/i.test(e.key)) {
      if (!this.#digit) this.#digit = e.key.toUpperCase();
      else this.#write(Number.parseInt(this.#digit + e.key, 16));
      return handled();
    }
    if (e.key === "Enter" && this.#digit) {
      this.#write(Number.parseInt(this.#digit, 16));
      return handled();
    }
    if (e.key === "Backspace" && this.#digit) {
      this.#digit = "";
      return handled();
    }
  }

  /** Write the selected byte and move on to the next. */
  #write(value) {
    const addr = this.#sel;
    this.#written.set(addr, { value, at: this.#now() });
    this.#send?.({ kind: "poke", compId: this.#state?.compId, addr, value });
    this.#select(addr + 1);
  }

  #toggleBreakpoint(addr) {
    if (!Number.isInteger(addr)) return;
    this.#setBreakpoint(addr, !this.#breaks().has(addr));
  }

  #setBreakpoint(addr, on) {
    const compId = this.#state?.compId;
    if (!compId) return;
    this.#send?.({ kind: "breakpoint", compId, addr: addr & 0xffff, on });
  }
}
