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

// sim-worker.js — the simulation Worker's entry (features/03-sim-worker.md):
// a module Worker the renderer starts (components/sim-host.js), running the
// SimController in components/sim-worker-host.js on its own thread. Its
// global scope stands in for `window` — an EventTarget with CustomEvent and
// timers, which is all the controller asks of one. Messages that arrive
// while the modules load are kept and handed over in order.

globalThis.window = globalThis;

const early = [];
let host = null;
globalThis.addEventListener("message", (e) => {
  if (host) host.receive(e.data);
  else early.push(e.data);
});

const { createWorkerHost } = await import("./sim-worker-host.js");
host = createWorkerHost({
  scope: globalThis,
  post: (message) => globalThis.postMessage(message),
});
for (const message of early.splice(0)) host.receive(message);
globalThis.postMessage({ type: "ready" });
