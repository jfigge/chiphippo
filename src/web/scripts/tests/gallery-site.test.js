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

// The gallery site (the gallery work, Phase 2): the seed list against the
// examples the app ships, scripts/build-gallery.mjs's output, and the shared
// grid (gallery/gallery-view.js) on a DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"; // prettier-ignore
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { LIB_FILES, buildGallery } from "../../../../scripts/build-gallery.mjs";
import { ENTRY_ID_RE } from "../gallery/entry-format.js";
import { GalleryView, filterEntries, tagsOf } from "../gallery/gallery-view.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SEED = JSON.parse(readFileSync(join(ROOT, "website/gallery/seed.json"), "utf8")); // prettier-ignore

/** Build into a throwaway folder; `fn` gets the result and the folder. */
function built(opts, fn) {
  const out = mkdtempSync(join(tmpdir(), "chiphippo-gallery-"));
  try {
    return fn(buildGallery({ out, generated: "2026-10-31", appVersion: "9.9.9", ...opts }), out); // prettier-ignore
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("the seed: about 25 entries, each a shipped example desktop, ids fixed and unique", () => {
  const ids = SEED.entries.map((e) => e.id);
  assert.ok(ids.length >= 20 && ids.length <= 30, `${ids.length} seeds`);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, ENTRY_ID_RE);
});

test("every seed builds clean, with its files and the page's lib/", () => {
  built({}, ({ index, problems, written }, out) => {
    assert.deepEqual(problems, []);
    assert.equal(written, SEED.entries.length);
    assert.deepEqual(
      index.entries.map((e) => e.id).sort(),
      SEED.entries.map((e) => e.id).sort(),
    );
    const cpu = index.entries.find((e) => e.title === "W65C02 Hello World computer"); // prettier-ignore
    assert.ok(cpu.featured);
    assert.ok(cpu.derived.autoTags.includes("cpu"));
    assert.equal(cpu.appVersion, "9.9.9");
    assert.equal(cpu.source, "seed");
    for (const e of index.entries) {
      const dir = join(out, "entries", e.id);
      const entry = JSON.parse(readFileSync(join(dir, "entry.json"), "utf8"));
      assert.equal(entry.id, e.id);
      const design = JSON.parse(readFileSync(join(dir, "design.desktop.chiphippo"), "utf8")); // prettier-ignore
      assert.equal(design.kind, "desktop");
      assert.equal(
        design.name,
        e.title,
        "the desktop opens named for its entry",
      );
    }
    for (const file of LIB_FILES)
      assert.ok(existsSync(join(out, "lib", file)), file);
  });
});

test("a seed naming a desktop no example has is reported, not built", () => {
  const dir = mkdtempSync(join(tmpdir(), "chiphippo-seed-"));
  try {
    const seed = join(dir, "seed.json");
    writeFileSync(seed, JSON.stringify({
      author: "Chip Hippo",
      entries: [{ id: "ghost-000000", demo: "NE555.json", desktop: "Nope", title: "Ghost" }],
    })); // prettier-ignore
    built({ seed }, ({ problems, written }) => {
      assert.equal(written, 0);
      assert.equal(problems[0].problems[0].code, "noSuchDemo");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gallery-repo entry is validated, its derived fields recomputed, its folder its id", () => {
  const repo = mkdtempSync(join(tmpdir(), "chiphippo-entries-"));
  const seed = join(repo, "seed.json");
  writeFileSync(seed, JSON.stringify({ entries: [] }));
  const demo = JSON.parse(readFileSync(join(ROOT, "src/web/demos/74LS00.json"), "utf8")); // prettier-ignore
  const design = JSON.stringify({ version: 5, kind: "desktop", name: "NAND", doc: demo.doc }); // prettier-ignore
  const put = (id, entry, text = design) => {
    mkdirSync(join(repo, "entries", id), { recursive: true });
    writeFileSync(
      join(repo, "entries", id, "entry.json"),
      JSON.stringify(entry),
    );
    writeFileSync(join(repo, "entries", id, "design.desktop.chiphippo"), text);
  };
  const good = { id: "nand-bench-abcdef", title: "NAND bench", author: "Ada", tags: ["logic"], created: "2026-11-01", derived: { chips: 99, engine: "spice" } }; // prettier-ignore
  put("nand-bench-abcdef", good);
  put("wrong-folder-abcdef", { ...good, id: "nand-bench-abcdef" });
  put("broken-design-abcdef", { ...good, id: "broken-design-abcdef" }, "{nope");
  try {
    built(
      { seed, entries: join(repo, "entries") },
      ({ index, problems }, out) => {
        assert.deepEqual(
          index.entries.map((e) => e.id),
          ["nand-bench-abcdef"],
        );
        const e = index.entries[0];
        assert.equal(e.derived.chips, 1, "never the entry's own claim");
        assert.equal(e.derived.engine, "logic");
        assert.equal(e.source, "shared");
        // Published under its entry's title, not the sharer's tab name.
        const published = JSON.parse(readFileSync(join(out, "entries", e.id, "design.desktop.chiphippo"), "utf8")); // prettier-ignore
        assert.equal(published.name, "NAND bench");
        assert.equal(published.description, undefined, "omitted when empty");
        const codes = Object.fromEntries(problems.map((p) => [p.id, p.problems.map((q) => q.code)])); // prettier-ignore
        assert.deepEqual(codes["wrong-folder-abcdef"], ["idMismatch"]);
        assert.deepEqual(codes["broken-design-abcdef"], ["notJson"]);
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const ENTRIES = [
  { id: "a-000001", title: "Blinker", author: "Ada", tags: ["led"], featured: false, derived: { level: "beginner", engine: "logic", autoTags: ["timer"], chips: 1, parts: 5 } }, // prettier-ignore
  { id: "b-000002", title: "Siren", author: "Grace", tags: [], featured: true, derived: { level: "intermediate", engine: "spice", autoTags: ["audio", "timer"], chips: 2, parts: 9 } }, // prettier-ignore
  { id: "c-000003", title: "Computer", author: "Ada", tags: ["hello-world"], featured: false, derived: { level: "advanced", engine: "logic", autoTags: ["cpu"], chips: 4, parts: 11 } }, // prettier-ignore
];

test("filtering: every word, the filters, featured first", () => {
  const ids = (f) => filterEntries(ENTRIES, f).map((e) => e.id);
  assert.deepEqual(ids({}), ["b-000002", "a-000001", "c-000003"]);
  assert.deepEqual(ids({ query: "ada" }), ["a-000001", "c-000003"]);
  assert.deepEqual(ids({ query: "ada cpu" }), ["c-000003"]);
  assert.deepEqual(ids({ tag: "timer" }), ["b-000002", "a-000001"]);
  assert.deepEqual(ids({ level: "advanced" }), ["c-000003"]);
  assert.deepEqual(ids({ engine: "spice" }), ["b-000002"]);
  assert.deepEqual(tagsOf(ENTRIES), ["audio", "cpu", "hello-world", "led", "timer"]); // prettier-ignore
});

test("the grid draws the index, filters live, and opens an entry with its actions", async () => {
  const dom = new JSDOM(`<div id="g"></div>`);
  const root = dom.window.document.getElementById("g");
  const view = new GalleryView({
    root,
    source: {
      index: async () => ({ entries: ENTRIES }),
      entry: async (id) => ({ description: `about ${id}` }),
      thumbUrl: () => null,
    },
    say: (key, p = {}) => `${key}${p.author ? `:${p.author}` : ""}`,
    actions: [
      { id: "open", label: "Open", href: (e) => `/desktop/?gallery=${e.id}` },
      { id: "download", label: "Download", href: (e) => `entries/${e.id}/x`, download: (e) => `${e.id}.x` }, // prettier-ignore
    ],
  });
  await view.load();
  const cards = () => [...root.querySelectorAll(".gallery-card")].map((c) => c.dataset.id); // prettier-ignore
  assert.deepEqual(cards(), ["b-000002", "a-000001", "c-000003"]);
  const search = root.querySelector(".gallery-search");
  search.value = "computer";
  search.dispatchEvent(new dom.window.Event("input"));
  assert.deepEqual(cards(), ["c-000003"]);
  search.value = "nothing at all";
  search.dispatchEvent(new dom.window.Event("input"));
  assert.deepEqual(cards(), []);
  assert.equal(root.querySelector(".gallery-status").textContent, "empty");
  search.value = "";
  search.dispatchEvent(new dom.window.Event("input"));
  root.querySelector('[data-id="c-000003"]').click();
  const detail = root.querySelector(".gallery-detail");
  assert.equal(detail.hidden, false);
  assert.equal(
    detail.querySelector(".gallery-detail-title").textContent,
    "Computer",
  );
  const open = detail.querySelector('[data-action="open"]');
  assert.equal(open.getAttribute("href"), "/desktop/?gallery=c-000003");
  assert.equal(detail.querySelector('[data-action="download"]').getAttribute("download"), "c-000003.x"); // prettier-ignore
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(detail.querySelector(".gallery-detail-description").textContent, "about c-000003"); // prettier-ignore
  detail.querySelector(".gallery-detail-close").click();
  assert.equal(detail.hidden, true);
  // Escape inside the detail goes back to the grid, and no further (the
  // Browse window closes on an Escape nothing took).
  root.querySelector('[data-id="c-000003"]').click();
  let reached = 0;
  dom.window.addEventListener("keydown", () => reached++);
  const esc = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); // prettier-ignore
  detail.querySelector(".gallery-detail-close").dispatchEvent(esc);
  assert.equal(detail.hidden, true);
  assert.equal(esc.defaultPrevented, true);
  assert.equal(reached, 0, "the window never hears it");
  assert.equal(dom.window.document.activeElement?.dataset.id, "c-000003", "back on its card"); // prettier-ignore
});

test("an index that cannot be read says so", async () => {
  const dom = new JSDOM(`<div id="g"></div>`);
  const root = dom.window.document.getElementById("g");
  const view = new GalleryView({
    root,
    source: { index: async () => { throw new Error("404"); }, thumbUrl: () => null }, // prettier-ignore
    say: (key) => key,
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    await view.load();
  } finally {
    console.error = quiet;
  }
  assert.equal(root.querySelector(".gallery-status").textContent, "failed");
});

test("the deploy builds the guide and the gallery from the release /desktop came from", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-site.yml"), "utf8"); // prettier-ignore
  const at = (name) => workflow.indexOf(`- name: ${name}`);
  // The web app's step names its tag; ONE checkout of that tag follows it,
  // and both the guide and the gallery run ITS scripts — so main's
  // unreleased Markdown and gallery code are never what the site shows.
  assert.match(workflow, /id: webapp/);
  assert.match(workflow, /echo "tag=\$\(gh release view .*--json tagName/);
  assert.match(
    workflow,
    /git worktree add --quiet --detach \.release-src "\$TAG"/,
  );
  assert.match(
    workflow,
    /MARKED_DIR="\$PWD\/\.docs-deps\/node_modules" make -C "\$CODE" docs/,
  );
  assert.match(workflow, /require\('\.\/\$CODE\/src\/package-lock\.json'\)/);
  assert.match(workflow, /node "\$CODE\/scripts\/build-gallery\.mjs" --strict/);
  assert.match(workflow, /timeout \d+m node "\$CODE\/scripts\/render-gallery-thumbs\.mjs"/, "bounded: a wedged browser never holds the deploy"); // prettier-ignore
  assert.doesNotMatch(workflow, /node scripts\/build-gallery\.mjs/);
  assert.doesNotMatch(workflow, /\n\s+MARKED_DIR=\S+ make docs\n/);
  const order = ["Put the web app at /desktop", "Check out the release's code", "Build the hosted user guide", "Put the gallery at /gallery"]; // prettier-ignore
  for (const name of order) assert.ok(at(name) > 0, name);
  assert.deepEqual(
    order.map(at),
    order.map(at).toSorted((a, b) => a - b),
  );
});

test("the page offers the desktop app by the link the app parses", async () => {
  const page = readFileSync(join(ROOT, "website/gallery/gallery.js"), "utf8");
  const m = /href: \(entry\) => `(chiphippo:\/\/gallery\/)\$\{encodeURIComponent\(entry\.id\)\}`/.exec(page); // prettier-ignore
  assert.ok(m, "an Open in desktop app action");
  const { createRequire } = await import("node:module");
  const { parseDeepLink } = createRequire(import.meta.url)("../../../app/deep-link.js"); // prettier-ignore
  for (const { id } of SEED.entries) {
    assert.deepEqual(parseDeepLink(`${m[1]}${encodeURIComponent(id)}`), { kind: "gallery", id }); // prettier-ignore
  }
});

test("the page's head is its own: one CSP, its own title, and a stylesheet the browser reads whole", () => {
  // A splice from releases.html once left that page's CSP, title and og tags
  // as raw text INSIDE <style>, where they became the first rule's selector —
  // invalid, so the browser dropped the site's reset with it.
  const html = readFileSync(join(ROOT, "website/gallery/index.html"), "utf8");
  const { document } = new JSDOM(html).window;
  const csp = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'); // prettier-ignore
  assert.equal(csp.length, 1);
  assert.match(csp[0].content, /script-src 'self'/);
  assert.equal(document.title, "Gallery — Chip Hippo");
  assert.equal(document.querySelector('meta[property="og:url"]')?.content, "https://chiphippo.com/gallery/"); // prettier-ignore
  for (const style of document.querySelectorAll("style")) {
    assert.match(
      style.textContent,
      /^\s*(\/\*[\s\S]*?\*\/\s*)?[*:.#a-z[@]/i,
      "a <style> opens on a rule",
    );
    assert.doesNotMatch(
      style.textContent,
      /<meta|<title|-->/,
      "no markup inside a <style>",
    );
  }
});
