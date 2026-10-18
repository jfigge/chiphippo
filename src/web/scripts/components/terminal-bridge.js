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

// terminal-bridge.js — the MAIN renderer's side of the Terminal windows
// (Feature 420). Each USB-serial adapter on the desk has its own window, its
// own sandboxed renderer, reaching this one only through main's
// `terminal:*` relay.
//
// The SCREEN is kept here, not in the window (model/terminal-screen.js, one
// per adapter): what an adapter receives while its window is closed is on the
// screen when it opens, and a window that reloads is sent the whole of it
// again. A window is a drawing of a screen and a keyboard, nothing more:
//
//   to the window   `state` — its adapter's name, settings, whether typing
//                   reaches the circuit (it runs) and whether the adapter
//                   is still on the desk; `screen` — the lines changed since
//                   the last send (`from` on), throttled to SEND_MS
//   from it         `ready`, `keys` (bytes a keystroke sends), `paste`
//                   (text), `clear`; main adds `closed`
//
// Typed bytes go to the simulation through SimHost `queueSerial`, paced by
// the room the adapter publishes (`serialPorts` on sim-state): a paste longer
// than the adapter's queue waits here and is fed as it drains. Received bytes
// arrive on `chiphippo:serial-rx`. The screens are RUN-volatile in the sense
// that matters: Stop keeps them (a terminal does not clear when the far end
// goes quiet), a desk that loads drops them, and Clear empties one.

import { partDef } from "../catalog/index.js";
import { usbSerialSettings } from "../catalog/usb-serial.js";
import { formatName } from "../sim/uart.js";
import { TerminalScreen, textBytes } from "../model/terminal-screen.js";

/** The fewest milliseconds between two `screen` messages to one window. */
export const SEND_MS = 50;

const DEFAULT_TIMERS = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h),
};

export class TerminalBridge {
  #bridge;
  #deskDoc;
  #sim;
  #timers;
  /** compId → {screen, ready, pending: number[], free, timer, settingsKey} */
  #ports = new Map();
  #running = false;

  /**
   * @param {object} opts
   * @param {object} opts.bridge - window.chiphippo (`terminal.*`)
   * @param {{toJSON: () => object, getComponent: (id: string) => object|null}} opts.deskDoc
   * @param {{queueSerial: (id: string, bytes: number[]) => number}} opts.sim - SimHost
   * @param {object} [opts.timers] - `{set, clear}` (tests)
   */
  constructor({ bridge, deskDoc, sim, timers = DEFAULT_TIMERS }) {
    this.#bridge = bridge;
    this.#deskDoc = deskDoc;
    this.#sim = sim;
    this.#timers = timers;
    window.addEventListener("chiphippo:terminal-host-inbound", (e) =>
      this.#receive(e.detail?.compId, e.detail?.msg),
    );
    window.addEventListener("chiphippo:serial-rx", (e) =>
      this.#onReceived(e.detail?.received),
    );
    window.addEventListener("chiphippo:sim-state", (e) =>
      this.#onSimState(e.detail),
    );
    window.addEventListener("chiphippo:doc-changed", () => this.#onDeskChanged()); // prettier-ignore
    window.addEventListener("chiphippo:desk-loaded", () => this.#onDeskLoaded()); // prettier-ignore
  }

  /**
   * An adapter's "Open Terminal…": open (or raise) its window.
   * @param {string} compId
   */
  open(compId) {
    if (!this.#isPort(compId)) return;
    this.#port(compId);
    Promise.resolve(this.#bridge?.terminal?.open?.(compId)).catch((err) =>
      console.error("[renderer] terminal:open failed:", err),
    );
  }

  /** The screen an adapter's window shows (tests, and nothing else). */
  screenOf(compId) {
    return this.#ports.get(compId)?.screen ?? null;
  }

  // ── The adapters ─────────────────────────────────────────────────────────

  #component(compId) {
    return this.#deskDoc?.getComponent?.(compId) ?? null;
  }

  #isPort(compId) {
    const comp = this.#component(compId);
    return Boolean(comp && partDef(comp.ref)?.serialPort);
  }

  #settings(compId) {
    return usbSerialSettings(this.#component(compId)?.params ?? {});
  }

  #port(compId) {
    let port = this.#ports.get(compId);
    if (!port) {
      const s = this.#settings(compId);
      port = {
        screen: new TerminalScreen({ columns: s.columns, crAsCrLf: s.crIn === "crlf" }), // prettier-ignore
        ready: false,
        pending: [],
        free: 0,
        timer: null,
        settingsKey: null,
      };
      this.#ports.set(compId, port);
    }
    return port;
  }

  // ── The window's messages ────────────────────────────────────────────────

  #receive(compId, msg) {
    if (typeof compId !== "string") return;
    switch (msg?.kind) {
      case "ready": {
        const port = this.#port(compId);
        port.ready = true;
        port.settingsKey = null;
        this.#sendState(compId);
        this.#sendScreen(compId, true);
        break;
      }
      case "closed": {
        const port = this.#ports.get(compId);
        if (port) port.ready = false;
        break;
      }
      case "keys":
        this.#type(compId, Array.isArray(msg.bytes) ? msg.bytes : []);
        break;
      case "paste":
        this.#type(compId, textBytes(String(msg.text ?? ""), this.#settings(compId))); // prettier-ignore
        break;
      case "clear": {
        const port = this.#ports.get(compId);
        if (!port) break;
        port.screen.clear();
        this.#sendScreen(compId, true);
        break;
      }
      default:
        break;
    }
  }

  /** Bytes the keyboard sent: onto the line while the circuit runs (and on
      the screen too with local echo). Stopped, nothing is listening. */
  #type(compId, bytes) {
    if (!this.#running || !this.#isPort(compId) || !bytes.length) return;
    const port = this.#port(compId);
    const clean = bytes.filter((b) => Number.isInteger(b)).map((b) => b & 0xff); // prettier-ignore
    if (this.#settings(compId).echo === "on") {
      port.screen.write(clean);
      this.#sendSoon(compId);
    }
    port.pending.push(...clean);
    this.#pump(compId);
  }

  /** Feed an adapter what it has room for. */
  #pump(compId) {
    const port = this.#ports.get(compId);
    if (!port?.pending.length || !this.#running) return;
    const n = Math.min(port.free, port.pending.length);
    if (n <= 0) return;
    const chunk = port.pending.splice(0, n);
    const taken = this.#sim?.queueSerial?.(compId, chunk) ?? 0;
    // What it could not take goes back to the front of the line.
    if (taken < chunk.length) port.pending.unshift(...chunk.slice(taken));
    port.free = Math.max(0, port.free - taken);
  }

  // ── The simulation ───────────────────────────────────────────────────────

  #onReceived(received) {
    if (!(received instanceof Map)) return;
    for (const [compId, list] of received) {
      if (!this.#isPort(compId)) continue;
      this.#port(compId).screen.write(list);
      this.#sendSoon(compId);
    }
  }

  #onSimState(detail) {
    const running = detail?.mode === "running" || detail?.mode === "paused";
    const ports = detail?.serialPorts ?? new Map();
    if (running !== this.#running) {
      this.#running = running;
      for (const [compId, port] of this.#ports) {
        if (!running) {
          port.pending = [];
          port.free = 0;
        }
        this.#sendState(compId);
      }
    }
    for (const [compId, shown] of ports) {
      const port = this.#ports.get(compId);
      if (!port) continue;
      port.free = shown?.free ?? 0;
      this.#pump(compId);
    }
  }

  /** An edit: an adapter's settings may have changed, or it may have gone. */
  #onDeskChanged() {
    for (const compId of this.#ports.keys()) {
      const port = this.#ports.get(compId);
      if (this.#isPort(compId)) {
        const s = this.#settings(compId);
        port.screen.configure({ columns: s.columns, crAsCrLf: s.crIn === "crlf" }); // prettier-ignore
      }
      this.#sendState(compId);
    }
  }

  /** Another desk: its adapters are other parts, whatever their ids. */
  #onDeskLoaded() {
    for (const port of this.#ports.values()) {
      this.#timers.clear(port.timer);
    }
    this.#ports.clear();
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  #sendState(compId) {
    const port = this.#ports.get(compId);
    if (!port?.ready) return;
    const comp = this.#component(compId);
    const present = this.#isPort(compId);
    const s = this.#settings(compId);
    const state = {
      kind: "state",
      present,
      ref: comp?.ref ?? null,
      id: compId,
      running: this.#running && present,
      line: present ? `${s.baud} ${formatName(s)}` : null,
      flow: s.flow,
      columns: s.columns,
      enter: s.enter,
      backspace: s.backspace,
    };
    const key = JSON.stringify(state);
    if (key === port.settingsKey) return;
    port.settingsKey = key;
    this.#post(compId, state);
  }

  #sendSoon(compId) {
    const port = this.#ports.get(compId);
    if (!port?.ready || port.timer != null) return;
    port.timer = this.#timers.set(() => {
      port.timer = null;
      this.#sendScreen(compId);
    }, SEND_MS);
  }

  /** The lines changed since the last send, or (`all`) every line. */
  #sendScreen(compId, all = false) {
    const port = this.#ports.get(compId);
    if (!port?.ready) return;
    const dirty = port.screen.takeDirty();
    if (dirty == null && !all) return;
    const from = all ? 0 : dirty;
    const { lines, col, bells } = port.screen;
    this.#post(compId, {
      kind: "screen",
      from,
      lines: lines.slice(from),
      count: lines.length,
      col,
      bells,
    });
  }

  #post(compId, msg) {
    Promise.resolve(this.#bridge?.terminal?.toWindow?.(compId, msg)).catch(
      () => {},
    );
  }
}
