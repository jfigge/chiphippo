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

// settings-gallery-panel.js — Settings ▸ Gallery (the gallery work, behind
// the `gallery` feature flag; the plan's D8). Two answers, both the user's:
//
//   · Gallery access — Yes | No (`galleryAccess`): may the desktop app read
//     chiphippo.com/gallery at all. Asked once, by the first Browse Gallery…;
//     changed here. Main reads it before every gallery request. Absent
//     (never asked) shows as No — nothing is fetched until it is Yes.
//   · Share consent — Yes | No | Ask (`galleryShare`, default Ask): whether
//     sharing a design shows its consent card each time, a one-line note, or
//     is switched off. (Sharing itself arrives later; the answer is kept now
//     so there is one place for both.)
//
// The web build is on the gallery's own site and never asks for access, so
// there the access row is left out.

import { t } from "../i18n.js";
import { buildSegmented } from "./segmented-picker.js";

/** The stored answers, read as the panel shows them. */
export function galleryAnswers(settings = {}) {
  return {
    access: settings.galleryAccess === "yes" ? "yes" : "no",
    share: ["yes", "no", "ask"].includes(settings.galleryShare)
      ? settings.galleryShare
      : "ask",
  };
}

/**
 * The panel's rows.
 * @param {object} settings
 * @param {(patch: object) => void} emit
 * @param {{rowWithNote: Function, web?: boolean}} helpers
 * @returns {{rows: HTMLElement[]}}
 */
export function buildGalleryPanel(
  settings,
  emit,
  { rowWithNote, web = false },
) {
  const answers = galleryAnswers(settings);
  const access = buildSegmented({
    options: [
      { value: "yes", label: t("settings.gallery.yes") },
      { value: "no", label: t("settings.gallery.no") },
    ],
    value: answers.access,
    ariaLabel: t("settings.gallery.access"),
    onPick: (galleryAccess) => emit({ galleryAccess }),
  });
  const share = buildSegmented({
    options: [
      { value: "yes", label: t("settings.gallery.yes") },
      { value: "no", label: t("settings.gallery.no") },
      { value: "ask", label: t("settings.gallery.ask") },
    ],
    value: answers.share,
    ariaLabel: t("settings.gallery.share"),
    onPick: (galleryShare) => emit({ galleryShare }),
  });
  return {
    rows: [
      !web &&
        rowWithNote({
          label: t("settings.gallery.access"),
          control: access,
          notes: [t("settings.gallery.accessHint")],
        }),
      rowWithNote({
        label: t("settings.gallery.share"),
        control: share,
        notes: [t("settings.gallery.shareHint")],
      }),
    ].filter(Boolean),
  };
}
