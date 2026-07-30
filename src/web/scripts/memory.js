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
import { el } from "./dom.js";
import { partDef } from "./catalog/index.js";
import { memoryConfig, isVolatileMemory } from "./sim/chip-eval.js";
import { MemoryInspector } from "./components/memory-inspector.js";
import { emitIntelHex } from "./model/hex-format.js";

const bridge = window.chiphippo;
const params = new URLSearchParams(location.search);
const compId = params.get("comp");
const ref = params.get("ref");
const def = ref ? partDef(ref) : null;
const mem = def ? memoryConfig(def) : null;

// Its own sandboxed renderer, so it loads its own catalog first (see pinout.js).
await i18n.init();

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
  const gotoBtn = button(t("memory.goto"), () => {
    const a = Number.parseInt(gotoInput.value, 16);
    if (!Number.isNaN(a)) grid.gotoAddress(a);
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
    const start = orHex(fillStart.value, sel?.start ?? 0);
    const end = orHex(fillEnd.value, sel?.end ?? start);
    const val = Number.parseInt(fillVal.value, 16);
    if (Number.isNaN(val)) return;
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
      pathLabel.classList.remove("mem-binding--bound");
      copyBtn.hidden = true;
    } else {
      pathLabel.textContent = path || "…";
      pathLabel.classList.add("mem-binding--bound");
      copyBtn.hidden = !path;
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
    if (path) await navigator.clipboard?.writeText(path).catch(() => {});
  }

  // ── Context ─────────────────────────────────────────────────────────────────
  async function applyContext(ctx) {
    running = ctx.running === true;
    guid = ctx.guid ?? null;
    path = ctx.path ?? null;
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
/** Parse a hex field, falling back to a default when it's blank/invalid. */
function orHex(text, fallback) {
  const v = Number.parseInt(text, 16);
  return Number.isNaN(v) ? fallback : v;
}
