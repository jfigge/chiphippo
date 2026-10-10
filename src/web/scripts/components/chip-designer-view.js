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

// chip-designer-view.js — the chip designer window's whole view: one window
// that is the DESIGNER while the circuit is stopped and the DEBUGGER while it
// runs, split down the middle — the package on the left, the code on the
// right — under a strip of tabs.
//
//   design mode   a tab per open chip DESIGN; the package (diagram + form)
//                 and the Verilog body are editable, the generated module
//                 header above it follows both, and every problem — the
//                 package's and the compiler's — is listed under it.
//   debug mode    a tab per CHIP being debugged (order of arrival, each with
//                 its state); the debugger bar, the code read-only with the
//                 statement it is paused at marked, the package lit with its
//                 pins' levels, and the watch panel.
//
// Two dividers are the user's to move: the one between the package and the
// code (a chip of several units wants a wide pin table), and the one under
// the generated module header, which otherwise takes what it needs and
// scrolls once the code is short of room. Where they were left is reported
// (`onLayout`) for the window to remember; a double-click puts one back.
//
// The window owns nothing. It draws the host's state (the main renderer's
// chip-design-bridge.js, through main's relay) and reports what the user did;
// the one thing it keeps is the text being TYPED, which it compiles locally
// for live highlighting and diagnostics and hands over after a pause — and
// which a host echo of an older version never overwrites.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { compileModule } from "../hdl/compile.js";
import { MODULE_END, moduleName } from "../hdl/header.js";
import { declaredNames } from "../hdl/highlight.js";
import {
  customChipProblems,
  hasErrors,
  modulePorts,
  namesForPin,
  pinsForName,
} from "../model/custom-chip.js";
import { HdlEditor } from "./hdl-editor.js";
import { ChipPackageDiagram } from "./chip-package-diagram.js";
import { ChipPackageForm } from "./chip-package-form.js";
import { ChipDebugBar, DEBUG_KEYS } from "./chip-debug-bar.js";
import { ChipWatchPanel } from "./chip-watch-panel.js";
import { beginPointerGesture } from "./pointer-gesture.js";

/** How long typing pauses before the code goes to the host. */
const CODE_DEBOUNCE_MS = 300;
/** The narrowest the package and the code may be dragged (CSS px) — the
    same floors app.css's `.cd-main` clamps a remembered width to. */
const MIN_LEFT = 300;
const MIN_RIGHT = 360;

export class ChipDesignerView {
  #send;
  #state = null;
  #local = new Map(); // design id → {chip, token}: edits the host has not echoed
  #token = 0;
  #codeTimer = null;
  #codePending = null; // the design id #codeTimer will send
  #root;
  #tabs;
  #notice;
  #bar;
  #main;
  #left;
  #split;
  #codeBox;
  #headerSplit;
  #footer;
  #onLayout;
  #rule;
  #formPane;
  #empty;
  #diagram;
  #form;
  #headerText;
  #editor;
  #problems;
  #watch;
  #shownChip = null; // the chip the code view is showing, and how
  #shownKey = "";
  #viewKey = null; // the design (or debugged chip) on screen; null: none

  /**
   * @param {HTMLElement} root
   * @param {object} opts
   * @param {(msg: object) => void} opts.send - to the host.
   * @param {{leftWidth?: number|null, headerHeight?: number|null}} [opts.layout]
   *   - where the dividers were left last time.
   * @param {(patch: object) => void} [opts.onLayout] - a divider was let go
   *   (`{chipDesignerLeftWidth}` / `{chipDesignerHeaderHeight}`, px or null).
   */
  constructor(root, { send, layout = {}, onLayout }) {
    this.#send = send;
    this.#onLayout = onLayout;
    this.#root = root;
    this.#tabs = el("div", { class: "cd-tabs", role: "tablist" });
    this.#notice = el("div", { class: "cd-notice", role: "status", hidden: true }); // prettier-ignore
    this.#bar = new ChipDebugBar({
      continue: () => this.#send({ kind: "debug", cmd: "continue" }),
      toSettled: () => this.#send({ kind: "debug", cmd: "toSettled" }),
      step: () => this.#debugCmd("step"),
      stepOut: () => this.#debugCmd("stepOut"),
      detach: () => this.#debugCmd("detach"),
      breakSettled: (on) => this.#arm({ settled: on }),
    });
    this.#diagram = new ChipPackageDiagram({
      onPinHover: (pin) => this.#pinHovered(pin),
    });
    this.#form = new ChipPackageForm({
      onChange: (chip) => this.#edited(chip),
    });
    this.#headerText = el("pre", { class: "cd-code-fixed cd-code-header" });
    this.#editor = new HdlEditor({
      label: t("chipdesign.code.label"),
      onInput: (text) => this.#typed(text),
      onHover: (run) => this.#nameHovered(run),
      onToggleBreakpoint: (line) => this.#toggleBreakpoint(line),
    });
    this.#problems = el("ul", { class: "cd-problems" });
    this.#watch = new ChipWatchPanel({
      onUnit: (unit) => {
        const tab = this.#focusedTab();
        if (tab) this.#send({ kind: "unit", compId: tab.compId, unit });
      },
      onMemoryRange: (compId, slot, from, count, req) =>
        this.#send({ kind: "memory-range", compId, slot, from, count, req }),
    });
    // The package stays at the top, always in view; only the form under the
    // rule scrolls (the package scrolls itself only when it is too tall to
    // leave the form any room).
    this.#rule = el("hr", { class: "cd-rule" });
    this.#formPane = el("div", { class: "cd-form-pane" }, [this.#form.element]);
    const left = el("div", { class: "cd-left" }, [
      this.#diagram.element,
      this.#rule,
      this.#formPane,
    ]);
    this.#left = left;
    // The divider between the package and the code, and the one under the
    // module header: drag to move, double-click to put back.
    this.#split = el("div", {
      class: "cd-split",
      title: t("chipdesign.split.panes"),
      "aria-hidden": "true",
    });
    this.#split.addEventListener("pointerdown", (e) => this.#onSplitDown(e));
    this.#split.addEventListener("dblclick", () => this.#setLeftWidth(null, true)); // prettier-ignore
    this.#headerSplit = el("div", {
      class: "cd-code-split",
      title: t("chipdesign.split.header"),
      "aria-hidden": "true",
    });
    this.#headerSplit.addEventListener("pointerdown", (e) =>
      this.#onHeaderSplitDown(e),
    );
    this.#headerSplit.addEventListener("dblclick", () =>
      this.#setHeaderHeight(null, true),
    );
    this.#footer = el("pre", { class: "cd-code-fixed cd-code-footer", text: MODULE_END }); // prettier-ignore
    this.#codeBox = el("div", { class: "cd-code" }, [
      this.#headerText,
      this.#headerSplit,
      this.#editor.element,
      this.#footer,
    ]);
    const right = el("div", { class: "cd-right" }, [
      this.#codeBox,
      el(
        "section",
        {
          class: "cd-problems-section",
          "aria-label": t("chipdesign.problems.title"),
        },
        [
          // prettier-ignore
          el("h3", { class: "cd-subhead", text: t("chipdesign.problems.title") }),
          this.#problems,
        ],
      ),
      this.#watch.element,
    ]);
    this.#main = el("div", { class: "cd-main" }, [left, this.#split, right]);
    this.#setLeftWidth(layout.leftWidth ?? null);
    this.#setHeaderHeight(layout.headerHeight ?? null);
    this.#empty = el("div", { class: "cd-empty", hidden: true });
    root.append(this.#tabs, this.#bar.element, this.#notice, this.#main, this.#empty); // prettier-ignore
    window.addEventListener("chiphippo:font-size-changed", () => {
      this.#editor.refreshMetrics();
      this.#watch.refreshMetrics();
    });
    window.addEventListener("keydown", (e) => this.#onKeyDown(e));
  }

  /** The debugger's function keys (`DEBUG_KEYS`), each a press of its bar
      button — only while debugging, and never with a modifier. */
  #onKeyDown(e) {
    if (!this.#debugging) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const key = DEBUG_KEYS[e.key];
    if (!key) return;
    e.preventDefault();
    this.#bar.press(key);
  }

  /** A message from the host. */
  receive(msg) {
    // An array's words, for the memory view that asked (never part of the
    // state: a 32K memory would ride every step).
    if (msg?.kind === "memory-range") {
      this.#watch.memoryRange(msg);
      return;
    }
    if (msg?.kind !== "state") return;
    this.#state = msg;
    // An echo that has caught up with the local edits retires them.
    for (const [id, local] of this.#local) {
      if ((msg.tokens?.[id] ?? 0) >= local.token) this.#local.delete(id);
    }
    if (msg.notice) this.#showNotice(msg.notice);
    this.#render();
  }

  // ── State ───────────────────────────────────────────────────────────────

  get #debugging() {
    return this.#state?.mode === "debug";
  }

  /** A design as the window should show it: the local edit if one is
      pending, else the host's. */
  #design(id) {
    return (
      this.#local.get(id)?.chip ??
      this.#state?.designs.find((c) => c.id === id) ??
      null
    );
  }

  #focusedTab() {
    const debug = this.#state?.debug;
    return debug?.tabs.find((tab) => tab.compId === debug.focus) ?? null;
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  /** Redraw — leaving the panes where the reader had them, so long as it is
      still the same design (or debugged chip) on screen. */
  #render() {
    const before = this.#viewKey;
    const offsets = this.#paneOffsets();
    this.#draw();
    if (this.#viewKey !== null && this.#viewKey === before) {
      this.#restorePanes(offsets);
    }
  }

  #draw() {
    const debugging = this.#debugging;
    this.#root.classList.toggle("cd-root--debug", debugging);
    this.#bar.element.hidden = !debugging;
    this.#renderTabs();
    let chip = null;
    let tab = null;
    if (debugging) {
      tab = this.#focusedTab();
      chip = tab ? this.#design(tab.ref) : null;
    } else {
      chip = this.#state?.focus ? this.#design(this.#state.focus) : null;
    }
    this.#viewKey = !chip ? null : debugging ? `debug:${tab.compId}` : `design:${chip.id}`; // prettier-ignore
    this.#main.hidden = !chip;
    this.#empty.hidden = Boolean(chip);
    if (!chip) {
      this.#renderEmpty(debugging);
      this.#bar.update(null, this.#state?.debug);
      document.title = t("chipdesign.windowTitle");
      return;
    }
    document.title = `${chip.name} · ${t("chipdesign.windowTitle")}`;
    const levels = tab ? new Map(tab.pinLevels) : null;
    this.#diagram.render(chip, { levels });
    this.#rule.hidden = debugging;
    this.#formPane.hidden = debugging;
    if (!debugging) {
      this.#form.render(chip, {
        placed: this.#state.uses?.[chip.id] ?? 0,
        readOnly: false,
      });
    }
    this.#renderCode(chip, tab);
    this.#watch.element.hidden = !debugging;
    if (debugging) this.#watch.render(tab);
    this.#bar.update(tab, this.#state.debug);
  }

  #renderTabs() {
    const nodes = [];
    if (this.#debugging) {
      const debug = this.#state.debug;
      for (const tab of debug.tabs) {
        nodes.push(
          this.#tab({
            key: tab.compId,
            label: tab.label,
            active: tab.compId === debug.focus,
            badge: badgeOf(tab),
            badgeClass: `cd-tab-badge--${tab.waitingAtSettled ? "settled" : tab.state}`,
            closable: tab.state !== "paused",
            onSelect: () =>
              this.#send({ kind: "focus-chip", compId: tab.compId }),
            onClose: () =>
              this.#send({ kind: "close-chip", compId: tab.compId }),
          }),
        );
      }
    } else {
      for (const id of this.#state?.open ?? []) {
        const chip = this.#design(id);
        if (!chip) continue;
        nodes.push(
          this.#tab({
            key: id,
            label: chip.name,
            active: id === this.#state.focus,
            closable: true,
            onSelect: () => this.#send({ kind: "focus-design", id }),
            onClose: () => {
              this.#flushCode();
              this.#send({ kind: "close-design", id });
            },
          }),
        );
      }
      nodes.push(
        el("button", {
          class: "cd-tab-new",
          type: "button",
          text: "+",
          title: t("chipdesign.newChip"),
          "aria-label": t("chipdesign.newChip"),
          onClick: () => {
            this.#flushCode();
            this.#send({ kind: "new" });
          },
        }),
      );
    }
    this.#tabs.replaceChildren(...nodes);
  }

  #tab({ key, label, active, badge, badgeClass, closable, onSelect, onClose }) {
    const tab = el(
      "div",
      { class: `cd-tab${active ? " cd-tab--active" : ""}`, dataset: { key } },
      [
        el(
          "button",
          {
            class: "cd-tab-label",
            type: "button",
            role: "tab",
            "aria-selected": String(active),
            onClick: onSelect,
          },
          [
            el("span", { class: "cd-tab-name", text: label }),
            badge ? el("span", { class: `cd-tab-badge ${badgeClass}`, text: badge }) : null, // prettier-ignore
          ],
        ),
        closable
          ? el("button", {
              class: "cd-tab-close",
              type: "button",
              text: "×",
              title: t("chipdesign.closeTab", { name: label }),
              "aria-label": t("chipdesign.closeTab", { name: label }),
              onClick: onClose,
            })
          : null,
      ],
    );
    return tab;
  }

  #renderEmpty(debugging) {
    const nodes = [
      el("p", {
        text: debugging
          ? t("chipdesign.emptyDebug")
          : t("chipdesign.emptyDesign"),
      }),
    ];
    if (!debugging) {
      nodes.push(
        el("button", {
          class: "cd-button",
          type: "button",
          text: t("chipdesign.newChip"),
          onClick: () => this.#send({ kind: "new" }),
        }),
      );
    }
    this.#empty.replaceChildren(...nodes);
  }

  /** The code side: the header, the body, its problems. */
  #renderCode(chip, tab) {
    const compiled = compileModule(chip.code, modulePorts(chip), {
      name: moduleName(chip.name),
    });
    this.#headerText.textContent = compiled.header;
    const readOnly = this.#debugging;
    this.#editor.setReadOnly(readOnly);
    // The text only when it is a different chip, or the host's copy has
    // moved on from what is on screen and the user is not mid-edit.
    const key = `${chip.id}:${readOnly}`;
    if (key !== this.#shownKey || !this.#local.has(chip.id)) {
      if (key !== this.#shownKey || this.#editor.value !== chip.code) {
        this.#editor.setValue(chip.code);
      }
      this.#shownKey = key;
    }
    this.#shownChip = chip;
    this.#editor.setNames({
      pins: chip.ports.map((p) => p.name),
      signals: declaredNames(chip.code),
    });
    this.#editor.setDiagnostics([...compiled.errors, ...compiled.warnings]);
    // The design's breakpoints, solid where the code can stop — which is
    // nowhere at all while the package or the code has an error, since the
    // chip then runs no code.
    const runs = compiled.ok && !hasErrors(customChipProblems(chip));
    this.#editor.setBreakpoints(
      this.#state?.debug?.breakpoints?.[chip.id] ?? [],
      runs ? compiled.program.executableLines : [],
    );
    this.#editor.setCurrent(
      tab?.state === "paused" && tab.loc ? tab.loc : null,
    );
    this.#renderProblems(chip, compiled);
  }

  #renderProblems(chip, compiled) {
    const items = [];
    for (const p of customChipProblems(chip)) {
      items.push({
        severity: p.severity,
        where: t("chipdesign.problems.package"),
        text: t(`chipdesign.problem.${p.code}`, p.args),
      });
    }
    for (const d of [...compiled.errors, ...compiled.warnings]) {
      items.push({
        severity: d.severity,
        where: d.line > 0 ? t("chipdesign.problems.line", { line: d.line }) : t("chipdesign.problems.header"), // prettier-ignore
        text: t(`hdl.diag.${d.code}`, d.args),
        line: d.line > 0 ? d.line : null,
      });
    }
    if (!items.length) {
      this.#problems.replaceChildren(
        el("li", { class: "cd-problem cd-problem--none", text: t("chipdesign.problems.none") }), // prettier-ignore
      );
      return;
    }
    this.#problems.replaceChildren(
      ...items.map((item) =>
        el(
          "li",
          {
            class: `cd-problem cd-problem--${item.severity}`,
            tabIndex: item.line ? 0 : -1,
            onClick: () => item.line && this.#editor.goToLine(item.line),
            onKeydown: (e) => {
              if (e.key === "Enter" && item.line)
                this.#editor.goToLine(item.line);
            },
          },
          [
            el("span", { class: "cd-problem-where", text: item.where }),
            el("span", { class: "cd-problem-text", text: item.text }),
          ],
        ),
      ),
    );
  }

  #showNotice(notice) {
    this.#notice.textContent = t(`chipdesign.notice.${notice.code}`, notice.args ?? {}); // prettier-ignore
    this.#notice.hidden = false;
    clearTimeout(this.#notice._timer);
    this.#notice._timer = setTimeout(() => {
      this.#notice.hidden = true;
    }, 6000);
  }

  // A redraw replaces everything the scrolled panes hold, and must leave the
  // reader where they were. (The browser's own scroll anchoring is switched
  // off on them in app.css: its anchor is a node the redraw has replaced.)

  /** The scrolled panes' offsets, as `[pane, top, left]`. */
  #paneOffsets() {
    const panes = [this.#diagram.element, this.#formPane, this.#problems];
    return panes.map((p) => [p, p.scrollTop, p.scrollLeft]);
  }

  #restorePanes(offsets) {
    for (const [pane, top, left] of offsets) {
      if (pane.scrollTop !== top) pane.scrollTop = top;
      if (pane.scrollLeft !== left) pane.scrollLeft = left;
    }
  }

  // ── Edits ───────────────────────────────────────────────────────────────

  /** A package edit: applied locally at once, sent at once. The form was
      drawn before any typing since, so the chip it hands back carries the
      code as it was then — the code is the editor's, and goes as it is now. */
  #edited(chip) {
    this.#flushCode();
    const code = this.#design(chip.id)?.code ?? chip.code;
    this.#commit({ ...chip, code });
  }

  /** Typing: compiled and coloured locally at once, sent after a pause. */
  #typed(text) {
    const id = this.#state?.focus;
    const chip = id ? this.#design(id) : null;
    if (!chip || this.#debugging) return;
    const next = { ...chip, code: text };
    const token = ++this.#token;
    this.#local.set(id, { chip: next, token });
    const offsets = this.#paneOffsets();
    this.#renderCode(next, null);
    this.#diagram.render(next);
    this.#restorePanes(offsets);
    // Typing still waiting in ANOTHER design (a tab switched to mid-pause)
    // goes now, rather than being cancelled by this design's timer.
    if (this.#codePending !== id) this.#flushCode();
    clearTimeout(this.#codeTimer);
    this.#codePending = id;
    this.#codeTimer = setTimeout(() => {
      this.#codeTimer = null;
      this.#codePending = null;
      this.#send({ kind: "update", chip: next, token });
    }, CODE_DEBOUNCE_MS);
  }

  /** Send any typing still waiting for its pause — the design it was typed
      in, whichever is on screen now. */
  #flushCode() {
    if (!this.#codeTimer) return;
    clearTimeout(this.#codeTimer);
    this.#codeTimer = null;
    const id = this.#codePending;
    this.#codePending = null;
    const local = id ? this.#local.get(id) : null;
    if (local) this.#send({ kind: "update", chip: local.chip, token: local.token }); // prettier-ignore
  }

  #commit(chip) {
    const token = ++this.#token;
    this.#local.set(chip.id, { chip, token });
    this.#send({ kind: "update", chip, token });
    this.#render();
  }

  #debugCmd(cmd) {
    const tab = this.#focusedTab();
    if (tab) this.#send({ kind: "debug", cmd, compId: tab.compId });
  }

  #arm(patch) {
    const tab = this.#focusedTab();
    if (tab) this.#send({ kind: "arm", compId: tab.compId, ...patch });
  }

  /** A line number clicked: a breakpoint on the design's line, or none. The
      typing still waiting for its pause goes first, so the host numbers the
      line against the same text the gutter does. */
  #toggleBreakpoint(line) {
    const chip = this.#shownChip;
    if (!chip) return;
    this.#flushCode();
    const tab = this.#debugging ? this.#focusedTab() : null;
    this.#send({
      kind: "breakpoint",
      ref: chip.id,
      line,
      compId: tab?.compId ?? null,
    });
  }

  // ── The dividers ────────────────────────────────────────────────────────

  /** The package's width in px, or null for the window's own (app.css
      clamps either to what the window has room for). */
  #setLeftWidth(px, report = false) {
    if (Number.isFinite(px) && px > 0) {
      this.#main.style.setProperty("--cd-left-width", `${Math.round(px)}px`);
    } else {
      this.#main.style.removeProperty("--cd-left-width");
    }
    if (report) this.#onLayout?.({ chipDesignerLeftWidth: Number.isFinite(px) ? Math.round(px) : null }); // prettier-ignore
  }

  /** The module header's height in px, or null for as tall as it needs up
      to app.css's cap (either way it gives way, and scrolls, when the code
      is short of room). */
  #setHeaderHeight(px, report = false) {
    const set = Number.isFinite(px) && px > 0;
    this.#headerText.style.flexBasis = set ? `${Math.round(px)}px` : "";
    this.#headerText.style.maxHeight = set ? "none" : "";
    if (report) this.#onLayout?.({ chipDesignerHeaderHeight: Number.isFinite(px) ? Math.round(px) : null }); // prettier-ignore
  }

  #onSplitDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.#left.getBoundingClientRect().width;
    const room = this.#main.getBoundingClientRect().width;
    let width = startW;
    this.#split.classList.add("cd-split--active");
    const end = beginPointerGesture(this.#split, e.pointerId, {
      onMove: (ev) => {
        const max = Math.max(MIN_LEFT, room - MIN_RIGHT);
        width = Math.min(max, Math.max(MIN_LEFT, startW + ev.clientX - startX)); // prettier-ignore
        this.#setLeftWidth(width);
      },
      // Kept wherever it was let go — an abort included: the panes are
      // already showing that width, and springing back would be the surprise.
      onEnd: () => {
        end();
        this.#split.classList.remove("cd-split--active");
        if (width !== startW) this.#setLeftWidth(width, true);
      },
    });
  }

  #onHeaderSplitDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const header = this.#headerText;
    const startY = e.clientY;
    const startH = header.getBoundingClientRect().height;
    const style = getComputedStyle(header);
    const min = parseFloat(style.minHeight) || 0;
    // No taller than the header's own text, and never so tall the code has
    // less than its floor.
    const editorMin = parseFloat(getComputedStyle(this.#editor.element).minHeight) || 0; // prettier-ignore
    const room =
      this.#codeBox.getBoundingClientRect().height -
      this.#footer.getBoundingClientRect().height -
      editorMin;
    const max = Math.max(min, Math.min(header.scrollHeight, room));
    let height = startH;
    this.#headerSplit.classList.add("cd-code-split--active");
    const end = beginPointerGesture(this.#headerSplit, e.pointerId, {
      onMove: (ev) => {
        height = Math.min(max, Math.max(min, startH + ev.clientY - startY));
        this.#setHeaderHeight(height);
      },
      onEnd: () => {
        end();
        this.#headerSplit.classList.remove("cd-code-split--active");
        if (height !== startH) this.#setHeaderHeight(height, true);
      },
    });
  }

  // ── Two-way hover linking ───────────────────────────────────────────────

  /** The code's pointer over a name: light that pin (those pins) on the
      package — only the paused unit's, while debugging one. */
  #nameHovered(run) {
    const chip = this.#shownChip;
    if (!chip || !run || run.cls !== "pin") {
      this.#diagram.setLinked(null);
      return;
    }
    const tab = this.#debugging ? this.#focusedTab() : null;
    const unit = tab ? tab.unit : null;
    this.#diagram.setLinked(pinsForName(chip, run.name, run.bit, unit));
  }

  /** The package's pointer over a pin: light its names in the code. */
  #pinHovered(pin) {
    const chip = this.#shownChip;
    if (!chip || pin == null) {
      this.#editor.setLinked(null);
      this.#diagram.setLinked(null);
      return;
    }
    const tab = this.#debugging ? this.#focusedTab() : null;
    const [first] = namesForPin(chip, pin, tab ? tab.unit : null);
    this.#editor.setLinked(first?.name ?? null, first?.bit ?? null);
    this.#diagram.setLinked(first ? [pin] : null);
  }
}

/** A debugger tab's badge text. */
function badgeOf(tab) {
  if (tab.waitingAtSettled) return t("chipdesign.tab.settled");
  if (tab.state === "paused") {
    return tab.held
      ? t("chipdesign.tab.pausedHeld", { count: tab.held })
      : t("chipdesign.tab.paused");
  }
  if (tab.state === "detached") return t("chipdesign.tab.detached");
  return t("chipdesign.tab.idle");
}
