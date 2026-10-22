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

// A constant-power electronic load on a current-limited supply, run as the
// app runs it (SimController, a real DeskDoc and NetlistCache, a fake wall
// clock): switched to CP from a collapsed supply, it sat at the crossing of
// its curve and the limit, V = P / I — a balance it falls off (the regrade,
// 2026-10-22; spice/network.js `mayRunAway`).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { NetlistCache } from "../components/netlist-cache.js";
import { exampleDesktops } from "../model/example-desktops.js";

const { SimController } = await import("../components/sim-controller.js");

function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      pending.set(++seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of pending) {
          if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = Math.max(now, end);
    },
  };
}

test("a constant-power load switched on a collapsed supply falls off the limit's knife-edge", async () => {
  const payload = JSON.parse(fs.readFileSync(new URL("../../demos/load.json", import.meta.url), "utf8")); // prettier-ignore
  const desk = exampleDesktops("load", payload).find((d) => d.name.includes("Supply limit")); // prettier-ignore
  resetDom();
  const clock = fakeClock();
  const deskDoc = new DeskDoc(structuredClone(desk.doc));
  const netlist = new NetlistCache(deskDoc);
  let last = null;
  window.addEventListener("chiphippo:sim-state", (e) => (last = e.detail));
  const sim = new SimController({
    deskDoc,
    netlist,
    notifications: null,
    clock,
  });
  sim.setSpiceLite({ enabled: true });
  await sim.start();
  const set = (patch) => {
    deskDoc.setComponentParams("load1", patch);
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  };
  const run = (ms) => {
    for (let t = 0; t < ms; t += 10) clock.advance(10);
  };
  run(300);
  set({ mode: "cv", volts: 0.1 });
  run(300);
  set({ mode: "cp", watts: 1 });
  run(1000);
  const v = last.bench.get("load1").volts;
  sim.stop();
  // 5 V limited to 0.5 A, 1 W: the crossing is 2.00 V. Fallen off it — down,
  // with no Von to bring it back — it rests on its RON line.
  assert.ok(v < 1 || v > 4.9, `${v} V`);
});
