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
import { t } from "../i18n.js";
import { buildRepairMessage, buildSystemPrompt } from "../ai/catalog-brief.js";
import { buildStepsFromReply, partitionFaults } from "../ai/generate.js";
import { addUsage, formatTotal, formatUsage } from "../ai/usage.js";
import { PromptHistory } from "../ai/prompt-history.js";

const MIN_PANEL_H = 160;
const DEFAULT_PANEL_H = 280;
const MAX_PANEL_FRAC = 0.6;

/** How many times a failing netlist is handed back for repair. */
const MAX_REPAIRS = 2;

/**
 * Hand the thread back so a label can paint, then continue.
 *
 * `scheduler.yield()` is the right primitive and resumes at the front of the
 * queue, so stepping a ladder does not fall behind ordinary tasks.
 * `requestAnimationFrame` is deliberately NOT used: it does not fire in a
 * hidden window, so a build would stall the moment the user switched away —
 * the one time they are most likely to leave it running.
 */
const yieldToPaint = () =>
  globalThis.scheduler?.yield
    ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));

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
  #onHistoryChange;

  // What the user has asked for before, and where they are in it. The cursor
  // and the parked draft live in the model, not here — see prompt-history.js.
  #past;

  #height = DEFAULT_PANEL_H;
  #resizeStartY = null;
  #resizeStartH = 0;

  #requestId = null; // the in-flight generation, or null
  #stream = ""; // text accumulated for the current request
  #streamRow = null; // the "thinking…" row it is reported through
  #history = []; // the conversation sent to the provider
  #repairs = 0; // repair rounds spent on the current ask
  #round = ""; // " (fix 1 of 2)", or "" on the first attempt

  // The ladder in flight, or null. It exists for two reasons, and the SECOND
  // is the important one: the build now spans many tasks, so there is a real
  // window in which the panel is working with no `#requestId` set — and a send
  // during that window would start a whole new PAID request. Today that is
  // prevented only by accident (the input is cleared, so the click reads an
  // empty prompt and returns), which is exactly the kind of safety that stops
  // being true the moment someone changes something unrelated.
  #building = null;

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
   * @param {Array<string>} [opts.history] - `settings.aiHistory`, newest first.
   *   The user's own prompt history, kept in the APP's settings rather than the
   *   project, so it follows them across every design they open.
   * @param {(entries:Array<string>)=>void} [opts.onHistoryChange]
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
      history,
      onHistoryChange,
      onVisibilityChange,
      onHeightChange,
    } = {},
  ) {
    this.#config = config ?? (() => ({}));
    this.#onDesign = onDesign;
    this.#isLocked = isLocked ?? (() => false);
    this.#onVisibilityChange = onVisibilityChange;
    this.#onHeightChange = onHeightChange;
    this.#past = new PromptHistory(history);
    this.#onHistoryChange = onHistoryChange;

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
      placeholder: t("ai.inputPlaceholder"),
      "aria-label": t("ai.inputLabel"),
    });
    // Enter sends; Shift+Enter is a newline. A multi-line description is
    // normal here, so the modifier is on the newline rather than the send.
    this.#input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.#onSend();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        this.#onArrow(e);
      }
      // The desk's own shortcuts must not fire while typing into the panel.
      e.stopPropagation();
    });
    // Any edit ends the navigation: the text on screen is now the user's, not
    // a recalled one, so the next Up should start again from the newest entry
    // rather than continuing from wherever they had wandered to.
    this.#input.addEventListener("input", () => this.#past.reset());

    this.#send = el("button", {
      class: "ai-send",
      type: "button",
      title: t("ai.buildTitle"),
      "aria-label": t("ai.build"),
      onClick: () => this.#onSend(),
    });
    this.#send.innerHTML = SEND_SVG;

    const header = el("div", { class: "ai-header" }, [
      el("span", { class: "ai-title", text: t("ai.title") }),
      el("div", { class: "ai-tools" }, [
        this.#status,
        this.#usage,
        el("button", {
          class: "ai-btn",
          type: "button",
          text: t("common.clear"),
          title: t("ai.clearTitle"),
          onClick: () => this.#clear(),
        }),
      ]),
      el("button", {
        class: "ai-close",
        type: "button",
        title: t("ai.close"),
        "aria-label": t("ai.close"),
        text: "×",
        onClick: () => this.setVisible(false),
      }),
    ]);

    this.#resize = el("div", {
      class: "ai-resize",
      title: t("ai.resize"),
      "aria-hidden": "true",
    });
    this.#resize.addEventListener("pointerdown", (e) => this.#onResizeDown(e));
    this.#resize.addEventListener("pointermove", (e) => this.#onResizeMove(e));
    this.#resize.addEventListener("pointerup", (e) => this.#onResizeUp(e));

    this.#el = el(
      "aside",
      { class: "ai-panel", "aria-label": t("ai.title"), hidden: true },
      [
        this.#resize,
        header,
        this.#log,
        el("div", { class: "ai-compose" }, [this.#input, this.#send]),
      ],
    );

    this.#say("note", t("ai.intro"));
  }

  get element() {
    return this.#el;
  }

  /**
   * Re-render the panel's CHROME in the new language (see app.js's
   * `relabelChrome`).
   *
   * The conversation LOG is deliberately left exactly as it is. Those rows are a
   * transcript — what was asked, and what the build reported at the time — and a
   * transcript is a record, not a label: re-wording it would be rewriting
   * history, and half of it (a provider's error text, a fault's message) has no
   * catalog key to re-resolve anyway. New rows arrive in the new language.
   */
  relocalize() {
    this.#input.placeholder = t("ai.inputPlaceholder");
    this.#input.setAttribute("aria-label", t("ai.inputLabel"));
    this.#send.title = t("ai.buildTitle");
    this.#send.setAttribute("aria-label", t("ai.build"));
    this.#el.setAttribute("aria-label", t("ai.title"));
    this.#resize.title = t("ai.resize");
    const title = this.#el.querySelector(".ai-title");
    if (title) title.textContent = t("ai.title");
    const clear = this.#el.querySelector(".ai-btn");
    if (clear) {
      clear.textContent = t("common.clear");
      clear.title = t("ai.clearTitle");
    }
    const close = this.#el.querySelector(".ai-close");
    if (close) {
      close.title = t("ai.close");
      close.setAttribute("aria-label", t("ai.close"));
    }
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
    if (this.#requestId || this.#building) this.#cancel();
    this.#history = [];
    // The CONVERSATION is cleared; the prompt history is not. It is the user's,
    // spans every project, and outlives any one design — so Clear only returns
    // the cursor home, exactly as sending does.
    this.#past.reset();
    this.#repairs = 0;
    this.#round = "";
    this.#sendUsage = null;
    this.#calls = 0;
    this.#session = null;
    this.#sends = 0;
    this.#paintTotal();
    this.#log.replaceChildren();
    this.#say("note", t("ai.cleared"));
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
    this.#send.title = busy ? t("ai.cancelTitle") : t("ai.buildTitle");
  }

  // ── History ────────────────────────────────────────────────────────────────

  /**
   * Up/Down: move within the text first, recall a past prompt at the edges.
   *
   * The rule is the caret's position, not a mode. An arrow does what an arrow
   * always does until there is nowhere left for it to go IN THE TEXT — caret at
   * the very start for Up, the very end for Down — and only then does it reach
   * for history. A browser already collapses a multi-line box to those two
   * points (Up on the first line goes to offset 0, Down on the last to the
   * end), so a long prompt takes one extra press to step out of, which is
   * exactly what stops a stray arrow from wiping what you were writing.
   *
   * A SELECTION is never an edge: arrows collapse it, so that keystroke belongs
   * to the textarea.
   */
  #onArrow(e) {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const box = this.#input;
    const { selectionStart: from, selectionEnd: to, value } = box;
    if (from !== to) return;

    const up = e.key === "ArrowUp";
    if (up ? from !== 0 : from !== value.length) return;

    const text = up ? this.#past.back(value) : this.#past.forward();
    if (text == null) return; // nowhere further to go — leave the box alone
    e.preventDefault();
    box.value = text;
    // Land the caret on the edge the user ARRIVED from, so the same key keeps
    // walking: at the top after an Up, at the bottom after a Down. Without
    // this, one recall would strand the caret and the next press would just
    // move through the text it had loaded.
    const caret = up ? 0 : text.length;
    box.setSelectionRange(caret, caret);
    // A recalled multi-line prompt is taller than the box; show the end the
    // caret is on rather than whichever the browser happens to keep.
    box.scrollTop = up ? 0 : box.scrollHeight;
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  #onSend() {
    // While a generation is in flight the same button cancels it — one control
    // for one activity, rather than a Stop that only exists sometimes. That now
    // covers the BUILD as well as the request: the ladder spans many tasks, so
    // "in flight" is no longer the same thing as "has a request id".
    if (this.#requestId || this.#building) {
      this.#cancel();
      return;
    }
    const prompt = this.#input.value.trim();
    if (!prompt) return;
    if (this.#isLocked()) {
      this.#say("fail", t("ai.lockedRunning"));
      return;
    }
    this.#input.value = "";
    // Remembered on SEND, which also ends any navigation in progress — so the
    // next Up starts from this prompt rather than from wherever the user had
    // arrowed back to. Persisted through the app's settings, not the project's.
    //
    // Two statements ON PURPOSE. Folded into `#onHistoryChange?.(remember(…))`
    // the optional call short-circuits WITHOUT EVALUATING ITS ARGUMENT, so a
    // panel nobody is listening to would quietly stop recording anything.
    const entries = this.#past.remember(prompt);
    this.#onHistoryChange?.(entries);
    this.#repairs = 0;
    this.#round = "";
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
    // Dropping the ladder is what `#build` checks for, so this abandons a
    // build in progress too — impossible while it ran as one atomic task. No
    // tokens come back (they were spent the moment the reply arrived); what it
    // saves is waiting out a build you have already decided against.
    this.#building = null;
    this.#requestId = null;
    this.#setBusy(false);
    if (this.#streamRow) {
      this.#streamRow.remove();
      this.#streamRow = null;
    }
    if (id != null) window.chiphippo?.ai?.cancel(id);
    this.#say("note", t("ai.cancelled"));
  }

  async #request() {
    this.#stream = "";
    this.#starting = true;
    this.#early = [];
    // Name the repair round UP FRONT. It was previously announced only after
    // the round it fixed had already failed, so the second request looked idle
    // for its whole duration.
    const round = this.#repairs
      ? ` ${t("ai.fixRound", { n: this.#repairs, total: MAX_REPAIRS })}`
      : "";
    this.#setBusy(true, t("ai.designing"));
    this.#streamRow = this.#say("working", t("ai.designingRow", { round }));
    this.#round = round;

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
      this.#say("fail", started?.error ?? t("ai.startFailed"));
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
        `Designing the circuit${this.#round}… ` +
        `(${this.#stream.length} characters)`;
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
        this.#say("fail", detail.error ?? t("ai.requestFailed"));
      this.#settle();
      return;
    }
    this.#setBusy(true, t("ai.building"));
    this.#build(detail.text ?? this.#stream);
  }

  // ── The ladder ─────────────────────────────────────────────────────────────

  /**
   * Step the build, painting each gate and yielding the thread between them.
   *
   * The ladder is where the time actually goes — L5 settles the whole circuit
   * and L7 runs every acceptance test — so running it in one task means a
   * frozen window under one unchanging word. A progress CALLBACK would not fix
   * that: nothing repaints until the task ends. Only yielding does.
   */
  async #build(text) {
    const steps = buildStepsFromReply(text);
    this.#building = steps;
    this.#streamRow = this.#say("working", t("ai.buildingRow"));

    let step;
    try {
      step = steps.next();
      while (!step.done) {
        if (this.#streamRow) {
          this.#streamRow.querySelector(".ai-row-text").textContent =
            step.value.label;
        }
        await yieldToPaint();
        // Cancelled (or superseded) while we were away — drop the ladder on
        // the floor. It is pure computation over its own copies, so abandoning
        // it mid-way leaves nothing behind to clean up.
        if (this.#building !== steps) return;
        step = steps.next();
      }
    } catch (err) {
      // Nothing in the ladder is supposed to throw — L7 already catches a
      // failing test. But this runs across many tasks with nobody awaiting it,
      // so an escape would otherwise be an unhandled rejection that left the
      // panel busy forever, with no way back but reloading.
      this.#building = null;
      this.#finishStream();
      this.#setBusy(false);
      this.#say("fail", t("ai.buildCrashed", { message: err?.message ?? err }));
      this.#settle();
      return;
    }

    this.#building = null;
    this.#finishStream();
    this.#consume(text, step.value);
  }

  #consume(text, built) {
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
        t("ai.compilerFault"),
        abort.map((f) => `${f.code}: ${f.message}`),
      );
      this.#settle();
      return;
    }

    if (this.#repairs >= MAX_REPAIRS) {
      this.#setBusy(false);
      this.#sayList(
        "fail",
        t("ai.gaveUp", { total: MAX_REPAIRS }),
        repair.map((f) => `${f.code}: ${f.message}`),
      );
      this.#settle();
      return;
    }

    this.#repairs += 1;
    this.#sayList(
      "note",
      t("ai.retrying", { n: this.#repairs, total: MAX_REPAIRS }),
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
      t("ai.summary", {
        title: built.title || t("ai.untitledCircuit"),
        parts: doc.components.length,
        wires: doc.wires.length,
        strips: doc.boards.length,
      }) + (tested ? ` ${t("ai.testsPassed", { passed, tested })}` : "");

    this.#sayList(
      "ok",
      summary,
      built.results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}`),
    );
    // The design's own explanation, at the moment the user is deciding whether
    // to place it. The same paragraph rides onto the desk as a caption, so it
    // is still there long after this conversation is gone.
    if (built.notes) this.#say("note", built.notes);
    if (built.warnings.length) {
      this.#sayList(
        "note",
        t("ai.builtWithNotes"),
        built.warnings.map((w) => w.message ?? String(w)),
      );
    }
    this.#say("note", t("ai.placeHint"));
    this.#onDesign?.(built.clip);
  }
}
