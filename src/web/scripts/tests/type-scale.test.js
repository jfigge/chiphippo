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

// type-scale.test.js — the ratchet under Settings ▸ Appearance ▸ Editor font
// size.
//
// The setting works by DERIVATION: theme.css states one base and every rank
// falls out of it, so a `font-size` written as a bare px is simply a piece of
// the app that stops resizing. There is no way to notice that from the code —
// it looks completely normal, and it renders perfectly at the shipped 13.
// Before this feature the stylesheet held ~90 of them; this is what stops them
// coming back one commit at a time.
//
// The exemptions are not a convenience list. Each names a rule whose size is in
// SVG USER UNITS or a viewBox's own coordinates — the desk's printed markings,
// which scale with the camera and belong to the circuit rather than the chrome.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "styles",
);

/**
 * Selectors allowed to state a literal `font-size`, each with the reason.
 * A selector here is matched against the whole selector text of its rule.
 */
const WORLD_UNITS = new Map([
  [".board-row-label", "board addressing, SVG user units (= pitch units)"],
  [".board-col-label", "board addressing, SVG user units"],
  [".part-chip-label", "printed on the chip, SVG user units"],
  [".part-can-badge", "printed on the part, SVG user units"],
  [".part-rnet-label", "printed on the part, SVG user units"],
  [".part-dip-on-label", "printed on the part, SVG user units"],
  [".part-psu-badge", "printed on the brick, SVG user units"],
  [".part-psu-terminal-glyph", "printed on the brick, SVG user units"],
  [".part-clock-badge", "printed on the brick, SVG user units"],
  [".part-clock-terminal-glyph", "printed on the brick, SVG user units"],
  [".part-lcd-pin1-label", "printed on the module, SVG user units"],
  [".part-lcd-size", "printed on the module, SVG user units"],
  [".bus-band-label", "drawn on the ribbon, world px"],
  [".annotation-text", "document content inside the zoom-scaled world layer"],
  [".annotation-editor", "document content inside the zoom-scaled world layer"],
  [".wire-gauge-length", "a 300x62 viewBox's own coordinates"],
]);

/** Every `font-size` declaration in a stylesheet, with the rule it belongs to. */
function fontSizeDecls(file) {
  const lines = fs.readFileSync(path.join(STYLES, file), "utf8").split("\n");
  const out = [];
  let selector = "";
  let pending = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.endsWith("{")) {
      pending.push(trimmed.slice(0, -1).trim());
      selector = pending.join(" ").trim();
      pending = [];
    } else if (trimmed.endsWith(",") && !trimmed.includes(":")) {
      pending.push(trimmed.slice(0, -1).trim()); // a multi-line selector list
    } else if (trimmed === "}") {
      pending = [];
    }
    const m = trimmed.match(/^font(?:-size)?: *([^;]+);/);
    if (m) out.push({ file, line: i + 1, selector, value: m[1] });
  }
  return out;
}

test("every chrome font-size comes off the type scale", () => {
  const offenders = [];
  for (const file of ["app.css", "docs.css"]) {
    for (const d of fontSizeDecls(file)) {
      if (d.value.includes("var(--font-size")) continue;
      if (/^[\d.]+em$/.test(d.value)) continue; // em rides the base for free
      if (d.value === "inherit") continue; // `font: inherit` rides it too
      const exempt = [...WORLD_UNITS.keys()].some((sel) =>
        d.selector.includes(sel),
      );
      if (exempt) continue;
      offenders.push(`${d.file}:${d.line}  ${d.selector} → ${d.value}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a literal font-size is a piece of chrome that stops resizing. Use one of " +
      "theme.css's --font-size-* tokens; if it is genuinely world/SVG units, " +
      "add its selector to WORLD_UNITS above with the reason.\n" +
      offenders.join("\n"),
  );
});

test("every exempt selector still exists, and still states a literal", () => {
  // The other direction: an exemption left behind after a rule is renamed or
  // tokenized is a hole in the ratchet nobody would ever notice.
  const all = ["app.css", "docs.css"].flatMap(fontSizeDecls);
  for (const [sel, why] of WORLD_UNITS) {
    const hit = all.find(
      (d) => d.selector.includes(sel) && !d.value.includes("var(--font-size"),
    );
    assert.ok(hit, `stale exemption: ${sel} (${why}) no longer needs one`);
  }
});

test("the auxiliary windows' inline styles are on the scale too", () => {
  // pinout.html and memory.html carry their own <style> blocks. They link
  // theme.css, so the custom properties reach them — but nothing else in the
  // build would ever point that out if they stopped using them.
  const web = path.join(STYLES, "..");
  for (const file of ["pinout.html", "memory.html"]) {
    const html = fs.readFileSync(path.join(web, file), "utf8");
    const literals = [...html.matchAll(/font-size: *([\d.]+px)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(literals, [], `${file} has a hardcoded font-size`);
  }
});

test("the scale's ranks are derived, not restated", () => {
  const css = fs.readFileSync(path.join(STYLES, "theme.css"), "utf8");
  for (const rank of ["xs", "sm", "lg", "xl", "display"]) {
    const m = css.match(new RegExp(`--font-size-${rank}:([^;]+);`));
    assert.ok(m, `--font-size-${rank} is declared`);
    assert.match(
      m[1],
      /var\(--font-size\)/,
      `--font-size-${rank} derives from the base rather than restating a px`,
    );
  }
  // The boxes that hold one line of text derive too, or the text clips inside
  // them at the larger sizes — which is the whole failure this setting invites.
  for (const box of [
    "--header-height",
    "--control-height",
    "--toolbar-height",
    "--segment-height",
  ]) {
    const m = css.match(new RegExp(`${box}: *([^;]+);`, "s"));
    assert.ok(m, `${box} is declared`);
    assert.match(m[1], /var\(--/, `${box} derives from the type scale`);
  }
});
