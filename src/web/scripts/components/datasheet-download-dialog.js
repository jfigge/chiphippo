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

// datasheet-download-dialog.js — the progress modal behind Settings ▸ Data
// Sheets ▸ Download.
//
// A download of several dozen files over someone else's web server is the one
// thing in this app that takes a visible amount of time and can half-succeed,
// so it gets a window rather than a spinner: a running count, the part in
// flight, and — when it is over — exactly which parts did not arrive. A
// summary that says "38 of 41" and stops would leave the user to work out the
// other three by listing a folder.
//
// IT REPLACES THE SETTINGS DIALOG rather than sitting on top of it, because
// PopupManager QUEUES a second popup instead of stacking it (see its open()) —
// so the caller closes Settings first and this mounts immediately after.
//
// DISMISSING IT CANCELS. This dialog IS the download's user interface; leaving
// a network run going with nothing on screen to stop it would be worse than
// stopping it, and whatever already landed is kept either way.

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";

/** Emit the settings patch pointing the datasheet folder at what we filled. */
function pointSettingsAt(dir) {
  window.dispatchEvent(
    new CustomEvent("chiphippo:settings-changed", {
      detail: { datasheetDir: dir },
    }),
  );
}

export class DatasheetDownloadDialog {
  static #open = false;

  /**
   * Start a download and show its progress (a no-op when one is already up).
   *
   * The caller is responsible for closing whatever popup it was invoked from
   * FIRST — this mounts its own, and PopupManager queues rather than stacks.
   */
  static open() {
    if (DatasheetDownloadDialog.#open) return;
    DatasheetDownloadDialog.#open = true;

    const bridge = window.chiphippo?.datasheets;

    // `running` gates the two things that must not happen after the run ends:
    // cancelling something that has already finished, and a late progress push
    // overwriting the summary. `dismissed` is the other axis — this dialog's
    // own nodes are off the page, so nothing may be drawn into them (the
    // static guard would not do: it is false by the time a resolve lands, and
    // true again the moment a NEW download is started).
    let running = true;
    let dismissed = false;

    const status = el("p", {
      class: "datasheet-dl-status",
      text: "Starting…",
    });
    const fill = el("div", { class: "datasheet-dl-fill" });
    const bar = el(
      "div",
      {
        class: "datasheet-dl-bar",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuenow": "0",
      },
      [fill],
    );
    const detail = el("p", { class: "datasheet-dl-detail", text: "" });
    const failures = el("ul", { class: "datasheet-dl-failures", hidden: true });

    const actionBtn = el("button", {
      class: "settings-action",
      type: "button",
      text: "Cancel",
      onClick: () => {
        // Running → stop it (the run's own resolve then draws the summary);
        // finished → the button is just Close.
        if (running) bridge?.cancel?.();
        else PopupManager.close();
      },
    });

    const onProgress = (e) => {
      if (!running) return;
      const { done = 0, total = 0, ref = null } = e.detail ?? {};
      status.textContent = total
        ? `Downloading datasheets — ${done} of ${total}`
        : "Downloading datasheets…";
      bar.setAttribute("aria-valuemax", String(total));
      bar.setAttribute("aria-valuenow", String(done));
      fill.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
      detail.textContent = ref ? `${ref}.pdf` : "";
    };
    window.addEventListener("chiphippo:datasheet-progress", onProgress);

    // The summary replaces the counter in place — the bar stays, so a partial
    // run still SHOWS that it was partial rather than only saying so.
    const finish = (result) => {
      running = false;
      const { total = 0, saved = 0, cancelled = false, dir } = result ?? {};
      const failed = result?.failures ?? [];
      if (result?.error) {
        status.textContent = "The download could not be started.";
        detail.textContent = result.error;
      } else {
        status.textContent = cancelled
          ? `Cancelled — ${saved} of ${total} downloaded`
          : `Downloaded ${saved} of ${total} datasheets`;
        detail.textContent = saved && dir ? dir : "";
      }
      if (failed.length) {
        failures.hidden = false;
        failures.replaceChildren(
          el("li", {
            class: "datasheet-dl-failures-head",
            text: `${failed.length} could not be fetched:`,
          }),
          ...failed.map((f) =>
            el("li", { text: `${f.ref} — ${f.error ?? "failed"}` }),
          ),
        );
      }
      actionBtn.textContent = "Close";
      actionBtn.focus();
      // Point the setting at the folder as soon as anything is IN it: a
      // cancelled run that fetched thirty sheets is still thirty sheets the
      // pinout windows should be offering.
      if (saved > 0 && dir) pointSettingsAt(dir);
    };

    PopupManager.dialog({
      title: "Download datasheets",
      closeAriaLabel: "Close",
      className: "datasheet-dl-popup",
      body: [
        status,
        bar,
        detail,
        failures,
        el("div", { class: "datasheet-dl-actions" }, [actionBtn]),
      ],
      onClose: () => {
        DatasheetDownloadDialog.#open = false;
        dismissed = true;
        window.removeEventListener("chiphippo:datasheet-progress", onProgress);
        // Closed mid-run — the dialog is the only way to watch or stop it, so
        // going means stopping. Whatever landed is kept, and the resolve below
        // then has no dialog to draw into.
        if (running) {
          running = false;
          bridge?.cancel?.();
        }
      },
    });

    Promise.resolve(bridge?.download?.()).then(
      (result) => {
        // A run cancelled by CLOSING the dialog still resolves; there is
        // nothing on screen to update, but the folder still wants pointing at.
        if (dismissed) {
          if (result?.saved > 0 && result?.dir) pointSettingsAt(result.dir);
          return;
        }
        finish(result ?? { error: "the download is not available" });
      },
      (err) => {
        if (!dismissed) finish({ error: String(err?.message ?? err) });
      },
    );
  }
}
