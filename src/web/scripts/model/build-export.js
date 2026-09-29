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

// build-export.js — the pure exporter behind the build guide's download button.
// It FORMATS the plain plan from model/build-plan.js into a Rich Text Format
// (.rtf) document: a heading per tab (BOM / Steps) followed by that tab's data,
// so a builder gets a printable bill of materials + assembly checklist in one
// file. DOM-free and side-effect-free — the view (components/build-guide.js)
// turns the returned string into a Blob and downloads it; nothing here touches
// the document or the DOM.
//
// It MIRRORS THE PANEL's tabs, which is why the Wiring section went when the
// Wiring tab did: the numbered BOM plus the steps carry the same information (a
// step names its wire by the item number the BOM gave it), and a printed page
// repeating it is the same duplication on paper.

// The section/group headings and the empty-state lines come from build-plan.js,
// which the PANEL reads too — they used to be a second copy of the same English
// here, and two copies of a translated string is two chances to drift.
import { tf } from "../i18n.js";
import {
  BOM_SECTION_KEYS,
  STEP_GROUP_KEYS,
  bomSectionLabel,
  stepGroupLabel,
  warningCount,
  wireItemLabel,
} from "./build-plan.js";

/**
 * Render a build plan as a Rich Text Format document.
 *
 * @param {import('./build-plan.js').BuildPlan} plan  buildPlan()'s result.
 * @param {{title?: string}} [opts]  `title` names the document heading
 *   (the schema name); defaults to "Untitled".
 * @returns {string} the full RTF document text.
 */
export function planToRtf(plan, { title } = {}) {
  const name = title ?? tf("common.untitled", "Untitled");
  const p = {
    bom: plan?.bom ?? {},
    steps: plan?.steps ?? [],
    warnings: plan?.warnings ?? [],
  };
  const body = [
    h1(tf("guide.exportTitle", "{name} — Build Guide", { name })),
    warningsBlock(p.warnings),
    ...bomBlocks(p.bom),
    ...stepsBlocks(p.steps),
  ].join("");
  return (
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\n" +
    "{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}}\n" +
    "\\f0\\fs22\n" +
    body +
    "}"
  );
}

// ── Section builders ─────────────────────────────────────────────────────────

/** The warnings roll-up (omitted entirely when the design is clean). */
function warningsBlock(warnings) {
  if (!warnings.length) return "";
  return (
    h2(warningCount(warnings.length)) +
    warnings.map((w) => bullet(w.message)).join("")
  );
}

/** BOM tab: a heading, then a sub-heading + counted list per non-empty group. */
function bomBlocks(bom) {
  const out = [h2(tf("guide.tab.bom", "BOM"))];
  let any = false;
  for (const key of BOM_SECTION_KEYS) {
    const lines = bom[key] ?? [];
    if (!lines.length) continue;
    any = true;
    out.push(h3(bomSectionLabel(key)));
    for (const line of lines) {
      // Wires carry a BOM item number the steps call out; nothing else does.
      const item = line.item == null ? "" : `${wireItemLabel(line.item)} `;
      out.push(bullet(`${item}${line.title}  ×${line.count}`));
    }
  }
  if (!any) out.push(para(tf("guide.emptyBom", "Nothing on the desk yet.")));
  return out;
}

/** Steps tab: a sub-heading + numbered checklist per non-empty group. */
function stepsBlocks(steps) {
  const out = [h2(tf("guide.tab.steps", "Steps"))];
  if (!steps.length) {
    out.push(para(tf("guide.emptySteps", "No build steps yet.")));
    return out;
  }
  for (const key of STEP_GROUP_KEYS) {
    const group = steps.filter((s) => s.group === key);
    if (!group.length) continue;
    out.push(h3(stepGroupLabel(key)));
    group.forEach((step, i) => {
      out.push(numbered(i + 1, step.text));
      for (const d of step.detail ?? []) out.push(detail(d));
    });
  }
  return out;
}

// ── RTF paragraph primitives ─────────────────────────────────────────────────

/** A document heading (18pt bold). */
function h1(text) {
  return `{\\pard\\sa120\\fs36\\b ${esc(text)}\\par}\n`;
}

/** A tab heading (14pt bold). */
function h2(text) {
  return `{\\pard\\sb160\\sa80\\fs28\\b ${esc(text)}\\par}\n`;
}

/** A section sub-heading (12pt bold). */
function h3(text) {
  return `{\\pard\\sb100\\sa40\\fs24\\b ${esc(text)}\\par}\n`;
}

/** A plain body paragraph. */
function para(text) {
  return `{\\pard\\sa60 ${esc(text)}\\par}\n`;
}

/** A bulleted line (indented). */
function bullet(text) {
  return `{\\pard\\li360\\fi-180 \\bullet\\tab ${esc(text)}\\par}\n`;
}

/** A numbered checklist line (indented). */
function numbered(n, text) {
  return `{\\pard\\li360\\fi-180 ${n}.\\tab ${esc(text)}\\par}\n`;
}

/** A deeper-indented step detail line. */
function detail(text) {
  return `{\\pard\\li720\\fi-180 \\u8211?\\tab ${esc(text)}\\par}\n`;
}

// ── Escaping ─────────────────────────────────────────────────────────────────

/**
 * Escape text for an RTF stream: the three control characters, and every
 * non-ASCII character as a `\uN?` unicode escape with an ASCII fallback.
 * Walks UTF-16 CODE UNITS, not code points — RTF's `\uN` escape is itself a
 * UTF-16-code-unit mechanism (it predates supplementary planes), so a
 * character outside the BMP (an emoji in a net name or component label, say)
 * must be split into its surrogate pair and each half escaped separately;
 * code-point iteration would hand the whole astral scalar value to the
 * int16-wrap formula below and produce an out-of-range, meaningless escape.
 */
function esc(str) {
  let out = "";
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") out += "\\\\";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if (ch === "\n") out += "\\line ";
    else {
      const code = ch.charCodeAt(0);
      if (code < 128) out += ch;
      else out += `\\u${code > 32767 ? code - 65536 : code}?`;
    }
  }
  return out;
}
