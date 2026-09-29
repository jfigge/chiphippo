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

// integration-shell.js — the Arduino serial integration's place in the app
// window: the element CARDS on the rail, the activity LAMPS by the zoom
// cluster, the toolbar's GENERATE segment and its out-of-sync dot, the run-time
// controller SimController consults at every settle boundary, and the two
// hooks that carry connections between this machine's settings and a project
// file. app.js builds it once and wires its pieces in; everything it does is
// here rather than in app.js, which is long enough.
//
// The Generate segment's DOT is the staleness indicator: for the desktop on
// screen, is there a connection whose header would be generated from a
// different design hash than the one the project recorded? Recomputed on
// every document change, settings change and desktop switch — the three
// things the hash (or the record) can change with.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { connectionsUsed } from "../model/integration.js";
import {
  knownConnections,
  mergeProjectConnections,
  projectConnections,
} from "../model/serial-connections.js";
import { CodegenDialog, codegenStatus } from "./codegen-dialog.js";
import { IntegrationController } from "./integration-controller.js";
import { IntegrationLamps } from "./integration-lamps.js";
import { IntegrationRail } from "./integration-rail.js";

/** The Generate segment's icon: a chip with code brackets on it. */
const GENERATE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="4" y="4" width="16" height="16" rx="2"/>' +
  '<path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>' +
  '<polyline points="10 9.5 7.5 12 10 14.5"/>' +
  '<polyline points="14 9.5 16.5 12 14 14.5"/></svg>';

/**
 * @param {object} opts
 * @param {object} opts.bridge window.chiphippo
 * @param {HTMLElement} opts.desk the `.desk-viewport`
 * @param {object} opts.deskDoc the DeskDoc
 * @param {object} opts.notifications the NotificationStack
 * @param {() => object} opts.getSettings the live settings document
 * @param {(patch: object) => void} opts.setSettings persist + apply a patch
 * @param {(tab: string) => void} opts.openSettings
 * @param {() => object|null} opts.getWorkspace the ProjectWorkspace
 * @param {() => object|null} opts.getController the DeskController
 */
export function createIntegrationShell({
  bridge,
  desk,
  deskDoc,
  notifications,
  getSettings,
  setSettings,
  openSettings,
  getWorkspace,
  getController,
}) {
  // Every connection this machine can use — the built-in Mock first.
  const connections = () => knownConnections(getSettings()?.serialConnections);
  let appVersion = "";
  Promise.resolve(bridge?.getVersion?.())
    .then((v) => (appVersion = typeof v === "string" ? v : ""))
    .catch(() => {});

  // ── The lamps, and the connection windows they open ──────────────────────
  const openWindow = (id) => void bridge?.serial?.log?.open?.(id);
  const openFromLamps = (rect) => {
    const ids = controller.connectionIds;
    const list = connections();
    if (ids.length === 1) {
      openWindow(ids[0]);
      return;
    }
    PopupManager.menu({
      x: rect?.left ?? 0,
      y: (rect?.top ?? 0) - 4,
      items: ids.map((id) => ({
        label: list.find((c) => c.id === id)?.name ?? id,
        onSelect: () => openWindow(id),
      })),
    });
  };
  const lamps = new IntegrationLamps(desk, { onOpen: openFromLamps });

  // ── The run-time controller (SimController's collaborator) ───────────────
  const controller = new IntegrationController({
    bridge,
    notifications,
    getConnections: connections,
    openSettings,
    openProperties: (id) => getController()?.openIntegrationProperties(id),
    lamps,
  });

  // ── The toolbar's Generate segment ───────────────────────────────────────
  const dot = el("span", {
    class: "toolbar-stale-dot",
    "aria-hidden": "true",
    hidden: true,
  });
  const generate = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon toolbar-generate",
    type: "button",
    onClick: () => openGenerate(),
  });
  generate.innerHTML = GENERATE_SVG;
  generate.append(dot);

  const status = () =>
    codegenStatus(
      deskDoc.integrations,
      connections(),
      (id) => getWorkspace()?.codegenHash(id) ?? null,
    );

  const refreshGenerate = () => {
    const has = deskDoc.integrations.length > 0;
    const stale = has && status().stale;
    generate.disabled = !has;
    dot.hidden = !stale;
    const label = t("toolbar.generate.label");
    generate.setAttribute("aria-label", stale ? t("toolbar.generate.staleLabel") : label); // prettier-ignore
    generate.title = !has
      ? t("toolbar.generate.none")
      : stale
        ? t("toolbar.generate.stale")
        : t("toolbar.generate.title");
  };

  function openGenerate() {
    const ws = getWorkspace();
    CodegenDialog.open({
      elements: deskDoc.integrations,
      connections: connections(),
      projectName: ws?.projectName || t("common.untitled"),
      desktopName: ws?.activeTab?.name ?? "",
      appVersion,
      storedHash: (id) => ws?.codegenHash(id) ?? null,
      onGenerated: (id, hash) => {
        ws?.setCodegenHash(id, hash);
        refreshGenerate();
      },
      // Save As… remembers where each file went per DESIGN — this project
      // file and this desktop — since one board serves many.
      saveScope: `${ws?.projectLocation ?? ""}|${ws?.activeTab?.id ?? ""}`,
      bridge,
    });
  }

  // ── The cards on the rail (mounted once the signal rail exists) ──────────
  let rail = null;
  const connectionName = (id) =>
    connections().find((c) => c.id === id)?.name ?? null;

  const refresh = () => {
    refreshGenerate();
  };
  window.addEventListener("chiphippo:doc-changed", refresh);

  return {
    controller,
    lamps,
    generate,

    /** Put the cards into the signal rail's column. */
    mountRail(signalRail) {
      rail = new IntegrationRail(signalRail.element, deskDoc, {
        onContextMenu: (id, e) =>
          getController()?.openIntegrationMenu(id, e.clientX, e.clientY),
        onTagPointerDown: (id, key, e) =>
          getController()?.beginIntegrationTagDrag(id, key, e),
        connectionName,
      });
      return rail;
    },

    /** A tag selected on the desk lights its element's card. */
    setSelected(elementId) {
      rail?.setSelected(elementId);
    },

    /** Settings changed: a connection's name is on the cards, and the serial
        settings are part of the design hash. */
    settingsChanged(patch) {
      if (!patch || !("serialConnections" in patch)) return;
      rail?.render();
      refreshGenerate();
    },

    /** The desktop (or project) on screen changed. */
    refresh,

    relocalize() {
      lamps.relocalize();
      rail?.relocalize();
      refreshGenerate();
    },

    /**
     * What a project FILE carries: every connection its desktops' elements
     * use, from this machine's settings (no port), or what the file already
     * had for one this machine does not know.
     */
    projectConnections(docs, previous) {
      const ids = [];
      for (const doc of docs ?? []) {
        for (const id of connectionsUsed(doc?.integrations)) {
          if (!ids.includes(id)) ids.push(id);
        }
      }
      return projectConnections(ids, connections(), previous);
    },

    /**
     * A project arrived with connections: any this machine lacks joins its
     * settings, port blank and flagged, so the first Run asks for it to be
     * verified instead of trying a device that means nothing here.
     */
    mergeProjectConnections(list) {
      const merged = mergeProjectConnections(
        getSettings()?.serialConnections,
        list,
      );
      if (merged.added.length === 0) return;
      setSettings({ serialConnections: merged.list });
    },
  };
}
