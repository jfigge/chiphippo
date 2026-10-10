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

// memory-bridge.js — the MAIN renderer's coordinator for memory-inspector
// windows (Feature 190). An inspector is its own OS window, so it reaches this
// renderer only through main's `memory:*` relay: a window announces itself
// (`ready`), asks to be programmed (`program`), or saves hand-edits (`save`),
// and this bridge answers with the chip's context and streams live byte writes.
//
// It also owns the two file operations that touch the DOCUMENT: the in-app
// EXTERNAL PROGRAMMER (pick a `.bin`/`.hex` → copy to the chip's file, flag it
// programmed, and RECORD WHICH FILE it was) and Save (write hand-edits, which
// keeps that record and marks it edited). Both run through the DeskController
// so the flag and the label ride undo/redo together. The bridge owns no state.

import { partDef } from "../catalog/index.js";
import { isMemory, isVolatileMemory, memoryConfig } from "../sim/chip-eval.js";
import {
  parseIntelHex,
  parseIntelHexWrites,
  placeHexWrites,
} from "../model/hex-format.js";
import { t } from "../i18n.js";

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
  #onImagesChanged;
  // Chips whose inspector window has announced itself this session. A window
  // closed since is harmless to address: main drops a message with nowhere
  // to go.
  #windows = new Set();

  /**
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {import('./sim-controller.js').SimController} opts.sim
   * @param {import('./desk-controller.js').DeskController} opts.controller
   * @param {object} opts.bridge - window.chiphippo (`mem.*` + `memory.*`).
   * @param {import('./notification-stack.js').NotificationStack} [opts.notifications]
   * @param {() => void} [opts.onImagesChanged] - a ROM's BYTES changed. The
   *   document may not have: re-loading the SAME file leaves both `programmed`
   *   and `storage.source` exactly as they were, so a signature comparison
   *   cannot see it, and the bytes have to travel in the project file. See
   *   `ProjectWorkspace.markImagesChanged`.
   */
  constructor({
    deskDoc,
    sim,
    controller,
    bridge,
    notifications,
    onImagesChanged,
  }) {
    this.#doc = deskDoc;
    this.#sim = sim;
    this.#controller = controller;
    this.#bridge = bridge;
    this.#notifications = notifications;
    this.#onImagesChanged = onImagesChanged;
    window.addEventListener(
      "chiphippo:memory-host-inbound",
      this.#onHostInbound,
    );
    window.addEventListener("chiphippo:mem-state", this.#onMemState);
  }

  /** Open (or focus) the inspector window for a memory chip (context menu). */
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
    if (this.#sim?.running) {
      return this.#warn(
        "danger",
        t("memory.programRunning"),
        t("memory.liveMessage", { chip: this.#refName(compId) }),
      );
    }
    const info = this.#romInfo(compId);
    if (!info) return;
    const picked = await this.#bridge?.mem?.pickImage();
    if (!picked) return; // cancelled
    if (picked.ok === false) {
      return this.#warn("danger", t("memory.importFailed"), picked.error);
    }
    let bytes = picked.bytes;
    if (/\.hex$/i.test(picked.path ?? "")) {
      try {
        const text = new TextDecoder().decode(picked.bytes);
        // At its own addresses, modulo the ROM (placeHexWrites says why);
        // rebased to its lowest address only when it spans more than fits.
        const parsed = parseIntelHexWrites(text);
        const current = await this.#currentBytes(info);
        bytes =
          placeHexWrites(parsed, info.byteLength, current) ??
          parseIntelHex(text);
      } catch (err) {
        return this.#warn("danger", t("memory.badHexFile"), err.message);
      }
    }
    if (bytes.length !== info.byteLength) {
      const sizes = {
        size: bytes.length,
        chip: this.#refName(compId),
        capacity: info.byteLength,
      };
      this.#warn(
        "warning",
        t("memory.sizeMismatch"),
        bytes.length < info.byteLength
          ? t("memory.sizeShort", sizes)
          : t("memory.sizeLong", sizes),
      );
    }
    const res = await this.#bridge?.mem?.program(
      info.guid,
      bytes,
      info.byteLength,
    );
    if (res?.ok === false) {
      return this.#warn("danger", t("memory.programFailed"), res.error);
    }
    // The file is recorded on the chip, so the inspector and the Properties
    // card can both say which image is loaded — a `<guid>.bin` under userData
    // is a cache path and answers nothing.
    this.#controller?.setMemoryProgrammed(compId, true, {
      source: picked.path ?? null,
    });
    this.#onImagesChanged?.();
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
    this.#windows.add(compId);
    await this.#ensureFile(compId);
    this.#sendContext(compId);
  }

  /** Persist inspector hand-edits to a ROM's file (Save) + flag it programmed. */
  async #save(compId, bytes) {
    if (this.#sim?.running) {
      // The requesting window is told when a run starts and stops, but a Save
      // can cross that message in flight — so this, not the window's own
      // flag, is the authoritative check: never let a live ROM's backing file
      // be overwritten out from under the running simulation's own image.
      return this.#warn(
        "danger",
        t("memory.saveRunning"),
        t("memory.liveMessage", { chip: this.#refName(compId) }),
      );
    }
    const info = this.#romInfo(compId);
    if (!info) return;
    const res = await this.#bridge?.mem?.write(info.guid, bytes);
    if (res?.ok === false) {
      return this.#warn("danger", t("memory.saveFailed"), res.error);
    }
    // The source file KEEPS its place and is marked instead: it is still where
    // these bytes came from, which is what the label is for — they have simply
    // moved on from it since.
    this.#controller?.setMemoryProgrammed(compId, true, { edited: true });
    this.#onImagesChanged?.();
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
        t("sim.memLost"),
        t("sim.memLostMessage", { chip: this.#refName(compId) }),
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
      // Which file the image was loaded from, and whether it has been edited
      // since. A volatile chip has no `storage` and so answers null/false.
      source: comp.params?.storage?.source ?? null,
      edited: comp.params?.storage?.edited === true,
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
      // A run starting: each window that has spoken gets its running context
      // (the live image, and "running" — so it stops offering edits).
      if (detail.started) {
        for (const compId of this.#windows) this.#sendContext(compId);
      }
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

  /** What a ROM's file holds now (what a HEX file leaves unmentioned keeps),
      or nothing when it cannot be read. */
  async #currentBytes(info) {
    try {
      const res = await this.#bridge?.mem?.load(info.guid, info.byteLength);
      return res?.ok === false ? [] : (res?.bytes ?? []);
    } catch {
      return [];
    }
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
