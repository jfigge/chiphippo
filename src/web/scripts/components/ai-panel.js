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

// ai-panel.js — describe a circuit, get one to place (Feature 260).
//
// A bottom-docked, resizable panel built on the same shell as the logic
// analyzer (`setVisible` / `onVisibilityChange` / `onHeightChange`, a draggable
// top edge). What it adds is a conversation: a prompt goes out, the reply
// streams back, and the panel runs it through the ladder in ai/generate.js.
//
// TWO RULES SHAPE EVERYTHING HERE:
//
//   1. NOTHING UNPROVEN REACHES THE DESK. A reply is compiled, seated,
//      net-checked, settled and run against its own tests before the user is
//      offered anything. A build that fails is reported, never placed.
//   2. THE USER PLACES IT. A passing build ARMS a ghost rather than dropping a
//      circuit on the desk — so the user sees the whole thing tracking the
//      cursor, snapping to what is already there and red where it will not fit,
//      and one click (or Escape) decides.
//
// A failure that is the SPEC's fault goes back to the model as structured
// faults, capped at two rounds. A failure that is OUR fault (a severed net, an
// unseated part) is not sent back at all — the model cannot fix the compiler,
// so re-asking would only spend the user's tokens.

import { el } from "../dom.js";
import { buildRepairMessage, buildSystemPrompt } from "../ai/catalog-brief.js";
import { buildFromReply, partitionFaults } from "../ai/generate.js";
import { addUsage, formatTotal, formatUsage } from "../ai/usage.js";

const MIN_PANEL_H = 160;
const DEFAULT_PANEL_H = 280;
const MAX_PANEL_FRAC = 0.6;

/** How many times a failing netlist is handed back for repair. */
const MAX_REPAIRS = 2;

const SEND_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="22" y1="2" x2="11" y2="13"/>' +
  '<polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

export class AiPanel {
  #el;
  #log;
  #input;
  #send;
  #resize;
  #status;
  #usage;

  #config;
  #onVisibilityChange;
  #onHeightChange;
  #onDesign;
  #isLocked;

  #height = DEFAULT_PANEL_H;
  #resizeStartY = null;
  #resizeStartH = 0;

  #requestId = null; // the in-flight generation, or null
  #stream = ""; // text accumulated for the current request
  #streamRow = null; // the "thinking…" row it is reported through
  #history = []; // the conversation sent to the provider
  #repairs = 0; // repair rounds spent on the current ask

  // Tokens. Two scopes: what the ask in hand has cost across all its repair
  // rounds, and what everything since the last Clear has cost. A repair round
  // is a whole extra API call, so a design that took three tries is reported
  // as one line saying so rather than three lines nobody adds up.
  #sendUsage = null;
  #calls = 0;
  #session = null;
  #sends = 0;

  // `ai:start` answers with the request id, but main's `ai:delta` / `ai:done`
  // pushes are a SEPARATE message stream — nothing guarantees the reply lands
  // first. A first fragment that beats it would otherwise be dropped, which
  // reads as text going missing. So events arriving before the id is known are
  // held and replayed once it is.
  #starting = false;
  #early = [];

  /**
   * @param {HTMLElement} container - the app shell; the panel docks along its
   *   bottom edge, exactly as the analyzer does.
   * @param {object} opts
   * @param {()=>object} opts.config - the current `settings.ai`, read fresh on
   *   every send so a Settings change needs no wiring back to here.
   * @param {(clip:object)=>void} opts.onDesign - hand a verified design clip to
   *   the desk (the controller arms it as a ghost).
   * @param {()=>boolean} [opts.isLocked] - true while the sim is running, when
   *   the desk refuses edits and a build could not be placed anyway.
   * @param {number} [opts.height]
   * @param {(visible:boolean)=>void} [opts.onVisibilityChange]
   * @param {(height:number)=>void} [opts.onHeightChange]
   */
  constructor(
    container,
    {
      config,
      onDesign,
      isLocked,
      height,
      onVisibilityChange,
      onHeightChange,
    } = {},
  ) {
    this.#config = config ?? (() => ({}));
    this.#onDesign = onDesign;
    this.#isLocked = isLocked ?? (() => false);
    this.#onVisibilityChange = onVisibilityChange;
    this.#onHeightChange = onHeightChange;

    this.#buildDom();
    container.append(this.#el);
    this.#applyHeight(Number.isFinite(height) ? height : DEFAULT_PANEL_H);

    window.addEventListener("chiphippo:ai-delta", (e) =>
      this.#route("delta", e.detail),
    );
    window.addEventListener("chiphippo:ai-done", (e) =>
      this.#route("done", e.detail),
    );
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  #buildDom() {
    this.#log = el("div", {
      class: "ai-log",
      role: "log",
      "aria-live": "polite",
    });
    this.#status = el("span", { class: "ai-status", text: "" });
    // Its own element rather than a second writer of `#status`, which `#setBusy`
    // owns outright. It sits to the RIGHT of the status because `.ai-tools`
    // packs to flex-end: width changes shift whatever is to their left, so this
    // way the number does not slide sideways every time "Designing…" appears.
    this.#usage = el("span", { class: "ai-usage", text: "", hidden: true });

    this.#input = el("textarea", {
      class: "ai-input",
      rows: "2",
      placeholder:
        "Describe a circuit — e.g. “add two 8-bit numbers with a carry, " +
        "switches for the inputs and an LED bar for the sum”",
      "aria-label": "Describe the circuit to build",
    });
    // Enter sends; Shift+Enter is a newline. A multi-line description is
    // normal here, so the modifier is on the newline rather than the send.
    this.#input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.#onSend();
      }
      // The desk's own shortcuts must not fire while typing into the panel.
      e.stopPropagation();
    });

    this.#send = el("button", {
      class: "ai-send",
      type: "button",
      title: "Build this circuit (Enter)",
      "aria-label": "Build this circuit",
      onClick: () => this.#onSend(),
    });
    this.#send.innerHTML = SEND_SVG;

    const header = el("div", { class: "ai-header" }, [
      el("span", { class: "ai-title", text: "AI circuit builder" }),
      el("div", { class: "ai-tools" }, [
        this.#status,
        this.#usage,
        el("button", {
          class: "ai-btn",
          type: "button",
          text: "Clear",
          title: "Clear the conversation and start a new design",
          onClick: () => this.#clear(),
        }),
      ]),
      el("button", {
        class: "ai-close",
        type: "button",
        title: "Close the AI builder",
        "aria-label": "Close the AI builder",
        text: "×",
        onClick: () => this.setVisible(false),
      }),
    ]);

    this.#resize = el("div", {
      class: "ai-resize",
      title: "Drag to resize the AI builder",
      "aria-hidden": "true",
    });
    this.#resize.addEventListener("pointerdown", (e) => this.#onResizeDown(e));
    this.#resize.addEventListener("pointermove", (e) => this.#onResizeMove(e));
    this.#resize.addEventListener("pointerup", (e) => this.#onResizeUp(e));

    this.#el = el(
      "aside",
      { class: "ai-panel", "aria-label": "AI circuit builder", hidden: true },
      [
        this.#resize,
        header,
        this.#log,
        el("div", { class: "ai-compose" }, [this.#input, this.#send]),
      ],
    );

    this.#say(
      "note",
      "Describe a circuit and it will be designed, built, simulated and " +
        "tested before you are offered it to place. Set up your own AI " +
        "connection first in Settings ▸ AI.",
    );
  }

  get element() {
    return this.#el;
  }

  get visible() {
    return !this.#el.hidden;
  }

  setVisible(on) {
    const was = this.visible;
    this.#el.hidden = !on;
    if (on) this.#input.focus();
    if (was !== on) this.#onVisibilityChange?.(on);
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  // ── Sizing (identical discipline to the analyzer's) ────────────────────────

  #maxHeight() {
    const half = Math.floor((window.innerHeight || 0) * MAX_PANEL_FRAC);
    return Math.max(MIN_PANEL_H, half);
  }

  #applyHeight(h) {
    const clamped = Math.round(
      Math.min(this.#maxHeight(), Math.max(MIN_PANEL_H, h)),
    );
    this.#height = clamped;
    this.#el.style.height = `${clamped}px`;
    return clamped;
  }

  #onResizeDown(e) {
    e.preventDefault();
    this.#resizeStartY = e.clientY;
    this.#resizeStartH = this.#el.getBoundingClientRect().height;
    this.#resize.setPointerCapture?.(e.pointerId);
    this.#resize.classList.add("ai-resize--active");
  }

  #onResizeMove(e) {
    if (this.#resizeStartY == null) return;
    this.#applyHeight(this.#resizeStartH - (e.clientY - this.#resizeStartY));
  }

  #onResizeUp(e) {
    if (this.#resizeStartY == null) return;
    this.#resizeStartY = null;
    this.#resize.releasePointerCapture?.(e.pointerId);
    this.#resize.classList.remove("ai-resize--active");
    this.#onHeightChange?.(this.#height);
  }

  // ── The transcript ─────────────────────────────────────────────────────────

  /** Append a row. `kind` ∈ you | note | working | ok | fail. */
  #say(kind, text) {
    const row = el("div", { class: `ai-row ai-row--${kind}` }, [
      el("p", { class: "ai-row-text", text }),
    ]);
    this.#log.append(row);
    this.#log.scrollTop = this.#log.scrollHeight;
    return row;
  }

  /** A row with a bulleted list under it — the shape every fault list takes. */
  #sayList(kind, text, items) {
    const row = this.#say(kind, text);
    if (items.length) {
      row.append(
        el(
          "ul",
          { class: "ai-row-list" },
          items.map((t) => el("li", { text: t })),
        ),
      );
      this.#log.scrollTop = this.#log.scrollHeight;
    }
    return row;
  }

  #clear() {
    if (this.#requestId) this.#cancel();
    this.#history = [];
    this.#repairs = 0;
    this.#sendUsage = null;
    this.#calls = 0;
    this.#session = null;
    this.#sends = 0;
    this.#paintTotal();
    this.#log.replaceChildren();
    this.#say("note", "Cleared. Describe a new circuit.");
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  /** Repaint the header total. Hidden when empty — `.ai-tools` has a gap, so an
   *  empty-but-present span still costs a space. */
  #paintTotal() {
    const { text, title } = formatTotal(this.#session, this.#sends);
    this.#usage.textContent = text;
    this.#usage.title = title;
    this.#usage.hidden = !text;
  }

  /**
   * Close out one ask: report what it cost, and fold it into the session.
   *
   * Called at the END of every terminal branch rather than hooked onto
   * `#setBusy(false)`, which fires at exactly the same five points but does so
   * BEFORE `#accept` writes its summary — the cost belongs under the result it
   * describes, not above it.
   */
  #settle() {
    if (this.#sendUsage) {
      const line = formatUsage(this.#sendUsage, this.#calls);
      if (line) this.#say("note", line);
      this.#session = addUsage(this.#session, this.#sendUsage);
      this.#sends += 1;
      this.#paintTotal();
    }
    this.#sendUsage = null;
    this.#calls = 0;
  }

  #setBusy(busy, label = "") {
    this.#status.textContent = label;
    this.#input.disabled = busy;
    this.#send.classList.toggle("ai-send--busy", busy);
    this.#send.title = busy
      ? "Cancel this build"
      : "Build this circuit (Enter)";
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  #onSend() {
    // While a generation is in flight the same button cancels it — one control
    // for one activity, rather than a Stop that only exists sometimes.
    if (this.#requestId) {
      this.#cancel();
      return;
    }
    const prompt = this.#input.value.trim();
    if (!prompt) return;
    if (this.#isLocked()) {
      this.#say("fail", "Stop the simulation before building a new circuit.");
      return;
    }
    this.#input.value = "";
    this.#repairs = 0;
    this.#sendUsage = null;
    this.#calls = 0;
    this.#history.push({ role: "user", content: prompt });
    this.#say("you", prompt);
    this.#request();
  }

  /**
   * Note the tokens a cancelled round already burned are not counted: nulling
   * the id here is what makes `#onDone` drop the reply that follows, usage and
   * all. A known undercount on a rare path, left alone deliberately — closing
   * it means remembering the abandoned id and folding its usage in without
   * writing to the transcript, which is more state machine than the accuracy
   * is worth.
   */
  #cancel() {
    const id = this.#requestId;
    this.#requestId = null;
    this.#setBusy(false);
    if (this.#streamRow) {
      this.#streamRow.remove();
      this.#streamRow = null;
    }
    window.chiphippo?.ai?.cancel(id);
    this.#say("note", "Cancelled.");
  }

  async #request() {
    this.#stream = "";
    this.#starting = true;
    this.#early = [];
    this.#setBusy(true, "Designing…");
    this.#streamRow = this.#say("working", "Designing the circuit…");

    let started;
    try {
      started = await window.chiphippo?.ai?.start(
        { ...this.#config() },
        buildSystemPrompt(),
        this.#history,
      );
    } catch (err) {
      started = { ok: false, error: String(err?.message ?? err) };
    }
    this.#starting = false;
    const early = this.#early;
    this.#early = [];
    if (!started?.ok) {
      this.#finishStream();
      this.#setBusy(false);
      this.#say("fail", started?.error ?? "The request could not be started.");
      this.#settle();
      return;
    }
    this.#requestId = started.requestId;
    for (const [type, detail] of early) this.#route(type, detail);
  }

  /** Dispatch a push, holding it if the request id is not known yet. */
  #route(type, detail) {
    if (this.#starting && this.#requestId == null) {
      this.#early.push([type, detail]);
      return;
    }
    if (type === "delta") this.#onDelta(detail);
    else this.#onDone(detail);
  }

  #onDelta(detail) {
    if (!detail || detail.requestId !== this.#requestId) return;
    this.#stream += detail.text ?? "";
    if (this.#streamRow) {
      // The reply is JSON, not prose, so showing it would be noise — the
      // character count is the honest progress signal.
      this.#streamRow.querySelector(".ai-row-text").textContent =
        `Designing the circuit… (${this.#stream.length} characters)`;
    }
  }

  #finishStream() {
    if (this.#streamRow) {
      this.#streamRow.remove();
      this.#streamRow = null;
    }
  }

  #onDone(detail) {
    if (!detail || detail.requestId !== this.#requestId) return;
    this.#requestId = null;
    // The single ingestion point: every round lands here, whatever it did.
    this.#sendUsage = addUsage(this.#sendUsage, detail.usage);
    this.#calls += 1;
    this.#finishStream();
    if (!detail.ok) {
      this.#setBusy(false);
      if (!detail.cancelled)
        this.#say("fail", detail.error ?? "The request failed.");
      this.#settle();
      return;
    }
    this.#setBusy(true, "Building…");
    // Yield once so "Building…" paints before the compiler + engine run — the
    // ladder settles a real circuit, which is not instant on a large design.
    setTimeout(() => this.#consume(detail.text ?? this.#stream), 0);
  }

  // ── The ladder ─────────────────────────────────────────────────────────────

  #consume(text) {
    const built = buildFromReply(text);
    if (built.ok) {
      this.#setBusy(false);
      this.#history.push({ role: "assistant", content: text });
      this.#accept(built);
      this.#settle();
      return;
    }

    const { abort, repair } = partitionFaults(built.faults);
    if (abort.length) {
      // Our bug. Say so plainly rather than blaming the model, and do not
      // spend a repair round on something it cannot influence.
      this.#setBusy(false);
      this.#sayList(
        "fail",
        "The circuit was described correctly but could not be built. This is " +
          "a fault in Chip Hippo's compiler, not in the design.",
        abort.map((f) => `${f.code}: ${f.message}`),
      );
      this.#settle();
      return;
    }

    if (this.#repairs >= MAX_REPAIRS) {
      this.#setBusy(false);
      this.#sayList(
        "fail",
        `Gave up after ${MAX_REPAIRS} repair attempts. What is still wrong:`,
        repair.map((f) => `${f.code}: ${f.message}`),
      );
      this.#settle();
      return;
    }

    this.#repairs += 1;
    this.#sayList(
      "note",
      `That design did not pass — asking for a fix (attempt ${this.#repairs} of ${MAX_REPAIRS}):`,
      repair.map((f) => `${f.code}: ${f.message}`),
    );
    this.#history.push({ role: "assistant", content: text });
    this.#history.push({ role: "user", content: buildRepairMessage(repair) });
    this.#request();
  }

  #accept(built) {
    const passed = built.results.filter((r) => r.ok).length;
    const tested = built.results.length;
    const doc = built.document;
    const summary =
      `${built.title || "Circuit"} — ${doc.components.length} parts, ` +
      `${doc.wires.length} wires, ${doc.boards.length} board strips.` +
      (tested ? ` ${passed}/${tested} of its own tests passed.` : "");

    this.#sayList(
      "ok",
      summary,
      built.results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}`),
    );
    if (built.warnings.length) {
      this.#sayList(
        "note",
        "Built with notes:",
        built.warnings.map((w) => w.message ?? String(w)),
      );
    }
    this.#say("note", "Click to place it on the desk, or press Escape.");
    this.#onDesign?.(built.clip);
  }
}
