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
// the toolbar: binding management, Save / Import / Export (.bin + Intel HEX),
// Fill-range, and Go-to-address. It reaches the main renderer ONLY through
// main's relay (window.chiphippo.memory.toHost / the chiphippo:memory-inbound
// event): it announces `ready` to pull its context, and posts `set-binding`
// when the user re-binds. While STOPPED the window is the authority (it loads
// the backing file and Save writes it); while RUNNING it is read-only and
// mirrors the engine's live writes.

import { el } from "./dom.js";
import { partDef } from "./catalog/index.js";
import { memoryConfig } from "./sim/chip-eval.js";
import { MemoryInspector } from "./components/memory-inspector.js";
import { parseIntelHex, emitIntelHex } from "./model/hex-format.js";

const bridge = window.chiphippo;
const params = new URLSearchParams(location.search);
const compId = params.get("comp");
const ref = params.get("ref");
const def = ref ? partDef(ref) : null;
const mem = def ? memoryConfig(def) : null;

const root = document.getElementById("memory-root");

if (!def || !mem) {
  document.title = "Memory inspector";
  root.append(
    el("p", { class: "mem-empty", text: `No memory chip for “${ref ?? ""}”.` }),
  );
} else {
  document.title = `${def.id} · Memory`;
  startInspector();
}

function startInspector() {
  const bytesPerWord = mem.width > 8 ? 2 : 1;
  const byteLength = mem.size * bytesPerWord;

  let storage = null; // { path, mode } | null
  let running = false;
  let dirty = false;

  // ── Toolbar ─────────────────────────────────────────────────────────────────
  const bindingLabel = el("span", {
    class: "mem-binding",
    text: "No backing file",
  });
  const romBtn = button("Program from file… (ROM)", () => chooseBinding("rom"));
  const ramBtn = button("Record to file… (RAM)", () => chooseBinding("ram"));
  const clearBtn = button("Clear", () => setBinding(null));
  const saveBtn = button("Save", save);
  const importBtn = button("Import…", importFile);
  const exportBinBtn = button("Export .bin", () => exportImage(false));
  const exportHexBtn = button("Export HEX", () => exportImage(true));

  const gotoInput = el("input", {
    class: "mem-input",
    type: "text",
    placeholder: "addr (hex)",
    "aria-label": "Go to address",
  });
  const gotoBtn = button("Go to", () => {
    const a = Number.parseInt(gotoInput.value, 16);
    if (!Number.isNaN(a)) grid.gotoAddress(a);
  });
  gotoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") gotoBtn.click();
  });

  const fillStart = el("input", {
    class: "mem-input",
    type: "text",
    placeholder: "start",
    "aria-label": "Fill start",
  });
  const fillEnd = el("input", {
    class: "mem-input",
    type: "text",
    placeholder: "end",
    "aria-label": "Fill end",
  });
  const fillVal = el("input", {
    class: "mem-input mem-input--val",
    type: "text",
    placeholder: "val",
    "aria-label": "Fill value",
  });
  const fillBtn = button("Fill", () => {
    const sel = grid.selection;
    const start = orHex(fillStart.value, sel?.start ?? 0);
    const end = orHex(fillEnd.value, sel?.end ?? start);
    const val = Number.parseInt(fillVal.value, 16);
    if (Number.isNaN(val)) return;
    grid.fillRange(start, end, val);
    markDirty();
  });

  const statusLabel = el("span", { class: "mem-status", text: "Stopped" });
  const errorLabel = el("span", { class: "mem-error", hidden: true });

  const toolbar = el("div", { class: "mem-toolbar" }, [
    el("div", { class: "mem-toolrow" }, [
      bindingLabel,
      romBtn,
      ramBtn,
      clearBtn,
      el("span", { class: "mem-tool-gap" }),
      importBtn,
      saveBtn,
      exportBinBtn,
      exportHexBtn,
    ]),
    el("div", { class: "mem-toolrow" }, [
      el("span", { class: "mem-tool-label", text: "Go to" }),
      gotoInput,
      gotoBtn,
      el("span", { class: "mem-tool-gap" }),
      el("span", { class: "mem-tool-label", text: "Fill" }),
      fillStart,
      fillEnd,
      fillVal,
      fillBtn,
      el("span", { class: "mem-tool-gap" }),
      statusLabel,
      errorLabel,
    ]),
  ]);
  root.append(toolbar);

  const grid = new MemoryInspector(root, { onEdit: markDirty });

  // ── State → UI ──────────────────────────────────────────────────────────────
  function updateBindingUI() {
    bindingLabel.textContent = storage
      ? `${fileName(storage.path)} · ${storage.mode.toUpperCase()}`
      : "No backing file";
    bindingLabel.classList.toggle("mem-binding--bound", Boolean(storage));
  }
  function updateRunningUI() {
    statusLabel.textContent = running
      ? "Running · read-only"
      : "Stopped · editable";
    statusLabel.classList.toggle("mem-status--running", running);
    grid.setEditable(!running);
    // Editing the binding / buffer is a stopped-only affordance.
    for (const b of [
      romBtn,
      ramBtn,
      clearBtn,
      importBtn,
      fillBtn,
      exportBinBtn,
      exportHexBtn,
    ]) {
      b.disabled = running;
    }
    updateSaveEnabled();
  }
  function updateSaveEnabled() {
    saveBtn.disabled = running || !storage || !dirty;
    clearBtn.disabled = running || !storage;
  }
  function markDirty() {
    dirty = true;
    updateSaveEnabled();
  }
  function showError(message) {
    errorLabel.textContent = message ?? "";
    errorLabel.hidden = !message;
  }

  // ── Binding ─────────────────────────────────────────────────────────────────
  async function chooseBinding(mode) {
    const path = await bridge?.mem?.choose(mode);
    if (path) setBinding({ path, mode });
  }
  function setBinding(next) {
    // The host owns the document — it applies the change and echoes context back.
    bridge?.memory?.toHost(compId, { kind: "set-binding", storage: next });
  }

  // ── File ops ────────────────────────────────────────────────────────────────
  async function save() {
    if (running || !storage) return;
    const res = await bridge?.mem?.write(storage.path, grid.getBytes());
    if (res && res.ok === false) return showError(res.error);
    dirty = false;
    updateSaveEnabled();
    showError(null);
  }
  async function importFile() {
    if (running) return;
    const res = await bridge?.mem?.import();
    if (!res) return; // cancelled
    if (res.ok === false) return showError(res.error);
    let bytes = res.bytes;
    if (/\.hex$/i.test(res.name ?? "")) {
      try {
        bytes = parseIntelHex(new TextDecoder().decode(res.bytes));
      } catch (err) {
        return showError(err.message);
      }
    }
    const buf = new Uint8Array(byteLength);
    buf.set(bytes.subarray(0, Math.min(bytes.length, byteLength)));
    grid.setBytes(buf);
    markDirty();
    showError(null);
  }
  async function exportImage(asHex) {
    const bytes = grid.getBytes();
    const payload = asHex
      ? new TextEncoder().encode(emitIntelHex(bytes))
      : bytes;
    await bridge?.mem?.export(payload, `${def.id}.${asHex ? "hex" : "bin"}`);
  }

  // ── Context ─────────────────────────────────────────────────────────────────
  async function applyContext(ctx) {
    storage = ctx.storage ?? null;
    running = ctx.running === true;
    updateBindingUI();
    updateRunningUI();
    if (ctx.bytes) {
      grid.setBytes(toBytes(ctx.bytes)); // running snapshot / stopped final image
      showError(null);
    } else if (storage) {
      const res = await bridge?.mem?.load(storage.path, byteLength);
      if (res && res.ok) {
        grid.setBytes(res.bytes);
        showError(null);
      } else {
        grid.setBytes(seedBytes());
        showError(res?.error ?? "could not load backing file");
      }
    } else {
      grid.setBytes(seedBytes()); // unbound → the def's seed (ROM ramp / zeros)
      showError(null);
    }
    dirty = false;
    updateSaveEnabled();
  }

  // Inbound messages from the host (only ours by component id).
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

  // Seed bytes from the def (an unbound chip shows what Run would use).
  function seedBytes() {
    const bytes = new Uint8Array(byteLength);
    if (mem.initial != null) {
      const seed =
        typeof mem.initial === "function" ? mem.initial(mem.size) : mem.initial;
      const n = Math.min(mem.size, seed?.length ?? 0);
      for (let i = 0; i < n; i++) {
        if (bytesPerWord === 2) {
          bytes[2 * i] = seed[i] & 0xff;
          bytes[2 * i + 1] = (seed[i] >> 8) & 0xff;
        } else {
          bytes[i] = seed[i] & 0xff;
        }
      }
    }
    return bytes;
  }
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
function fileName(p) {
  return typeof p === "string" ? p.split(/[\\/]/).pop() : p;
}
function toBytes(b) {
  return b instanceof Uint8Array ? b : Uint8Array.from(b ?? []);
}
/** Parse a hex field, falling back to a default when it's blank/invalid. */
function orHex(text, fallback) {
  const v = Number.parseInt(text, 16);
  return Number.isNaN(v) ? fallback : v;
}
