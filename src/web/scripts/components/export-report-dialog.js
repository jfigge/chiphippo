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

// export-report-dialog.js — what an export to another tool will NOT carry as
// it is, said before anything is written (Feature 390).
//
// The card only appears when there is something to say: a part the target
// has no model for (dropped), one that becomes something that behaves
// differently (changed), or one whose PCB footprint is a stand-in to replace
// (footprint). A clean export goes straight to the file dialog. Parts are
// named by the same designators the exported file uses (U7, R1–R3), since the
// report is read beside it.
//
// The pure exporters hand back CODES, never sentences (model/export/): every
// word here is this card's, through `t()` — this is user interface, not the
// AI ladder's protocol text.
//
// It answers exactly once — true for Export, false for every other way out —
// because PopupManager fires `onClose` on every dismissal and an awaiting
// caller must never hang.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { partDef } from "../catalog/index.js";
import { partTitle } from "../catalog/labels.js";
import { guidePageButton } from "./protocol-doc-button.js";

/** The guide page the card's book button opens. */
export const EXPORT_PAGE = "exporting";

/** The groups, in the order the card lists them. */
const KINDS = ["dropped", "changed", "footprint"];

/** Whether a report has anything the card would show. */
export function reportWorthShowing(report) {
  return (report ?? []).some((e) => KINDS.includes(e.kind));
}

/**
 * `R1 R2 R3 R5` → `R1–R3, R5`: designators of one prefix, runs folded.
 * @param {string[]} designators
 * @returns {string}
 */
export function compactDesignators(designators) {
  const parsed = designators
    .map((d) => /^([A-Z]+)(\d+)$/.exec(d))
    .map((m, i) =>
      m ? { p: m[1], n: Number(m[2]) } : { raw: designators[i] },
    );
  const out = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    out.push(
      run.to === run.from
        ? `${run.p}${run.from}`
        : `${run.p}${run.from}–${run.p}${run.to}`,
    );
    run = null;
  };
  for (const d of parsed) {
    if (d.raw) {
      flush();
      out.push(d.raw);
    } else if (run && run.p === d.p && d.n === run.to + 1) {
      run.to = d.n;
    } else {
      flush();
      run = { p: d.p, from: d.n, to: d.n };
    }
  }
  flush();
  return out.join(", ");
}

/** A part's name on the card: a chip by its number, anything else by title. */
function partName(ref) {
  const def = partDef(ref);
  if (!def) return ref;
  return def.kind === "chip" ? def.id : partTitle(def);
}

function entryRow(entry, formatName) {
  if (!entry.designators) {
    return el("li", {
      class: "export-report-row export-report-row--whole",
      text: t(`export.reason.${entry.code}`, {
        count: entry.count,
        format: formatName,
      }),
    });
  }
  return el("li", { class: "export-report-row" }, [
    el("span", {
      class: "export-report-refs",
      text: compactDesignators(entry.designators),
    }),
    el("span", { class: "export-report-part", text: partName(entry.ref) }),
    el("span", {
      class: "export-report-why",
      text: t(`export.reason.${entry.code}`, {
        ref: entry.ref,
        format: formatName,
      }),
    }),
  ]);
}

/**
 * Show the report and wait for the answer.
 *
 * @param {object} opts
 * @param {string} opts.formatName - the target's product name ("KiCad").
 * @param {Array<object>} opts.report - the exporter's report entries.
 * @param {object} [opts.bridge] - window.chiphippo, for the guide button.
 * @returns {Promise<boolean>} true to go ahead with the export.
 */
export function openExportReport({ formatName, report, bridge }) {
  return new Promise((resolve) => {
    let answer = false;
    const groups = [];
    for (const kind of KINDS) {
      const entries = report.filter((e) => e.kind === kind);
      if (!entries.length) continue;
      const count = entries.reduce(
        (n, e) => n + (e.designators?.length ?? e.count ?? 0),
        0,
      );
      groups.push(
        el("section", { class: "export-report-group" }, [
          el("h3", {
            class: `export-report-heading export-report-heading--${kind}`,
            text: t(`export.group.${kind}`, { count, format: formatName }),
          }),
          el(
            "ul",
            { class: "export-report-list" },
            entries.map((e) => entryRow(e, formatName)),
          ),
        ]),
      );
    }
    const hasDropped = report.some((e) => e.kind === "dropped");

    const finish = (value) => {
      answer = value;
      PopupManager.close();
    };
    PopupManager.dialog({
      title: t("export.title", { format: formatName }),
      className: "export-report-popup",
      headerActions: [guidePageButton(bridge, EXPORT_PAGE, t("export.guide"))],
      body: [
        ...groups,
        hasDropped &&
          el("p", { class: "export-report-note", text: t("export.note") }),
        el("div", { class: "export-report-footer" }, [
          el("button", {
            class: "btn popup-btn btn--secondary",
            type: "button",
            text: t("common.cancel"),
            onClick: () => finish(false),
          }),
          el("button", {
            class: "btn popup-btn btn--primary",
            type: "button",
            text: t("export.confirm"),
            "data-autofocus": true,
            onClick: () => finish(true),
          }),
        ]),
      ].filter(Boolean),
      onClose: () => resolve(answer),
    });
  });
}
