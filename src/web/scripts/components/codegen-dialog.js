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

// codegen-dialog.js — the toolbar's Generate: one file per connection the
// desktop on screen uses, in that connection's LANGUAGE — an Arduino header
// (ChipHippo.h) or a Python module (chiphippo.py) — each saved wherever that
// board's code lives. `model/integration-files.js` is the one place the
// language is read; this card only shows what it hands back.
//
// GENERATION IS EXPLICIT, never automatic, and the file is the link ONLY —
// the board's own code includes (imports) it and implements the Output
// functions itself — so saving over last time's never touches a line the
// user wrote.
//
// Each connection is a row saying how many Outputs and Inputs it carries, and
// whether its code is IN SYNC: the design hash it would be generated from now,
// against the one this project recorded when it was last GENERATED. The row
// has ONE button, and the status picks it: never generated or out of date →
// **Generate**, which records the new hash (in the project file — an ordinary
// unsaved change, and what takes the dot off the toolbar button) and opens
// the files; in sync → **View files…**, which only opens them. Every
// identifier a name had to be changed into is listed under its row, since a
// function the sketch defines under the old spelling will not link.
//
// The built-in MOCK gets no row: it is built from the design on screen at
// every run, so it has no header to generate and nothing to fall out of date.
// A desktop whose elements are all on the Mock is told so rather than shown
// an empty card.
//
// The FILES are the row's file beside an example program that uses it —
// ChipHippoExample.ino for C++; main.py, code.py and boot.py for Python, the
// reference the file's own comment points at — in `CodeFilesDialog`'s tabbed
// text view, where Copy and Save As… act on the file on show. Save As… goes
// through `integration:save-file`, which opens where THAT file was last saved
// for this connection and design (`saveScope`). PopupManager QUEUES a second
// popup rather than stacking it, so the viewer REPLACES this card, and closing
// it brings this card back.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { connectionsUsed, elementsFor } from "../model/integration.js";
import { designHash, hashHex } from "../model/integration-codegen.js";
import { connectionFiles } from "../model/integration-files.js";
import { CodeFilesDialog } from "./code-files-dialog.js";
import { findConnection, isMockId } from "../model/serial-connections.js";

/**
 * For a desktop: every connection its elements use, whether its header is in
 * sync, and the unassigned elements. Pure — also what the toolbar's
 * staleness dot is computed from.
 *
 * @param {Array} elements the desktop's elements
 * @param {Array} connections the settings' connections
 * @param {(connectionId: string) => string|null} storedHash
 * @returns {{rows: Array<{id, connection, outputs, inputs, hash, stored,
 *   status: "current"|"stale"|"never"|"unknown"}>, unassigned: number,
 *   mock: boolean, stale: boolean}} — `mock`: some element is on the Mock,
 *   which has no row (it needs no header).
 */
export function codegenStatus(elements, connections, storedHash) {
  const used = connectionsUsed(elements);
  const rows = used
    .filter((id) => !isMockId(id))
    .map((id) => {
      const connection = findConnection(connections, id);
      const outputs = elementsFor(elements, id, "output").length;
      const inputs = elementsFor(elements, id, "input").length;
      if (!connection) {
        return { id, connection: null, outputs, inputs, hash: null, stored: null, status: "unknown" }; // prettier-ignore
      }
      const hash = hashHex(designHash(connection, elements));
      const stored = storedHash(id);
      const status = !stored ? "never" : stored === hash ? "current" : "stale";
      return { id, connection, outputs, inputs, hash, stored, status };
    });
  return {
    rows,
    unassigned: (elements ?? []).filter((e) => !e.connection).length,
    mock: used.some(isMockId),
    stale: rows.some((r) => r.status === "stale" || r.status === "never"),
  };
}

/** One identifier warning, as a sentence — a reserved word is reserved in
    the file's language. */
function warningText(w, language) {
  if (w.code === "serial-config") return t("integration.generate.warnConfig");
  if (w.code === "python-framing") {
    return t("integration.generate.warnPythonFraming", {
      baud: w.baud,
      format: w.format,
    });
  }
  const code =
    w.code === "reserved" && language === "python" ? "reservedPython" : w.code;
  return t(`integration.generate.warn.${code}`, {
    name: w.name,
    identifier: w.identifier,
    element: w.element ?? "",
  });
}

export class CodegenDialog {
  static #open = false;

  /**
   * @param {object} opts
   * @param {Array} opts.elements the desktop's elements
   * @param {Array} opts.connections the settings' connections
   * @param {string} [opts.projectName]
   * @param {string} [opts.desktopName]
   * @param {string} [opts.appVersion]
   * @param {(connectionId: string) => string|null} opts.storedHash
   * @param {(connectionId: string, hash: string) => void} opts.onGenerated
   *   — Generate was pressed: record `hash` as this connection's.
   * @param {string} [opts.saveScope] — the design the files are generated
   *   from, as Save As… remembers it (opaque; see ipc/serial.js).
   * @param {object} opts.bridge window.chiphippo
   */
  static open(opts) {
    if (CodegenDialog.#open) return;
    CodegenDialog.#open = true;
    const {
      elements,
      connections,
      projectName = "",
      desktopName = "",
      appVersion = "",
      storedHash,
      onGenerated,
      saveScope = "",
      bridge,
    } = opts;
    const list = el("div", { class: "codegen-list" });

    const render = () => {
      const status = codegenStatus(elements, connections, storedHash);
      const rows = status.rows.map((row) => {
        const name = row.connection?.name ?? row.id;
        const files = row.connection
          ? connectionFiles({
              connection: row.connection,
              elements,
              projectName,
              desktopName,
              appVersion,
            })
          : null;
        const python = files?.language === "python";
        const current = row.status === "current";
        const openFiles = () => {
          PopupManager.close(); // this card: the viewer takes its place
          CodeFilesDialog.open({
            title: python
              ? t("integration.generate.viewTitlePython", { name })
              : t("integration.generate.viewTitle", { name }),
            files: files.files,
            onSave: (file) =>
              bridge?.integration?.saveFile(
                row.id,
                saveScope,
                file.name,
                file.text,
              ) ?? Promise.resolve(null),
            // Back to this card once the viewer has finished closing.
            onClose: () => queueMicrotask(() => CodegenDialog.open(opts)),
          });
        };
        const action = el("button", {
          class: `btn popup-btn ${current ? "btn--secondary" : "btn--primary"}`,
          type: "button",
          text: current
            ? t("integration.generate.view")
            : t("integration.generate.generate"),
          disabled: !files,
          onClick: () => {
            if (!current) onGenerated?.(row.id, hashHex(files.hash));
            openFiles();
          },
        });
        return el(
          "section",
          {
            class: `codegen-row codegen-row--${row.status}`,
            dataset: { connectionId: row.id },
          },
          [
            el("div", { class: "codegen-row-head" }, [
              el("span", { class: "codegen-name", text: name }),
              el("span", {
                class: "codegen-status",
                text: t(`integration.generate.status.${row.status}`),
              }),
            ]),
            el("p", {
              class: "codegen-counts",
              text: t("integration.generate.counts", {
                outputs: row.outputs,
                inputs: row.inputs,
              }),
            }),
            ...(files
              ? [
                  el("p", {
                    class: "codegen-language",
                    text: t(`integration.generate.language.${files.language}`),
                  }),
                ]
              : []),
            ...(row.hash
              ? [
                  el("p", {
                    class: "codegen-hash",
                    text: t("integration.generate.hash", { hash: row.hash }),
                  }),
                ]
              : []),
            ...(files?.warnings.length
              ? [
                  el(
                    "ul",
                    { class: "codegen-warnings" },
                    files.warnings.map((w) =>
                      el("li", { text: warningText(w, files.language) }),
                    ),
                  ),
                ]
              : []),
            el("div", { class: "codegen-actions" }, [action]),
          ],
        );
      });
      list.replaceChildren(
        ...(rows.length
          ? rows
          : [
              el("p", {
                class: "settings-hint",
                text: status.mock
                  ? t("integration.generate.mockOnly")
                  : t("integration.generate.none"),
              }),
            ]),
        ...(rows.length && status.mock
          ? [
              el("p", {
                class: "settings-hint",
                text: t("integration.generate.mockNote"),
              }),
            ]
          : []),
        ...(status.unassigned
          ? [
              el("p", {
                class: "settings-hint",
                text: t("integration.generate.unassigned", {
                  count: status.unassigned,
                }),
              }),
            ]
          : []),
      );
    };
    render();

    PopupManager.dialog({
      title: t("integration.generate.title"),
      closeAriaLabel: t("common.close"),
      className: "codegen-popup",
      bodyClass: "codegen-popup-body",
      body: [
        el("p", {
          class: "settings-hint",
          text: t("integration.generate.intro"),
        }),
        list,
      ],
      onClose: () => {
        CodegenDialog.#open = false;
      },
    });
  }
}
