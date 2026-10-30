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
//     (the main thread puts back its own of the version each event names —
//     the one its netlist was built from) and a sim-tick cut down to the nets
//     the analyzer reads.
//
// Every message out carries the RUN it belongs to: the main thread drops
// what a run it has stopped still had in flight. No DOM: it runs anywhere an
// EventTarget scope and `post` can be had — the Worker (components/
// sim-worker.js) or a test.

import { SimController, levelReader } from "./sim-controller.js";
import { NetlistCache } from "./netlist-cache.js";
import { applyCatalog } from "../i18n.js";
import { PUBLISH_MS, WORKER_PACING } from "./sim-pacer.js";
import { partDef, setCustomChips } from "../catalog/index.js";
import { onlyNets as only, scopeNets } from "../model/scope-recorder.js";

/** The events the main thread's views hear, forwarded as dispatched. */
const FORWARDED = [
  "chiphippo:sim-state",
  "chiphippo:sim-tick",
  "chiphippo:mem-state",
  "chiphippo:cpu-break",
  "chiphippo:cpu-resumed",
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
  "monitorCpu",
  "setCpuBreakpoints",
  "stepCpu",
  "stepOverCpu",
  "setCpuRegister",
  "pokeCpuMemory",
]);

/** A sim-tick's lamps, sent (the analyzer reads only that there are some —
    scope-recorder.js `isSpiceRun`): one empty Map, shared. */
const NO_LAMPS = new Map();

/**
 * A timer the HTML clamp does not hold back (SimController's `continuation`,
 * for the next batch of a run that is behind — runtime review R2,
 * 2026-10-26). A timer set from inside a timer is held to at least 4 ms once
 * nested five deep, and the pacer's batches each set the next: so it hops
 * through a MessageChannel first — a task of its own, where the batch runs at
 * once if it is due, or else the wait left is set from there, un-nested.
 * Messages the main thread sent meanwhile (an input, an edit, Stop) are let
 * in before it, as before a timer. Null where there is no MessageChannel.
 *
 * `fn` never runs before its moment: a timer's wait is whole ms, cut DOWN
 * from a fraction, so a 1.6 ms rest fired 0.6 ms early — the batch found
 * nothing due, set the next for the 0.6 left, and so on: 35–70k empty
 * batches a second on busy16 Spice ×4 (runtime regrade NEW-1, 2026-10-27).
 * So the whole ms go on a timer, and what is left under one hops the
 * channel again until it is due — no batch runs on the way. (Rounded UP to
 * a whole ms instead, the wait after each batch that dropped debt — its
 * next edge a fraction away — slept the rest of a ms: busy32 Spice ×4 and
 * Regulated 5V ran 1.5–3 % slower.)
 * @param {object} [opts]
 * @param {() => number} [opts.now] - the wall clock, ms (SimController's)
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers] -
 *   the platform's unless a test stands in for them
 * @returns {{set: (fn: Function, ms: number) => number, clear: (id: number) => void} | null}
 */
export function urgentTimer({
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  timers = globalThis,
} = {}) {
  if (typeof MessageChannel !== "function") return null;
  const channel = new MessageChannel();
  const live = new Map(); // id → {fn, at, timer}
  let seq = 0;
  const fire = (id, slot) => {
    if (!slot || live.get(id) !== slot) return; // cleared meanwhile
    const rest = slot.at - now();
    if (rest >= 1) {
      slot.timer = timers.setTimeout(() => fire(id, slot), Math.floor(rest));
      return;
    }
    if (rest > 0) {
      slot.timer = null;
      channel.port2.postMessage(id);
      return;
    }
    live.delete(id);
    slot.fn();
  };
  channel.port1.onmessage = (e) => fire(e.data, live.get(e.data));
  // Node's ports would hold its event loop open (the tests); a Worker's
  // has no unref and needs none.
  channel.port1.unref?.();
  return {
    set(fn, ms) {
      const id = ++seq;
      live.set(id, { fn, at: now() + Math.max(0, ms), timer: null });
      channel.port2.postMessage(id);
      return id;
    },
    clear(id) {
      const slot = live.get(id);
      if (slot?.timer != null) timers.clearTimeout(slot.timer);
      live.delete(id);
    },
  };
}

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
  const cache = new NetlistCache(deskDoc, { scope });
  // The version each netlist was BUILT from. An edit's catch-up and run-on
  // ticks (SimController `#onDocChanged`) go out on the board as it stood —
  // the netlist from before the edit — in the same task as the edited
  // board's, so each event names its own netlist's version, not the latest:
  // paired with the new netlist, a net the edit renamed (a pot's wiper
  // reaching its end joins two nets, which take the smaller address as
  // their id) read no voltage there, and the analyzer drew a glitch.
  const builtAt = new WeakMap();
  const netlist = {
    get(opts) {
      const built = cache.get(opts);
      if (!builtAt.has(built)) builtAt.set(built, nv);
      return built;
    },
    partStates: () => cache.partStates(),
  };
  const sim = new SimController({
    scope,
    pacing: WORKER_PACING,
    // A test's clock drives its own timers, unhurried.
    continuation: clock ? null : urgentTimer(),
    tickSink: (detail) => forward("chiphippo:sim-tick", detail),
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
  let ticked = false; // a sim-tick is in the queue
  let loneAt = -Infinity; // when a sim-tick last went with no channel
  const wallNow = () => clock?.now() ?? globalThis.performance?.now?.() ?? Date.now(); // prettier-ignore
  // The custom chips on the snapshot (#flush's snapshots), kept per snapshot.
  let customOf = { doc: null, ids: [] };
  const flush = () => {
    if (!queue.length) return;
    const events = queue;
    queue = [];
    ticked = false;
    // A custom chip's last reading and state, for the chip debugger arming
    // it (SimController `chipSnapshot`) — what the main thread hands it.
    if (customOf.doc !== doc) {
      customOf = { doc, ids: (doc?.components ?? []).filter((c) => partDef(c.ref)?.custom).map((c) => c.id) }; // prettier-ignore
    }
    const snapshots = new Map();
    for (const id of customOf.ids) snapshots.set(id, sim.chipSnapshot(id));
    send({ type: "events", nv, events, snapshots });
  };
  let watched = null; // {doc, netlist, nets} — the analyzer's nets
  const tickNets = (detail) => {
    if (watched?.doc !== doc || watched.netlist !== detail.netlist) {
      watched = { doc, netlist: detail.netlist, nets: scopeNets(doc, detail.netlist), from: null, cut: null }; // prettier-ignore
    }
    return watched;
  };
  // A tick's levels cut to the analyzer's nets ONCE, however many curve
  // samples after it carry them (they read the last tick's board): one Map,
  // which the message's structured clone then sends once (runtime review
  // R9, 2026-10-26). A tick's own are cut afresh — its map may be the last
  // one's, updated in place.
  const cutOnce = (detail, w) => {
    if (detail.levelOf) {
      // (A tick read one net at a time off its record: A2.)
      const levelOf = detail.levelOf;
      delete detail.levelOf;
      w.from = null;
      return (w.cut = only(levelReader(levelOf), w.nets));
    }
    const map = detail.netLevels;
    if (!map) return map;
    if (!detail.sample || w.from !== map) {
      w.from = map;
      w.cut = only(map, w.nets);
    }
    return w.cut;
  };
  const forward = (type, detail) => {
    if (quiet) return;
    // The main thread has the netlist of every version it sent — except
    // a bounce's (SimController `#bounceNetlist`), which goes along.
    const at = (detail?.netlist && builtAt.get(detail.netlist)) ?? nv;
    if (type === "chiphippo:sim-tick") {
      // With no channel the analyzer records nothing (scope-view.js
      // `#onSim`): it hears only that a run is under way, which one tick
      // a message says (R9 — every tick sent was 800–7000 a second).
      // Nor need it hear that more than once a frame: a lone tick (nothing
      // else to go with it) waits for one PUBLISH_MS on from the last, or a
      // run behind on 10 ms batches sent twice the messages (N3).
      if (!(doc?.scopeChannels?.length > 0)) {
        if (ticked) return;
        const t = wallNow();
        if (!queue.length && t - loneAt < PUBLISH_MS) return;
        ticked = true;
        loneAt = t;
      }
      // Cut down in place: the controller made this detail for its sink
      // alone and keeps nothing of it.
      const w = tickNets(detail);
      detail.netLevels = cutOnce(detail, w);
      detail.nodeVolts = only(detail.nodeVolts, w.nets);
      detail.lamps = detail.lamps ? NO_LAMPS : null;
      if (!detail.ownNetlist) detail.netlist = null;
    } else if (detail?.netlist && !detail.ownNetlist) {
      detail = { ...detail, netlist: null };
    }
    if (!queue.length) queueMicrotask(flush);
    queue.push({ type, detail, nv: at });
  };
  // A sim-tick comes straight from the controller (its `tickSink`); the
  // rest are heard as dispatched.
  for (const type of FORWARDED) {
    if (type !== "chiphippo:sim-tick") scope.addEventListener(type, (e) => forward(type, e.detail)); // prettier-ignore
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
          sim.monitorCpu(message.cpuWatch ?? null, message.cpuView ?? null);
          for (const [id, addrs] of message.cpuBreaks ?? []) sim.setCpuBreakpoints(id, addrs); // prettier-ignore
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
