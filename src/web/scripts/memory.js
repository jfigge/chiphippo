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

// memory.js — entry point for the standalone memory-inspector OS window
// (web/memory.html, one per memory chip). It reads the component id + ref from
// the query string, renders the virtualized MemoryInspector grid, and drives
// the toolbar. It reaches the main renderer ONLY through main's relay
// (window.chiphippo.memory.toHost / the chiphippo:memory-inbound event): it
// announces `ready` to pull its context, and posts `program` / `save`.
//
// A NON-VOLATILE (ROM/EPROM/EEPROM) chip is file-backed: the window shows its
// backing-file path (copyable), the in-app programmer ("Load image…"), Save,
// and Export, and is editable while stopped. A VOLATILE (SRAM) chip has no file
// — the window is a read-only live viewer (watch writes while running; the
// final image when stopped) with Export only.

import * as i18n from "./i18n.js";
import { t } from "./i18n.js";
import { followFontSize } from "./font-scale.js";
import { el } from "./dom.js";
import { partDef } from "./catalog/index.js";
import { memoryConfig, isVolatileMemory } from "./sim/chip-eval.js";
import { MemoryInspector } from "./components/memory-inspector.js";
import { emitIntelHex, parseHexStrict } from "./model/hex-format.js";

const bridge = window.chiphippo;
const params = new URLSearchParams(location.search);
const compId = params.get("comp");
const ref = params.get("ref");
const def = ref ? partDef(ref) : null;
const mem = def ? memoryConfig(def) : null;

// Its own sandboxed renderer, so it loads its own catalog first (see pinout.js).
await i18n.init();
// And its own text size, for the same reason — awaited BEFORE the grid is
// built, since MemoryInspector measures its row height off `--font-size` at
// construction.
await followFontSize(window.chiphippo);

const root = document.getElementById("memory-root");

if (!def || !mem) {
  document.title = t("window.memory");
  root.append(
    el("p", {
      class: "mem-empty",
      text: t("memory.noChip", { ref: ref ?? "" }),
    }),
  );
} else {
  document.title = `${def.id} · ${t("memory.titleSuffix")}`;
  startInspector();
}

function startInspector() {
  const byteLength = mem.size * (mem.width > 8 ? 2 : 1);
  const chipVolatile = isVolatileMemory(def);

  let guid = null;
  let running = false;
  let dirty = false;

  // ── Toolbar ─────────────────────────────────────────────────────────────────
  const statusLabel = el("span", {
    class: "mem-status",
    text: t("memory.stopped"),
  });
  const pathLabel = el("span", { class: "mem-binding" });
  const copyBtn = button(t("memory.copyPath"), copyPath);

  const loadBtn = button(t("memory.loadImage"), program);
  const saveBtn = button(t("common.save"), save);
  const exportBinBtn = button(t("memory.exportBin"), () => exportImage(false));
  const exportHexBtn = button(t("memory.exportHex"), () => exportImage(true));

  const gotoInput = el("input", {
    class: "mem-input",
    type: "text",
    placeholder: t("memory.addrPlaceholder"),
    "aria-label": t("memory.gotoAddress"),
  });
  // A field that is not hex is SAID, never read as its leading digits:
  // parseInt took "8OOO" (letter O) for 8 and "1FF" for a byte.
  const hexOrSay = (input) => {
    const v = parseHexStrict(input.value);
    if (v == null) showError(t("memory.badHex", { text: input.value.trim() }));
    return v;
  };
  const gotoBtn = button(t("memory.goto"), () => {
    const a = hexOrSay(gotoInput);
    if (a == null) return;
    showError(null);
    grid.gotoAddress(a);
  });
  gotoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") gotoBtn.click();
  });

  const fillStart = fillInput("start", t("memory.fillStart"));
  const fillEnd = fillInput("end", t("memory.fillEnd"));
  const fillVal = fillInput("val", t("memory.fillValue"));
  fillVal.classList.add("mem-input--val");
  const fillBtn = button(t("memory.fill"), () => {
    const sel = grid.selection;
    // A blank start/end falls back to the selection; anything else must be hex.
    const field = (input, fallback) =>
      input.value.trim() === "" ? fallback : hexOrSay(input);
    const start = field(fillStart, sel?.start ?? 0);
    if (start == null) return;
    const end = field(fillEnd, sel?.end ?? start);
    if (end == null) return;
    const val = hexOrSay(fillVal);
    if (val == null) return;
    if (val > 0xff) {
      showError(t("memory.badHex", { text: fillVal.value.trim() }));
      return;
    }
    showError(null);
    grid.fillRange(start, end, val);
  });

  const errorLabel = el("span", { class: "mem-error", hidden: true });

  const toolbar = el("div", { class: "mem-toolbar" }, [
    el("div", { class: "mem-toolrow" }, [
      statusLabel,
      pathLabel,
      copyBtn,
      el("span", { class: "mem-tool-gap" }),
      loadBtn,
      saveBtn,
      exportBinBtn,
      exportHexBtn,
    ]),
    el("div", { class: "mem-toolrow" }, [
      el("span", { class: "mem-tool-label", text: t("memory.goto") }),
      gotoInput,
      gotoBtn,
      el("span", { class: "mem-tool-gap" }),
      el("span", { class: "mem-tool-label", text: t("memory.fill") }),
      fillStart,
      fillEnd,
      fillVal,
      fillBtn,
      el("span", { class: "mem-tool-gap" }),
      errorLabel,
    ]),
  ]);
  root.append(toolbar);

  const grid = new MemoryInspector(root, { onEdit: () => markDirty() });
  // The CSS follows `--font-size` on its own, but this grid is VIRTUALIZED —
  // its row height is arithmetic, not layout — so it has to re-measure. Fires
  // after followFontSize's own listener, which has already applied the size.
  window.addEventListener("chiphippo:font-size-changed", () =>
    grid.refreshMetrics(),
  );

  // ── State → UI ──────────────────────────────────────────────────────────────
  function updateUI() {
    statusLabel.textContent = running
      ? t("memory.statusRunning")
      : chipVolatile
        ? t("memory.statusVolatile")
        : t("memory.statusEditable");
    statusLabel.classList.toggle("mem-status--running", running);

    if (chipVolatile) {
      pathLabel.textContent = t("memory.volatileNote");
      pathLabel.title = "";
      pathLabel.classList.remove("mem-binding--bound");
      copyBtn.hidden = true;
    } else {
      // The SOURCE file leads when there is one: since Feature 250 the
      // `<guid>.bin` sidecar is explicitly a CACHE the app rebuilds on every
      // open, so naming it as THE binding while a real image file exists
      // answers the wrong question. The sidecar stays one hover away.
      const shown = bindingLabel();
      pathLabel.textContent = shown || "…";
      pathLabel.title = path ?? "";
      pathLabel.classList.add("mem-binding--bound");
      copyBtn.hidden = !shown;
    }

    // A ROM is editable only when stopped; SRAM is never editable (volatile).
    const editable = !running && !chipVolatile;
    grid.setEditable(editable);
    loadBtn.disabled = !editable;
    fillBtn.disabled = !editable;
    for (const b of [fillStart, fillEnd, fillVal, gotoInput])
      b.disabled = false;
    updateSaveEnabled();
  }
  function updateSaveEnabled() {
    saveBtn.disabled = running || chipVolatile || !dirty;
  }
  function markDirty() {
    dirty = true;
    updateSaveEnabled();
  }
  function showError(message) {
    errorLabel.textContent = message ?? "";
    errorLabel.hidden = !message;
  }

  let path = null;
  let source = null;
  let sourceEdited = false;

  /** What the binding line says: the image file this chip was loaded from
      (marked when its bytes have been hand-edited since), else the backing
      sidecar. */
  function bindingLabel() {
    if (!source) return path;
    return sourceEdited ? t("memory.sourceEdited", { path: source }) : source;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  function program() {
    // The programmer lives in the host (it warns + flags the chip); ask for it.
    bridge?.memory?.toHost(compId, { kind: "program" });
  }
  function save() {
    if (running || chipVolatile) return;
    bridge?.memory?.toHost(compId, {
      kind: "save",
      bytes: Array.from(grid.getBytes()),
    });
    dirty = false;
    updateSaveEnabled();
  }
  async function exportImage(asHex) {
    const bytes = grid.getBytes();
    const payload = asHex
      ? new TextEncoder().encode(emitIntelHex(bytes))
      : bytes;
    await bridge?.mem?.export(payload, `${def.id}.${asHex ? "hex" : "bin"}`);
  }
  async function copyPath() {
    // Whatever is on the line — but the bare path, never the "(edited)" note.
    const target = source ?? path;
    if (target) await navigator.clipboard?.writeText(target).catch(() => {});
  }

  // ── Context ─────────────────────────────────────────────────────────────────
  async function applyContext(ctx) {
    running = ctx.running === true;
    guid = ctx.guid ?? null;
    path = ctx.path ?? null;
    source = ctx.source ?? null;
    sourceEdited = ctx.edited === true;
    updateUI();
    if (ctx.bytes) {
      grid.setBytes(toBytes(ctx.bytes)); // running snapshot / SRAM final image
      showError(null);
    } else if (!chipVolatile && guid) {
      const res = await bridge?.mem?.load(guid, byteLength);
      if (res && res.ok) {
        grid.setBytes(res.bytes);
        showError(null);
      } else {
        grid.setBytes(new Uint8Array(byteLength));
        showError(res?.error ?? t("memory.loadFailed"));
      }
    } else {
      grid.setBytes(new Uint8Array(byteLength)); // volatile stopped → cleared
      showError(null);
    }
    dirty = false;
    updateSaveEnabled();
  }

  // Inbound messages from the host (only ours, by component id).
  window.addEventListener("chiphippo:memory-inbound", (e) => {
    const { compId: id, msg } = e.detail ?? {};
    if (id !== compId || !msg) return;
    if (msg.kind === "context") applyContext(msg);
    else if (msg.kind === "bytes") grid.applyChanges(msg.changes ?? []);
  });

  // Announce we're ready; the host replies with our context.
  bridge?.memory?.toHost(compId, { kind: "ready" });

  // Escape closes the window (the same reflex as the pinout window).
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.target?.closest?.("input")) {
      e.preventDefault();
      window.close();
    }
  });
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function button(label, onClick) {
  return el("button", {
    class: "mem-btn",
    type: "button",
    text: label,
    onClick,
  });
}
function fillInput(placeholder, label) {
  return el("input", {
    class: "mem-input",
    type: "text",
    placeholder,
    "aria-label": label,
  });
}
function toBytes(b) {
  return b instanceof Uint8Array ? b : Uint8Array.from(b ?? []);
}
