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

/**
 * serial-manager.js — every named connection a RUN has open, and every log it
 * has collected. Main's half of the Arduino serial integration; main.js wires
 * its IPC and its pushes, and nothing here knows about Electron.
 *
 * THE RENDERER NAMES CONNECTIONS, NEVER DEVICES. A run asks for connection
 * ids; which device each one means is read here, from the settings main
 * itself stores. So `serial:open` cannot be turned into "open this path" —
 * the same stance `knownPath` takes for files and the datasheet download takes
 * for URLs.
 *
 * Ports OPEN ON RUN AND CLOSE ON STOP, so the Arduino IDE can have the port
 * back to reflash the board between runs. A run is all-or-nothing: if any one
 * connection cannot be opened, or its device never answers HELLO (or answers
 * for another protocol version or another layout), every port it did open is
 * closed again and the run is refused with the reason.
 *
 * Each connection has a STREAM (connection-stream.js): its log text, every
 * value that crossed it, the protocol's traffic and what went wrong, in one
 * order — what its connection window shows. It lives for the life of the
 * process (never on disk), is CLEARED as a run opens the connection, and
 * after Stop stays to be read until the next run. Main records FACTS and
 * times; what a line SAYS is the renderer's business. The link reports what
 * it does through `onTrace`; the run's milestones (the port opening and
 * closing, a drop) are added here. Pushes to a window are BATCHED per tick —
 * a busy run is hundreds of entries a second — and the app window hears only
 * of log text, which is all its LG lamp needs.
 *
 * A run brings each connection's LAYOUT — the names and fields of the
 * elements on it, which main otherwise never sees — so a data line can say
 * which element a value belongs to (the element is SNAPSHOTTED into the
 * entry: the next run's layout may differ).
 *
 * THE MOCK is a connection every installation has and no settings list: a
 * MockDevice (mock-device.js) behind the same port interface as a USB cable,
 * so a run opens, greets, delivers to and closes it exactly as it does a
 * board — and its stream records it all the same way. It needs no port, so it
 * is never unconfigured and never missing, and its layout also gives its
 * window a row per Input.
 */
"use strict";

const { SerialLink } = require("./link");
const { MockDevice } = require("./mock-device");
const { ConnectionStream, MAX_ENTRIES } = require("./connection-stream");
const {
  MOCK_ID,
  MOCK_NAME,
} = require("../../web/scripts/model/mock-connection.js");
const {
  FIELD_PINS,
  MAX_WIDTH,
} = require("../../web/scripts/model/serial-wire.js");

/** How many entries one connection's stream keeps before dropping the oldest. */
const MAX_LOG_ENTRIES = MAX_ENTRIES;

/** What a connection id may look like — it reaches main from the renderer. */
const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** The built-in Mock as a connection record. Never in settings. */
const MOCK_CONFIG = Object.freeze({ id: MOCK_ID, name: MOCK_NAME, mock: true });

/** At most this many elements a side, as a desk holds. */
const MAX_LAYOUT_ELEMENTS = 16;

const clip = (value, max) =>
  typeof value === "string" ? value.slice(0, max) : "";

/**
 * The mock's layout as the renderer sent it, reduced to what a window may
 * show: per side, each element's name and its fields (type and name), never
 * more pins than a value holds. It is display only — nothing routes by it.
 */
function connectionLayout(raw) {
  const side = (list) =>
    (Array.isArray(list) ? list : []).slice(0, MAX_LAYOUT_ELEMENTS).map((e) => {
      const fields = [];
      let pins = 0;
      for (const f of Array.isArray(e?.fields) ? e.fields : []) {
        const n = Object.hasOwn(FIELD_PINS, f?.type) ? FIELD_PINS[f.type] : 0;
        if (!n || pins + n > MAX_WIDTH) continue;
        pins += n;
        fields.push({ type: f.type, name: clip(f.name, 32) });
      }
      return { name: clip(e?.name, 64), fields };
    });
  return { outputs: side(raw?.outputs), inputs: side(raw?.inputs) };
}

class SerialManager {
  #connections;
  #listPorts;
  #openPort;
  #emit;
  #timers;
  #links = new Map(); // id → SerialLink (only while a run has it open)
  #streams = new Map(); // id → ConnectionStream (outlives runs)
  #layouts = new Map(); // id → its last run's elements (display only)
  #pending = new Map(); // id → { reset, entries, text } not yet pushed
  #flushQueued = false;
  #generation = 0; // bumped by every open/close, so a stale open can tell
  #settled = Promise.resolve(); // every earlier open and close, let go
  #mock; // the Mock's device — one for the life of the process

  /**
   * @param {object} opts
   * @param {() => Array<object>} opts.connections - the configured
   *   connections, read fresh each time (settings.json's `serialConnections`).
   * @param {() => Promise<Array<{path: string}>>} opts.listPorts
   * @param {(config: object) => Promise<object>} opts.openPort
   * @param {(event: string, payload: object) => void} opts.emit - `inbound`,
   *   `log`, `restart`, `dropped`, `mock`.
   * @param {object} [opts.timers]
   * @param {number} [opts.mockTimeoutMs] - the mock's ACK timeout (tests).
   */
  constructor({
    connections,
    listPorts,
    openPort,
    emit,
    timers,
    mockTimeoutMs,
  }) {
    this.#connections = connections;
    this.#listPorts = listPorts;
    this.#openPort = openPort;
    this.#emit = emit ?? (() => {});
    this.#timers = timers;
    this.#mock = new MockDevice({
      timers: timers ?? globalThis,
      timeoutMs: mockTimeoutMs,
      onEvent: (kind, data) => this.#onMock(kind, data),
    });
  }

  /** The connection with this id — the Mock, or one settings configure — or
      null. A settings entry can never stand in for the Mock. */
  connection(id) {
    if (id === MOCK_ID) return MOCK_CONFIG;
    if (!CONNECTION_ID_RE.test(String(id ?? ""))) return null;
    const list = this.#connections?.() ?? [];
    return list.find((c) => c && c.id === id) ?? null;
  }

  /** Every port the OS reports, for Settings ▸ Integration and Run. */
  async ports() {
    try {
      return await this.#listPorts();
    } catch (err) {
      console.error("[main] listing serial ports failed:", err);
      return [];
    }
  }

  /** Are any connections open (a run is using the serial link)? */
  get active() {
    return this.#links.size > 0;
  }

  /**
   * Open every connection a run uses and greet each device.
   *
   * @param {Array<{id: string, signature: number, layout?: object}>} requests -
   *   each connection the run uses, with the layout signature its sketch must
   *   have been built for (the renderer's, from the document main never sees)
   *   and its `layout`, for its window.
   * @returns {Promise<{ok: true} |
   *   {ok: false, id: string, code: string, detail?: string, version?: number}>}
   *   `code` is one of `unknown` (no such connection), `unconfigured`
   *   (flagged, or no port), `port-missing`, `open-failed` (the driver refused
   *   — `detail` says why), `no-response` (the port opened but nothing
   *   answered HELLO), `version` (the sketch speaks another protocol version —
   *   `version` says which), `signature` (it was built for a different
   *   layout), `dropped` (its port went away while the run was opening) or
   *   `closed` (a Stop, or a newer run, came first — nothing to explain).
   *
   * A run first stops whatever was running or opening, and its own ports open
   * only once EVERY earlier open and close has let go: a port still closing,
   * or one a stopped run's open is still acquiring, holds the device's
   * exclusive lock and would answer this run "busy". A superseded open notices
   * after every await and closes only what it opened itself — never a newer
   * run's links.
   */
  open(requests) {
    this.close();
    const generation = this.#generation;
    const run = this.#settled.then(() => this.#open(requests, generation));
    this.#settled = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #open(requests, generation) {
    const stale = () => generation !== this.#generation;
    const closed = { ok: false, code: "closed" };
    if (stale()) return closed; // stopped while an earlier run let go
    const wanted = new Map();
    for (const r of Array.isArray(requests) ? requests : []) {
      if (r && !wanted.has(r.id)) wanted.set(r.id, r);
    }
    const configs = [];
    for (const id of wanted.keys()) {
      const config = this.connection(id);
      if (!config) return { ok: false, id, code: "unknown" };
      if (!config.mock && (config.needsConfig || !config.port)) {
        return { ok: false, id, code: "unconfigured" };
      }
      configs.push(config);
    }
    if (configs.length === 0) return { ok: true };

    const real = configs.filter((c) => !c.mock);
    if (real.length) {
      const present = new Set((await this.ports()).map((p) => p.path));
      if (stale()) return closed;
      for (const config of real) {
        if (!present.has(config.port)) {
          return { ok: false, id: config.id, code: "port-missing" };
        }
      }
    }
    for (const [id, request] of wanted) {
      this.#layouts.set(id, connectionLayout(request.layout));
    }

    // THIS open's links, and only these: a newer run's are not its to touch.
    const opened = [];
    const refuse = async (result) => {
      for (const [id, link] of opened) {
        if (this.#links.get(id) === link) this.#links.delete(id);
        await this.#closeLink(id, link);
      }
      return result;
    };
    for (const config of configs) {
      // A run starts each connection's stream afresh.
      this.#stream(config.id).beginRun();
      this.#queue(config.id, { reset: true });
      let port;
      try {
        port = config.mock
          ? this.#mock.openPort({
              signature: wanted.get(config.id).signature >>> 0,
            })
          : await this.#openPort(config);
      } catch (err) {
        if (stale()) return refuse(closed);
        const detail = String(err?.message ?? err);
        this.#record(config.id, { kind: "error", event: "open-failed", detail }); // prettier-ignore
        return refuse({ ok: false, id: config.id, code: "open-failed", detail }); // prettier-ignore
      }
      const link = this.#linkFor(config, port);
      opened.push([config.id, link]);
      this.#record(config.id, {
        kind: "proto",
        event: "open",
        port: config.mock ? null : config.port,
      });
      // Stopped while the driver was opening it: let it go again at once.
      if (stale()) return refuse(closed);
      this.#links.set(config.id, link);
    }

    // Each link as it was opened — a drop may already have taken one out of
    // `#links`, and its handshake then answers "closed" at once.
    const results = await Promise.all(
      opened.map(([id, link]) =>
        link.handshake(wanted.get(id).signature >>> 0),
      ),
    );
    if (stale()) return refuse(closed);
    for (let i = 0; i < opened.length; i++) {
      const [id, link] = opened[i];
      // Nothing of ours has closed it (that would have made the open stale),
      // so its port went away — during its own handshake or while another's
      // finished. That is a drop to explain, never a Stop to keep quiet about.
      if (link.closed) return refuse({ ok: false, id, code: "dropped" });
      const r = results[i];
      if (r.ok) continue;
      const refusal = { ok: false, id, code: r.code };
      if (r.code === "version") refusal.version = r.device.version;
      return refuse(refusal);
    }
    return { ok: true };
  }

  /** Close every open connection — Stop, or a refused run. An open still in
      flight notices, and lets go of whatever it acquires. */
  close() {
    this.#generation++;
    const links = [...this.#links];
    this.#links.clear();
    const done = (async () => {
      for (const [id, link] of links) await this.#closeLink(id, link);
    })();
    this.#settled = Promise.all([this.#settled, done]).then(
      () => {},
      () => {},
    );
    return done;
  }

  async #closeLink(id, link) {
    if (link.closed) return;
    await link.close();
    this.#record(id, { kind: "proto", event: "close" });
  }

  /**
   * Deliver one Output frame.
   * @returns {Promise<{ok: true} | {ok: false, code: string}>}
   */
  send(id, index, width, value) {
    const link = this.#links.get(id);
    if (!link) return Promise.resolve({ ok: false, code: "closed" });
    return link.send(index, width, value);
  }

  // ── The Mock ─────────────────────────────────────────────────────────────

  /** What the Mock's window shows: open / connected / armed faults, and the
      layout of its last run (null before the first). */
  mockState() {
    return { ...this.#mock.state, layout: this.#layouts.get(MOCK_ID) ?? null };
  }

  /**
   * Send an Input's value from the Mock, as a sketch's `send()` would.
   * @returns {Promise<{ok: true} | {ok: false, code: string}>}
   */
  mockSend(index, width, value) {
    return this.#mock.sendInput(index, width, value);
  }

  /** Log text from the Mock, as a sketch's `print()` would. */
  mockLog(text) {
    return this.#mock.log(text);
  }

  /** Arm or disarm one of the Mock's one-shot faults. */
  mockFault(fault, on) {
    return this.#mock.arm(fault, on);
  }

  /** The Mock's device changed state (its values reach its stream through
      the link, as a board's do). */
  #onMock(kind) {
    if (kind === "state") {
      this.#emit("mock", { id: MOCK_ID, ...this.mockState() });
    }
  }

  // ── Streams ──────────────────────────────────────────────────────────────

  /** A connection's whole stream, for a window that has just opened. */
  logRead(id) {
    return this.#stream(id).snapshot();
  }

  /** Empty a connection's stream (the window's Clear). */
  logClear(id) {
    this.#stream(id).clear();
    this.#queue(id, { reset: true });
  }

  #stream(id) {
    let stream = this.#streams.get(id);
    if (!stream) this.#streams.set(id, (stream = new ConnectionStream()));
    return stream;
  }

  /** One fact about a connection, into its stream. A data entry gains the
      element it belongs to, as the run described it. */
  #record(id, entry) {
    let full = entry;
    if (entry.kind === "data") {
      const side = entry.dir === "out" ? "outputs" : "inputs";
      const element = this.#layouts.get(id)?.[side]?.[entry.index];
      if (element) full = { ...entry, element };
    }
    this.#queue(id, { entries: this.#stream(id).add(full) });
  }

  /** Log text, cut into lines by the stream. */
  #logText(id, text) {
    const stream = this.#stream(id);
    this.#queue(id, { entries: stream.text(text), text: true });
  }

  /**
   * Hold what changed for the next push. A RESET (a run beginning, a Clear)
   * replaces whatever was waiting — the window starts over from it.
   */
  #queue(id, { reset = false, entries = [], text = false }) {
    let q = this.#pending.get(id);
    if (!q || reset) {
      q = { reset: reset || Boolean(q?.reset), entries: [], text: false };
      this.#pending.set(id, q);
    }
    q.entries.push(...entries);
    q.text ||= text || entries.some((e) => e.kind === "text");
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    setImmediate(() => this.#flush());
  }

  #flush() {
    this.#flushQueued = false;
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const [id, q] of pending) {
      const stream = this.#stream(id);
      this.#emit("log", {
        id,
        ...(q.reset ? { reset: true } : {}),
        t0: stream.t0,
        entries: q.entries,
        partial: stream.partial,
        text: q.text,
      });
    }
  }

  #linkFor(config, port) {
    const id = config.id;
    let link = null;
    link = new SerialLink({
      port,
      timers: this.#timers,
      onInbound: (data) => this.#emit("inbound", { id, ...data }),
      onLog: (text) => this.#logText(id, text),
      onTrace: (entry) => this.#record(id, entry),
      onRestart: () => this.#emit("restart", { id }),
      onClosed: ({ error }) => {
        // Only a link still in the run's set was dropped — one a Stop has
        // already let go of is not news.
        if (this.#links.get(id) !== link) return;
        this.#links.delete(id);
        this.#record(id, {
          kind: "error",
          event: "dropped",
          detail: error ? String(error.message ?? error) : "",
        });
        this.#emit("dropped", {
          id,
          detail: error ? String(error.message ?? error) : "",
        });
      },
    });
    return link;
  }
}

module.exports = {
  SerialManager,
  MAX_LOG_ENTRIES,
  CONNECTION_ID_RE,
  MOCK_ID,
};
