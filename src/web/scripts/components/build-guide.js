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
import { buildPlan } from "../model/build-plan.js";
import { NetlistCache } from "./netlist-cache.js";

const TABS = [
  { id: "bom", label: "BOM" },
  { id: "wiring", label: "Wiring" },
  { id: "steps", label: "Steps" },
];

/** The BOM sections, in display order (skip a section with no line items). */
const BOM_SECTIONS = [
  { key: "boards", label: "Breadboards" },
  { key: "chips", label: "Chips" },
  { key: "discretes", label: "Discrete parts" },
  { key: "power", label: "Power" },
];

/** Human names for the step groups, in the order buildPlan emits them. */
const STEP_GROUPS = [
  { key: "boards", label: "Place the boards" },
  { key: "power", label: "Power" },
  { key: "chips", label: "Seat the chips" },
  { key: "discretes", label: "Add discrete parts" },
  { key: "wires", label: "Run the signal wires" },
];

export class BuildGuide {
  #doc;
  #netlist;
  #el;
  #body;
  #tabButtons = new Map();
  #warnBadge;
  #onVisibilityChange;
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
   */
  constructor(container, { deskDoc, onVisibilityChange, netlist }) {
    this.#doc = deskDoc;
    this.#netlist = netlist ?? new NetlistCache(deskDoc);
    this.#onVisibilityChange = onVisibilityChange;

    const tabs = el("div", { class: "build-guide-tabs", role: "tablist" });
    for (const { id, label } of TABS) {
      const btn = el("button", {
        class: "build-guide-tab",
        type: "button",
        role: "tab",
        text: label,
        "aria-selected": String(id === this.#tab),
        onClick: () => this.#selectTab(id),
      });
      this.#tabButtons.set(id, btn);
      tabs.append(btn);
    }

    this.#warnBadge = el("span", {
      class: "build-guide-warn-badge",
      hidden: true,
      title: "Design warnings",
    });

    const header = el("div", { class: "build-guide-header" }, [
      el("span", { class: "build-guide-title" }, [
        "Build guide",
        this.#warnBadge,
      ]),
      el("button", {
        class: "build-guide-close",
        type: "button",
        title: "Close the build guide",
        "aria-label": "Close the build guide",
        text: "×",
        onClick: () => this.setVisible(false),
      }),
    ]);

    this.#body = el("div", { class: "build-guide-body" });
    this.#el = el(
      "aside",
      { class: "build-guide", "aria-label": "Build guide", hidden: true },
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

  #selectTab(id) {
    if (this.#tab === id) return;
    this.#tab = id;
    for (const [tabId, btn] of this.#tabButtons) {
      btn.setAttribute("aria-selected", String(tabId === id));
    }
    this.#renderBody();
  }

  /** Re-derive the plan (if needed) and repaint the whole panel. */
  #render() {
    if (this.#dirty) {
      this.#plan = buildPlan(this.#doc.toJSON(), this.#netlist.get());
      this.#dirty = false;
    }
    const n = this.#plan.warnings.length;
    this.#warnBadge.textContent = n ? String(n) : "";
    this.#warnBadge.hidden = n === 0;
    this.#renderBody();
  }

  #plan = { bom: {}, nets: [], steps: [], warnings: [] };

  #renderBody() {
    clear(this.#body);
    this.#body.append(this.#warningsBlock());
    if (this.#tab === "bom") this.#body.append(this.#bomView());
    else if (this.#tab === "wiring") this.#body.append(this.#wiringView());
    else this.#body.append(this.#stepsView());
  }

  // ── Warnings banner (shown on every tab) ─────────────────────────────────
  #warningsBlock() {
    const warnings = this.#plan.warnings;
    if (!warnings.length) return el("div", { hidden: true });
    return el("div", { class: "build-guide-warnings", role: "alert" }, [
      el("div", { class: "build-guide-warnings-head" }, [
        `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
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
    const sections = BOM_SECTIONS.map(({ key, label }) => {
      const lines = bom[key] ?? [];
      if (!lines.length) return null;
      return el("section", { class: "build-guide-section" }, [
        el("h3", { class: "build-guide-section-head" }, [label]),
        el(
          "ul",
          { class: "build-guide-bom-list" },
          lines.map((line) =>
            el("li", { class: "build-guide-bom-line" }, [
              el("span", { class: "build-guide-bom-title" }, [line.title]),
              el("span", { class: "build-guide-count" }, [`×${line.count}`]),
            ]),
          ),
        ),
      ]);
    }).filter(Boolean);
    if (!sections.length) return this.#empty("Nothing on the desk yet.");
    return el("div", {}, sections);
  }

  // ── Wiring tab (net-centric, buses grouped) ──────────────────────────────
  #wiringView() {
    const { nets } = this.#plan;
    if (!nets.length) return this.#empty("No connections yet.");

    const rows = [];
    let busName = null;
    for (const net of nets) {
      if (net.bus && net.bus.name !== busName) {
        busName = net.bus.name;
        rows.push(
          el("h3", { class: "build-guide-bus-head" }, [`${busName} bus`]),
        );
      }
      if (!net.bus) busName = null;
      rows.push(this.#netRow(net));
    }
    return el("div", { class: "build-guide-wiring" }, rows);
  }

  #netRow(net) {
    const title = net.bus ? `bit ${net.bus.bit}` : (net.name ?? "unnamed net");
    return el(
      "div",
      {
        class:
          "build-guide-net" +
          (net.isSingleton ? " build-guide-net--singleton" : "") +
          (net.name ? " build-guide-net--named" : ""),
      },
      [
        el("div", { class: "build-guide-net-name" }, [
          title,
          net.isSingleton
            ? el(
                "span",
                { class: "build-guide-net-flag", title: "Only one connection" },
                ["⚠"],
              )
            : null,
        ]),
        el(
          "div",
          { class: "build-guide-net-members" },
          this.#joinMembers(net.members),
        ),
      ],
    );
  }

  /** Member labels joined by a middot separator, each a pill by kind. */
  #joinMembers(members) {
    const out = [];
    members.forEach((m, i) => {
      if (i) out.push(el("span", { class: "build-guide-sep" }, ["·"]));
      out.push(
        el(
          "span",
          { class: `build-guide-member build-guide-member--${m.kind}` },
          [m.label],
        ),
      );
    });
    return out;
  }

  // ── Steps tab (ordered checklist) ────────────────────────────────────────
  #stepsView() {
    const { steps } = this.#plan;
    if (!steps.length) return this.#empty("No build steps yet.");

    const sections = STEP_GROUPS.map(({ key, label }) => {
      const groupSteps = steps.filter((s) => s.group === key);
      if (!groupSteps.length) return null;
      return el("section", { class: "build-guide-section" }, [
        el("h3", { class: "build-guide-section-head" }, [label]),
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
