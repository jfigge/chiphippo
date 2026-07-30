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

// build-export.js — the pure exporter behind the build guide's download button.
// It FORMATS the plain plan from model/build-plan.js into a Rich Text Format
// (.rtf) document: a heading per tab (BOM / Wiring / Steps) followed by that
// tab's data, so a builder gets a printable bill of materials + wiring list +
// assembly checklist in one file. DOM-free and side-effect-free — the view
// (components/build-guide.js) turns the returned string into a Blob and
// downloads it; nothing here touches the document or the DOM.

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
  netTitle,
  busHeading,
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
    nets: plan?.nets ?? [],
    steps: plan?.steps ?? [],
    warnings: plan?.warnings ?? [],
  };
  const body = [
    h1(tf("guide.exportTitle", "{name} — Build Guide", { name })),
    warningsBlock(p.warnings),
    ...bomBlocks(p.bom),
    ...wiringBlocks(p.nets),
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
    for (const line of lines) out.push(bullet(`${line.title}  ×${line.count}`));
  }
  if (!any) out.push(para(tf("guide.emptyBom", "Nothing on the desk yet.")));
  return out;
}

/** Wiring tab: bus headings, then one line per net (title · members). */
function wiringBlocks(nets) {
  const out = [h2(tf("guide.tab.wiring", "Wiring"))];
  if (!nets.length) {
    out.push(para(tf("guide.emptyWiring", "No connections yet.")));
    return out;
  }
  let busName = null;
  for (const net of nets) {
    if (net.bus && net.bus.name !== busName) {
      busName = net.bus.name;
      out.push(h3(busHeading(busName)));
    }
    if (!net.bus) busName = null;
    const title = netTitle(net);
    const members = (net.members ?? [])
      .map((m) => esc(m.label))
      .join(" \\u183? ");
    const flag = net.isSingleton
      ? ` (${tf("guide.singletonFlag", "only one connection")})`
      : "";
    out.push(`{\\pard\\sa60 {\\b ${esc(title + flag)}:} ${members}\\par}\n`);
  }
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
