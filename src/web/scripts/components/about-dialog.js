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
// popover, subtitle, description, support address, credit, and a prominent
// Close button. Build metadata loads asynchronously from the main process
// (getAppInfo).

import { t } from "../i18n.js";
import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";
import { buildInfoButton } from "./info-button.js";

/** The product name — never translated, in any language. */
const NAME = "Chip Hippo";

// The support address. An IDENTITY, not prose — the same characters in every
// language, like the name above and the copyright line below, so it is a code
// constant and not a catalog entry. It is duplicated in `app/main.js` (Help ▸
// Chip Hippo Support) because the two processes share no module; keep them in
// step. App Store Review Guideline 1.5 requires the APP to carry a contact
// route, not merely the store listing's Support URL — which is why this is
// here at all, and why it is TEXT as well as a link: a machine with no mail
// client configured must still be able to read the address off the card.
const SUPPORT_EMAIL = "hippoherd@gmail.com";

/** A small "i" glyph for the info toggle (the button supplies the circle). */
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

    const infoBtn = buildInfoButton({
      target: build,
      label: t("about.versionInfo"),
    });

    const element = el(
      "div",
      {
        class: "popup about-dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": t("app.about"),
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
        el("p", { class: "about-subtitle", text: t("about.subtitle") }),
        el("p", { class: "about-desc", text: t("about.description") }),
        // `target="_blank"` is what routes the click to the OS mail client:
        // main's setWindowOpenHandler passes a mailto: window-open to
        // shell.openExternal, where a bare in-frame navigation would try to
        // move the desk's own document.
        el("p", { class: "about-support" }, [
          el("span", {
            class: "about-support-label",
            text: t("about.support"),
          }),
          el("a", {
            class: "about-support-link",
            href: `mailto:${SUPPORT_EMAIL}`,
            target: "_blank",
            rel: "noopener noreferrer",
            text: SUPPORT_EMAIL,
          }),
        ]),
        // The copyright line is a legal notice, not prose — the same words in
        // every language, like the product name above it.
        el("p", {
          class: "about-credit",
          text: "Copyright © 2026 Jason Figge",
        }),
        el("button", {
          class: "about-close",
          type: "button",
          text: t("common.close"),
          onClick: () => PopupManager.close(),
          "data-autofocus": true,
        }),
      ],
    );

    // onClose fires only when THIS popup closes (not when a popup it was queued
    // behind closes), so the guard never resets while the dialog is still up.
    PopupManager.open({
      element,
      onMaskClick: () => PopupManager.close(),
      onClose: () => {
        AboutDialog.#open = false;
      },
    });

    AboutDialog.#fillDetails(build);
  }

  static async #fillDetails(build) {
    let info = null;
    try {
      info = await window.chiphippo?.getAppInfo?.();
    } catch {
      /* dev build without the bridge — show version-less */
    }
    // Electron / Chromium / Node / Platform are product names, so only the row
    // LABEL "Version" is catalog text.
    const rows = info
      ? [
          [t("about.version"), info.version],
          ["Electron", info.electron],
          ["Chromium", info.chrome],
          ["Node", info.node],
          [t("about.platform"), info.platform],
        ]
      : [[t("about.version"), t("about.devBuild")]];
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
