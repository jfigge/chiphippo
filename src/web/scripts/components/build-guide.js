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

// build-guide.js — the right-docked build-guide panel (Feature 140): a toggled
// aside with three tabs (BOM / Wiring / Steps) that FORMATS the pure plan from
// model/build-plan.js. It re-derives on every `chiphippo:doc-changed` while
// open (through its own NetlistCache, the same pattern the probe uses), so the
// guide never drifts from the live document. It owns no electrical logic — it
// only reads the DeskDoc and renders what buildPlan() returns.

import { clear, el } from "../dom.js";
import { t } from "../i18n.js";
import {
  buildPlan,
  BOM_SECTION_KEYS,
  STEP_GROUP_KEYS,
  bomSectionLabel,
  stepGroupLabel,
  warningCount,
  wireItemLabel,
} from "../model/build-plan.js";
import { planToRtf } from "../model/build-export.js";
import { NetlistCache } from "./netlist-cache.js";

/** The two tab ids, in display order; each label is `guide.tab.<id>`.
 *
 * There WAS a third, "wiring" — a net-centric list of every connection. The
 * numbered BOM plus the steps replaced it: each step now names the wire to run by
 * its own BOM item number and says where it goes, which is the same information
 * where you actually need it, in the order you do it in. A separate tab saying it
 * again is a second place to keep true. */
const TAB_IDS = ["bom", "steps"];

/** Download icon (Feather "download"), for the header export button. */
const DOWNLOAD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
  '<polyline points="7 10 12 15 17 10"/>' +
  '<line x1="12" y1="15" x2="12" y2="3"/></svg>';

export class BuildGuide {
  #doc;
  #netlist;
  #el;
  #body;
  #tabButtons = new Map();
  #warnBadge;
  #onVisibilityChange;
  #schemaName;
  #tab = "bom";
  #dirty = true; // re-derive lazily when shown / on change while shown

  /**
   * @param {HTMLElement} container - the desk row (app-main); the panel docks
   *   to its right.
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {(visible:boolean) => void} [opts.onVisibilityChange] - fired
   *   whenever the panel opens/closes (incl. its own close button), so the
   *   toolbar button + persisted setting stay in step.
   * @param {() => string} [opts.schemaName] - the current schematic's base name
   *   (no extension), used to name the exported bill-of-materials file.
   */
  constructor(container, { deskDoc, onVisibilityChange, netlist, schemaName }) {
    this.#doc = deskDoc;
    this.#netlist = netlist ?? new NetlistCache(deskDoc);
    this.#onVisibilityChange = onVisibilityChange;
    // No English default of its own: the one place this is read already falls
    // back to `t("common.untitled")`, and a hardcoded one here would win over
    // it (a truthy string) and ship English to every other language.
    this.#schemaName = schemaName ?? null;

    const tabs = el("div", { class: "build-guide-tabs", role: "tablist" });
    for (const id of TAB_IDS) {
      const btn = el("button", {
        class: "build-guide-tab",
        type: "button",
        role: "tab",
        text: t(`guide.tab.${id}`),
        dataset: { tab: id },
        "aria-selected": String(id === this.#tab),
        onClick: () => this.#selectTab(id),
      });
      this.#tabButtons.set(id, btn);
      tabs.append(btn);
    }

    this.#warnBadge = el("span", {
      class: "build-guide-warn-badge",
      hidden: true,
      title: t("guide.warnBadge"),
    });

    const downloadBtn = el("button", {
      class: "build-guide-download",
      type: "button",
      title: t("guide.downloadTitle"),
      "aria-label": t("guide.download"),
      onClick: () => this.#downloadBom(),
    });
    downloadBtn.innerHTML = DOWNLOAD_SVG;

    const header = el("div", { class: "build-guide-header" }, [
      el("div", { class: "build-guide-header-left" }, [
        el("span", { class: "build-guide-title" }, [
          el("span", {
            class: "build-guide-title-text",
            text: t("guide.title"),
          }),
          this.#warnBadge,
        ]),
        downloadBtn,
      ]),
      el("button", {
        class: "build-guide-close",
        type: "button",
        title: t("guide.close"),
        "aria-label": t("guide.close"),
        text: "×",
        onClick: () => this.setVisible(false),
      }),
    ]);

    this.#body = el("div", { class: "build-guide-body" });
    this.#el = el(
      "aside",
      { class: "build-guide", "aria-label": t("guide.title"), hidden: true },
      [header, tabs, this.#body],
    );
    container.append(this.#el);

    // Re-derive on any topology/name/bus change; only repaint while visible.
    window.addEventListener("chiphippo:doc-changed", () => {
      this.#dirty = true;
      if (this.visible) this.#render();
    });
    window.addEventListener("chiphippo:part-state", () => {
      this.#dirty = true;
      if (this.visible) this.#render();
    });
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
    if (on) this.#render();
    if (was !== on) this.#onVisibilityChange?.(on);
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  /**
   * Re-render in the new language (see app.js's `relabelChrome`). The plan is
   * WORDED by build-plan.js, which resolves its own strings through `tf()` on
   * every call — so the panel has to mark itself dirty rather than repaint the
   * plan it already derived, or the body would keep the old language's steps.
   */
  relocalize() {
    for (const [id, btn] of this.#tabButtons) {
      btn.textContent = t(`guide.tab.${id}`);
    }
    this.#warnBadge.title = t("guide.warnBadge");
    const title = this.#el.querySelector(".build-guide-title-text");
    if (title) title.textContent = t("guide.title");
    this.#el.setAttribute("aria-label", t("guide.title"));
    const download = this.#el.querySelector(".build-guide-download");
    download.title = t("guide.downloadTitle");
    download.setAttribute("aria-label", t("guide.download"));
    const close = this.#el.querySelector(".build-guide-close");
    close.title = t("guide.close");
    close.setAttribute("aria-label", t("guide.close"));
    this.#dirty = true;
    if (this.visible) this.#render();
  }

  #selectTab(id) {
    if (this.#tab === id) return;
    this.#tab = id;
    for (const [tabId, btn] of this.#tabButtons) {
      btn.setAttribute("aria-selected", String(tabId === id));
    }
    this.#renderBody();
  }

  /** Re-derive the plan only when the document changed since last time. */
  #ensurePlan() {
    if (this.#dirty) {
      this.#plan = buildPlan(this.#doc.toJSON(), this.#netlist.get());
      this.#dirty = false;
    }
    return this.#plan;
  }

  /** Re-derive the plan (if needed) and repaint the whole panel. */
  #render() {
    const plan = this.#ensurePlan();
    const n = plan.warnings.length;
    this.#warnBadge.textContent = n ? String(n) : "";
    this.#warnBadge.hidden = n === 0;
    this.#renderBody();
  }

  #plan = { bom: {}, nets: [], steps: [], warnings: [] };

  // ── Export (a Rich Text bill of materials; a browser download, no IPC) ───────

  /** Format the live plan as an .rtf document and download it. */
  #downloadBom() {
    const name = this.#schemaName?.() || t("common.untitled");
    const rtf = planToRtf(this.#ensurePlan(), { title: name });
    this.#download(
      new Blob([rtf], { type: "application/rtf" }),
      `${name}-bom.rtf`,
    );
  }

  #download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  #renderBody() {
    clear(this.#body);
    this.#body.append(this.#warningsBlock());
    if (this.#tab === "bom") this.#body.append(this.#bomView());
    else this.#body.append(this.#stepsView());
  }

  // ── Warnings banner (shown on every tab) ─────────────────────────────────
  #warningsBlock() {
    const warnings = this.#plan.warnings;
    if (!warnings.length) return el("div", { hidden: true });
    return el("div", { class: "build-guide-warnings", role: "alert" }, [
      el("div", { class: "build-guide-warnings-head" }, [
        warningCount(warnings.length),
      ]),
      el(
        "ul",
        { class: "build-guide-warn-list" },
        warnings.map((w) =>
          el("li", { class: `build-guide-warn build-guide-warn--${w.kind}` }, [
            w.message,
          ]),
        ),
      ),
    ]);
  }

  // ── BOM tab ──────────────────────────────────────────────────────────────
  #bomView() {
    const { bom } = this.#plan;
    const sections = BOM_SECTION_KEYS.map((key) => {
      const lines = bom[key] ?? [];
      if (!lines.length) return null;
      return el("section", { class: "build-guide-section" }, [
        el("h3", { class: "build-guide-section-head" }, [bomSectionLabel(key)]),
        el(
          "ul",
          { class: "build-guide-bom-list" },
          lines.map((line) =>
            el("li", { class: "build-guide-bom-line" }, [
              // Only the wires are numbered, and their number is what the steps
              // call out — so it leads the row, as an item number does.
              line.item == null
                ? null
                : el("span", { class: "build-guide-bom-item" }, [
                    wireItemLabel(line.item),
                  ]),
              el("span", { class: "build-guide-bom-title" }, [line.title]),
              el("span", { class: "build-guide-count" }, [`×${line.count}`]),
            ]),
          ),
        ),
      ]);
    }).filter(Boolean);
    if (!sections.length) return this.#empty(t("guide.emptyBom"));
    return el("div", {}, sections);
  }

  // ── Steps tab (ordered checklist) ────────────────────────────────────────
  #stepsView() {
    const { steps } = this.#plan;
    if (!steps.length) return this.#empty(t("guide.emptySteps"));

    const sections = STEP_GROUP_KEYS.map((key) => {
      const groupSteps = steps.filter((s) => s.group === key);
      if (!groupSteps.length) return null;
      return el("section", { class: "build-guide-section" }, [
        el("h3", { class: "build-guide-section-head" }, [stepGroupLabel(key)]),
        el(
          "ol",
          { class: "build-guide-steps" },
          groupSteps.map((s) => this.#stepItem(s)),
        ),
      ]);
    }).filter(Boolean);
    return el("div", {}, sections);
  }

  #stepItem(step) {
    const check = el("input", {
      class: "build-guide-step-check",
      type: "checkbox",
      "aria-label": step.text,
    });
    const li = el("li", { class: "build-guide-step" }, [
      el("label", { class: "build-guide-step-main" }, [
        check,
        el("span", { class: "build-guide-step-text" }, [step.text]),
      ]),
      step.detail?.length
        ? el(
            "ul",
            { class: "build-guide-step-detail" },
            step.detail.map((d) => el("li", {}, [d])),
          )
        : null,
    ]);
    // Session-only tick — a visual aid; nothing is persisted (a future
    // interactive mode drives this from the plan's stable step ids).
    check.addEventListener("change", () => {
      li.classList.toggle("build-guide-step--done", check.checked);
    });
    return li;
  }

  #empty(text) {
    return el("p", { class: "build-guide-empty" }, [text]);
  }
}
