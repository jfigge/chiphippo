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

// settings-gallery-panel.js — Settings ▸ Gallery (the gallery work; the
// plan's D8). Two answers, both the user's, and the list of shares:
//
//   · Gallery access — Yes | No (`galleryAccess`): may the desktop app read
//     chiphippo.com/gallery at all. Asked once, by the first Browse Gallery…;
//     changed here. Main reads it before every gallery request. Absent
//     (never asked) shows as No — nothing is fetched until it is Yes.
//   · Share consent — Yes | No | Ask (`galleryShare`, default Ask): whether
//     sharing a design shows its consent card each time, a one-line note, or
//     is switched off.
//   · Your shares — what was shared from here (`galleryShares`, kept by
//     gallery-share.js `rememberShare`) and what became of each: Check status
//     asks the service (main's `gallery:share-status`), one share at a time,
//     only when pressed, and keeps the answers — waiting, accepted, not
//     accepted, and the reviewer's note, shown as plain text.
//
// The web build is on the gallery's own site and never asks for access, so
// there the access row is left out.

import { el } from "../dom.js";
import { formatDate, t } from "../i18n.js";
import { buildSegmented } from "./segmented-picker.js";

/** The statuses a share can have, as the service says them. */
const STATUSES = Object.freeze(["waiting", "accepted", "declined", "notFound"]);

/** The kept shares, each held to its shape (the file is the user's to edit). */
export function keptShares(settings = {}) {
  const list = Array.isArray(settings.galleryShares) ? settings.galleryShares : []; // prettier-ignore
  return list.filter(
    (s) =>
      s &&
      typeof s.id === "string" &&
      typeof s.title === "string" &&
      Number.isInteger(s.number) &&
      typeof s.key === "string",
  );
}

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
 * @param {{rowWithNote: Function, web?: boolean,
 *   shareStatus?: (share: object) => Promise<object>}} helpers -
 *   `shareStatus` is the bridge's `gallery.shareStatus`.
 * @returns {{rows: HTMLElement[]}}
 */
export function buildGalleryPanel(
  settings,
  emit,
  { rowWithNote, web = false, shareStatus = null },
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
      ...buildShares(settings, emit, { rowWithNote, shareStatus }),
    ].filter(Boolean),
  };
}

/** One share's line: title, when, what became of it, and the reviewer's note. */
function shareItem(entry) {
  const status = STATUSES.includes(entry.status) ? entry.status : "waiting";
  const date = new Date(`${entry.at}T00:00:00`);
  const when = Number.isNaN(date.getTime()) ? "" : t("settings.gallery.sharedOn", { date: formatDate(date, { dateStyle: "medium" }) }); // prettier-ignore
  return el(
    "li",
    { class: "settings-gallery-share" },
    [
      el("div", { class: "settings-gallery-share-head" }, [
        el("span", {
          class: "settings-gallery-share-title",
          text: entry.title,
        }),
        el("span", {
          class: `settings-gallery-share-status settings-gallery-share-status--${status === "notFound" ? "not-found" : status}`, // prettier-ignore
          text: t(`settings.gallery.status.${status}`),
        }),
      ]),
      when && el("p", { class: "settings-gallery-share-when", text: when }),
      entry.note &&
        el("blockquote", { class: "settings-gallery-share-note" }, [
          el("span", { class: "settings-gallery-share-note-label", text: t("settings.gallery.note") }), // prettier-ignore
          // The reviewer's words as TEXT — never markup.
          el("p", { text: entry.note }),
        ]),
    ].filter(Boolean),
  );
}

/** Your shares: a row with Check status, and the list under it. */
function buildShares(settings, emit, { rowWithNote, shareStatus }) {
  let shares = keptShares(settings);
  const list = el("ul", { class: "settings-gallery-shares" });
  const problem = el("p", { class: "settings-gallery-shares-problem", role: "alert", hidden: true }); // prettier-ignore
  const draw = () => {
    list.replaceChildren(
      ...(shares.length
        ? shares.map(shareItem)
        : [el("li", { class: "settings-gallery-shares-empty", text: t("settings.gallery.sharesEmpty") })]), // prettier-ignore
    );
  };
  const check = el("button", {
    class: "settings-action",
    type: "button",
    text: t("settings.gallery.check"),
    disabled: !shares.length || !shareStatus,
  });
  check.addEventListener("click", async () => {
    check.disabled = true;
    check.textContent = t("settings.gallery.checking");
    problem.hidden = true;
    let failed = false;
    const next = [];
    // One at a time: a handful of small questions, and the service reuses
    // each answer for a few minutes.
    for (const entry of shares) {
      let res = null;
      try {
        res = await shareStatus({ id: entry.id, number: entry.number, key: entry.key }); // prettier-ignore
      } catch {
        res = null;
      }
      if (res?.ok)
        next.push({ ...entry, status: res.status, note: res.note ?? "" }); // prettier-ignore
      else if (res?.code === "notFound")
        next.push({ ...entry, status: "notFound", note: "" }); // prettier-ignore
      else {
        failed = true;
        next.push(entry);
      }
    }
    shares = next;
    draw();
    emit({ galleryShares: shares });
    if (failed) {
      problem.textContent = t("settings.gallery.checkFailed");
      problem.hidden = false;
    }
    check.textContent = t("settings.gallery.check");
    check.disabled = false;
  });
  draw();
  return [
    rowWithNote({
      label: t("settings.gallery.shares"),
      control: check,
      notes: [t("settings.gallery.sharesHint")],
    }),
    list,
    problem,
  ];
}
