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
//     chiphippo.com/gallery at all. Asked once, by the first visit to Browse's Gallery tab;
//     changed here. Main reads it before every gallery request. Absent
//     (never asked) shows as No — nothing is fetched until it is Yes.
//   · Share consent — Yes | No | Ask (`galleryShare`, default Ask): whether
//     sharing a design shows its consent card each time, a one-line note, or
//     is switched off.
//   · Your shares — what was shared from here (`galleryShares`, kept by
//     gallery-share.js `rememberShare`) and what became of each: Check status
//     asks the service (main's `gallery:share-status`), one share at a time,
//     only when pressed, and keeps the answers — waiting, accepted, not
//     accepted, and the reviewer's note, shown as plain text. A share's ×
//     takes it off the list, and only the list.
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
  { rowWithNote, web = false, shareStatus = null, storedShares = null },
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
      ...buildShares(settings, emit, { rowWithNote, shareStatus, storedShares }), // prettier-ignore
    ].filter(Boolean),
  };
}

/**
 * One share's line: title, when, what became of it, the reviewer's note, and
 * a × that takes it off this list (only the list — the share itself stays
 * where it is, in review or in the gallery).
 */
function shareItem(entry, onRemove) {
  const status = STATUSES.includes(entry.status) ? entry.status : "waiting";
  const date = new Date(`${entry.at}T00:00:00`);
  const when = Number.isNaN(date.getTime()) ? "" : t("settings.gallery.sharedOn", { date: formatDate(date, { dateStyle: "medium" }) }); // prettier-ignore
  return el(
    "li",
    { class: "settings-gallery-share" },
    [
      // One line, as the rows above it are: the name and its date on the
      // left, in line with the labels, and what became of it on the right
      // edge the controls end at (the × waits beside it until hovered).
      el("div", { class: "settings-gallery-share-head" }, [
        el("span", {
          class: "settings-gallery-share-title",
          text: entry.title,
        }),
        when &&
          el("span", { class: "settings-gallery-share-when", text: when }),
        el("button", {
          class: "settings-gallery-share-remove",
          type: "button",
          title: t("settings.gallery.remove", { title: entry.title }),
          "aria-label": t("settings.gallery.remove", { title: entry.title }),
          text: "×",
          onClick: () => onRemove(entry),
        }),
        el("span", {
          class: `settings-gallery-share-status settings-gallery-share-status--${status === "notFound" ? "not-found" : status}`, // prettier-ignore
          text: t(`settings.gallery.status.${status}`),
        }),
      ]),
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
function buildShares(
  settings,
  emit,
  { rowWithNote, shareStatus, storedShares },
) {
  let shares = keptShares(settings);
  const removedHere = new Set();
  const list = el("ul", { class: "settings-gallery-shares" });
  const problem = el("p", { class: "settings-gallery-shares-problem", role: "alert", hidden: true }); // prettier-ignore
  let checking = false;
  const remove = (entry) => {
    removedHere.add(entry.id);
    shares = shares.filter((s) => s.id !== entry.id);
    draw();
    if (!checking) check.disabled = !shares.length || !shareStatus;
    emit({ galleryShares: shares });
  };
  const draw = () => {
    list.replaceChildren(
      ...(shares.length
        ? shares.map((entry) => shareItem(entry, remove))
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
    checking = true;
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
    // The answers go into the list AS IT IS STORED NOW, by id: a check can
    // outlive the card (Settings closed mid-check), and a share made
    // meanwhile must not be written over by the copy the panel began with.
    // A share removed while the check ran stays removed. An answer replaces
    // only the share it was ASKED about (its PR number too): declined, the
    // same design shared again has the same id and a new PR, and the old
    // answer must not write over it.
    const answered = new Map(next.map((e) => [`${e.id}#${e.number}`, e]));
    let stored = null;
    try {
      stored = storedShares ? await storedShares() : null;
    } catch {
      stored = null;
    }
    shares = (stored ?? shares)
      .filter((s) => !removedHere.has(s.id))
      .map((s) => answered.get(`${s.id}#${s.number}`) ?? s);
    draw();
    emit({ galleryShares: shares });
    if (failed) {
      problem.textContent = t("settings.gallery.checkFailed");
      problem.hidden = false;
    }
    check.textContent = t("settings.gallery.check");
    checking = false;
    check.disabled = !shares.length;
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
