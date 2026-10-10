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

// sim-worker-host.js — the SimController run INSIDE the simulation Worker
// (features/03-sim-worker.md). The Worker runs the very same SimController
// the main thread does — its transport, batches, pacing and publishing — so
// the two modes cannot drift: what differs is only what is around it.
//
//   · Its document is a snapshot the main thread hands over (`start`, and
//     again on every edit — `doc`), each edit announced on the Worker's own
//     scope as `chiphippo:doc-changed` / `chiphippo:part-state`, as DeskDoc
//     and the views announce them on the window; its netlist is a
//     NetlistCache of that snapshot, so its net ids are the main thread's.
//   · Its toasts (`notify`/`dismiss`), its damage latches
//     (`setComponentParams` — written into its own snapshot AND sent, so the
//     main thread writes the real document) and its ROM loads (the
//     `window.chiphippo.mem` bridge, answered by the main thread) cross back.
//   · Every `chiphippo:sim-state`, `sim-tick` and `mem-state` it dispatches
//     is forwarded, in order, batched per task, with its netlist left behind
//     (the main thread puts back its own of the same version) and a sim-tick
//     cut down to the nets the analyzer reads.
//
// Every message out carries the RUN it belongs to: the main thread drops
// what a run it has stopped still had in flight. No DOM: it runs anywhere an
// EventTarget scope and `post` can be had — the Worker (components/
// sim-worker.js) or a test.

import { SimController } from "./sim-controller.js";
import { NetlistCache } from "./netlist-cache.js";
import { applyCatalog } from "../i18n.js";
import { WORKER_PACING } from "./sim-pacer.js";
import { partDef, setCustomChips } from "../catalog/index.js";

/** The events the main thread's views hear, forwarded as dispatched. */
const FORWARDED = [
  "chiphippo:sim-state",
  "chiphippo:sim-tick",
  "chiphippo:mem-state",
];

/** The public SimController calls the main thread may make. */
const CALLS = new Set([
  "stop",
  "pause",
  "resume",
  "step",
  "setSpeed",
  "toggleClockPause",
  "manualToggle",
  "pressSignal",
  "wake",
  "setSpiceLite",
]);

/**
 * The nets the logic analyzer reads off a sim-tick (components/scope-view.js
 * `#resolveCells`): each net channel's, and each bus member wire's `from`.
 */
function scopeNets(doc, netlist) {
  const out = new Set();
  const wires = new Map((doc.wires ?? []).map((w) => [w.id, w]));
  const buses = new Map((doc.buses ?? []).map((b) => [b.id, b]));
  const add = (address) => {
    const net = address ? netlist?.netOfPoint.get(address) : null;
    if (net) out.add(net);
  };
  for (const ch of doc.scopeChannels ?? []) {
    if (ch.kind === "bus") {
      for (const wid of buses.get(ch.ref)?.members ?? []) add(wires.get(wid)?.from); // prettier-ignore
    } else add(ch.ref);
  }
  return out;
}

const only = (map, keep) => {
  if (!map) return map;
  const out = new Map();
  for (const net of keep) if (map.has(net)) out.set(net, map.get(net));
  return out;
};

/**
 * Host a SimController on `scope` (an EventTarget standing for `window`),
 * talking to the main thread through `post(message)` and `receive(message)`.
 * @param {object} opts
 * @param {EventTarget} opts.scope - what the controller dispatches on
 * @param {(message: object) => void} opts.post
 * @param {object} [opts.clock] - SimController's clock option (tests)
 * @returns {{receive: (message: object) => void}}
 */
export function createWorkerHost({ scope, post, clock = null }) {
  let doc = null; // the document snapshot, replaced whole on every change
  let run = 0; // the run the main thread last started
  let nv = 0; // the netlist version the main thread last sent
  let quiet = false; // handed over (`export`): nothing more goes out
  let seq = 0;
  const pending = new Map(); // mem request id → resolve/reject

  const send = (message) => {
    if (!quiet) post({ ...message, run });
  };
  const deskDoc = {
    toJSON: () => doc,
    getComponent: (id) => doc?.components.find((c) => c.id === id) ?? null,
    setComponentParams(id, patch) {
      doc = {
        ...doc,
        components: doc.components.map((c) =>
          c.id === id ? { ...c, params: { ...c.params, ...patch } } : c,
        ),
      };
      send({ type: "params", id, patch });
      return deskDoc.getComponent(id);
    },
    get scopeChannels() {
      return doc?.scopeChannels ?? [];
    },
  };
  // The ROM loads' bridge (SimController reads `window.chiphippo.mem`):
  // asked of the main thread, which holds the real one.
  const request = (op, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      send({ type: "mem", id, op, args });
    });
  scope.chiphippo = {
    mem: {
      create: (...args) => request("create", args),
      load: (...args) => request("load", args),
    },
  };
  const netlist = new NetlistCache(deskDoc, { scope });
  const sim = new SimController({
    scope,
    pacing: WORKER_PACING,
    deskDoc,
    netlist,
    notifications: {
      notify: (opts) => send({ type: "notify", opts }),
      dismiss: (key) => send({ type: "dismiss", key }),
    },
    ...(clock ? { clock } : {}),
  });

  // What the run dispatches, in order, sent once per task.
  let queue = [];
  const flush = () => {
    if (!queue.length) return;
    const events = queue;
    queue = [];
    // A custom chip's last reading and state, for the chip debugger arming
    // it (SimController `chipSnapshot`) — what the main thread hands it.
    const snapshots = new Map();
    for (const c of doc?.components ?? []) {
      if (partDef(c.ref)?.custom) snapshots.set(c.id, sim.chipSnapshot(c.id));
    }
    send({ type: "events", nv, events, snapshots });
  };
  let watched = null; // {doc, netlist, nets} — the analyzer's nets
  const tickNets = (detail) => {
    if (watched?.doc !== doc || watched.netlist !== detail.netlist) {
      watched = { doc, netlist: detail.netlist, nets: scopeNets(doc, detail.netlist) }; // prettier-ignore
    }
    return watched.nets;
  };
  for (const type of FORWARDED) {
    scope.addEventListener(type, (e) => {
      if (quiet) return;
      let detail = e.detail;
      if (type === "chiphippo:sim-tick") {
        const nets = tickNets(detail);
        detail = { ...detail, netLevels: only(detail.netLevels, nets), nodeVolts: only(detail.nodeVolts, nets), lamps: detail.lamps ? new Map() : null }; // prettier-ignore
      }
      if (detail?.netlist) detail = { ...detail, netlist: null };
      if (!queue.length) queueMicrotask(flush);
      queue.push({ type, detail });
    });
  }

  const announce = (type, detail) =>
    scope.dispatchEvent(new CustomEvent(type, detail ? { detail } : undefined));

  return {
    sim,
    receive(message) {
      switch (message.type) {
        case "start": {
          run = message.run;
          quiet = false;
          nv = message.nv;
          applyCatalog(message.catalog ?? {});
          setCustomChips(message.customChips ?? []);
          doc = message.doc;
          for (const [id, state] of message.partStates ?? []) {
            announce("chiphippo:part-state", { id, state });
          }
          announce("chiphippo:doc-changed");
          sim.setSpiceLite(message.spice);
          sim.setSpeed(message.speed);
          // Once its memories are seeded (a ROM loaded over the bridge), the
          // main thread is handed their bytes — what an inspector opened
          // mid-run shows (SimController `imageBytesOf`), kept up to date
          // from `mem-state` after that.
          Promise.resolve(sim.start()).then(() => {
            const images = new Map();
            for (const c of doc?.components ?? []) {
              const bytes = sim.imageBytesOf(c.id);
              if (bytes) images.set(c.id, bytes);
            }
            send({ type: "images", images });
          });
          break;
        }
        case "doc":
          nv = message.nv;
          doc = message.doc;
          announce("chiphippo:doc-changed");
          break;
        case "part-state":
          nv = message.nv;
          announce("chiphippo:part-state", message.detail);
          break;
        case "call":
          if (CALLS.has(message.method)) sim[message.method](...(message.args ?? [])); // prettier-ignore
          break;
        case "export": {
          flush();
          const state = sim.exportRun();
          send({ type: "exported", state });
          quiet = true;
          sim.stop();
          break;
        }
        case "mem-reply": {
          const slot = pending.get(message.id);
          pending.delete(message.id);
          if (message.ok) slot?.resolve(message.value);
          else slot?.reject(new Error(message.error ?? "memory bridge"));
          break;
        }
      }
    },
  };
}
