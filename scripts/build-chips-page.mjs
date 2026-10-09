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

// build-chips-page.mjs — write website/chips.html, the website's list of every
// chip the app ships, FROM THE CATALOG.
//
// The list is a projection of data the repo already holds — CHIP_DEFS for the
// part, its title and its package, and src/web/demos/ for which ones carry an
// example circuit — so it is derived rather than typed, for the reason the
// guide's PAGES and the AI catalog card are: a chip added to catalog/ reaches
// the site with nobody remembering to edit HTML. `make docs` runs this, and the
// deploy workflow runs `make docs` on every push, so the deployed page is a
// function of the catalog. The committed copy is held to that by
// tests/website-chips.test.js.
//
// SECTIONS is the one hand-kept thing here, and it cannot fall behind quietly:
// a chip whose `group` no section claims THROWS (a new catalog group must not
// vanish from the site), and so does a claimed group no chip has any more.
//
// Plain Node with no dependencies. Deliberately does NOT import build-docs.mjs,
// whose top level loads `marked` and exits when it is missing.
//
//   node scripts/build-chips-page.mjs
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CHIP_DEFS } from "../src/web/scripts/catalog/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMOS_DIR = resolve(ROOT, "src/web/demos");
export const OUT = resolve(ROOT, "website/chips.html");
const SITE_URL = "https://chiphippo.com";

/**
 * The page's sections, in order. `bands` are ordered lists of catalog
 * `group`s: rows sort by band first, then by family (74LS before CD4000 —
 * Feature 400; the part number already says which is which, so the family
 * needs no column of its own), then by part number, so the gate
 * families read 00 → 86 as one run with the bus buffers after them, while the
 * counters come before the shift registers.
 */
export const SECTIONS = Object.freeze([
  {
    id: "gates",
    title: "Gates & buffers",
    bands: [["NAND", "NOR", "AND", "OR", "XOR", "Inverter"], ["Buffer"]],
  },
  {
    id: "registers",
    title: "Flip-flops, latches & registers",
    bands: [["Flip-flop", "Latch", "Register"]],
  },
  {
    id: "counters",
    title: "Counters & shift registers",
    bands: [["Counter"], ["Shift register"]],
  },
  {
    // The parts that keep time with an external resistor and capacitor: the
    // CD4000 one-shots and multivibrator, and the 555 — and the op-amp, the
    // other analog chip on the bench.
    id: "timers",
    title: "Timers & op-amps",
    bands: [["Timer"], ["Op-amps"]],
  },
  {
    id: "decoders",
    title: "Decoders, encoders & multiplexers",
    bands: [["Decoder", "Encoder", "Multiplexer"]],
  },
  {
    id: "arithmetic",
    title: "Arithmetic, comparison & display",
    bands: [["Arithmetic"], ["Comparator"], ["Display driver"]],
  },
  { id: "memory", title: "Memory", bands: [["Memory"]] },
  {
    id: "processors",
    title: "Interface & processors",
    bands: [["Interface"], ["PROCESSOR"]],
  },
]);

/** Does this chip ship an example circuit? The same file test main answers
    the pinout window's example button with, so the ✦ cannot disagree. */
export const hasDemo = (id) => existsSync(resolve(DEMOS_DIR, `${id}.json`));

// The 74xx number (74LS00 → 0, 74LS283 → 283) or the CD4000 one (CD4011B →
// 4011, CD40106B → 40106); anything else sorts after, in catalog order.
const partNumber = (id) => {
  const m = /^74[A-Z]*(\d+)/.exec(id) ?? /^CD(\d+)/.exec(id);
  return m ? Number(m[1]) : Infinity;
};

// Within a band the 74LS rows come first, then the CD4000 ones, then the
// family-less parts — so a family reads as one run rather than interleaved.
const FAMILY_ORDER = ["74LS", "CD4000"];
const familyRank = (def) => {
  const i = FAMILY_ORDER.indexOf(def.family);
  return i < 0 ? FAMILY_ORDER.length : i;
};

/**
 * The chips grouped into SECTIONS, as plain data.
 *
 * @param {object[]} [defs] - chip defs (`id`, `title`, `group`, `package`).
 * @param {(id: string) => boolean} [hasExample]
 * @returns {{id: string, title: string, rows: {id: string, title: string,
 *   package: string, example: boolean}[]}[]}
 * @throws when a chip's group is in no section, or a section names a group no
 *   chip belongs to.
 */
export function chipSections(defs = CHIP_DEFS, hasExample = hasDemo) {
  const place = new Map(); // group → [section index, band index]
  SECTIONS.forEach((s, si) =>
    s.bands.forEach((band, bi) => band.forEach((g) => place.set(g, [si, bi]))),
  );

  const unmapped = defs.filter((d) => !place.has(d.group));
  if (unmapped.length) {
    throw new Error(
      "build-chips-page: no section for " +
        unmapped.map((d) => `${d.id} (group "${d.group}")`).join(", ") +
        " — add the group to SECTIONS",
    );
  }
  const used = new Set(defs.map((d) => d.group));
  const stale = [...place.keys()].filter((g) => !used.has(g));
  if (stale.length) {
    throw new Error(
      `build-chips-page: SECTIONS names group(s) no chip has: ${stale.join(", ")}`,
    );
  }

  const keyed = defs.map((def, index) => {
    const [section, band] = place.get(def.group);
    return {
      def,
      index,
      section,
      band,
      family: familyRank(def),
      number: partNumber(def.id),
    };
  });
  return SECTIONS.map((s, si) => ({
    id: s.id,
    title: s.title,
    rows: keyed
      .filter((k) => k.section === si)
      .sort(
        (a, b) =>
          a.band - b.band ||
          a.family - b.family ||
          a.number - b.number ||
          a.index - b.index,
      )
      .map(({ def }) => ({
        id: def.id,
        title: def.title,
        package: def.package,
        example: hasExample(def.id),
      })),
  })).filter((s) => s.rows.length);
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const LOGO = (size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 512 512" role="img" aria-label="Chip Hippo">
          <rect x="0" y="0" width="512" height="512" rx="114" fill="#2F855A"/>
          <circle cx="170" cy="146" r="40" fill="#FFFFFF"/><circle cx="342" cy="146" r="40" fill="#FFFFFF"/>
          <rect x="144" y="140" width="224" height="190" rx="74" fill="#FFFFFF"/>
          <rect x="118" y="260" width="276" height="150" rx="74" fill="#FFFFFF"/>
          <circle cx="201" cy="198" r="17" fill="#1C1C1C"/><circle cx="311" cy="198" r="17" fill="#1C1C1C"/>
          <rect x="186" y="320" width="140" height="52" rx="8" fill="#23272B"/>
          <circle cx="186" cy="346" r="11" fill="#FFFFFF"/>
        </svg>`;

// privacy.html's tokens, nav and footer, plus the jump list and the tables.
const STYLE = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:#1c1c1c; --mantle:#161616; --crust:#101010;
      --surface-0:#2a2a2a; --surface-1:#383838; --overlay-0:#686868;
      --text:#e8e8e8; --subtext:#b0b0b0; --accent:#3fb950; --green:#56d364;
    }
    html { scroll-behavior: smooth; }
    body {
      font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.6;
      min-height: 100vh; display: flex; flex-direction: column;
    }
    nav {
      background: var(--mantle); border-bottom: 1px solid var(--surface-0);
      position: sticky; top: 0; z-index: 100; padding: 0 2rem;
      display: flex; align-items: center; justify-content: space-between; height: 58px;
    }
    .nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
    .logo-mark { width: 32px; height: 32px; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .nav-wordmark { font-size: 1.2rem; font-weight: 800; color: var(--text); letter-spacing: -0.5px; }
    .nav-right { display: flex; align-items: center; gap: 1.5rem; }
    .nav-link { color: var(--subtext); text-decoration: none; font-size: 0.875rem; transition: color 0.15s; }
    .nav-link:hover { color: var(--text); }
    .btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 18px; border-radius: 8px; font-size: 0.875rem; font-weight: 600; text-decoration: none; cursor: pointer; border: none; line-height: 1; transition: background 0.15s, transform 0.15s; }
    .btn-primary { background: var(--accent); color: var(--crust); }
    .btn-primary:hover { background: var(--green); transform: translateY(-1px); }
    .page { flex: 1; max-width: 880px; width: 100%; margin: 0 auto; padding: 64px 2rem 80px; }
    .page-tag { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: var(--accent); margin-bottom: 12px; }
    .page h1 { font-size: clamp(2rem, 5vw, 3rem); font-weight: 900; letter-spacing: -1.5px; line-height: 1.1; margin-bottom: 24px; }
    .page h2 { font-size: 1.3rem; font-weight: 800; letter-spacing: -0.4px; margin: 44px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--surface-0); scroll-margin-top: 76px; }
    .page p { color: var(--subtext); margin-bottom: 14px; }
    .page a { color: var(--accent); text-decoration: none; }
    .page a:hover { text-decoration: underline; }
    .page strong { color: var(--text); }
    .page code { font-family: "Cascadia Code", "JetBrains Mono", "Fira Code", monospace; font-size: 0.88em; color: var(--text); }
    .count { font-size: 0.8rem; font-weight: 700; color: var(--overlay-0); margin-left: 6px; letter-spacing: 0; }
    .example-mark { color: var(--accent); cursor: help; }
    .chip-jump { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; margin: 28px 0 8px; }
    .chip-jump a { display: inline-flex; align-items: baseline; gap: 6px; padding: 6px 12px; border: 1px solid var(--surface-1); border-radius: 999px; background: var(--mantle); color: var(--subtext); font-size: 0.85rem; }
    .chip-jump a:hover { color: var(--text); border-color: var(--accent); text-decoration: none; }
    .chip-jump .count { margin-left: 0; font-size: 0.75rem; }
    .table-wrap { overflow-x: auto; }
    .chip-table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    .chip-table th, .chip-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--surface-0); }
    .chip-table th { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--overlay-0); }
    .chip-table td { color: var(--subtext); }
    .chip-table td:first-child { white-space: nowrap; width: 9.5rem; }
    .chip-table td:last-child, .chip-table th:last-child { white-space: nowrap; width: 6.5rem; }
    .chip-table tbody tr:hover td { background: var(--mantle); }
    footer { background: var(--crust); border-top: 1px solid var(--surface-0); padding: 48px 2rem; text-align: center; }
    .footer-inner { max-width: 700px; margin: 0 auto; }
    .footer-logo { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 16px; }
    .footer-name { font-size: 1.1rem; font-weight: 800; color: var(--text); }
    footer p { color: var(--overlay-0); font-size: 0.83rem; line-height: 1.8; }
    footer a { color: var(--accent); text-decoration: none; }
    /* The nav wraps onto a second row rather than hiding its links, as
       privacy.html's does. */
    @media (max-width: 640px) {
      nav {
        position: static; height: auto; flex-wrap: wrap;
        justify-content: center; gap: 10px; padding: 10px 1rem;
      }
      .nav-right { width: 100%; flex-wrap: wrap; justify-content: center; gap: 10px 1.1rem; }
      .nav-link { font-size: 0.82rem; }
      .nav-right .btn { padding: 7px 14px; }
      .page { padding: 44px 1rem 64px; }
      .page h2 { scroll-margin-top: 0; }
      .chip-table th, .chip-table td { padding: 8px 8px; }
      .chip-table td:first-child { width: auto; }
    }`;

const MARK = `<span class="example-mark" role="img" aria-label="has an example circuit" title="Has a built-in example circuit">✦</span>`;

function renderSection(s) {
  const rows = s.rows
    .map(
      (r) =>
        `        <tr><td><code>${esc(r.id)}</code>${r.example ? ` ${MARK}` : ""}</td><td>${esc(r.title)}</td><td>${esc(r.package)}</td></tr>`,
    )
    .join("\n");
  return `  <h2 id="${s.id}">${esc(s.title)} <span class="count">${s.rows.length}</span></h2>
  <div class="table-wrap">
    <table class="chip-table">
      <thead>
        <tr><th scope="col">Part</th><th scope="col">Function</th><th scope="col">Package</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>`;
}

/**
 * The whole of website/chips.html.
 * @param {ReturnType<typeof chipSections>} [sections]
 * @returns {string}
 */
export function renderChipsPage(sections = chipSections()) {
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  const examples = sections.reduce(
    (n, s) => n + s.rows.filter((r) => r.example).length,
    0,
  );
  const description = `Every chip Chip Hippo simulates — ${total} 74LS TTL and CD4000 CMOS logic, memory, interface and processor parts, each with a datasheet-accurate pinout.`;
  const jump = sections
    .map(
      (s) =>
        `    <li><a href="#${s.id}">${esc(s.title)} <span class="count">${s.rows.length}</span></a></li>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<!-- GENERATED by scripts/build-chips-page.mjs from the parts catalog — do not
     edit by hand. Change src/web/scripts/catalog/, then run \`make docs\`. -->
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- The same meta CSP as privacy.html: no scripts at all, so script-src is
       'none'; the inline <style> is what needs 'unsafe-inline'. -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <meta name="description" content="${esc(description)}" />
  <title>Supported chips — Chip Hippo</title>
  <link rel="canonical" href="${SITE_URL}/chips.html" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Chip Hippo" />
  <meta property="og:title" content="Supported chips — Chip Hippo" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${SITE_URL}/chips.html" />
  <style>${STYLE}
  </style>
</head>
<body>

<nav>
  <a class="nav-logo" href="/">
    <span class="logo-mark">
      ${LOGO(32)}
    </span>
    <span class="nav-wordmark">Chip Hippo</span>
  </a>
  <div class="nav-right">
    <a class="nav-link" href="/#features">Features</a>
    <a class="nav-link" href="/docs/">Guide</a>
    <a class="nav-link" href="/#downloads">Downloads</a>
    <a class="nav-link" href="https://github.com/jfigge/chiphippo" rel="noopener noreferrer">GitHub</a>
    <a class="btn btn-primary" href="/#downloads">Download</a>
  </div>
</nav>

<main class="page">
  <p class="page-tag">Catalog</p>
  <h1>Supported chips</h1>
  <p>
    Chip Hippo ships <strong>${total} chips</strong>, every one with a datasheet-accurate
    pinout and a working simulation you can wire up and run — logic from two families,
    74LS TTL and CD4000 CMOS, listed 74LS first in each table.
    <strong>${examples}</strong> of them carry a built-in example circuit, marked
    <span class="example-mark" aria-hidden="true">✦</span> below: open the chip's
    <em>Pin Assignment</em> window and click its example button to drop a working bench
    onto a new desktop. The memory, interface and processor chips have none — a RAM or
    a CPU can't be shown off by flipping switches at it.
  </p>
  <p>
    How each part behaves on the desk — open-collector outputs, non-standard power pins,
    how the CPUs are clocked — is covered in
    <a href="/docs/chip-library.html">The Chip Library</a>. LEDs, switches, displays and
    the other discrete parts are in <a href="/docs/components.html">Chips &amp; Components</a>.
  </p>

  <ul class="chip-jump" aria-label="Chip sections">
${jump}
  </ul>

${sections.map(renderSection).join("\n\n")}
</main>

<footer>
  <div class="footer-inner">
    <div class="footer-logo">
      <span class="logo-mark">
        ${LOGO(28)}
      </span>
      <span class="footer-name">Chip Hippo</span>
    </div>
    <p style="margin-bottom:14px">
      <a href="/">Home</a>
      &nbsp;·&nbsp;
      <a href="/docs/">Guide</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/jfigge/chiphippo" rel="noopener noreferrer">GitHub</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/sponsors/jfigge" rel="noopener noreferrer">Donate</a>
      &nbsp;·&nbsp;
      <a href="/privacy.html">Privacy</a>
      &nbsp;·&nbsp;
      <a href="/code-signing-policy.html">Code Signing</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/jfigge/chiphippo/issues" rel="noopener noreferrer">Contact</a>
    </p>
    <p>Copyright &copy; 2026 Jason Figge. Released under the GNU General Public License v3.<br>
    Built with Electron &amp; Vanilla JS. No telemetry, no accounts, fully offline.</p>
  </div>
</footer>

</body>
</html>
`;
}

// ── Build ─────────────────────────────────────────────────────────────────────
// Only write when run directly, so a test can import the renderer.
const IS_MAIN =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (IS_MAIN) {
  const sections = chipSections();
  writeFileSync(OUT, renderChipsPage(sections));
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  console.log(
    `Wrote website/chips.html (${total} chips in ${sections.length} sections)`,
  );
}
