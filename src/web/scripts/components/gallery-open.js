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

// gallery-open.js — the app window's half of the gallery (the gallery work):
// the Browse window's Gallery tab with its one-time access question, and the questions a
// gallery design is asked on its way onto the desk (ProjectWorkspace.openGalleryEntry's `prepare` and
// `chooseRevisions` hooks). A `chiphippo://gallery/<id>` link (Phase 4) asks
// the same access question (`galleryAccess`) before it opens the entry. Every question is a PopupManager card, settled
// on every way out, so an awaiting caller cannot hang.
//
//   · ACCESS (the plan's D8): the desktop app reads chiphippo.com only after
//     the user says yes, ONCE — the answer is stored (`galleryAccess`) and
//     never asked again; Settings ▸ Gallery changes it. The web build is on
//     the gallery's own site and never asks. Main checks the stored answer
//     on every request, so this card is the question, not the permission.
//   · COMPATIBILITY (D7): an entry validated on an OLDER release is loaded
//     here first (gallery/validate.js `loadCheck`, the validator's own
//     verdict); anything this build would drop is said before it lands.
//     (The report back to the gallery, and its trusted re-check, wait for
//     the Worker — Phase 5.)
//   · SPICE LITE: a design built for it, opened with the logic engine on,
//     offers to switch the engine.
//   · REVISIONS (Part 2b): a newer revision of a designed chip already here —
//     Update (the default, Jason 2026-10-31) or Keep both.

import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { compareVersions } from "../gallery/entry-format.js";
import { loadCheck } from "../gallery/validate.js";
import { deriveEntry } from "../gallery/derive.js";
import { normalizeCustomChips } from "../model/custom-chip.js";
import { normalizeSpiceConfig } from "../sim/spice/config.js";

/** A promise of what a `choose` card answers (null for every dismissal). */
const choose = (opts) =>
  new Promise((resolve) => PopupManager.choose({ ...opts, onChoose: resolve }));

/**
 * May the app read the gallery? The desktop app asks the ONE time it has
 * never been asked (D8), and a stored no answers with the way to Settings ▸
 * Gallery; the web build never asks. The Browse window's Gallery tab and a `chiphippo://`
 * link both come through here.
 * @param {{web: boolean, settings: () => object,
 *   saveSettings: (patch: object) => Promise<unknown>,
 *   openSettings: (tab: string) => void}} deps
 * @returns {Promise<boolean>}
 */
export async function galleryAccess({
  web,
  settings,
  saveSettings,
  openSettings,
}) {
  if (web) return true;
  const access = settings().galleryAccess;
  if (access === "yes") return true;
  if (access === "no") {
    const go = await choose({
      title: t("gallery.access.offTitle"),
      message: t("gallery.access.offMessage"),
      choices: [{ label: t("gallery.access.openSettings"), value: true }],
    });
    if (go) openSettings("gallery");
    return false;
  }
  const answer = await choose({
    title: t("gallery.access.title"),
    message: t("gallery.access.message"),
    note: t("gallery.access.note"),
    cancelLabel: t("gallery.access.notNow"),
    choices: [{ label: t("gallery.access.allow"), value: "yes" }],
  });
  // Asked ONCE (D8): "Not now" — or any other way out — is a no, kept, and
  // Settings ▸ Gallery is where it is changed.
  await saveSettings({ galleryAccess: answer === "yes" ? "yes" : "no" });
  return answer === "yes";
}

/**
 * The Browse window's GALLERY tab: ask for access first the one time it has
 * never been asked, then open (or bring forward) the window on that tab. What
 * the tab's own Allow… button relays here (`chiphippo:browse-ask-access`).
 * @param {{bridge: object} & Parameters<typeof galleryAccess>[0]} deps
 * @returns {Promise<boolean>} whether the window was opened.
 */
export async function browseGallery({ bridge, ...deps }) {
  if (!(await galleryAccess(deps))) return false;
  return Boolean(await bridge.gallery?.show?.("gallery"));
}

/** "3 parts, 2 wires" — what a load check found missing, in a line. */
export function droppedSummary(problems) {
  const counts = new Map();
  const add = (key, n) => counts.set(key, (counts.get(key) ?? 0) + n);
  for (const p of problems) {
    if (p.code === "unknownPart" || p.code === "missingChip")
      add("components", 1); // prettier-ignore
    else if (p.code === "brokenChip") add("brokenChips", 1);
    else if (p.code === "dropped") add(p.list, p.ids?.length ?? p.count ?? 0);
  }
  return [...counts]
    .filter(([, n]) => n > 0)
    .map(([key, n]) =>
      t(`gallery.compat.count.${COUNT_KEYS[key] ?? "other"}`, { count: n }),
    ) // prettier-ignore
    .join(", ");
}

/** The load check's lists, by the word each is counted in. */
const COUNT_KEYS = Object.freeze({
  components: "parts",
  wires: "wires",
  boards: "boards",
  buses: "buses",
  brokenChips: "brokenChips",
});

/**
 * The checks a gallery design is put through before it lands
 * (`openGalleryEntry`'s `prepare`): resolves false to leave it.
 * @param {{appVersion: () => Promise<string>, settings: () => object,
 *   saveSettings: (patch: object) => Promise<unknown>}} deps
 */
export function galleryPrepare({ appVersion, settings, saveSettings }) {
  return async (res) => {
    const chips = normalizeCustomChips(res.customChips);
    // D7: pinned to ANY other release → load it here first, and say what
    // this build would lose before it is on the desk. Newer counts as much
    // as older: the gallery pins every entry to the release it is published
    // from, so a user a release behind meets nothing BUT newer pins — and a
    // part added since is exactly what their build would silently drop.
    const version = await appVersion();
    if (res.pin && compareVersions(res.pin, version) !== 0) {
      const { problems } = loadCheck(res.doc, chips);
      if (problems.length) {
        const go = await choose({
          title: t("gallery.compat.title"),
          message: t("gallery.compat.message", {
            pin: res.pin,
            version,
            lost: droppedSummary(problems),
          }),
          note: t("gallery.compat.note"),
          choices: [{ label: t("gallery.compat.openAnyway"), value: true }],
        });
        if (!go) return false;
      }
    }
    // Built for Spice Lite, opened on the logic engine: offer the switch.
    const spice = normalizeSpiceConfig(settings().spiceLite);
    const needsSpice =
      res.engine === "spice" || deriveEntry(res.doc, chips).engine === "spice";
    if (needsSpice && !spice.enabled) {
      const answer = await choose({
        title: t("gallery.spice.title"),
        message: t("gallery.spice.message"),
        choices: [
          { label: t("gallery.spice.openOnly"), value: "open", class: "btn--secondary" }, // prettier-ignore
          { label: t("gallery.spice.turnOn"), value: "spice" },
        ],
      });
      if (answer == null) return false;
      if (answer === "spice") {
        await saveSettings({ spiceLite: { ...spice, enabled: true } });
      }
    }
    return true;
  };
}

/**
 * A newer revision of a designed chip already here (Part 2b): Update — the
 * default — or Keep both, asked once per chip. Any other way out keeps both:
 * the safe answer changes nothing already on a desk.
 * @returns {(asks: object[]) => Promise<Record<string, "update"|"keep">>}
 */
export function galleryRevisions() {
  return async (asks) => {
    const answers = {};
    for (const ask of asks) {
      // A confirm, not a choose: its CONFIRM button takes the focus, and
      // Update is the answer Enter should give.
      const update = await new Promise((resolve) =>
        PopupManager.confirm({
          title: t("gallery.revision.title", { name: ask.name }),
          message: t("gallery.revision.message", { name: ask.name, from: ask.from, to: ask.to }), // prettier-ignore
          note: t("gallery.revision.note"),
          confirmLabel: t("gallery.revision.update"),
          cancelLabel: t("gallery.revision.keep"),
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      );
      answers[ask.gcid] = update ? "update" : "keep";
    }
    return answers;
  };
}
