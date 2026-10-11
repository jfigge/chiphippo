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
//   memory     │ flags · inputs · step · clock │ registers, │ stack
//   (256 bytes)│ instructions (5 before, the   │ one a line │ breakpoints
//              │   one in flight, 5 after)     │            │ I/O ports (Z80)
//
// There is no bus-cycle breakdown and no buses panel: the cores emulate an
// instruction's RESULT, not the silicon's insides, so a cycle-by-cycle
// picture would be the emulator's bookkeeping dressed up as the chip's.
//
// Above it, the chip designer's debugger chrome: a TAB per CPU on the
// desktop (the shown one carrying the run's Running/Paused badge), then a bar
// in the toolbar's pill shape — Pause/Continue · Step · Step Over — with a
// one-line status.
//
// The panels are built ONCE and only their contents redrawn from each
// message (a few hundred nodes, ten times a second at most): the Go-to field
// lives in one, and a field rebuilt under the caret loses keystrokes; and the
// Stack and Breakpoints panels SCROLL (the window is as big as it gets, so
// the right-hand column shares out its height and they take the rest), and
// a scroller rebuilt from nothing would jump back to its top. The tabs and the bar are touched only where they change,
// so a click being made is not torn down under the pointer.
//
// What is interactive:
//   · PAUSE / CONTINUE (one button, F8 — DevTools' key for the same toggle):
//     the run's own Pause and Resume. STEP (F6) and STEP OVER (F7) while the
//     run is PAUSED: Step runs the board on, edge by edge, to where this
//     CPU's next operation begins (SimController `stepCpu`); Step Over is
//     offered only at a call (JSR, CALL, RST) and runs on to the instruction
//     after it, the subroutine and all (`stepOverCpu`). A key is a PRESS of
//     its button, so it does nothing when the button is greyed out. The keys
//     are this window's own: they reach it only while it has the focus.
//   · WHERE THE MEMORY BLOCK IS. It follows PC until the user looks
//     elsewhere: clicking a byte, scrolling the block, an arrow off its edge
//     or an address typed into Go to all PIN it (`view`, the host builds the
//     summary from there), and ticking Follow PC lets go again. The selected
//     byte is therefore always in the block shown, or in the one asked for.
//   · EDITING a byte while the circuit runs or is paused — click it, type two
//     hex digits (type-through moves on to the next byte, as the memory
//     inspector's grid does; Enter writes a lone digit, Escape drops it,
//     arrows move). The digits are kept by the VIEW, never in an <input>: the
//     contents are rebuilt on every message. A written byte shows at once and
//     stays shown until a board carries it. The host writes it into the run
//     image (`poke`). Only a byte that is in the block shown (or the block on
//     its way) can be typed over — never one out of sight.
//   · EDITING a register (or clicking a flag) while paused at an
//     instruction's start (`regsEditable`) — click it, type its hex digits;
//     its last digit writes it (Enter writes fewer). `set-register`.
//   · BREAKPOINTS — F9 on the selected byte, its right-click menu, or a click
//     in an instruction line's margin (the chip designer's gutter). A byte
//     with one is red, and
//     so is the margin dot of a line at its address. The panel lists them
//     all, wherever they are; a click on one shows it in memory.
//   · WHAT CHANGED: paused, the registers and flags the run changed since it
//     last paused (a Step: that instruction) are lit.

import { t, formatNumber } from "../i18n.js";
import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";
import { memBase } from "../sim/cpu-monitor.js";

/** How long a byte just written is shown before a board must carry it, ms. */
const OPTIMISTIC_MS = 1500;

const hex = (v, digits) =>
  v == null ? "-".repeat(digits) : v.toString(16).toUpperCase().padStart(digits, "0"); // prettier-ignore

/** An address typed in: hex, with or without `$` or `0x` — or null. */
export function parseAddress(text) {
  const m = /^\s*(?:\$|0x)?([0-9a-f]{1,4})\s*$/i.exec(text ?? "");
  return m ? Number.parseInt(m[1], 16) : null;
}

/** The status line's words for a core's status. */
const STATUS_KEYS = new Set(["running", "reset", "irq", "nmi", "int", "wai", "stp", "halt", "busack"]); // prettier-ignore

/** The steps shown as boxes (more, if an operation runs longer). */
const STEP_BOXES = 8;

/** Each function key → the bar button it presses (the chip debugger's
    `DEBUG_KEYS` where it has the same thing: F8 Continue, F6 Step). */
export const MONITOR_KEYS = Object.freeze({ F8: "run", F6: "step", F7: "stepOver" }); // prettier-ignore

/** Redraw a scrolling panel's contents where its scroll stood. */
function keepScroll(node, redraw) {
  const top = node.scrollTop;
  redraw();
  node.scrollTop = top;
}

/** The flags' register value under a pseudo-name in the changed set. */
const FLAGS = "\u0000flags";

export class CpuMonitorView {
  #root;
  #send;
  #tabs;
  #tabsKey = null; // what the tabs were last drawn from
  #buttons;
  #statusLine;
  #count;
  #body;
  #panels;
  #empty;
  #keep;
  #keepLabel;
  #follow;
  #goto;
  #state = null; // the last message drawn
  #memAt = null; // where the block was asked to start (null: around PC)
  #sel = null; // the selected address (absolute, as the CPU sees it)
  #digit = ""; // the first hex digit typed over it, pending
  #written = new Map(); // address → {value, at}: written, not yet on a board
  #reg = null; // the selected register's name
  #regDigits = ""; // the digits typed over it so far
  #regWritten = new Map(); // name → {value, at}
  #base = null; // the registers last seen paused: {compId, cycles, values}
  #changed = new Set(); // the registers (and FLAGS) changed since then
  #flagsChanged = 0; // the flag bits among them
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
    const button = (key, kind, label, title) =>
      el("button", {
        class: "toolbar-pill-btn cpumon-bar-btn",
        type: "button",
        text: t(label),
        title: t(title),
        disabled: true,
        dataset: { action: kind, key },
        onClick: (e) => this.#send?.({ kind: e.currentTarget.dataset.action, compId: this.#state?.compId }), // prettier-ignore
      });
    this.#buttons = {
      run: button("run", "pause", "cpumonitor.pause", "cpumonitor.pauseTitle"),
      step: button("step", "step", "cpumonitor.stepOp", "cpumonitor.stepOpTitle"), // prettier-ignore
      stepOver: button("stepOver", "step-over", "cpumonitor.stepOver", "cpumonitor.stepOverTitle"), // prettier-ignore
    };
    this.#statusLine = el("span", {
      class: "cpumon-bar-status",
      role: "status",
    });
    this.#buildPanels();
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
    this.#panels.memory.content.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false }); // prettier-ignore
    (root.ownerDocument?.defaultView ?? window).addEventListener("keydown", (e) => this.#onKey(e)); // prettier-ignore
    this.render({ cpus: [], compId: null, running: false, mode: "stopped", summary: null }); // prettier-ignore
  }

  /** The panels, each a title over a contents node redrawn per message. */
  #buildPanels() {
    const panel = (cls, title, { head = [] } = {}) => {
      const content = el("div", { class: "cpumon-panel-body" });
      const hint = el("p", { class: "cpumon-hint", hidden: true });
      const section = el("section", { class: `cpumon-panel ${cls}` }, [
        el("div", { class: "cpumon-panel-head" }, [
          el("h2", { class: "cpumon-title", text: title }),
          ...head,
        ]),
        content,
        hint,
      ]);
      return { section, content, hint };
    };
    // A field's own keys stay in it: Enter acts, Escape lets go.
    const field = (cls, placeholder, title, onEnter) => {
      const input = el("input", {
        type: "text",
        class: `cpumon-field ${cls}`,
        placeholder: t(placeholder),
        title: t(title),
        spellcheck: false,
        autocomplete: "off",
        maxLength: 6,
        onInput: () => input.classList.remove("cpumon-field--invalid"),
        onKeydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const addr = parseAddress(input.value);
            if (addr == null) {
              input.classList.add("cpumon-field--invalid");
              return;
            }
            input.value = "";
            onEnter(addr);
          } else if (e.key === "Escape") {
            e.preventDefault();
            input.value = "";
            input.classList.remove("cpumon-field--invalid");
            input.blur();
          }
        },
      });
      return input;
    };
    this.#follow = el("input", {
      type: "checkbox",
      class: "cpumon-follow-box",
      checked: true,
      onChange: () => (this.#follow.checked ? this.#followPc() : this.#pinBlock(this.#shownBase())), // prettier-ignore
    });
    this.#goto = field("cpumon-goto", "cpumonitor.goto", "cpumonitor.gotoTitle", (addr) => this.#goTo(addr)); // prettier-ignore
    this.#panels = {
      memory: panel("cpumon-memory", t("cpumonitor.memory"), {
        head: [
          el(
            "label",
            { class: "cpumon-follow", title: t("cpumonitor.followTitle") },
            [
              // prettier-ignore
              this.#follow,
              el("span", { text: t("cpumonitor.follow") }),
            ],
          ),
          this.#goto,
        ],
      }),
      status: panel("cpumon-status", t("cpumonitor.state")),
      pipeline: panel("cpumon-pipeline", t("cpumonitor.instructions")),
      registers: panel("cpumon-registers", t("cpumonitor.registers")),
      stack: panel("cpumon-stack", t("cpumonitor.stack")),
      breaks: panel("cpumon-breaks", t("cpumonitor.breakpoints")),
      ports: panel("cpumon-ports", t("cpumonitor.ports")),
    };
    const p = this.#panels;
    this.#empty = el("p", { class: "cpumon-empty" });
    this.#body = el("div", { class: "cpumon-body" }, [
      p.memory.section,
      p.status.section,
      p.pipeline.section,
      p.registers.section,
      el("div", { class: "cpumon-side" }, [p.stack.section, p.breaks.section, p.ports.section]), // prettier-ignore
      this.#empty,
    ]);
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
    if (state.compId !== this.#state?.compId) this.#forgetCpu();
    this.#state = state;
    const s = state.summary;
    const mode = state.running ? state.mode : "stopped";
    this.#renderTabs(state.cpus ?? [], state.compId, mode);
    this.#keep.checked = state.keepEdits === true;
    // Offered only once a ROM has been edited this run: until then there is
    // nothing for it to keep.
    this.#keepLabel.hidden = state.romEdited !== true;
    this.#renderButtons(mode, state, s);
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
    this.#noteChanges(mode, state.compId, s);
    if (!s?.regsEditable || mode !== "paused") this.#selectRegister(null);

    const p = this.#panels;
    const shown = Boolean(state.cpus?.length && s);
    this.#body.classList.toggle("cpumon-body--empty", !shown);
    for (const key of [
      "memory",
      "status",
      "pipeline",
      "registers",
      "stack",
      "ports",
    ]) {
      // prettier-ignore
      p[key].section.hidden = !shown;
    }
    p.breaks.section.hidden = !state.cpus?.length || !state.compId;
    this.#empty.hidden = shown;
    if (!state.cpus?.length) {
      this.#empty.textContent = t("cpumonitor.noCpu");
      return;
    }
    this.#breakpoints(s);
    if (!s) {
      this.#empty.textContent = t(state.running ? "cpumonitor.waiting" : "cpumonitor.notRunning"); // prettier-ignore
      return;
    }
    this.#memory(s);
    this.#status(s, mode);
    this.#pipeline(s);
    this.#registers(s, mode);
    this.#stack(s);
    this.#ports(s);
  }

  /** Another CPU shown: nothing selected, the block back on its PC. */
  #forgetCpu() {
    this.#select(null);
    this.#selectRegister(null);
    this.#memAt = null;
    this.#follow.checked = true;
    this.#base = null;
    this.#changed = new Set();
    this.#flagsChanged = 0;
  }

  /** The bar's buttons: Pause while running, Continue while paused; Step
      paused; Step Over paused at a call. */
  #renderButtons(mode, state, s) {
    const run = this.#buttons.run;
    const pausing = mode === "running";
    run.dataset.action = pausing ? "pause" : "continue";
    run.textContent = t(pausing ? "cpumonitor.pause" : "cpumonitor.continue");
    run.title = t(pausing ? "cpumonitor.pauseTitle" : "cpumonitor.continueTitle"); // prettier-ignore
    run.disabled = mode !== "running" && mode !== "paused";
    const stepping = mode === "paused" && Boolean(state.compId) && Boolean(s);
    this.#buttons.step.disabled = !stepping;
    this.#buttons.stepOver.disabled = !stepping || s.pipeline?.current?.call !== true; // prettier-ignore
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

  // ── What changed ───────────────────────────────────────────────────────────

  /** The registers by name (the flags under FLAGS), as a summary has them. */
  #values(s) {
    const out = new Map(s.view.registers.map((r) => [r.name, r.value]));
    out.set(FLAGS, s.view.flags.value);
    return out;
  }

  /**
   * Keep the picture the run last PAUSED at, and what differs from it. A
   * new paused moment (the count moved: a Step, a breakpoint) is compared
   * with the last one and becomes the next baseline; the same moment again
   * (an edit made while paused) only updates the baseline, since nothing
   * the PROGRAM did changed it. Running, the baseline waits — and the first
   * pause has nothing to be compared with.
   */
  #noteChanges(mode, compId, s) {
    // A run's changes are its own: Stop (a desktop switch among them, where
    // `c1` may be another CPU entirely) starts over.
    if (mode === "stopped") this.#base = null;
    if (!s || !compId || mode !== "paused") return;
    const values = this.#values(s);
    const base = this.#base;
    if (!base || base.compId !== compId) {
      this.#base = { compId, cycles: s.cycles, values };
      this.#changed = new Set();
      this.#flagsChanged = 0;
      return;
    }
    if (s.cycles === base.cycles) {
      base.values = values;
      return;
    }
    this.#changed = new Set();
    for (const [name, value] of values) {
      if (base.values.get(name) !== value) this.#changed.add(name);
    }
    this.#flagsChanged = (base.values.get(FLAGS) ?? 0) ^ (values.get(FLAGS) ?? 0); // prettier-ignore
    this.#base = { compId, cycles: s.cycles, values };
  }

  /** Is a change to show? Only while paused, on the moment it was seen. */
  #showChanges(mode) {
    return mode === "paused" && this.#base?.cycles === this.#state?.summary?.cycles; // prettier-ignore
  }

  // ── The panels ─────────────────────────────────────────────────────────────

  /** The first address of the block shown. */
  #shownBase() {
    return this.#state?.summary?.memory?.base ?? 0;
  }

  /** Sixteen rows of sixteen bytes. */
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
    const p = this.#panels.memory;
    p.content.replaceChildren(el("div", { class: "cpumon-mem" }, [head, ...rows])); // prettier-ignore
    this.#hint(p, t(this.#state?.running ? "cpumonitor.memoryHint" : "cpumonitor.memoryHintStopped")); // prettier-ignore
  }

  #hint(panel, text) {
    panel.hint.textContent = text ?? "";
    panel.hint.hidden = !text;
  }

  /** Flags, inputs, step, clock and what the CPU is doing. */
  #status(s, mode) {
    const v = s.view;
    const lit = this.#showChanges(mode) ? this.#flagsChanged : 0;
    const editable = this.#regsEditable();
    const flags = el(
      "div",
      { class: "cpumon-flags" },
      v.flags.names.map((name, i) => {
        const bit = 1 << (7 - i);
        const on = (v.flags.value & bit) !== 0;
        const settable = editable && !(v.flags.fixed & bit);
        let cls = "cpumon-flag";
        if (on) cls += " cpumon-flag--on";
        if (lit & bit) cls += " cpumon-flag--changed";
        if (settable) cls += " cpumon-flag--settable";
        return el("span", {
          class: cls,
          text: name,
          dataset: settable ? { flagBit: String(bit) } : {},
          title: settable ? t("cpumonitor.flagToggle") : null,
        });
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
    this.#panels.status.content.replaceChildren(
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
    );
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
      el("div", { class: "cpumon-line cpumon-line--blank" }, " "),
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
    this.#panels.pipeline.content.replaceChildren(
      el("div", { class: "cpumon-lines" }, [
        ...pad,
        ...previous.map((l) => line(l, "previous")),
        line(current, "current"),
        ...ahead.map((l) => line(l, "ahead")),
      ]),
    );
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

  /** The registers, one a line — lit where the run changed one, editable
      paused at an instruction's start. */
  #registers(s, mode) {
    const lit = this.#showChanges(mode) ? this.#changed : new Set();
    const editable = this.#regsEditable();
    const regs = el(
      "div",
      { class: "cpumon-regs" },
      s.view.registers.map((r) => {
        const value = this.#regShown(r.name, r.value);
        const typing = r.name === this.#reg;
        let cls = "cpumon-reg";
        if (lit.has(r.name)) cls += " cpumon-reg--changed";
        if (editable) cls += " cpumon-reg--editable";
        if (typing) cls += " cpumon-reg--selected";
        const text = typing && this.#regDigits
          ? `${this.#regDigits}${"_".repeat(r.digits - this.#regDigits.length)}`
          : r.digits === 1 ? String(value) : hex(value, r.digits); // prettier-ignore
        return el(
          "span",
          { class: cls, dataset: editable ? { reg: r.name } : {} },
          [
            // prettier-ignore
            el("span", { class: "cpumon-reg-name", text: r.name }),
            el("span", { class: "cpumon-reg-value", text }),
          ],
        );
      }),
    );
    const p = this.#panels.registers;
    p.content.replaceChildren(regs);
    // A tooltip, not a line of text: a Z80's seventeen registers fill the
    // column already.
    p.content.title = mode !== "paused" ? "" : t(editable ? "cpumonitor.registersHint" : "cpumonitor.registersHintLocked"); // prettier-ignore
  }

  /** The stack's top, an entry a line; a click shows it in memory. */
  #stack(s) {
    const st = s.stack;
    const p = this.#panels.stack;
    p.section.hidden = !st;
    if (!st) return;
    const digits = st.width * 2;
    keepScroll(p.content, () =>
      p.content.replaceChildren(
        st.entries.length
          ? el(
              "div",
              { class: "cpumon-stack-lines" },
              st.entries.map((e, i) =>
                el(
                  "div",
                  {
                    class: `cpumon-stack-line${i === 0 ? " cpumon-stack-line--top" : ""}`,
                    dataset: { goto: String(e.addr) },
                    title: t("cpumonitor.showInMemory"),
                  },
                  [
                    // prettier-ignore
                    el("span", { class: "cpumon-stack-addr", text: hex(e.addr, 4) }), // prettier-ignore
                    el("span", { class: "cpumon-stack-value", text: e.value == null ? "-".repeat(digits) : hex(e.value, digits) }), // prettier-ignore
                  ],
                ),
              ),
            )
          : el("p", { class: "cpumon-none", text: t("cpumonitor.stackEmpty") }),
      ),
    );
  }

  /** Every breakpoint of the CPU shown, its instruction beside it (once a
      run has memory to decode); a click shows one in memory, × clears it. */
  #breakpoints(s) {
    const addrs = [...this.#breaks()].sort((a, b) => a - b);
    const text = new Map((s?.breakLines ?? []).map((l) => [l.addr, l.text]));
    const p = this.#panels.breaks;
    keepScroll(p.content, () =>
      p.content.replaceChildren(
        addrs.length
          ? el(
              "div",
              { class: "cpumon-break-lines" },
              addrs.map((a) =>
                el("div", { class: "cpumon-break-line" }, [
                  el("span", { class: "cpumon-line-mark cpumon-line-mark--break", text: "●" }), // prettier-ignore
                  el("span", { class: "cpumon-break-addr", text: `$${hex(a, 4)}`, dataset: s ? { goto: String(a) } : {}, title: s ? t("cpumonitor.showInMemory") : null }), // prettier-ignore
                  el("span", { class: "cpumon-break-text", text: text.get(a) ?? "" }), // prettier-ignore
                  el("button", { class: "cpumon-break-clear", type: "button", text: "×", title: t("cpumonitor.breakpointRemove"), dataset: { clearBreak: String(a) } }), // prettier-ignore
                ]),
              ),
            )
          : el("p", {
              class: "cpumon-none",
              text: t("cpumonitor.breakpointsNone"),
            }),
      ),
    );
  }

  /** What crossed each I/O port (a core with an I/O space only). */
  #ports(s) {
    const p = this.#panels.ports;
    p.section.hidden = !Array.isArray(s.io);
    if (!Array.isArray(s.io)) return;
    if (!s.io.length) {
      p.content.replaceChildren(el("p", { class: "cpumon-none", text: t("cpumonitor.portsNone") })); // prettier-ignore
      return;
    }
    const cell = (port, dir) =>
      el("span", { class: `cpumon-port-value${port.last === dir ? " cpumon-port-value--last" : ""}`, text: port[dir] == null ? "--" : hex(port[dir], 2) }); // prettier-ignore
    p.content.replaceChildren(
      el("div", { class: "cpumon-port-lines" }, [
        el("div", { class: "cpumon-port-line cpumon-port-head" }, [
          el("span", { text: t("cpumonitor.portHead.port") }),
          el("span", { text: t("cpumonitor.portHead.out") }),
          el("span", { text: t("cpumonitor.portHead.in") }),
        ]),
        ...s.io.map((port) =>
          el(
            "div",
            {
              class: `cpumon-port-line${port.latest ? " cpumon-port-line--latest" : ""}`,
            },
            [
              // prettier-ignore
              el("span", { class: "cpumon-port-addr", text: `$${hex(port.port, 2)}` }), // prettier-ignore
              cell(port, "out"),
              cell(port, "in"),
            ],
          ),
        ),
      ]),
    );
  }

  // ── Where the memory block is ──────────────────────────────────────────────

  /** Pin the block at `at` (a row), telling the host if that moved it. */
  #pinBlock(at) {
    const base = memBase(at);
    this.#follow.checked = false;
    if (base === this.#memAt) return;
    this.#memAt = base;
    this.#send?.({ kind: "view", compId: this.#state?.compId, memAt: base });
  }

  /** Back to the block around PC; nothing stays selected. */
  #followPc() {
    this.#follow.checked = true;
    this.#select(null);
    if (this.#memAt == null) return this.#redraw();
    this.#memAt = null;
    this.#send?.({ kind: "view", compId: this.#state?.compId, memAt: null });
    this.#redraw();
  }

  /** Keep `addr` in the block: pinned where it is now, scrolled a row at a
      time when the address is off its top or bottom. */
  #reveal(addr) {
    let at = this.#memAt ?? this.#shownBase();
    if (addr < at) at = addr & 0xfff0;
    else if (addr >= at + 256) at = (addr & 0xfff0) - 0xf0;
    this.#pinBlock(at);
  }

  /** Go to: the address's row at the block's top, the byte selected. */
  #goTo(addr) {
    this.#pinBlock(addr & 0xfff0);
    this.#select(addr);
    this.#redraw();
  }

  #onWheel(e) {
    if (!this.#state?.summary || !e.deltaY) return;
    e.preventDefault();
    const rows = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 40)); // prettier-ignore
    this.#pinBlock((this.#memAt ?? this.#shownBase()) + rows * 16);
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

  /** A register as shown: one just written wins until a board carries it. */
  #regShown(name, value) {
    const w = this.#regWritten.get(name);
    if (!w) return value;
    if (value === w.value || this.#now() - w.at > OPTIMISTIC_MS) {
      this.#regWritten.delete(name);
      return value;
    }
    return w.value;
  }

  /** May the selected byte be typed over? While the run is live, where the
      CPU reads memory a chip answers — and only a byte in the block shown,
      or in the block asked for (it is on its way), never one out of sight. */
  #editable() {
    const st = this.#state;
    if (!st?.running || !st.summary || this.#sel == null) return false;
    const { base, bytes } = st.summary.memory;
    const i = this.#sel - base;
    if (i >= 0 && i < bytes.length) return bytes[i] != null;
    return this.#memAt != null && this.#sel >= this.#memAt && this.#sel < this.#memAt + 256; // prettier-ignore
  }

  /** May the registers be changed? Paused at an instruction's start. */
  #regsEditable() {
    const st = this.#state;
    return st?.running === true && st.mode === "paused" && st.summary?.regsEditable === true; // prettier-ignore
  }

  #select(addr) {
    this.#sel = addr == null ? null : addr & 0xffff;
    this.#digit = "";
    if (addr != null) this.#selectRegister(null);
  }

  #selectRegister(name) {
    this.#reg = name;
    this.#regDigits = "";
    if (name != null) this.#select(null);
  }

  #redraw() {
    if (this.#state) this.render(this.#state);
  }

  #onPress(e) {
    if (e.button !== 0) return;
    const clear = e.target.closest?.("[data-clear-break]");
    if (clear) {
      e.preventDefault();
      this.#setBreakpoint(Number(clear.dataset.clearBreak), false);
      return;
    }
    const mark = e.target.closest?.("[data-break-addr]");
    if (mark) {
      e.preventDefault();
      this.#toggleBreakpoint(Number(mark.dataset.breakAddr));
      return;
    }
    const go = e.target.closest?.("[data-goto]");
    if (go) {
      e.preventDefault();
      this.#goTo(Number(go.dataset.goto));
      return;
    }
    const flag = e.target.closest?.("[data-flag-bit]");
    if (flag) {
      e.preventDefault();
      const v = this.#state?.summary?.view?.flags;
      if (v && this.#regsEditable()) this.#writeRegister(v.reg, v.value ^ Number(flag.dataset.flagBit)); // prettier-ignore
      return;
    }
    const reg = e.target.closest?.("[data-reg]");
    if (reg) {
      e.preventDefault();
      this.#selectRegister(reg.dataset.reg);
      this.#redraw();
      return;
    }
    const cell = e.target.closest?.("[data-addr]");
    if (!cell) return;
    e.preventDefault();
    const addr = Number(cell.dataset.addr);
    this.#select(addr);
    this.#reveal(addr);
    this.#redraw();
  }

  #onContextMenu(e) {
    const cell = e.target.closest?.("[data-addr]");
    if (!cell) return;
    e.preventDefault();
    const addr = Number(cell.dataset.addr);
    this.#select(addr);
    this.#reveal(addr);
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
    // A field's keys are its own (it handles Enter and Escape itself).
    if (e.target?.closest?.("input")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.#reg != null) return this.#onRegisterKey(e);
    if (this.#sel == null) return;
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
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -16, ArrowDown: 16, PageUp: -256, PageDown: 256 }[e.key]; // prettier-ignore
    if (move) {
      const to = (this.#sel + move) & 0xffff;
      this.#select(to);
      this.#reveal(to);
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

  /** A key while a register is selected: its digits, Enter, Escape, and
      the arrows to the register above or below. */
  #onRegisterKey(e) {
    const regs = this.#state?.summary?.view?.registers ?? [];
    const i = regs.findIndex((r) => r.name === this.#reg);
    const r = regs[i];
    const handled = () => {
      e.preventDefault();
      this.#redraw();
    };
    if (!r || !this.#regsEditable()) {
      this.#selectRegister(null);
      return handled();
    }
    if (e.key === "Escape") {
      if (this.#regDigits) this.#regDigits = "";
      else this.#selectRegister(null);
      return handled();
    }
    const move = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (move) {
      const next = regs[i + move];
      if (next) this.#selectRegister(next.name);
      return handled();
    }
    if (/^[0-9a-f]$/i.test(e.key)) {
      this.#regDigits += e.key.toUpperCase();
      if (this.#regDigits.length >= r.digits) this.#commitRegister(r);
      return handled();
    }
    if (e.key === "Enter" && this.#regDigits) {
      this.#commitRegister(r);
      return handled();
    }
    if (e.key === "Backspace" && this.#regDigits) {
      this.#regDigits = this.#regDigits.slice(0, -1);
      return handled();
    }
  }

  /** Write the digits typed over a register, and let it go. */
  #commitRegister(r) {
    const value = Number.parseInt(this.#regDigits, 16);
    this.#regDigits = "";
    this.#writeRegister(r.name, value);
    this.#selectRegister(null);
  }

  #writeRegister(name, value) {
    const flags = this.#state?.summary?.view?.flags;
    if (name !== flags?.reg) this.#regWritten.set(name, { value, at: this.#now() }); // prettier-ignore
    this.#send?.({ kind: "set-register", compId: this.#state?.compId, name, value }); // prettier-ignore
    this.#redraw();
  }

  /** Write the selected byte and move on to the next. */
  #write(value) {
    const addr = this.#sel;
    this.#written.set(addr, { value, at: this.#now() });
    this.#send?.({ kind: "poke", compId: this.#state?.compId, addr, value });
    const next = (addr + 1) & 0xffff;
    this.#select(next);
    this.#reveal(next);
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
