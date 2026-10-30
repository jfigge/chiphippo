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

// engine-diff.mjs — the logic engine of the working tree held to the one at
// a git ref, TICK BY TICK (features/digital-event-tick.md). Every example
// desk in src/web/demos/ (each desktop of each) and the busy bench fixture
// are run on both, driven alike — every clock brick flipped each tick, time
// moving on — and every field of every tick's result compared: net levels,
// sequential states, pin levels, memory writes, warnings, chip status,
// wakes, settled, iterations. The first difference is printed and the script
// exits 1.
//
//   node scripts/engine-diff.mjs [--ref HEAD] [--ticks 2000] [--only NAME]
//   node scripts/engine-diff.mjs --parts [--ref HEAD] [--steps 2000] [--only ID]
//   node scripts/engine-diff.mjs --spice [--ref HEAD] [--seconds 0.25] [--only NAME]
//   (--quiet: print only what differs, and the totals)

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const REF = arg("ref", "HEAD");
const TICKS = Number(arg("ticks", 2000));
const ONLY = arg("only", null);
const QUIET = process.argv.includes("--quiet"); // only the differences
const STEP_S = 0.0005; // simulated time between ticks

// The ref's scripts, unpacked beside the working tree's.
const refDir = mkdtempSync(join(tmpdir(), "engine-diff-"));
execSync(`git archive ${REF} src/web/scripts | tar -x -C ${refDir}`, {
  cwd: ROOT,
});

async function engineAt(root) {
  const at = (p) => import(pathToFileURL(join(root, "src/web/scripts", p)).href); // prettier-ignore
  const [netlist, engine, levels, bench, evalMod, catalog, drive] =
    await Promise.all([
      at("sim/netlist.js"),
      at("sim/engine.js"),
      at("sim/levels.js"),
      at("bench/busy-circuit.js"),
      at("sim/chip-eval.js"),
      at("catalog/index.js"),
      at("bench/drive-spice.js"),
    ]);
  return { ...netlist, ...engine, ...levels, ...bench, chipEval: evalMod, catalog, driveSpice: drive.driveSpice }; // prettier-ignore
}

/** A value as one canonical string: maps and objects by sorted key. */
function canon(v) {
  if (v === undefined) return "u";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (ArrayBuffer.isView(v)) return `[${Array.from(v).join(",")}]`;
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  // (A Map, or what reads as one — sim/chip-eval.js `PinReading`.)
  if (!(v instanceof Map) && typeof v.get === "function" && typeof v.entries === "function") return canon(new Map(v.entries())); // prettier-ignore
  if (v instanceof Map) {
    const keys = [...v.keys()].sort((a, b) => String(a).localeCompare(String(b))); // prettier-ignore
    return `M{${keys.map((k) => `${JSON.stringify(k)}:${canon(v.get(k))}`).join(",")}}`; // prettier-ignore
  }
  if (v instanceof Set) return `S{${[...v].map(canon).sort().join(",")}}`;
  return `{${Object.keys(v).sort().map((k) => `${k}:${canon(v[k])}`).join(",")}}`; // prettier-ignore
}

const FIELDS = ["netLevels", "state", "pinLevels", "memWrites", "warnings", "chipStatus", "wakeAt", "settled", "iterations"]; // prettier-ignore

/** Every desk to run: each demo desktop, and the busy fixture. */
function desks(busyDocument) {
  const out = [];
  const dir = join(ROOT, "src/web/demos");
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const demo = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const docs = demo.doc ? [{ name: "", doc: demo.doc }] : (demo.desktops ?? []); // prettier-ignore
    docs.forEach((d, k) => out.push({ name: `${f}#${k}`, doc: d.doc, images: demo.images ?? {} })); // prettier-ignore
  }
  out.push({ name: "busy-4", doc: busyDocument(4), images: {} });
  return out;
}

/** The desk's memory images, by component id (each side its own copy). */
function imagesOf(doc, images) {
  const out = new Map();
  for (const c of doc.components) {
    const guid = c.params?.storage?.guid;
    if (guid && images[guid]) out.set(c.id, new Uint8Array(Buffer.from(images[guid], "base64"))); // prettier-ignore
  }
  return out;
}

/** One side's run of a desk, a tick at a time. */
function runner(E, doc, images) {
  const netlist = E.buildNetlist(doc);
  const context = E.prepareCircuit(doc, netlist);
  const clocks = doc.components.filter((c) => c.kind === "clock").map((c) => c.id); // prettier-ignore
  const phase = new Map(clocks.map((id) => [id, E.L]));
  const ties = E.tieMemo?.() ?? null;
  const imgs = imagesOf(doc, images);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let carry = null;
  return (t) => {
    if (t > 0) for (const id of clocks) phase.set(id, phase.get(id) === E.H ? E.L : E.H); // prettier-ignore
    const r = E.tick({ document: doc, netlist, warmStart: warm, state, prevPinLevels: prev, clockPhase: phase, images: imgs, now: t * STEP_S, context, warm: carry, ties, inPlace: true }); // prettier-ignore
    warm = r.liveLevels ?? r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    carry = r.warm ?? null;
    for (const w of r.memWrites) {
      const img = imgs.get(w.compId);
      if (img && w.addr < img.length) img[w.addr] = w.value;
    }
    const seen = {};
    for (const f of FIELDS) seen[f] = canon(r[f]);
    return seen;
  };
}

const [NEW, OLD] = await Promise.all([engineAt(ROOT), engineAt(refDir)]);

/** A seeded generator (mulberry32): the same sequence every run. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `--parts`: every part's MODEL held to the ref's, one at a time — each def
 * the two catalogs share (combinational, sequential, timed, memory) driven
 * through the same seeded random levels on its input and io pins, every step
 * compared: its evaluation, or its state and outputs, or its memory read and
 * write. Each side reads its pins through its own `inputLevels`.
 */
function partsDiff(steps) {
  const LEVELS = [NEW.H, NEW.L, NEW.H, NEW.L, NEW.H, NEW.L, NEW.X, NEW.Z];
  const oldDefs = new Map(OLD.catalog.PALETTE_DEFS.map((d) => [d.id, d]));
  const outcome = (fn) => {
    try {
      return canon(fn());
    } catch (err) {
      return `throws ${err?.message}`;
    }
  };
  let parts = 0;
  let failures = 0;
  for (const def of NEW.catalog.PALETTE_DEFS) {
    const was = oldDefs.get(def.id);
    if (!was || !def.logic || (ONLY && !def.id.includes(ONLY))) continue;
    const A = NEW.chipEval;
    const B = OLD.chipEval;
    const seq = A.isSequential(def);
    const mem = A.isMemory(def);
    const comb = !seq && !mem && Array.isArray(def.logic.units);
    if (!seq && !mem && !comb) continue;
    parts++;
    const next = random([...def.id].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7)); // prettier-ignore
    const pins = def.pins.filter((p) => p.role === "input" || p.role === "io" || def.logic.sense?.[p.n]).map((p) => p.n); // prettier-ignore
    const image = mem ? new Uint8Array(4096).map(() => Math.floor(next() * 256)) : null; // prettier-ignore
    let sa = seq ? A.initialState(def) : null;
    let sb = seq ? B.initialState(was) : null;
    let pa = null;
    let pb = null;
    let bad = null;
    for (let step = 0; step < steps && !bad; step++) {
      const raw = new Map();
      for (const pin of pins) raw.set(pin, LEVELS[Math.floor(next() * LEVELS.length)]); // prettier-ignore
      const env = { now: step * 1e-4, timing: null };
      const pairs = [];
      if (comb) {
        pairs.push(["evaluate", outcome(() => A.evaluate(def, raw)), outcome(() => B.evaluate(was, raw))]); // prettier-ignore
      } else {
        const ia = A.inputLevels(def, raw, pa);
        const ib = B.inputLevels(was, raw, pb);
        if (mem) {
          pairs.push(["memory read", outcome(() => A.memoryOutputs(def, ia, image)), outcome(() => B.memoryOutputs(was, ib, image))]); // prettier-ignore
          pairs.push(["memory write", outcome(() => A.memoryWrite(def, ia, image)), outcome(() => B.memoryWrite(was, ib, image))]); // prettier-ignore
        } else {
          let na;
          let nb;
          pairs.push(["state", outcome(() => (na = A.stepChip(def, sa, ia, pa, env))), outcome(() => (nb = B.stepChip(was, sb, ib, pb, env)))]); // prettier-ignore
          if (na !== undefined) sa = na;
          if (nb !== undefined) sb = nb;
          pairs.push(["outputs", outcome(() => A.outputsOf(def, sa, ia)), outcome(() => B.outputsOf(was, sb, ib))]); // prettier-ignore
        }
        [pa, pb] = [ia, ib];
      }
      for (const [what, x, y] of pairs) {
        if (x !== y)
          bad = { step, what, x: x.slice(0, 300), y: y.slice(0, 300) };
      }
    }
    if (bad) {
      failures++;
      console.log(`✖ ${def.id}: step ${bad.step}, ${bad.what} differs\n  new ${bad.x}\n  ${REF} ${bad.y}`); // prettier-ignore
    } else {
      if (!QUIET) console.log(`✔ ${def.id}`);
    }
  }
  console.log(`${parts} parts compared against ${REF}, ${steps} steps each${failures ? ` — ${failures} DIFFER` : ", all identical"}`); // prettier-ignore
  return failures > 0;
}

/**
 * `--spice`: Spice Lite held to the ref's, tick by tick, bit for bit — each
 * desk driven by its own tree's `bench/drive-spice.js` (SimController's
 * transport) for `--seconds` of simulated time, and every tick's moment and
 * result compared: levels, voltages, states, pins, warnings, status,
 * supplies, lamps, currents, wakes, settled, iterations.
 */
const SPICE_FIELDS = ["netLevels", "nodeVolts", "state", "pinLevels", "memWrites", "warnings", "chipStatus", "supplies", "lamps", "currents", "wakeAt", "settled", "iterations"]; // prettier-ignore
function spiceDiff(seconds) {
  let desksRun = 0;
  let ticks = 0;
  let failures = 0;
  for (const desk of desks(NEW.busyDocument)) {
    if (ONLY && !desk.name.includes(ONLY)) continue;
    const run = (E) => {
      const out = [];
      try {
        E.driveSpice(structuredClone(desk.doc), {
          seconds,
          onTick: (now, r) => {
            const seen = { now: canon(now) };
            for (const f of SPICE_FIELDS) seen[f] = canon(r[f]);
            out.push(seen);
          },
        });
      } catch (err) {
        out.push({ now: `throws ${err?.message}` });
      }
      return out;
    };
    const a = run(NEW);
    const b = run(OLD);
    desksRun++;
    let bad = null;
    for (let t = 0; t < Math.max(a.length, b.length) && !bad; t++) {
      ticks++;
      for (const f of ["now", ...SPICE_FIELDS]) {
        const x = a[t]?.[f] ?? "(no tick)";
        const y = b[t]?.[f] ?? "(no tick)";
        if (x !== y) {
          bad = { t, f, x: x.slice(0, 300), y: y.slice(0, 300) };
          break;
        }
      }
    }
    if (bad) {
      failures++;
      console.log(`✖ ${desk.name}: tick ${bad.t}, ${bad.f} differs\n  new ${bad.x}\n  ${REF} ${bad.y}`); // prettier-ignore
    } else if (!QUIET) {
      console.log(`✔ ${desk.name} (${a.length} ticks)`);
    }
  }
  console.log(`${desksRun} desks, ${ticks} Spice Lite ticks compared against ${REF}${failures ? ` — ${failures} DIFFER` : ", all identical"}`); // prettier-ignore
  return failures > 0;
}

if (process.argv.includes("--spice")) {
  const failedSpice = spiceDiff(Number(arg("seconds", 0.25)));
  rmSync(refDir, { recursive: true, force: true });
  process.exit(failedSpice ? 1 : 0);
}

if (process.argv.includes("--parts")) {
  const failedParts = partsDiff(Number(arg("steps", 2000)));
  rmSync(refDir, { recursive: true, force: true });
  process.exit(failedParts ? 1 : 0);
}
let failed = false;
let compared = 0;
for (const desk of desks(NEW.busyDocument)) {
  if (ONLY && !desk.name.includes(ONLY)) continue;
  const a = runner(NEW, structuredClone(desk.doc), desk.images);
  const b = runner(OLD, structuredClone(desk.doc), desk.images);
  let bad = null;
  for (let t = 0; t < TICKS && !bad; t++) {
    const x = a(t);
    const y = b(t);
    for (const f of FIELDS) {
      if (x[f] !== y[f]) {
        bad = { t, f, x: x[f].slice(0, 400), y: y[f].slice(0, 400) };
        break;
      }
    }
    compared++;
  }
  if (bad) {
    failed = true;
    console.log(`✖ ${desk.name}: tick ${bad.t}, ${bad.f} differs\n  new ${bad.x}\n  ${REF} ${bad.y}`); // prettier-ignore
  } else {
    if (!QUIET) console.log(`✔ ${desk.name}`);
  }
}
rmSync(refDir, { recursive: true, force: true });
console.log(`${compared} ticks compared against ${REF}${failed ? " — DIFFERENCES" : ", all identical"}`); // prettier-ignore
process.exit(failed ? 1 : 0);
