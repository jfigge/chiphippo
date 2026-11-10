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

// gallery-share.js — Desktop ▸ Share to Gallery… (the gallery work, Phase 5;
// the desktop app and the web build). One card: the four fields a sharer
// writes, what the gallery's validator makes of the design, what will be
// published and who sees what — then Share publicly, the ONE press that sends
// anything (main.js `shareToGallery`). A share that goes is remembered in
// `galleryShares` (`rememberShare`) for Settings ▸ Gallery ▸ Your shares.
//
//   · Share consent (Settings ▸ Gallery, D8): "ask" shows the whole consent
//     block every time, "yes" one line saying the same, "no" puts Share off —
//     a card pointing at Settings ▸ Gallery instead of this one.
//   · The design is judged BEFORE anything is asked (gallery/validate.js, the
//     gallery's own check): a desktop that would not load whole, or holds
//     nothing, cannot be shared, and the card says why. The document is the
//     live one, already this build's version, so it needs no migration (the
//     identity stands in for main's). ROM bytes stay in main, which holds the
//     finished snapshot to the size cap itself.
//   · Off while the circuit runs, as Duplicate is.
//   · Sent is not published: the card that follows says it is waiting for
//     review.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import {
  MAX_AUTHOR,
  MAX_DESCRIPTION,
  MAX_TITLE,
  checkEntryText,
} from "../gallery/entry-format.js";
import { validateSubmission } from "../gallery/validate.js";
import { droppedSummary } from "./gallery-open.js";

/** The codes main and the service answer with that the card has words for. */
const ERROR_CODES = Object.freeze([
  "invalid",
  "tooBig",
  "romTooBig",
  "wording",
  "duplicate",
  "rateLimited",
  "busy",
  "dailyLimit",
  "refused",
  "unavailable",
]);

/** The most shares Settings ▸ Gallery ▸ Your shares keeps, newest first. */
export const MAX_SHARES = 50;

/**
 * The `galleryShares` list with one more share at its head: what the service
 * answered (`id`, and `number` + `key` to ask after it later), its title, and
 * when — a share the service gave no key for (an older service) is not kept,
 * since nothing could be asked about it.
 * @returns {object[]}
 */
export function rememberShare(list, { id, number, key, title, at }) {
  const kept = Array.isArray(list) ? list.filter((s) => s?.id !== id) : [];
  if (!Number.isInteger(number) || typeof key !== "string") return kept;
  return [{ id, number, key, title, at, status: "waiting", note: "" }, ...kept].slice(0, MAX_SHARES); // prettier-ignore
}

/** "555, LED flasher" → ["555", "led-flasher"]: tags are comma-separated. */
export function parseTags(text) {
  return String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * What the gallery would make of this desktop: `{ok, problems, derived}`.
 * @param {{name: string, description: string, doc: object,
 *   customChips: object[]}} desktop - `ProjectWorkspace.portableDesktop`.
 */
export function checkDesign(desktop) {
  const text = JSON.stringify({ kind: "desktop", ...desktop });
  // The live document is already this build's: no migration to run.
  const { ok, problems, derived } = validateSubmission(text, { migrate: (doc) => doc }); // prettier-ignore
  return { ok, problems, derived };
}

/** The design's verdict in a sentence, or null when it can be shared. */
export function designProblem(check) {
  if (check.ok) return null;
  if (check.problems.some((p) => p.code === "empty")) return t("gallery.share.design.empty"); // prettier-ignore
  const lost = droppedSummary(check.problems);
  return lost
    ? t("gallery.share.design.lost", { lost })
    : t("gallery.share.design.other");
}

/** The first problem with the four fields, in a sentence, or null. */
export function fieldProblem(problems) {
  const p = problems[0];
  return p ? t(`gallery.share.field.${p.code}`, p) : null;
}

/**
 * Open Share to Gallery for one desktop.
 * @param {object} deps
 * @param {object} deps.bridge - window.chiphippo.
 * @param {object|null} deps.desktop - `ProjectWorkspace.portableDesktop(id)`.
 * @param {() => object} deps.settings
 * @param {(patch: object) => Promise<unknown>} deps.saveSettings
 * @param {(tab: string) => void} deps.openSettings
 * @param {() => boolean} deps.isRunning
 * @returns {Promise<string|null>} the entry id it was sent as, or null.
 */
export async function shareToGallery({
  bridge,
  desktop,
  settings,
  saveSettings,
  openSettings,
  isRunning,
}) {
  if (!desktop) return null;
  const consent = settings().galleryShare;
  if (consent === "no") {
    const go = await new Promise((resolve) =>
      PopupManager.choose({
        title: t("gallery.share.offTitle"),
        message: t("gallery.share.offMessage"),
        choices: [{ label: t("gallery.access.openSettings"), value: true }],
        onChoose: resolve,
      }),
    );
    if (go) openSettings("gallery");
    return null;
  }

  const check = checkDesign(desktop);
  const designSays = designProblem(check);
  const running = isRunning();

  return new Promise((resolve) => {
    let sentAs = null;
    let sending = false;
    let closed = false;
    const tellSent = (title) =>
      PopupManager.notify({
        title: t("gallery.share.sentTitle"),
        message: t("gallery.share.sentMessage", { title }),
      });
    const field = (labelKey, control) =>
      el("label", { class: "gallery-share-field" }, [
        el("span", { class: "popup-label", text: t(labelKey) }),
        control,
      ]);
    const title = el("input", {
      class: "properties-text-input",
      type: "text",
      value: desktop.name ?? "",
      maxLength: MAX_TITLE,
      "data-autofocus": true,
    });
    const author = el("input", {
      class: "properties-text-input",
      type: "text",
      value: settings().galleryAuthor ?? "",
      maxLength: MAX_AUTHOR,
      placeholder: t("gallery.share.authorPlaceholder"),
    });
    const description = el("textarea", {
      class: "properties-textarea",
      rows: 4,
      maxLength: MAX_DESCRIPTION,
    });
    description.value = desktop.description ?? "";
    const tags = el("input", {
      class: "properties-text-input",
      type: "text",
      placeholder: t("gallery.share.tagsPlaceholder"),
    });
    const fieldNote = el("p", { class: "gallery-share-problem", "aria-live": "polite" }); // prettier-ignore
    const failure = el("p", { class: "gallery-share-problem", role: "alert" });
    const send = el("button", {
      class: "btn popup-btn btn--primary",
      type: "button",
      text: t("gallery.share.send"),
    });

    const entry = () =>
      checkEntryText({
        title: title.value,
        author: author.value,
        description: description.value,
        tags: parseTags(tags.value),
      });
    const refresh = () => {
      const says = fieldProblem(entry().problems);
      fieldNote.textContent = says ?? "";
      fieldNote.hidden = !says;
      send.disabled = sending || running || Boolean(designSays) || Boolean(says); // prettier-ignore
    };
    for (const input of [title, author, description, tags]) {
      input.addEventListener("input", refresh);
    }

    send.addEventListener("click", async () => {
      const { value, problems } = entry();
      if (problems.length || sending) return;
      sending = true;
      failure.hidden = true;
      send.textContent = t("gallery.share.sending");
      refresh();
      // A call that THROWS (rather than answering a code) is "unavailable":
      // left to reject, it held the button on "Sending…" for good.
      let res;
      try {
        res = await bridge.gallery.share({ ...desktop, entry: value });
      } catch (err) {
        console.error("[gallery] the share could not be sent:", err);
        res = { ok: false, code: "unavailable" };
      }
      sending = false;
      // The name is remembered for next time, and the share in Settings ▸
      // Gallery ▸ Your shares, to ask after.
      const keep = () =>
        saveSettings({
          galleryAuthor: value.author,
          galleryShares: rememberShare(settings().galleryShares, {
            id: res.id,
            number: res.number,
            key: res.key,
            title: value.title,
            at: new Date().toISOString().slice(0, 10),
          }),
        });
      // Closed while it was on its way: a share that went still says so.
      if (closed) {
        if (res?.ok) {
          void keep();
          tellSent(value.title);
        }
        return;
      }
      send.textContent = t("gallery.share.send");
      if (res?.ok) {
        sentAs = { id: res.id, title: value.title };
        void keep();
        PopupManager.close();
        return;
      }
      const code = ERROR_CODES.includes(res?.code) ? res.code : "unavailable";
      failure.textContent = t(`gallery.share.error.${code}`);
      failure.hidden = false;
      refresh();
    });

    const facts = check.derived
      ? `${t("gallery.factChips", { count: check.derived.chips })} · ${t("gallery.factParts", { count: check.derived.parts })}` // prettier-ignore
      : "";
    const verdict = designSays
      ? el("p", { class: "gallery-share-verdict gallery-share-verdict--bad", text: designSays }) // prettier-ignore
      : el("p", { class: "gallery-share-verdict", text: t("gallery.share.design.ok", { facts }) }); // prettier-ignore
    const consentBlock =
      consent === "yes"
        ? el("p", { class: "gallery-share-consent", text: t("gallery.share.consentLine") }) // prettier-ignore
        : el("div", { class: "gallery-share-consent" }, [
            el("p", { class: "gallery-share-consent-title", text: t("gallery.share.consentTitle") }), // prettier-ignore
            el(
              "ul",
              { class: "gallery-share-consent-list" },
              ["public", "sent", "server", "review"].map((k) =>
                el("li", { text: t(`gallery.share.consent.${k}`) }),
              ),
            ),
          ]);

    fieldNote.hidden = true;
    failure.hidden = true;
    PopupManager.dialog({
      title: t("gallery.share.title"),
      className: "gallery-share-popup",
      body: [
        el("p", { class: "popup-message", text: t("gallery.share.intro") }),
        field("gallery.share.titleLabel", title),
        field("gallery.share.authorLabel", author),
        field("gallery.share.descriptionLabel", description),
        field("gallery.share.tagsLabel", tags),
        fieldNote,
        verdict,
        consentBlock,
        running &&
          el("p", { class: "gallery-share-problem", text: t("gallery.share.running") }), // prettier-ignore
        failure,
        el("div", { class: "gallery-share-footer" }, [
          el("button", {
            class: "btn popup-btn btn--secondary",
            type: "button",
            text: t("common.cancel"),
            onClick: () => PopupManager.close(),
          }),
          send,
        ]),
      ].filter(Boolean),
      onClose: () => {
        closed = true;
        if (sentAs) tellSent(sentAs.title);
        resolve(sentAs?.id ?? null);
      },
    });
    refresh();
  });
}
