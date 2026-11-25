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

// share-to.js — Desktop ▸ Share To… (and a tab's menu): ONE card for both
// ways a desktop leaves this desk, Public (the gallery, gallery-share.js) or
// Private (one of this computer's stores, store-save.js), chosen with a
// switch at its top — the segmented picker the Settings rows use. The switch
// is what turns the Store picker on.
//
//   · NOTHING above the footer's notes moves when the switch flips (Jason,
//     2026-11-23): the top row is the switch and the Store picker (greyed
//     while Public is on), then Save as for a desktop opened from a store
//     (likewise), then Title, Your name, Description and Tags — ONE set of
//     fields (gallery-share.js `buildEntryFields`), so switching keeps what
//     was typed. A new version shows the design's own title, words and tags,
//     greyed, and asks only Your name (and What changed?, below Tags).
//   · Below the fields each side says its own things: Public the check and
//     the consent notice, Private the store's privacy line.
//   · Public with Share consent "No", or Private with no store yet, greys the
//     fields, says why below them, and its button opens Settings ▸ Gallery.
//   · The side it opens on: Private for a desktop opened from a store (its
//     next save is most likely a new version there), else the side last shown
//     here or in Settings ▸ Gallery (`galleryTabShown`) — one answer for both.
//   · While a share or a save is on its way the switch is off, so the press
//     that closes the card is always the side on screen.
//   · Without the private stores (the web build) it is Share to Gallery's own
//     card, as it always was.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import {
  buildEntryFields,
  buildGalleryShare,
  buildGalleryShareOff,
  cancelButton,
  shareToGallery,
} from "./gallery-share.js";
import { buildSegmented } from "./segmented-picker.js";
import { galleryTabShown, preferGalleryTab } from "./settings-gallery-panel.js";
import {
  buildStoreSave,
  buildStoreSaveEmpty,
  loadStoreSave,
} from "./store-save.js";

/**
 * Open Share To… for one desktop.
 * @param {object} deps - what gallery-share.js `shareToGallery` and
 *   store-save.js `buildStoreSave` take, plus:
 * @param {boolean} deps.privateEnabled - the private stores are here (the
 *   desktop app); false → Share to Gallery's card alone.
 * @param {() => Promise<string|null>} [deps.takePicture] - a capture token.
 * @returns {Promise<{public: string|null,
 *   private: {entry: string, rev: string}|null}>} what was sent or saved.
 */
export async function shareTo(deps) {
  if (!deps.desktop) return { public: null, private: null };
  if (!deps.privateEnabled) {
    return { public: await shareToGallery(deps), private: null };
  }
  const loaded = await loadStoreSave(deps);

  return new Promise((resolve) => {
    const linked = Boolean(deps.storeFrom) && loaded.stores.some((s) => s.id === deps.storeFrom.store); // prettier-ignore
    let mode = linked ? "private" : galleryTabShown();
    let picker = null;
    const onBusy = (busy) => {
      for (const b of picker?.querySelectorAll("button") ?? []) b.disabled = busy; // prettier-ignore
    };
    const fields = buildEntryFields(deps);
    const sides = {
      public:
        deps.settings().galleryShare === "no"
          ? buildGalleryShareOff(deps)
          : buildGalleryShare(deps, { fields, onBusy }),
      private: loaded.stores.length
        ? buildStoreSave(deps, { ...loaded, fields, onBusy, active: () => mode === "private" }) // prettier-ignore
        : buildStoreSaveEmpty(deps),
    };
    const box = (nodes) => el("div", { class: "share-to-side" }, nodes ?? []);
    const afters = { public: box(sides.public.after), private: box(sides.private.after) }; // prettier-ignore
    const sends = { public: box([sides.public.send]), private: box([sides.private.send]) }; // prettier-ignore
    const inputs = [fields.title, fields.author, fields.description, fields.tags]; // prettier-ignore

    const show = (next) => {
      mode = next;
      preferGalleryTab(next);
      // Both sides' notes (and buttons) share one cell, the side not on
      // only invisible and inert — so the card is as tall (and the footer
      // as wide) on either side, and nothing on it moves when it flips.
      for (const k of ["public", "private"]) {
        for (const b of [afters[k], sends[k]]) {
          b.classList.toggle("share-to-side--off", k !== next);
          b.inert = k !== next;
        }
      }
      // The fields stand where they are whichever side is on; a side that
      // cannot share (consent No, no store yet) greys them instead.
      for (const f of inputs) f.disabled = false;
      // Private first: leaving a new version puts the typed values back, and
      // Public must then judge THOSE, not the entry's (setting `.value` in
      // code fires no input event to make it look again).
      sides.private.refresh();
      sides.public.refresh();
      if (!sides[next].usesFields) for (const f of inputs) f.disabled = true;
    };
    picker = buildSegmented({
      options: ["public", "private"].map((value) => ({ value, label: t(`settings.gallery.tab.${value}`) })), // prettier-ignore
      value: mode,
      ariaLabel: t("gallery.shareTo.where"),
      className: "share-to-switch",
      onPick: show,
    });
    // Opened on a new version, the title is not asked: the first stop is
    // the name.
    if (linked) {
      fields.title.removeAttribute("data-autofocus");
      fields.author.setAttribute("data-autofocus", "");
    }
    show(mode);
    PopupManager.dialog({
      title: t("gallery.shareTo.title"),
      className: "gallery-share-popup share-to-popup",
      body: [
        // The top row: the switch, and the store it would save to — greyed
        // while Public is on. Then Save as, for a desktop from a store.
        el("div", { class: "share-to-where" }, [
          picker,
          el("label", { class: "share-to-store" }, [
            el("span", { class: "popup-label", text: t("stores.save.store") }),
            sides.private.store,
          ]),
        ]),
        sides.private.modes,
        ...fields.list,
        el("div", { class: "share-to-stack" }, [afters.public, afters.private]), // prettier-ignore
        el("div", { class: "gallery-share-footer" }, [
          cancelButton(),
          el("div", { class: "share-to-stack share-to-stack--send" }, [sends.public, sends.private]), // prettier-ignore
        ]),
      ].filter(Boolean),
      onClose: () =>
        resolve({
          public: sides.public.closed(),
          private: sides.private.closed(),
        }),
    });
  });
}
