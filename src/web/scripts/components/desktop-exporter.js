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

// desktop-exporter.js — Desktop ▸ Export To, end to end (Feature 390): the
// Desktop menu's submenu and the tab strip's both land here, with a desktop
// snapshot and a format.
//
//   generate (pure, model/export/) → the report card, only if there is
//   something to say → main's dialog and write (`desktop:export-to`) → a toast
//   saying where it went.
//
// It reads the document and changes nothing, so like Export Desktop… it is
// offered while the circuit runs. One export at a time: a second request while
// one is waiting on a dialog is ignored rather than queued behind it.

import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { exportDesktop, exportable } from "../model/export/index.js";
import {
  openExportReport,
  reportWorthShowing,
} from "./export-report-dialog.js";

/** The targets' product names: shown as they are in every language. */
export const FORMAT_NAMES = Object.freeze({
  kicad: "KiCad",
  digital: "Digital",
});

export class DesktopExporter {
  #bridge;
  #notifications;
  #busy = false;

  /**
   * @param {object} opts
   * @param {object} opts.bridge - window.chiphippo (`desktop.exportTo`, `docs`).
   * @param {{notify: Function}} opts.notifications - the toast stack.
   */
  constructor({ bridge, notifications }) {
    this.#bridge = bridge;
    this.#notifications = notifications;
  }

  /**
   * Export one desktop.
   *
   * @param {{tabId:string, name:string, description?:string, doc:object}}
   *   desktop - from ProjectWorkspace.desktopSnapshot.
   * @param {string} format - "kicad" | "digital".
   * @returns {Promise<boolean>} whether files were written.
   */
  async export(desktop, format) {
    if (this.#busy || !desktop) return false;
    const formatName = FORMAT_NAMES[format];
    if (!formatName) return false;
    if (!exportable(desktop.doc)) {
      this.#notifications.notify({
        key: "export",
        message: t("export.empty"),
      });
      return false;
    }
    this.#busy = true;
    try {
      const result = exportDesktop(format, desktop.doc, desktop);
      if (reportWorthShowing(result.report)) {
        const go = await openExportReport({
          formatName,
          report: result.report,
          bridge: this.#bridge,
        });
        if (!go) return false;
      }
      const res = await this.#bridge.desktop.exportTo(format, result.files);
      if (res == null) return false; // the dialog was cancelled
      if (!res.ok) {
        this.#refused(res, formatName);
        return false;
      }
      this.#notifications.notify({
        key: "export",
        title: t("export.doneTitle", { format: formatName }),
        message: t("export.done", { name: desktop.name, path: res.path }),
      });
      return true;
    } catch (err) {
      console.error("[renderer] export failed:", err);
      this.#notifications.notify({
        key: "export",
        variant: "danger",
        message: t("workspace.failExport"),
      });
      return false;
    } finally {
      this.#busy = false;
    }
  }

  /** Main wrote nothing: say why, in the one case the user can act on. */
  #refused(res, formatName) {
    if (res.code === "foreign") {
      PopupManager.notify({
        title: t("export.title", { format: formatName }),
        message: t("export.foreign", { file: res.file }),
        okLabel: t("common.ok"),
      });
      return;
    }
    console.error("[renderer] desktop:export-to refused:", res);
    this.#notifications.notify({
      key: "export",
      variant: "danger",
      message: t("workspace.failExport"),
    });
  }
}
