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
// (`ready`), asks to be programmed (`program`), or saves hand-edits (`save`),
// and this bridge answers with the chip's context and streams live byte writes.
//
// It also owns the two file operations that touch the DOCUMENT: the in-app
// EXTERNAL PROGRAMMER (pick a `.bin`/`.hex` → copy to the chip's file, flag it
// programmed) and Save (write hand-edits). Both run through the DeskController
// so the `programmed` flag rides undo/redo. The bridge owns no state.

import { partDef } from "../catalog/index.js";
import { isMemory, isVolatileMemory, memoryConfig } from "../sim/chip-eval.js";
import { parseIntelHex } from "../model/hex-format.js";

/** A memory chip's backing-file byte length (address space × bytes-per-word). */
function byteLengthOf(def) {
  const { size, width } = memoryConfig(def);
  return size * (width > 8 ? 2 : 1);
}

export class MemoryBridge {
  #doc;
  #sim;
  #controller;
  #bridge;
  #notifications;

  /**
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {import('./sim-controller.js').SimController} opts.sim
   * @param {import('./desk-controller.js').DeskController} opts.controller
   * @param {object} opts.bridge - window.chiphippo (`mem.*` + `memory.*`).
   * @param {import('./notification-stack.js').NotificationStack} [opts.notifications]
   */
  constructor({ deskDoc, sim, controller, bridge, notifications }) {
    this.#doc = deskDoc;
    this.#sim = sim;
    this.#controller = controller;
    this.#bridge = bridge;
    this.#notifications = notifications;
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

  /**
   * Run the in-app external programmer for a ROM chip: pick a `.bin`/`.hex`,
   * copy it into the chip's backing file (a short image writes to the start, a
   * long one truncates — with a warning), flag the chip programmed, and reload
   * any open inspector. Invoked from the desk context menu or the inspector.
   */
  async program(compId) {
    const info = this.#romInfo(compId);
    if (!info) return;
    const picked = await this.#bridge?.mem?.pickImage();
    if (!picked) return; // cancelled
    if (picked.ok === false) {
      return this.#warn("danger", "Import failed", picked.error);
    }
    let bytes = picked.bytes;
    if (/\.hex$/i.test(picked.name ?? "")) {
      try {
        bytes = parseIntelHex(new TextDecoder().decode(picked.bytes));
      } catch (err) {
        return this.#warn("danger", "Bad Intel HEX file", err.message);
      }
    }
    if (bytes.length !== info.byteLength) {
      this.#warn(
        "warning",
        "Image size mismatch",
        bytes.length < info.byteLength
          ? `The image is ${bytes.length} bytes but ${this.#refName(compId)} holds ${info.byteLength} — loaded to the start; the rest is unchanged.`
          : `The image is ${bytes.length} bytes but ${this.#refName(compId)} holds ${info.byteLength} — truncated to fit.`,
      );
    }
    const res = await this.#bridge?.mem?.program(
      info.guid,
      bytes,
      info.byteLength,
    );
    if (res?.ok === false) {
      return this.#warn("danger", "Program failed", res.error);
    }
    this.#controller?.setMemoryProgrammed(compId, true);
    this.#sendContext(compId); // the window reloads from the programmed file
  }

  // ── Inspector → host ────────────────────────────────────────────────────────

  #onHostInbound = (e) => {
    const { compId, msg } = e.detail ?? {};
    if (!compId || !msg) return;
    if (msg.kind === "ready") this.#onReady(compId);
    else if (msg.kind === "program") this.program(compId);
    else if (msg.kind === "save") this.#save(compId, msg.bytes);
  };

  /** A window is up: make sure a ROM's file exists (warn on a lost one), then
      hand it its context. */
  async #onReady(compId) {
    await this.#ensureFile(compId);
    this.#sendContext(compId);
  }

  /** Persist inspector hand-edits to a ROM's file (Save) + flag it programmed. */
  async #save(compId, bytes) {
    const info = this.#romInfo(compId);
    if (!info) return;
    const res = await this.#bridge?.mem?.write(info.guid, bytes);
    if (res?.ok === false) {
      return this.#warn("danger", "Save failed", res.error);
    }
    this.#controller?.setMemoryProgrammed(compId, true);
  }

  /** Create a ROM's backing file if missing; a programmed chip losing its file
      (delete then undo) now holds noise — say so. */
  async #ensureFile(compId) {
    const info = this.#romInfo(compId);
    if (!info) return;
    const res = await this.#bridge?.mem?.create(info.guid, info.byteLength);
    if (res?.created && this.#doc.getComponent(compId)?.params?.programmed) {
      this.#warn(
        "danger",
        "Memory data lost",
        `${this.#refName(compId)} was programmed, but its data file was missing — it now holds random noise. Re-load an image.`,
      );
    }
  }

  /** Send a window its chip's context (kind + binding + running snapshot). */
  async #sendContext(compId, finalBytes = null) {
    const comp = this.#doc.getComponent(compId);
    if (!comp) return;
    const def = partDef(comp.ref);
    const volatile = isVolatileMemory(def);
    const guid = comp.params?.storage?.guid ?? null;
    const running = this.#sim?.running === true;
    const ctx = {
      kind: "context",
      ref: comp.ref,
      volatile,
      guid,
      programmed: comp.params?.programmed === true,
      running,
    };
    if (!volatile && guid) {
      const p = await this.#bridge?.mem?.path(guid);
      if (p?.ok) ctx.path = p.path;
    }
    // While running the host owns the image (hand over the live bytes). Stopped,
    // a ROM window loads its file itself; only a VOLATILE chip needs its final
    // bytes sent (it has no file to reload from).
    if (running) ctx.bytes = this.#sim.imageBytesOf(compId);
    else if (finalBytes && volatile) ctx.bytes = finalBytes;
    this.#relay(compId, ctx);
  }

  // ── Host → inspector (live image) ───────────────────────────────────────────

  #onMemState = (e) => {
    const detail = e.detail ?? {};
    if (detail.running) {
      for (const [compId, changes] of detail.changes ?? new Map()) {
        this.#relay(compId, { kind: "bytes", changes });
      }
    } else {
      // Stop: hand each memory its context (+ final bytes for volatile SRAM).
      for (const [compId, bytes] of detail.images ?? new Map()) {
        this.#sendContext(compId, bytes);
      }
    }
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** A ROM chip's `{ guid, byteLength }`, or null (not a file-backed chip). */
  #romInfo(compId) {
    const comp = this.#doc.getComponent(compId);
    const def = comp && partDef(comp.ref);
    if (!def || !isMemory(def) || isVolatileMemory(def)) return null;
    const guid = comp.params?.storage?.guid;
    return guid ? { guid, byteLength: byteLengthOf(def) } : null;
  }

  #refName(compId) {
    const comp = this.#doc.getComponent(compId);
    return comp ? `${comp.ref} (${compId})` : compId;
  }

  #warn(variant, title, message) {
    this.#notifications?.notify({
      variant,
      title,
      message,
      sticky: variant === "danger",
    });
  }

  #relay(compId, msg) {
    this.#bridge?.memory?.toInspector(compId, msg).catch(() => {});
  }
}
