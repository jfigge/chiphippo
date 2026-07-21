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

// about-dialog.js — the "About Chip Hippo" modal, opened from the top-left brand
// icon or the application menu (menu:show-about → chiphippo:show-about). A
// renderer PopupManager modal styled like the Rest Hippo About card: a large
// rounded logo, the name with an (i) toggle revealing a floating version/build
// popover, subtitle, description, credit, and a prominent Close button. Build
// metadata loads asynchronously from the main process (getAppInfo).

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";

const NAME = "Chip Hippo";
const SUBTITLE = "TTL breadboard designer & simulator";
const DESCRIPTION =
  "Design and simulate 74xx-family logic circuits on virtual solderless " +
  "breadboards — place chips, wires, switches, LEDs and power, then watch " +
  "electricity settle through every net.";
const CREDIT = "Copyright © 2026 Jason Figge";

/** A small "i" glyph for the info toggle (the button supplies the circle). */
const INFO_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
  '<circle cx="8" cy="4" r="1.25" fill="currentColor"/>' +
  '<rect x="7" y="6.5" width="2" height="6" rx="1" fill="currentColor"/></svg>';

export class AboutDialog {
  static #open = false;

  /** Show the About dialog (a no-op when one is already open). */
  static open() {
    if (AboutDialog.#open) return;
    AboutDialog.#open = true;

    const build = el("div", {
      class: "about-build",
      id: "about-build",
      hidden: true,
    });

    const infoBtn = el("button", {
      class: "about-info-btn",
      type: "button",
      "aria-controls": "about-build",
      "aria-expanded": "false",
      "aria-label": "Version information",
      title: "Version information",
      onClick: () => {
        const show = build.hasAttribute("hidden");
        build.toggleAttribute("hidden", !show);
        infoBtn.setAttribute("aria-expanded", String(show));
      },
    });
    infoBtn.innerHTML = INFO_SVG;

    const element = el(
      "div",
      {
        class: "popup about-dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": `About ${NAME}`,
      },
      [
        el("img", {
          class: "about-logo",
          src: "chiphippo-logo.png",
          alt: "",
          "aria-hidden": "true",
          draggable: false,
        }),
        el("div", { class: "about-name-row" }, [
          el("h1", { class: "about-name", text: NAME }),
          infoBtn,
          build,
        ]),
        el("p", { class: "about-subtitle", text: SUBTITLE }),
        el("p", { class: "about-desc", text: DESCRIPTION }),
        el("p", { class: "about-credit", text: CREDIT }),
        el("button", {
          class: "about-close",
          type: "button",
          text: "Close",
          onClick: () => PopupManager.close(),
          "data-autofocus": true,
        }),
      ],
    );

    PopupManager.open({ element, onMaskClick: () => PopupManager.close() });
    window.addEventListener(
      "chiphippo:popup-closed",
      () => {
        AboutDialog.#open = false;
      },
      { once: true },
    );

    AboutDialog.#fillDetails(build);
  }

  static async #fillDetails(build) {
    let info = null;
    try {
      info = await window.chiphippo?.getAppInfo?.();
    } catch {
      /* dev build without the bridge — show version-less */
    }
    const rows = info
      ? [
          ["Version", info.version],
          ["Electron", info.electron],
          ["Chromium", info.chrome],
          ["Node", info.node],
          ["Platform", info.platform],
        ]
      : [["Version", "dev build"]];
    for (const [label, value] of rows) {
      build.append(
        el("div", { class: "about-build-row" }, [
          el("span", { class: "about-build-label", text: label }),
          el("span", { class: "about-build-value", text: value ?? "—" }),
        ]),
      );
    }
  }
}
