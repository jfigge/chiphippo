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

// profile-desk.mjs — record a Chrome DevTools performance profile of the app
// running a BUSY circuit, and say where the main thread's time went:
// the ENGINE (sim/engine.js `tick`), the views reacting to each tick (the
// `chiphippo:sim-state` broadcast), and the browser's own RENDERING (style,
// layout, paint, compositing).
//
//   make profile                     (PROFILE_SLICES=16 PROFILE_SECONDS=10 …)
//   PROFILE_SPICE=1 make profile     the same, Run on Spice Lite
//
// Launches the real app — the Electron binary, a throwaway --user-data-dir,
// never the project's data/ — on the busy fixture (web/scripts/bench/
// busy-circuit.js), presses Run, sets the speed, lets it warm up, then records
// for PROFILE_SECONDS over the DevTools protocol:
//
//   trace.json          a Performance-panel trace (DevTools ▸ Performance ▸
//                       Load profile…): every task, style recalc, layout,
//                       paint and frame, with JS samples.
//   renderer.cpuprofile the app window's JS CPU profile (also loadable).
//   report.txt          the breakdown printed below.
//
// Written to PROFILE_OUT (default: <tmp>/chiphippo-profile). Local tooling:
// it drives the UI by selector, so a renamed toolbar class breaks it loudly.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const require = createRequire(path.join(SRC, "package.json"));

const OUT = process.env.PROFILE_OUT ?? path.join(os.tmpdir(), "chiphippo-profile"); // prettier-ignore
const SLICES = Number(process.env.PROFILE_SLICES ?? 8);
const SECONDS = Number(process.env.PROFILE_SECONDS ?? 8);
const WARMUP = Number(process.env.PROFILE_WARMUP ?? 3);
const SPEED = process.env.PROFILE_SPEED ?? "×4"; // the speed button's label
const PORT = Number(process.env.PROFILE_PORT ?? 9388);
const SPICE = /^(1|true|yes)$/i.test(process.env.PROFILE_SPICE ?? "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A minimal DevTools-protocol client (Node's own WebSocket) ───────────────

async function fetchJson(url, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error(`DevTools endpoint never came up: ${url}`);
}

class Session {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  static async attach(url) {
    const s = new Session(new WebSocket(url));
    await new Promise((resolve, reject) => {
      s.#ws.addEventListener("open", resolve, { once: true });
      s.#ws.addEventListener("error", reject, { once: true });
    });
    return s;
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id != null) {
        const slot = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) slot?.reject(new Error(JSON.stringify(msg.error)));
        else slot?.resolve(msg.result);
        return;
      }
      for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const fns = this.#listeners.get(method) ?? [];
      const fn = (p) => {
        fns.splice(fns.indexOf(fn), 1);
        resolve(p);
      };
      fns.push(fn);
      this.#listeners.set(method, fns);
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`); // prettier-ignore
    }
    return res.result?.value;
  }

  async waitFor(expr, timeout = 20000) {
    const until = Date.now() + timeout;
    while (!(await this.eval(`return !!(${expr});`))) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${expr}`);
      await sleep(100);
    }
  }

  async click(selector) {
    const [x, y] = await this.eval(
      `const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`,
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); // prettier-ignore
    }
  }

  close() {
    this.#ws.close();
  }
}

// ── The fixture project and a clean profile directory ───────────────────────

async function writeFixture() {
  const { busyDocument } = await import(
    pathToFileURL(path.join(SRC, "web/scripts/bench/busy-circuit.js")).href
  );
  const doc = busyDocument(SLICES);
  const file = path.join(OUT, "busy.chiphippo");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 5,
      name: "busy",
      activeTab: "t1",
      nextIndex: 2,
      tabs: [{ id: "t1", name: `Busy circuit (${SLICES} slices)`, doc }],
    }),
  );
  const data = path.join(OUT, "data");
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    path.join(data, "settings.json"),
    JSON.stringify({
      recentProjects: [file],
      windowBounds: { x: 40, y: 40, width: 1400, height: 900 },
      paletteOpen: false,
      ...(SPICE
        ? { spiceLite: { enabled: true, gapPercent: 1, families: {} } }
        : {}),
    }),
  );
  return { doc, data };
}

function launch(data) {
  const child = spawn(
    require("electron"),
    ["app/main.js", `--user-data-dir=${data}`, `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*"], // prettier-ignore
    // Its own process group, so one kill takes Electron's helpers with it.
    { cwd: SRC, stdio: "ignore", detached: true },
  );
  return {
    async page(suffix) {
      for (let i = 0; i < 160; i++) {
        const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
        const hit = list.find((t) => t.type === "page" && t.url.includes(suffix)); // prettier-ignore
        if (hit?.webSocketDebuggerUrl) return Session.attach(hit.webSocketDebuggerUrl); // prettier-ignore
        await sleep(250);
      }
      throw new Error(`no ${suffix} page`);
    },
    kill() {
      for (const sig of ["SIGTERM", "SIGKILL"]) {
        try {
          process.kill(-child.pid, sig);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

async function readStream(page, handle) {
  let text = "";
  for (;;) {
    const { data, eof, base64Encoded } = await page.send("IO.read", { handle, size: 4 << 20 }); // prettier-ignore
    text += base64Encoded ? Buffer.from(data, "base64").toString("utf8") : data;
    if (eof) break;
  }
  await page.send("IO.close", { handle });
  return text;
}

// ── Analysis ────────────────────────────────────────────────────────────────

/** Self and inclusive milliseconds per function in a V8 CPU profile. */
function profileTimes(prof) {
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id); // prettier-ignore
  const dt = new Map();
  prof.samples.forEach((id, i) => {
    dt.set(id, (dt.get(id) ?? 0) + (prof.timeDeltas[i + 1] ?? 0) / 1000);
  });
  const name = (n) => n.callFrame.functionName || "(anonymous)";
  const where = (n) => n.callFrame.url.replace(/^.*\/web\//, "");
  const key = (n) => `${name(n)}  ${where(n)}:${n.callFrame.lineNumber + 1}`;
  const self = new Map();
  const incl = new Map();
  const under = new Map(); // "fn@file" → inclusive ms (by name + file only)
  let total = 0;
  for (const [id, ms] of dt) {
    total += ms;
    const n = nodes.get(id);
    self.set(key(n), (self.get(key(n)) ?? 0) + ms);
    const seenKey = new Set();
    const seenUnder = new Set();
    for (let cur = id; cur != null; cur = parent.get(cur)) {
      const m = nodes.get(cur);
      const k = key(m);
      if (!seenKey.has(k)) {
        seenKey.add(k);
        incl.set(k, (incl.get(k) ?? 0) + ms);
      }
      const u = `${name(m)}@${where(m).split("/").pop()}`;
      if (!seenUnder.has(u)) {
        seenUnder.add(u);
        under.set(u, (under.get(u) ?? 0) + ms);
      }
    }
  }
  return { self, incl, under, total };
}

/** Self time by where the code lives. */
function selfByArea(self) {
  const area = (k) => {
    if (k.startsWith("(garbage collector)")) return "garbage collection";
    if (k.startsWith("(idle)")) return "idle";
    if (k.startsWith("(program)")) return "browser native (program)";
    if (k.includes("scripts/sim/")) return "engine — sim/";
    if (k.includes("scripts/model/"))
      return "model/ (geometry, netlist helpers…)";
    if (k.includes("scripts/components/"))
      return "components/ (views, controllers)";
    if (k.includes("scripts/desk/")) return "desk/ (geometry)";
    if (k.includes("scripts/catalog/")) return "catalog/";
    if (k.includes("scripts/")) return "other app scripts";
    return "browser / built-ins";
  };
  const out = new Map();
  for (const [k, ms] of self) out.set(area(k), (out.get(area(k)) ?? 0) + ms);
  return out;
}

/** Main-thread work in the trace: lifecycle phases, split FORCED (inside a
    script) from the frame's own, plus busy time and frames. */
function traceTimes(trace) {
  const events = trace.traceEvents ?? trace;
  // The app window's renderer main thread: the CrRendererMain with the most
  // events (DevTools' own pages are not in the trace).
  const names = new Map();
  for (const e of events) {
    if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args.name); // prettier-ignore
  }
  const counts = new Map();
  for (const e of events) {
    const k = `${e.pid}:${e.tid}`;
    if (names.get(k) === "CrRendererMain") counts.set(k, (counts.get(k) ?? 0) + 1); // prettier-ignore
  }
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const mine = events
    .filter(
      (e) => `${e.pid}:${e.tid}` === main && e.ph === "X" && e.dur != null,
    ) // prettier-ignore
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const SCRIPT = new Set(["FunctionCall", "EvaluateScript", "TimerFire", "EventDispatch", "v8.callFunction", "FireAnimationFrame", "FireIdleCallback", "RunMicrotasks", "V8.Execute"]); // prettier-ignore
  const PHASES = {
    UpdateLayoutTree: "style",
    Layout: "layout",
    PrePaint: "pre-paint",
    Paint: "paint",
    PaintImage: "paint",
    Layerize: "layerize / commit",
    Commit: "layerize / commit",
    UpdateLayer: "layerize / commit",
    "Decode Image": "image decode",
    HitTest: "hit test",
  };
  const phase = new Map();
  let busy = 0;
  let frames = 0;
  const stack = [];
  let t0 = Infinity;
  let t1 = 0;
  for (const e of mine) {
    while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts)
      stack.pop();
    if (!stack.length && (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask")) busy += e.dur; // prettier-ignore
    t0 = Math.min(t0, e.ts);
    t1 = Math.max(t1, e.ts + e.dur);
    const p = PHASES[e.name];
    if (p) {
      const forced = stack.some((s) => SCRIPT.has(s.name));
      const k = `${p}${forced ? " (forced, inside script)" : ""}`;
      // Count a phase once — not again where it nests inside itself.
      if (!stack.some((s) => PHASES[s.name] === p)) phase.set(k, (phase.get(k) ?? 0) + e.dur / 1000); // prettier-ignore
    }
    if (e.name === "Commit") frames++;
    stack.push(e);
  }
  return { phase, busyMs: busy / 1000, spanMs: (t1 - t0) / 1000, frames };
}

// ── Run ─────────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT, { recursive: true });
const { doc, data } = await writeFixture();
const app = launch(data);
const report = [];
const say = (s = "") => {
  report.push(s);
  console.log(s);
};
try {
  const page = await app.page("index.html");
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.waitFor(`document.querySelector(".part-chip")`);
  // A first load can run stale code out of Chromium's cache.
  await page.send("Page.reload", { ignoreCache: true });
  await sleep(800);
  await page.waitFor(`document.querySelector(".part-chip")`);
  await sleep(1500);
  await page.eval(`
    window.__simStates = 0;
    window.addEventListener("chiphippo:sim-state", () => window.__simStates++);
  `);
  await page.click(".toolbar-pill--transport button");
  await page.waitFor(`document.querySelector(".part-chip") && window.__simStates > 0`); // prettier-ignore
  for (let i = 0; i < 3; i++) {
    const label = await page.eval(`const b = [...document.querySelectorAll(".toolbar-pill--transport button")].find((x) => /^×/.test(x.textContent)); if (!b) return null; if (b.textContent !== ${JSON.stringify(SPEED)}) b.click(); return b.textContent;`); // prettier-ignore
    if (label === SPEED) break;
  }
  await sleep(WARMUP * 1000);

  const chips = doc.components.filter((c) => c.kind === "chip").length;
  await page.send("Profiler.enable");
  await page.send("Profiler.setSamplingInterval", { interval: 250 });
  const before = await page.eval(`return window.__simStates`);
  await page.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "v8.execute", "disabled-by-default-v8.cpu_profiler", "blink.user_timing", "toplevel", "latencyInfo"], // prettier-ignore
    },
  });
  await page.send("Profiler.start");
  await sleep(SECONDS * 1000);
  const { profile } = await page.send("Profiler.stop");
  const after = await page.eval(`return window.__simStates`);
  const done = page.once("Tracing.tracingComplete");
  await page.send("Tracing.end");
  const { stream } = await done;
  const traceText = await readStream(page, stream);
  page.close();

  fs.writeFileSync(path.join(OUT, "trace.json"), traceText);
  fs.writeFileSync(
    path.join(OUT, "renderer.cpuprofile"),
    JSON.stringify(profile),
  );

  // ── Report ──
  const cpu = profileTimes(profile);
  const tr = traceTimes(JSON.parse(traceText));
  const wall = SECONDS * 1000;
  const per = (ms) => `${(ms / SECONDS).toFixed(0).padStart(5)} ms/s  ${((100 * ms) / wall).toFixed(1).padStart(5)}%`; // prettier-ignore
  const u = (fn) => cpu.under.get(fn) ?? 0;
  const ticks = after - before;
  say(`Busy circuit, ${SLICES} slices (${chips} chips, ${doc.components.length} components, ${doc.wires.length} wires), Run at ${SPEED}${SPICE ? " on Spice Lite" : ""}, ${SECONDS} s recorded`); // prettier-ignore
  say(`  ${ticks} ticks published = ${(ticks / SECONDS).toFixed(0)}/s; ${tr.frames} frames committed = ${(tr.frames / (tr.spanMs / 1000)).toFixed(0)} fps; main thread busy ${((100 * tr.busyMs) / tr.spanMs).toFixed(0)}% of the time`); // prettier-ignore
  if (tr.frames === 0) {
    // macOS stops drawing an occluded window, or any window while the display
    // sleeps — and the run throttles with it. Seen once as 4 ticks a second.
    say("  ⚠ NO FRAMES were drawn: the window was hidden or the display asleep. These numbers are not representative — keep the window on screen and run again."); // prettier-ignore
  }
  say();
  say("MAIN THREAD, per second of wall time");
  const tickOnce = u("#tickOnce@sim-controller.js");
  const engine = u("tick@engine.js");
  const publish = u("#publish@sim-controller.js");
  const snapshot = u("toJSON@desk-doc.js");
  say(`  JS: one tick, start to finish (#tickOnce)     ${per(tickOnce)}`);
  say(`    engine (sim/engine.js tick)                  ${per(engine)}`);
  say(`    views reacting to it (sim-state broadcast)   ${per(publish)}`);
  // V8 sometimes inlines toJSON (a structuredClone of the whole document),
  // and then its time is #tickOnce's own: so the two are reported together.
  say(`    document snapshot + the rest of the tick     ${per(tickOnce - engine - publish)}`); // prettier-ignore
  say(`      of which DeskDoc.toJSON, when not inlined  ${per(snapshot)}`);
  say(`  JS outside a tick                              ${per(cpu.total - tickOnce - (cpu.self.get("(idle)  :0") ?? 0) - (cpu.self.get("(program)  :0") ?? 0) - (cpu.self.get("(garbage collector)  :0") ?? 0))}`); // prettier-ignore
  say(`  garbage collection                             ${per(cpu.self.get("(garbage collector)  :0") ?? 0)}`); // prettier-ignore
  say(`  browser rendering (trace):`);
  for (const [k, v] of [...tr.phase].sort((a, b) => b[1] - a[1])) {
    say(`    ${k.padEnd(45)}${per(v)}`);
  }
  say(`  idle (no JS)                                   ${per(cpu.self.get("(idle)  :0") ?? 0)}`); // prettier-ignore
  say();
  say("JS SELF TIME BY AREA");
  for (const [k, v] of [...selfByArea(cpu.self)].sort((a, b) => b[1] - a[1])) {
    say(`  ${k.padEnd(40)} ${per(v)}`);
  }
  say();
  say("HOTTEST FUNCTIONS (self)");
  for (const [k, v] of [...cpu.self].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
    say(`  ${per(v)}  ${k}`);
  }
  say();
  say("UNDER THE sim-state BROADCAST (inclusive, by listener file)");
  const views = [...cpu.under]
    .filter(([k]) =>
      /@(sim-overlay|desk-controller|probe-inspector|scope-view|schematic-view|desk-3d-view|signal-rail|integration-[a-z]+|chip-view|discrete-view|lcd-view|clock-view|part-symbols|sim-controller|app)\.js$/.test(
        k,
      ),
    ) // prettier-ignore
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14);
  for (const [k, v] of views) say(`  ${per(v)}  ${k}`);
  say();
  say(`Artifacts in ${OUT}: trace.json (DevTools ▸ Performance ▸ Load profile), renderer.cpuprofile, report.txt`); // prettier-ignore
  fs.writeFileSync(path.join(OUT, "report.txt"), `${report.join("\n")}\n`);
} finally {
  app.kill();
}
