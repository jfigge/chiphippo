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

// integration-controller.js — the Arduino serial integration WHILE A CIRCUIT
// RUNS. It is SimController's settle-boundary collaborator (see the header of
// sim-controller.js), and the renderer's end of main's serial link:
//
//   preflight  Run pressed: every element waiting for an edge must have its
//              trigger tag on the board, and every connection the desk's
//              elements use must be configured, not flagged, and have its port
//              plugged in — or the run does not start, and the user is told
//              which and why (never offered some other port: that is theirs
//              to choose).
//   begin      the ports open and each device is greeted (HELLO / HELLO_ACK):
//              one that does not answer, speaks another protocol version, or
//              was built for a different LAYOUT (the signature: what shapes
//              the bytes, never a name) refuses the run, saying which.
//   settled    each boundary: Outputs whose trigger fired are sent, and the
//              board STALLS until every one is acknowledged; then every
//              eligible Input value is applied at once, and the board settles
//              again (model/integration-runtime.js holds the rules).
//   levels     what the Inputs' pins drive.
//   end        Stop: the ports close, so the Arduino IDE can reflash.
//
// Every connection's open request carries its LAYOUT — its elements' names
// and fields, which main otherwise never sees — so its connection window can
// name the element a value belongs to.
//
// The built-in MOCK goes through every one of these exactly as a board does —
// it is a connection like any other to this side — bar two things: it needs
// no port, and its window opens by itself, in the background, when a run
// begins: the Mock is useless unseen.
//
// A delivery that fails three times, a port that drops mid-run and a device
// that restarts mid-run all STOP the run with a message naming the connection.
// There is no pause-and-resume: a half-connected circuit is not one worth
// running.
//
// The LAMPS (integration-lamps.js) are told of DATA only — an Output sent (TX),
// an Input received (RX), log text (LG). Acknowledgements, NAKs and retries
// never reach this side at all (link.js keeps them to itself), which is what
// keeps the lamps honest: with the clock paused, a flickering TX/RX is a
// feedback loop.

import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import {
  TRIGGER_KEY,
  connectionLayout,
  connectionsUsed,
  elementsFor,
  isAutoTrigger,
  isElementPlanted,
  isTagPlanted,
  layoutSignature,
  pinCount,
  runElements,
} from "../model/integration.js";
import { IntegrationRuntime, isLive } from "../model/integration-runtime.js";
import { MAX_SENDS, PROTOCOL_VERSION } from "../model/serial-wire.js";
import {
  MOCK_ID,
  connectionProblem,
  findConnection,
} from "../model/serial-connections.js";

export class IntegrationController {
  #bridge;
  #notifications;
  #getConnections;
  #openSettings;
  #openProperties;
  #lamps;
  #sim = null;
  #runtime = new IntegrationRuntime();
  #elements = []; // frozen at begin — the topology is frozen while running
  #running = false;
  // Between begin() and the ports' open resolving: a device already greeted
  // may be sending its Inputs' starting values (its onConnect runs the moment
  // its handshake completes, before every other connection's has).
  #opening = false;
  // Which run the ports are being opened for: bumped by begin() and end(), so
  // an open answering for a run that has since ended (a Stop, or a Stop and a
  // new Run, while main was still opening) changes nothing of the run now.
  #run = 0;
  #partials = new Map(); // connection id → the log's last partial line

  /**
   * @param {object} opts
   * @param {object} opts.bridge window.chiphippo
   * @param {object} [opts.notifications] the NotificationStack
   * @param {() => Array} opts.getConnections the settings' connections
   * @param {(tab: string) => void} [opts.openSettings]
   * @param {(elementId: string) => void} [opts.openProperties]
   * @param {object} [opts.lamps] `{flash(kind), setActive(on)}`
   */
  constructor({
    bridge,
    notifications,
    getConnections,
    openSettings,
    openProperties,
    lamps,
  }) {
    this.#bridge = bridge;
    this.#notifications = notifications;
    this.#getConnections = getConnections ?? (() => []);
    this.#openSettings = openSettings;
    this.#openProperties = openProperties;
    this.#lamps = lamps ?? null;
    window.addEventListener("chiphippo:serial-inbound", (e) =>
      this.#onInbound(e.detail),
    );
    window.addEventListener("chiphippo:serial-log", (e) =>
      this.#onLog(e.detail),
    );
    window.addEventListener("chiphippo:serial-dropped", (e) =>
      this.#onDropped(e.detail),
    );
    window.addEventListener("chiphippo:serial-restart", (e) =>
      this.#onRestart(e.detail),
    );
    // A renderer that has just (re)loaded cannot be mid-run: any port a run
    // before it left open is let go, so the Arduino IDE can have it back.
    Promise.resolve(bridge?.serial?.close?.()).catch(() => {});
  }

  /** The SimController this answers to — for Stop and wake. */
  setSim(sim) {
    this.#sim = sim;
  }

  /** Is a run using the serial link right now? */
  get running() {
    return this.#running;
  }

  /** The connections the run in progress uses (the LG lamp's menu). */
  get connectionIds() {
    return connectionsUsed(this.#elements);
  }

  // ── SimController's collaborator ────────────────────────────────────────

  /**
   * Before Run: may the circuit start? Synchronously true for a desk with no
   * elements in use; otherwise every element on the breadboard needs a
   * connection, and every connection the breadboard references must be
   * configured and have its port present (see `runElements` — a board nothing
   * on the breadboard uses is none of this run's business). A refusal shows
   * the reason and offers the way to fix it.
   * @returns {boolean|Promise<boolean>}
   */
  preflight(doc) {
    const all = doc?.integrations ?? [];
    // Unassigned is asked of the whole desk, not the run's elements: an
    // element with no connection is never IN a run, and one planted on the
    // breadboard that would silently do nothing is exactly what to say.
    const unassigned = all.find((e) => !e.connection && isElementPlanted(e));
    if (unassigned) {
      this.#refuse(
        t("integration.verify.noConnection", {
          name: unassigned.name || unassigned.id,
        }),
        () => this.#openProperties?.(unassigned.id),
        t("integration.verify.openProperties"),
      );
      return false;
    }
    const elements = runElements(all);
    if (elements.length === 0) return true;
    // An element waiting for an edge with no line to watch would never send
    // (an Output) or never apply (an Input): a run that silently does
    // nothing. Auto is the one trigger with no tag, so it is never asked — and
    // nor is an element with NOTHING on the breadboard, riding along on a board
    // its neighbours use: it reaches no net, so there is no silence to warn of.
    const untriggered = elements.find(
      (e) =>
        isElementPlanted(e) &&
        !isAutoTrigger(e) &&
        !isTagPlanted(e, TRIGGER_KEY),
    );
    if (untriggered) {
      this.#refuse(
        t("integration.verify.noTrigger", {
          name: untriggered.name || untriggered.id,
        }),
        () => this.#openProperties?.(untriggered.id),
        t("integration.verify.openProperties"),
      );
      return false;
    }
    const connections = this.#getConnections() ?? [];
    // A connection this computer does not know — removed in Settings since
    // the element chose it — has no card to fix it on, so the way out is the
    // ELEMENT's Properties, where it reads "(not on this computer)".
    const orphan = elements.find(
      (e) => !findConnection(connections, e.connection),
    );
    if (orphan) {
      this.#refuse(
        t("integration.verify.unknownConnection", {
          name: orphan.name || orphan.id,
        }),
        () => this.#openProperties?.(orphan.id),
        t("integration.verify.openProperties"),
      );
      return false;
    }
    for (const id of connectionsUsed(elements)) {
      const conn = findConnection(connections, id);
      const problem = connectionProblem(conn, null);
      if (problem) {
        this.#refuseConnection(conn, id, problem);
        return false;
      }
    }
    return this.#checkPorts(connectionsUsed(elements), connections);
  }

  async #checkPorts(ids, connections) {
    // Only a real board has a port to look for.
    if (ids.every((id) => findConnection(connections, id)?.builtin)) {
      return true;
    }
    let ports = [];
    try {
      ports = (await this.#bridge?.serial?.ports?.()) ?? [];
    } catch (err) {
      console.error("[renderer] serial:ports failed:", err);
    }
    const present = ports.map((p) => p.path);
    for (const id of ids) {
      const conn = findConnection(connections, id);
      const problem = connectionProblem(conn, present);
      if (problem) {
        this.#refuseConnection(conn, id, problem);
        return false;
      }
    }
    return true;
  }

  /**
   * The run is starting: open the ports and greet every device.
   * @returns {Promise<boolean>|null} false stops the run (after saying why)
   */
  begin(doc) {
    const elements = runElements(doc?.integrations);
    if (elements.length === 0) return null;
    this.#elements = elements;
    this.#runtime.begin(elements);
    this.#partials.clear();
    this.#opening = true;
    return this.#open(connectionsUsed(elements), ++this.#run);
  }

  async #open(ids, run) {
    const connections = this.#getConnections() ?? [];
    const names = ids
      .map((id) => findConnection(connections, id)?.name ?? id)
      .join(", ");
    this.#notifications?.notify({
      key: "integration-connect",
      title: t("integration.run.connectingTitle"),
      message: t("integration.run.connecting", { names }),
      sticky: true,
    });
    let result;
    try {
      result = await this.#bridge.serial.open(
        ids.map((id) => ({
          id,
          signature: layoutSignature(this.#elements, id),
          // Names and fields, so its connection window can say which element
          // a value belongs to (and the Mock's can offer a row per Input).
          layout: connectionLayout(this.#elements, id),
        })),
      );
    } catch (err) {
      result = {
        ok: false,
        code: "open-failed",
        detail: String(err?.message ?? err),
      };
    }
    // An answer for a run that has ended: its Stop said everything already,
    // and what it would set (the lamps, the opening state, the "Connecting…"
    // note) is the current run's.
    if (run !== this.#run) return false;
    this.#notifications?.dismiss?.("integration-connect");
    this.#opening = false;
    if (!result?.ok) {
      if (result?.code !== "closed")
        this.#explainOpenFailure(result, connections);
      return false;
    }
    this.#running = true;
    this.#lamps?.setActive(true);
    if (ids.includes(MOCK_ID)) {
      Promise.resolve(
        this.#bridge?.serial?.log?.open?.(MOCK_ID, { background: true }),
      ).catch(() => {});
    }
    return true;
  }

  /**
   * A settle boundary. Returns null (nothing to do), `{again: true}` (Input
   * values went on the board), or the STALL — a promise that resolves once
   * every Output sent here has been acknowledged and the eligible Inputs have
   * been applied.
   */
  settled({ netlist, netLevels }) {
    if (!this.#running) return null;
    const levelAt = (address) => netLevels.get(netlist.netOfPoint.get(address));
    const { sends, released } = this.#runtime.boundary(this.#elements, levelAt);
    if (sends.length === 0) {
      return this.#runtime.apply(this.#elements, released)
        ? { again: true }
        : null;
    }
    for (let i = 0; i < sends.length; i++) this.#lamps?.flash("tx");
    return Promise.all(
      sends.map((s) =>
        this.#bridge.serial
          .send(s.element.connection, s.index, s.width, s.value)
          .catch((err) => ({
            ok: false,
            code: "delivery",
            detail: String(err),
          })),
      ),
    ).then((results) => {
      // Stopped while the frames were in flight: closing the ports is what
      // failed them, and that is not news.
      if (!this.#running) return { again: false };
      const failed = results.findIndex((r) => !r?.ok);
      if (failed >= 0) {
        this.#deliveryFailed(sends[failed].element.connection, results[failed]);
        return { again: false };
      }
      return { again: this.#runtime.apply(this.#elements, released) };
    });
  }

  /** What the Inputs' pins drive right now. */
  levels() {
    return this.#running ? this.#runtime.levels(this.#elements) : new Map();
  }

  /** Stop: forget the run and let the ports go. */
  end() {
    const was = this.#running || this.#elements.length > 0;
    this.#run++;
    this.#running = false;
    this.#opening = false;
    this.#elements = [];
    this.#runtime.end();
    this.#lamps?.setActive(false);
    this.#notifications?.dismiss?.("integration-connect");
    if (was) Promise.resolve(this.#bridge?.serial?.close?.()).catch(() => {});
  }

  // ── What arrives from main ──────────────────────────────────────────────

  /**
   * A value from a device. Kept from the moment its connection is greeted —
   * while the run is still opening too: a device sends its Inputs' starting
   * values as soon as its own handshake completes (the protocol's `onConnect`),
   * and it has been ACKed, so a value dropped here would never come again.
   */
  #onInbound(detail) {
    if ((!this.#running && !this.#opening) || !detail) return;
    const element = elementsFor(this.#elements, detail.id, "input")[
      detail.index
    ];
    // Unusable — an element this desk does not have, or not its width — is
    // dropped (it was ACKed already: a resend would carry the same bytes).
    // The handshake's signature makes either all but impossible.
    if (!element || detail.width !== pinCount(element.fields)) return;
    this.#lamps?.flash("rx");
    this.#runtime.receive(this.#elements, element, detail.width, detail.value);
    // A LIVE Input applies at the next boundary — which, on a quiet board, is
    // now. A triggered one waits for its edge, and a stalled board applies
    // what it holds when the stall ends.
    if (this.#running && isLive(element) && !this.#sim?.stalled) {
      this.#sim?.wake();
    }
  }

  #onLog(detail) {
    if (!detail || detail.reset) return;
    const partial = detail.partial ?? "";
    const before = this.#partials.get(detail.id) ?? "";
    this.#partials.set(detail.id, partial);
    const text = (detail.entries ?? []).some((e) => e.kind === "text");
    if (text || (partial && partial !== before)) this.#lamps?.flash("lg");
  }

  #onDropped(detail) {
    if (!this.#running || !detail) return;
    const conn = findConnection(this.#getConnections(), detail.id);
    this.#stopWith(
      t("integration.run.droppedTitle"),
      t("integration.run.dropped", { name: conn?.name ?? detail.id }),
    );
  }

  /** The device announced mid-run that it is in no session — it restarted,
      or gave up on this one after an Input went unacknowledged — and will not
      answer until greeted again, which only a new Run does. */
  #onRestart(detail) {
    if (!this.#running || !detail) return;
    const conn = findConnection(this.#getConnections(), detail.id);
    this.#stopWith(
      t("integration.run.restartTitle"),
      t("integration.run.restart", { name: conn?.name ?? detail.id }),
    );
  }

  // ── Saying why ──────────────────────────────────────────────────────────

  #deliveryFailed(id, result) {
    const conn = findConnection(this.#getConnections(), id);
    const name = conn?.name ?? id;
    // A device that restarted says so through `serial-restart`, which this
    // may beat to it.
    if (result?.code === "restart") {
      this.#onRestart({ id });
      return;
    }
    // A port that went away reports itself through `serial-dropped`; this is
    // the other failure — the board is there but never acknowledged.
    if (result?.code === "closed") {
      this.#stopWith(
        t("integration.run.droppedTitle"),
        t("integration.run.dropped", { name }),
      );
      return;
    }
    this.#stopWith(
      t("integration.run.deliveryTitle"),
      t("integration.run.delivery", { name, attempts: MAX_SENDS }),
    );
  }

  #stopWith(title, message) {
    this.#sim?.stop();
    PopupManager.notify({ title, message, okLabel: t("common.ok") });
  }

  #refuse(message, fix, fixLabel) {
    PopupManager.confirm({
      title: t("integration.verify.title"),
      message,
      confirmLabel: fixLabel ?? t("integration.verify.openSettings"),
      onConfirm: fix ?? (() => this.#openSettings?.("integration")),
    });
  }

  #refuseConnection(conn, id, problem) {
    const name = conn?.name ?? id;
    const message =
      problem === "port-missing"
        ? t("integration.verify.portMissing", { name, port: conn.port })
        : t("integration.verify.unconfigured", { name });
    this.#refuse(message);
  }

  #explainOpenFailure(result, connections) {
    const conn = findConnection(connections, result?.id);
    const name = conn?.name ?? result?.id ?? "";
    const port = conn?.port ?? "";
    if (result?.code === "port-missing") {
      this.#refuse(t("integration.verify.portMissing", { name, port }));
    } else if (result?.code === "unknown" || result?.code === "unconfigured") {
      this.#refuse(t("integration.verify.unconfigured", { name }));
    } else if (result?.code === "no-response") {
      PopupManager.notify({
        title: t("integration.run.noResponseTitle"),
        message: t("integration.run.noResponse", { name, port }),
        okLabel: t("common.ok"),
      });
    } else if (result?.code === "version") {
      PopupManager.notify({
        title: t("integration.run.versionTitle"),
        message: t("integration.run.version", {
          name,
          device: result.version,
          host: PROTOCOL_VERSION,
        }),
        okLabel: t("common.ok"),
      });
    } else if (result?.code === "signature") {
      PopupManager.notify({
        title: t("integration.run.signatureTitle"),
        message: t("integration.run.signature", { name }),
        okLabel: t("common.ok"),
      });
    } else if (result?.code === "dropped") {
      // Its port went away while the run was opening (a board that
      // re-enumerates as its port opens, a cable pulled while "Connecting…"
      // showed) — the same news `serial-dropped` brings mid-run, which this
      // run was not yet running to hear.
      PopupManager.notify({
        title: t("integration.run.droppedTitle"),
        message: t("integration.run.dropped", { name }),
        okLabel: t("common.ok"),
      });
    } else {
      PopupManager.notify({
        title: t("integration.run.openFailedTitle"),
        message: t("integration.run.openFailed", {
          name,
          port,
          detail: result?.detail ?? "",
        }),
        okLabel: t("common.ok"),
      });
    }
  }
}
