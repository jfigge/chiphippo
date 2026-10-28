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
  looksLikeIntelHex,
  parseIntelHex,
  parseIntelHexWrites,
  placeHexWrites,
  requireHexData,
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
  #whereNow;
  #markKept;
  // Which document is on the desk: counts `desk-loaded`. With no `markKept`
  // to flag a chip where its write began, a write that comes back under
  // another document flags nothing (`#flag`).
  #epoch = 0;
  // ROM writes still under way — a desk swap and the leave question wait for
  // them (`desk-leaving` / `writes-pending`, their `hold`).
  #writing = new Set();
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
   * @param {() => object} [opts.whereNow] - where the desk's document belongs
   *   (`ProjectWorkspace.deskWhere`), taken as a write starts
   * @param {(where: object, compId: string, binding: object) => boolean} [opts.markKept]
   *   - a write landed: flag the chip in the desktop it began on, wherever
   *   that is now (`ProjectWorkspace.markRomKept`); whether a chip was flagged
   */
  constructor({
    deskDoc,
    sim,
    controller,
    bridge,
    notifications,
    onImagesChanged,
    whereNow,
    markKept,
  }) {
    this.#doc = deskDoc;
    this.#sim = sim;
    this.#controller = controller;
    this.#bridge = bridge;
    this.#notifications = notifications;
    this.#onImagesChanged = onImagesChanged;
    this.#whereNow = whereNow;
    this.#markKept = markKept;
    window.addEventListener(
      "chiphippo:memory-host-inbound",
      this.#onHostInbound,
    );
    window.addEventListener("chiphippo:mem-state", this.#onMemState);
    window.addEventListener("chiphippo:desk-loaded", () => (this.#epoch += 1));
    const holdWrites = (e) => {
      for (const write of this.#writing) e.detail?.hold?.(write);
    };
    window.addEventListener("chiphippo:desk-leaving", holdWrites);
    window.addEventListener("chiphippo:writes-pending", holdWrites);
  }

  /** Where a write of file `guid` begins: the desk as it stands (`#flag`
      reads it). Taken when the chip is, before any await between them. The
      guid goes with it, so only the chip that names THAT file is flagged —
      not one placed since under a reused id (an undo, then a new ROM). */
  #stamp(guid) {
    return { epoch: this.#epoch, where: this.#whereNow?.() ?? null, guid };
  }

  /**
   * Run one ROM write — `write()` resolves with main's answer — and flag its
   * chip once it has landed, in the desktop the write began on (`#flag`), so
   * the file and the chip that names it never disagree. Tracked while under
   * way, for whoever has to wait for it. A write that THROWS answers as one
   * that failed; a flag that throws is logged, not reported as the write
   * failing (the bytes are written). Main's answer (or `{ok: true}`), with
   * `flagged`: whether a chip now names the bytes.
   */
  async #landed(compId, binding, write, stamp) {
    const pending = (async () => {
      let res;
      try {
        res = await write();
      } catch (err) {
        res = { ok: false, error: err?.message ?? String(err) };
      }
      if (res?.ok === false) return res;
      let flagged = false;
      try {
        // The bytes changed in the project the write began in — and only
        // there: one opened since must not be marked edited by another's file.
        flagged = this.#flag(compId, binding, stamp);
        if (flagged) this.#onImagesChanged?.();
      } catch (err) {
        console.error("[renderer] flagging a written ROM failed:", err);
      }
      return { ...(res ?? { ok: true }), flagged };
    })();
    this.#writing.add(pending);
    try {
      return await pending;
    } finally {
      this.#writing.delete(pending);
    }
  }

  /** Flag a written ROM's chip where its write began (`markKept`) — or, with
      no workspace to ask, on the desk if it still holds that document.
      Whether a chip was flagged. */
  #flag(compId, binding, { epoch, where, guid }) {
    if (this.#markKept) {
      return this.#markKept(where, compId, binding, guid) === true;
    }
    if (this.#epoch !== epoch) return false;
    return this.#controller?.setMemoryProgrammed(compId, true, binding, { guid }) === true; // prettier-ignore
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
    const stamp = this.#stamp(info.guid); // with the chip, before the picker's wait
    let picked;
    try {
      picked = await this.#bridge?.mem?.pickImage();
    } catch (err) {
      // A pick that failed after the click (the web build's picker rejects
      // rather than reading as a cancel) is said like a refused read.
      return this.#warn("danger", t("memory.importFailed"), err?.message);
    }
    if (!picked) return; // cancelled
    // Asked again: a run can start while the picker is up (a menu shortcut),
    // and its ROM must not be written out from under it.
    if (this.#sim?.running) {
      return this.#warn(
        "danger",
        t("memory.programRunning"),
        t("memory.liveMessage", { chip: this.#refName(compId) }),
      );
    }
    if (picked.ok === false) {
      return this.#warn("danger", t("memory.importFailed"), picked.error);
    }
    let bytes = picked.bytes;
    // HEX by its name (`.hex`, SDCC's `.ihx`, `.ihex`), or by what it holds:
    // picked through "All files", a HEX image read as raw bytes would program
    // the ROM with its own ASCII.
    if (
      /\.(hex|ihx|ihex)$/i.test(picked.path ?? "") ||
      looksLikeIntelHex(picked.bytes)
    ) {
      try {
        const text = new TextDecoder().decode(picked.bytes);
        // At its own addresses, modulo the ROM (placeHexWrites says why);
        // rebased to its lowest address only when it spans more than fits.
        const parsed = requireHexData(parseIntelHexWrites(text));
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
    // The file is recorded on the chip, so the inspector and the Properties
    // card can both say which image is loaded — a `<guid>.bin` under userData
    // is a cache path and answers nothing.
    const res = await this.#landed(
      compId,
      { source: picked.path ?? null },
      () => this.#bridge?.mem?.program(info.guid, bytes, info.byteLength),
      stamp,
    );
    if (res?.ok === false) {
      return this.#warn("danger", t("memory.programFailed"), res.error);
    }
    this.#sendContext(compId); // the window reloads from the programmed file
  }

  // ── Inspector → host ────────────────────────────────────────────────────────

  #onHostInbound = (e) => {
    const { compId, msg } = e.detail ?? {};
    if (!compId || !msg) return;
    const failed = (err) =>
      console.error(`[renderer] memory ${msg.kind} failed:`, err);
    if (msg.kind === "ready") this.#onReady(compId).catch(failed);
    else if (msg.kind === "program") this.program(compId).catch(failed);
    else if (msg.kind === "edits") {
      this.#controller?.setMemoryUnsaved?.(compId, msg.unsaved === true);
    } else if (msg.kind === "closed") {
      this.#controller?.setMemoryUnsaved?.(compId, false);
    } else if (msg.kind === "save") {
      this.#save(compId, msg.bytes)
        .then((res) => this.#savedReply(compId, res))
        .catch(failed);
    }
  };

  /** Answer an inspector's Save. It has already marked its edits saved, so a
      failure hands them back as unsaved (`save-failed`); a success tells it
      the chip's binding now (`saved` — the line says "(edited)"), and only
      that: a whole context would reload its bytes over any typed since. */
  #savedReply(compId, res) {
    if (res.ok === false) {
      this.#relay(compId, { kind: "save-failed" });
      return;
    }
    const storage = this.#doc.getComponent(compId)?.params?.storage;
    this.#relay(compId, {
      kind: "saved",
      source: storage?.source ?? null,
      edited: storage?.edited === true,
    });
  }

  /** A window is up: make sure a ROM's file exists (warn on a lost one), then
      hand it its context. */
  async #onReady(compId) {
    this.#windows.add(compId);
    await this.#ensureFile(compId);
    this.#sendContext(compId);
  }

  /**
   * Keep a ROM's bytes as a run left them — the CPU monitor's edits, kept at
   * Stop when its "keep edits" box is ticked. The inspector's Save, made for
   * it: the file written, the chip flagged programmed and edited (one undo
   * step), and an open inspector told to read the file again (it was told of
   * the Stop before this write landed). Whether the bytes were kept.
   * @param {string} compId
   * @param {Uint8Array} bytes - the chip's whole image, packed as its file is
   */
  async keepRunEdits(compId, bytes) {
    const res = await this.#save(compId, bytes);
    if (res.ok === false) return false;
    if (this.#windows.has(compId)) this.#sendContext(compId);
    // Written, but no chip names the file any more (its desktop or project
    // gone since): not "kept" — nothing open will ever read those bytes.
    return res.flagged === true;
  }

  /** Persist inspector hand-edits to a ROM's file (Save) + flag it programmed.
      `#landed`'s answer, or `{ok: false}` when it was refused. */
  async #save(compId, bytes) {
    if (this.#sim?.running) {
      // The requesting window is told when a run starts and stops, but a Save
      // can cross that message in flight — so this, not the window's own
      // flag, is the authoritative check: never let a live ROM's backing file
      // be overwritten out from under the running simulation's own image.
      this.#warn(
        "danger",
        t("memory.saveRunning"),
        t("memory.liveMessage", { chip: this.#refName(compId) }),
      );
      return { ok: false };
    }
    const info = this.#romInfo(compId);
    if (!info) return { ok: false };
    // The source file KEEPS its place and is marked instead: it is still where
    // these bytes came from, which is what the label is for — they have simply
    // moved on from it since.
    const res = await this.#landed(
      compId,
      { edited: true },
      () => this.#bridge?.mem?.write(info.guid, bytes),
      this.#stamp(info.guid),
    );
    if (res.ok === false) this.#warn("danger", t("memory.saveFailed"), res.error); // prettier-ignore
    return res;
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
      // Fire-and-forget everywhere it is called, so it may not reject.
      try {
        const p = await this.#bridge?.mem?.path(guid);
        if (p?.ok) ctx.path = p.path;
      } catch (err) {
        console.error("[renderer] mem:path failed:", err);
      }
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
