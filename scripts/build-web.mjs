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

// build-web.mjs — build Chip Hippo's WEB distribution into dist/web/: the app
// with Electron taken out, as a static site (see .claude/rules/web.md).
//
//   node scripts/build-web.mjs            # → dist/web/
//   node scripts/build-web.mjs --out DIR  # somewhere else
//
// What it does:
//   · copies src/web minus its tests and benches, then BUNDLES the renderer:
//     each page's module script (and the simulation Worker) becomes one
//     minified file in its own place, built from exactly the modules it loads
//     in Electron — the source is unchanged, only how it is delivered;
//   · bundles MAIN — src/app/main.js and everything it requires — with esbuild
//     into web-host/host.js, swapping Electron and the Node built-ins for the
//     browser stand-ins under src/web-host/, and app/updater.js for the
//     service-worker one;
//   · bundles app/preload.js the same way into web-host/preload.js, and puts
//     it (and, in index.html, the host) at the head of every page;
//   · writes the manifest of shipped content main reads by path
//     (web-host/files.json), version.json, the service worker with the list of
//     files it caches, the PWA manifest and a _headers file (read by hosts
//     such as Cloudflare Pages; GitHub Pages, where it lives, ignores it).
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const WEB = join(SRC, "web");
const HOST = join(SRC, "web-host");
const APP = join(SRC, "app");

const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const OUT = outArg >= 0 ? resolve(args[outArg + 1]) : join(ROOT, "dist", "web");
const MINIFY = !args.includes("--no-minify");

const pkg = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8"));

// Not shipped: the renderer's tests and benches, and the desktop-only icons.
const SKIP = [
  /^scripts[/\\]tests([/\\]|$)/,
  /^scripts[/\\]bench([/\\]|$)/,
  /\.ico$/,
  /^chiphippo-mac-icon\./,
];

// Shipped content main reads BY PATH (bundle.js) — listed in files.json.
const BY_PATH = ["locales", "demos", "docs", "datasheets"];

// Fetched when first wanted rather than at install: the guide and the
// datasheet crops are most of the release's bytes and most visits read none.
const LAZY = [/^docs\//, /^datasheets\//, /^icons\/(?!(256|512)x)/];

// Every bundle opens with the project's notice: minifying drops the source's
// own headers (CLAUDE.md → "License headers"), and a file someone copies out
// of the site should still say whose it is, under what licence, and where its
// source is (GPL-3.0 §6).
const BANNER = {
  js: `/*! Chip Hippo ${pkg.version} — Copyright 2026 Jason Figge. Licensed GPL-3.0-or-later (https://www.gnu.org/licenses/). Source: https://github.com/jfigge/chiphippo */`,
};

/** The connect-src a page needs for the AI builder's own-key calls. */
const CONNECT =
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*;";

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/**
 * One page, made a web page: the host's stylesheet, the preload (and, in
 * index.html, the host) ahead of the page's own modules, and a CSP that lets
 * the AI builder reach the provider the visitor configured. Exported for
 * web-host/tests/build-web.test.js.
 */
export function transformHtml(html, { isIndex = false } = {}) {
  let out = html;
  // The CSP: main now runs in the page, so its one outbound call (the AI
  // builder, with the visitor's own key) is the page's.
  out = out.replace(
    /default-src\s+'self';/,
    (m) =>
      `${m}\n        ${CONNECT}\n        worker-src 'self';\n        manifest-src 'self';`,
  );
  out = out.replace(/img-src\s+'self' data:;/, "img-src 'self' data: blob:;");
  const head = [
    `<link rel="stylesheet" href="web-host/web-host.css" />`,
    `<script src="web-host/preload.js"></script>`,
  ];
  if (isIndex) {
    head.unshift(
      `<link rel="manifest" href="manifest.webmanifest" />`,
      `<meta name="theme-color" content="#1c1c1c" />`,
      `<link rel="apple-touch-icon" href="icons/256x256.png" />`,
    );
    head.push(`<script type="module" src="web-host/host.js"></script>`);
  }
  if (!out.includes("</head>")) throw new Error("a page with no </head>");
  out = out.replace("</head>", `    ${head.join("\n    ")}\n  </head>`);
  return out;
}

/**
 * The renderer's entry modules, relative to src/web: each page's module script
 * (read from the pages themselves, so a new window needs no list) and every
 * Worker one names with `new URL(…, import.meta.url)`. Exported for
 * web-host/tests/build-web.test.js.
 */
export function rendererEntries(webDir = WEB) {
  const pages = [];
  for (const name of readdirSync(webDir)) {
    if (!name.endsWith(".html")) continue;
    const html = readFileSync(join(webDir, name), "utf8");
    for (const m of html.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g))
      pages.push(m[1]);
  }
  for (const rel of pages)
    if (posix.dirname(rel) !== "scripts")
      throw new Error(`${rel}: a page's module script must live in scripts/`);
  return [...new Set(pages)].sort().concat(WORKERS);
}

// The Workers — one, the simulation's. A page bundle is written to scripts/,
// so the URL its code builds from import.meta.url is rewritten to be relative
// to that (rendererUrls); a `new URL(…, import.meta.url)` naming anything not
// listed here fails the build rather than a visit.
const WORKERS = ["scripts/components/sim-worker.js"];
const META_URL_RE =
  /new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

function rendererUrls() {
  return {
    name: "chiphippo-web-meta-url",
    setup(build) {
      build.onLoad({ filter: /\.js$/ }, (a) => {
        const src = readFileSync(a.path, "utf8");
        if (!src.includes("import.meta.url")) return undefined;
        const contents = src.replace(META_URL_RE, (_m, spec) => {
          const rel = relative(WEB, resolve(dirname(a.path), spec))
            .split(sep)
            .join("/");
          if (!WORKERS.includes(rel))
            throw new Error(
              `${a.path}: new URL("${spec}") is not a Worker build-web.mjs knows`,
            );
          const from = posix.relative("scripts", rel);
          return `new URL(${JSON.stringify(`./${from}`)}, import.meta.url)`;
        });
        return { contents, loader: "js" };
      });
    },
  };
}

/**
 * The esbuild plugin that puts the web host's modules in place of main's own
 * where the browser needs a different one (app/updater.js), and hands main's
 * `require("../package.json")` the version alone rather than the whole build
 * configuration.
 */
function replaceModules(map) {
  const PKG = join(SRC, "package.json");
  return {
    name: "chiphippo-web-replace",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (a) => {
        if (!a.path.startsWith(".")) return undefined;
        const target = resolve(a.resolveDir, a.path);
        const hit = map.get(target) ?? map.get(`${target}.js`);
        return hit ? { path: hit } : undefined;
      });
      build.onLoad({ filter: /package\.json$/ }, (a) =>
        a.path === PKG
          ? {
              contents: JSON.stringify({ version: pkg.version }),
              loader: "json",
            }
          : undefined,
      );
    },
  };
}

/**
 * The two esbuild configurations: MAIN (host-entry.js → web-host/host.js) and
 * the PRELOAD (preload-entry.js → web-host/preload.js). Exported so
 * web-host/tests/ can build both in memory — a bundle that will not build
 * (main gaining a Node module the host has no stand-in for) fails there.
 * @param {{outDir?: string, minify?: boolean}} [opts]
 */
export function bundleOptions({ outDir = OUT, minify = MINIFY } = {}) {
  const shims = {
    electron: join(HOST, "electron.js"),
    fs: join(HOST, "node/fs.js"),
    "node:fs": join(HOST, "node/fs.js"),
    path: join(HOST, "node/path.js"),
    "node:path": join(HOST, "node/path.js"),
    crypto: join(HOST, "node/crypto.js"),
    "node:crypto": join(HOST, "node/crypto.js"),
    string_decoder: join(HOST, "node/string-decoder.js"),
    serialport: join(HOST, "serialport.js"),
  };
  const common = {
    bundle: true,
    platform: "browser",
    target: "es2022",
    minify,
    sourcemap: true,
    logLevel: "warning",
    banner: BANNER,
    inject: [join(HOST, "node/globals.js")],
    define: {
      __dirname: '"/app"',
      fetch: "__chiphippoFetch",
      // the app's version, so the boot need not fetch version.json for it
      __CHIPHIPPO_VERSION__: JSON.stringify(pkg.version),
    },
  };
  return {
    // The renderer: one file per entry, written over the entry's own copy, so
    // every page and the Worker load the path they load in Electron. No
    // splitting — each window is its own realm and loads its own modules there
    // too — and no dynamic chunks (the one import() is the Worker's own host).
    renderer: {
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "esm",
      minify,
      sourcemap: true,
      logLevel: "warning",
      banner: BANNER,
      entryPoints: rendererEntries().map((rel) => join(WEB, rel)),
      outbase: WEB,
      outdir: outDir,
      allowOverwrite: true,
      absWorkingDir: ROOT,
      plugins: [rendererUrls()],
    },
    host: {
      ...common,
      entryPoints: [join(HOST, "host-entry.js")],
      outfile: join(outDir, "web-host/host.js"),
      format: "esm",
      alias: shims,
      plugins: [
        replaceModules(
          new Map([[join(APP, "updater.js"), join(HOST, "updater.js")]]),
        ),
      ],
    },
    preload: {
      ...common,
      entryPoints: [join(HOST, "renderer/preload-entry.js")],
      outfile: join(outDir, "web-host/preload.js"),
      format: "iife",
      alias: { electron: join(HOST, "renderer/electron.js") },
    },
  };
}

/** esbuild, from src/'s own dependencies. */
export function loadEsbuild() {
  return createRequire(join(SRC, "package.json"))("esbuild");
}

async function bundle(esbuild) {
  const { renderer, host, preload } = bundleOptions();
  await esbuild.build(host);
  await esbuild.build(preload);
  const { metafile } = await esbuild.build({ ...renderer, metafile: true });
  // The renderer's module files are in the bundles now: only those ship.
  const keep = new Set(
    Object.keys(metafile.outputs).map((p) => resolve(ROOT, p)),
  );
  for (const rel of walk(join(OUT, "scripts"))) {
    const file = join(OUT, "scripts", rel);
    if (rel.endsWith(".js") && !keep.has(file)) rmSync(file);
  }
  rmSync(join(OUT, "scripts/package.json"), { force: true });
  pruneEmpty(join(OUT, "scripts"));
}

function pruneEmpty(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) pruneEmpty(join(dir, entry.name));
  if (!readdirSync(dir).length) rmSync(dir, { recursive: true });
}

function stampOf(files) {
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update(readFileSync(join(OUT, rel)));
  }
  return hash.digest("hex").slice(0, 12);
}

export async function buildWeb() {
  const esbuild = loadEsbuild();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // ① The renderer, as it is.
  for (const rel of walk(WEB)) {
    if (SKIP.some((re) => re.test(rel))) continue;
    const to = join(OUT, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(WEB, rel), to);
  }

  // ② The pages, made web pages.
  for (const name of readdirSync(OUT)) {
    if (!name.endsWith(".html")) continue;
    const file = join(OUT, name);
    writeFileSync(
      file,
      transformHtml(readFileSync(file, "utf8"), {
        isIndex: name === "index.html",
      }),
    );
  }

  // ③ Main, the preload and the renderer.
  await bundle(esbuild);
  cpSync(join(HOST, "web-host.css"), join(OUT, "web-host/web-host.css"));

  // ④ What main reads by path.
  const byPath = [];
  for (const dir of BY_PATH) {
    if (!existsSync(join(OUT, dir))) continue;
    for (const rel of walk(join(OUT, dir))) {
      const p = `${dir}/${rel}`;
      byPath.push([p, statSync(join(OUT, p)).size]);
    }
  }
  byPath.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  writeFileSync(
    join(OUT, "web-host/files.json"),
    `${JSON.stringify({ files: byPath })}\n`,
  );

  // ⑤ The PWA manifest.
  writeFileSync(
    join(OUT, "manifest.webmanifest"),
    `${JSON.stringify(
      {
        name: "Chip Hippo",
        short_name: "Chip Hippo",
        description: pkg.description,
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#1c1c1c",
        theme_color: "#1c1c1c",
        icons: [
          { src: "chiphippo-icon.svg", sizes: "any", type: "image/svg+xml" },
          { src: "icons/256x256.png", sizes: "256x256", type: "image/png" },
          { src: "icons/512x512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      null,
      2,
    )}\n`,
  );

  // ⑥ The release: its version, its stamp, and what the worker caches.
  const all = walk(OUT).sort();
  const shell = all.filter(
    (rel) => !LAZY.some((re) => re.test(rel)) && !rel.endsWith(".map"),
  );
  const stamp = stampOf(shell);
  writeFileSync(
    join(OUT, "version.json"),
    `${JSON.stringify({ version: pkg.version, stamp })}\n`,
  );
  const build = {
    version: pkg.version,
    stamp,
    shell: ["./", ...shell.filter((r) => r !== "_headers")],
  };
  writeFileSync(
    join(OUT, "sw.js"),
    `const BUILD = ${JSON.stringify(build)};\n${readFileSync(join(HOST, "sw.js"), "utf8")}`,
  );

  // ⑦ For a host that reads _headers: everything revalidated (the worker is the cache), and
  //    the usual hardening. A host without _headers serves the site as well.
  writeFileSync(
    join(OUT, "_headers"),
    [
      "/*",
      "  Cache-Control: no-cache",
      "  X-Content-Type-Options: nosniff",
      "  Referrer-Policy: strict-origin-when-cross-origin",
      "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
      "",
    ].join("\n"),
  );

  const bytes = all.reduce((n, rel) => n + statSync(join(OUT, rel)).size, 0);
  return { out: OUT, files: all.length, bytes, version: pkg.version, stamp };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  buildWeb().then(
    ({ out, files, bytes, version, stamp }) =>
      console.log(
        `Chip Hippo web ${version} (${stamp}): ${files} files, ${(bytes / 1048576).toFixed(1)} MB → ${relative(ROOT, out)}`,
      ),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
