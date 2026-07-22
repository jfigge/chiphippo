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

// memory-bridge.js — the MAIN renderer's coordinator for memory-inspector
// windows (Feature 190). An inspector is its own OS window, so it reaches this
// renderer only through main's `memory:*` relay: a window announces itself
// (`ready`) or changes its binding (`set-binding`), and this bridge answers
// with the chip's live context and streams the engine's byte writes to it.
//
// It sits between three owners already present in app.js: the DeskDoc (the
// binding lives in a component's params), the DeskController (mutations ride
// its undo/redo commit seam), and the SimController (the run-volatile image +
// the `chiphippo:mem-state` broadcast). The bridge itself owns no state.

import { partDef } from "../catalog/index.js";
import { isMemory } from "../sim/chip-eval.js";

export class MemoryBridge {
  #doc;
  #sim;
  #controller;
  #bridge;

  /**
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {import('./sim-controller.js').SimController} opts.sim
   * @param {import('./desk-controller.js').DeskController} opts.controller
   * @param {object} opts.bridge - window.chiphippo (needs `memory.open/toInspector`).
   */
  constructor({ deskDoc, sim, controller, bridge }) {
    this.#doc = deskDoc;
    this.#sim = sim;
    this.#controller = controller;
    this.#bridge = bridge;
    window.addEventListener(
      "chiphippo:memory-host-inbound",
      this.#onHostInbound,
    );
    window.addEventListener("chiphippo:mem-state", this.#onMemState);
  }

  /** Open (or focus) the inspector window for a memory chip (dblclick / menu). */
  open(compId) {
    const comp = this.#doc.getComponent(compId);
    if (!comp || !isMemory(partDef(comp.ref))) return;
    this.#bridge?.memory
      ?.open(compId, comp.ref)
      .catch((err) => console.error("[renderer] memory:open failed:", err));
  }

  // ── Inspector → host ────────────────────────────────────────────────────────

  #onHostInbound = (e) => {
    const { compId, msg } = e.detail ?? {};
    if (!compId || !msg) return;
    if (msg.kind === "ready") {
      this.#sendContext(compId);
    } else if (msg.kind === "set-binding") {
      // Binding is a document edit — route it through the controller so it
      // rides undo/redo (and is refused while running); then reflect it back.
      this.#controller?.setMemoryStorage(compId, msg.storage ?? null);
      this.#sendContext(compId);
    }
  };

  /** Send a window its chip's current context (binding + running snapshot). */
  #sendContext(compId) {
    const comp = this.#doc.getComponent(compId);
    if (!comp) return;
    const running = this.#sim?.running === true;
    const ctx = {
      kind: "context",
      ref: comp.ref,
      storage: comp.params?.storage ?? null,
      running,
    };
    // While running the host owns the image; hand over its current bytes so the
    // window mirrors live. While stopped the WINDOW is the authority (it loads
    // the file itself), so send no bytes.
    if (running) ctx.bytes = this.#sim.imageBytesOf(compId);
    this.#relay(compId, ctx);
  }

  // ── Host → inspector (live image) ───────────────────────────────────────────

  #onMemState = (e) => {
    const detail = e.detail ?? {};
    if (detail.running) {
      // A tick's byte writes → live grid updates for each affected chip.
      for (const [compId, changes] of detail.changes ?? new Map()) {
        this.#relay(compId, { kind: "bytes", changes });
      }
    } else {
      // Stop: hand each memory its final image and flip the window to editable.
      for (const [compId, bytes] of detail.images ?? new Map()) {
        const comp = this.#doc.getComponent(compId);
        this.#relay(compId, {
          kind: "context",
          ref: comp?.ref,
          storage: comp?.params?.storage ?? null,
          running: false,
          bytes,
        });
      }
    }
  };

  #relay(compId, msg) {
    this.#bridge?.memory?.toInspector(compId, msg).catch(() => {});
  }
}
