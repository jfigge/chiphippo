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

// store-save.js — the Private side of Desktop ▸ Share To… (share-to.js; the
// private stores work, .claude/rules/stores.md): one desktop saved to one of
// the private stores this computer has added — as a NEW DESIGN, or as the next version of the
// design the desktop was opened from (its tab's `storeFrom`).
//
//   · Which store: the one the desktop came from, else the last one saved to.
//   · A new version names the revision it was made FROM. If a friend saved
//     after that one, main refuses it as "behind" (ipc/stores.js), and the
//     card says whose save is newer and offers the two honest answers: open
//     theirs, or save this one alongside (a fork both of them will see).
//   · The design is judged first as Share to Gallery judges it
//     (gallery-share.js `checkDesign`): one that would not load whole, or
//     holds nothing, is not saved.
//   · The picture is taken BEFORE the card opens (a card would be in it) by
//     the caller, `takePicture`.
//
// A save that lands links the desktop to the revision it wrote, so the next
// save to the store follows on from it.

import { el } from "../dom.js";
import { formatDate, t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { checkEntryText } from "../gallery/entry-format.js";
import { MAX_NOTE } from "../stores/store-format.js";
import { buildEntryFields, checkDesign, designProblem, fieldProblem, parseTags } from "./gallery-share.js"; // prettier-ignore
import { storeError } from "./store-setup.js";
import { preferGalleryTab } from "./settings-gallery-panel.js";

/**
 * The Private pane's two awaits, done BEFORE the Share To card opens: this
 * computer's stores, and the board's picture (a card would be in it).
 * @param {{bridge: object, takePicture?: () => Promise<string|null>}} deps
 * @returns {Promise<{stores: object[], thumbToken: string|null}>}
 */
export async function loadStoreSave({
  bridge,
  takePicture = async () => null,
}) {
  const stores = (await bridge.stores.list().catch(() => null)) ?? [];
  const thumbToken = stores.length ? await takePicture().catch(() => null) : null; // prettier-ignore
  return { stores, thumbToken };
}

/**
 * No store on this computer yet: what the Private pane holds instead of the
 * form — and the way to Settings ▸ Gallery ▸ Private, where one is added.
 * @returns {{nodes: Node[], refresh: () => void, closed: () => null}}
 */
export function buildStoreSaveEmpty({ openSettings }) {
  return {
    usesFields: false,
    // Where the picker stands, greyed, so nothing moves.
    store: el("select", { class: "settings-select store-save-store", "aria-label": t("stores.save.store"), disabled: true }, [el("option", { text: t("stores.save.noStoreTitle") })]), // prettier-ignore
    modes: null,
    after: [el("p", { class: "popup-message", text: t("stores.save.noStore") })], // prettier-ignore
    send: el("button", {
      class: "btn popup-btn btn--primary",
      type: "button",
      text: t("gallery.access.openSettings"),
      onClick: () => {
        PopupManager.close();
        preferGalleryTab("private");
        openSettings("gallery");
      },
    }),
    refresh: () => {},
    closed: () => null,
  };
}

/**
 * The Private half of Desktop ▸ Share To… (share-to.js): one desktop saved
 * to one of this computer's stores — its Store picker and Save as (on the
 * card's top row, greyed while Public is on), what it adds after the four
 * fields (What changed?, the verdict, "someone saved first") and its Save
 * button. A save that lands closes the card.
 * @param {object} deps
 * @param {object} deps.bridge - window.chiphippo.
 * @param {string} deps.tabId
 * @param {object} deps.desktop - `ProjectWorkspace.portableDesktop`.
 * @param {object|null} deps.storeFrom - the tab's link to a revision.
 * @param {(tabId: string, from: object) => void} deps.setStoreFrom
 * @param {(ref: object) => void} deps.openRevision - open a store revision.
 * @param {() => object} deps.settings
 * @param {(patch: object) => unknown} deps.saveSettings
 * @param {() => boolean} deps.isRunning
 * @param {{stores: object[], thumbToken: string|null, fields?: object,
 *   active?: () => boolean, onBusy?: (busy: boolean) => void}} loaded -
 *   `loadStoreSave`'s answer (at least one store); the four fields
 *   (gallery-share.js `buildEntryFields`, made here when not handed in);
 *   whether the card is on this side (only then does a new version hide
 *   Title, Description and Tags); who is told while a save is on its way.
 * @returns {{usesFields: true, fields: object, store: HTMLSelectElement,
 *   modes: HTMLElement|null, after: Node[],
 *   send: HTMLElement, refresh: () => void,
 *   closed: () => {entry: string, rev: string}|null}} `closed` is the
 *   card's onClose: it says a save that landed, and answers what it wrote.
 */
export function buildStoreSave(
  deps,
  {
    stores,
    thumbToken,
    fields = buildEntryFields(deps),
    active = () => true,
    onBusy = () => {},
  },
) {
  // prettier-ignore
  const { bridge, tabId, desktop, storeFrom, setStoreFrom, openRevision, settings, saveSettings, isRunning } = deps; // prettier-ignore
  const { title, author, description, tags } = fields;
  const say = (key, params) => t(`stores.save.${key}`, params);
  const check = checkDesign(desktop);
  const designSays = designProblem(check);
  const running = isRunning();
  const linked = storeFrom && stores.some((s) => s.id === storeFrom.store) ? storeFrom : null; // prettier-ignore
  const last = settings().storeLast;
  const firstStore = linked?.store ?? (stores.some((s) => s.id === last) ? last : stores[0].id); // prettier-ignore

  let saved = null;
  let saving = false;
  /** The card was closed (Cancel, ×, Escape) — a save already on its way
      still lands, and is still said, but closes nothing else. */
  let closed = false;
  /** While the linked entry is being read: the card cannot yet say whether
      this is a new version, so it does not save at all (a press now would
      quietly make a second design). */
  let reading = Boolean(linked);
  /** What the linked entry is, once read: `{title, head}` or null. */
  let linkedEntry = null;
  /** The linked entry could not be read (`linkNote` says so). */
  let linkLost = false;
  const linkNote = el("p", { class: "gallery-share-verdict", role: "status", hidden: true }); // prettier-ignore

  const field = (labelKey, control) =>
    el("label", { class: "gallery-share-field" }, [el("span", { class: "popup-label", text: t(labelKey) }), control]); // prettier-ignore
  const storePick = el(
    "select",
    { class: "settings-select store-save-store", "aria-label": say("store") },
    stores.map((s) => el("option", { value: s.id, text: s.name, selected: s.id === firstStore })), // prettier-ignore
  );
  const modeVersion = el("input", { type: "radio", name: "store-save-mode", value: "version", checked: Boolean(linked) }); // prettier-ignore
  const modeNew = el("input", { type: "radio", name: "store-save-mode", value: "new", checked: !linked }); // prettier-ignore
  const versionLabel = el("span", { text: say("asVersion", { title: "…" }) });
  const modes = !linked
    ? null
    : el("fieldset", { class: "store-save-modes" }, [
        el("legend", { class: "popup-label", text: say("saveAs") }),
        el("label", { class: "store-save-mode" }, [modeVersion, versionLabel]),
        el("label", { class: "store-save-mode" }, [modeNew, el("span", { text: say("asNew") })]), // prettier-ignore
      ]);
  const note = el("textarea", { class: "properties-textarea", rows: 2, maxLength: MAX_NOTE, placeholder: say("notePlaceholder") }); // prettier-ignore
  const noteField = field("stores.save.noteLabel", note);
  const fieldNote = el("p", { class: "gallery-share-problem", "aria-live": "polite", hidden: true }); // prettier-ignore
  const failure = el("p", { class: "gallery-share-problem", role: "alert", hidden: true }); // prettier-ignore
  const behind = el("div", { class: "store-save-behind", role: "alert", hidden: true }); // prettier-ignore
  const storeNameNow = () => stores.find((s) => s.id === storePick.value)?.name ?? ""; // prettier-ignore
  let told = false;
  /** "Saved to …", once — after the card is gone. */
  const tellSaved = () => {
    if (told) return;
    told = true;
    PopupManager.notify({ title: say("savedTitle"), message: say("saved", { store: storeNameNow() }) }); // prettier-ignore
  };
  const send = el("button", { class: "btn popup-btn btn--primary", type: "button", text: say("save") }); // prettier-ignore

  const asVersion = () => Boolean(linked) && storePick.value === linked.store && modeVersion.checked && Boolean(linkedEntry); // prettier-ignore
  const entryFields = () =>
    checkEntryText({
      title: asVersion() ? linkedEntry.title : title.value,
      author: author.value,
      description: asVersion() ? "" : description.value,
      tags: asVersion() ? [] : parseTags(tags.value),
    });
  /** The fields' own values while a new version shows the design's instead
      (null when it doesn't): put back when it stops. */
  let typed = null;
  const keptFields = [title, description, tags];
  const refresh = () => {
    // The Store picker and Save as are there on both sides — nothing moves
    // when the switch flips — but only the Private side can use them.
    storePick.disabled = !active() || saving;
    modeNew.disabled = !active() || saving;
    modeVersion.disabled = !active() || saving || !linkedEntry || storePick.value !== linked?.store; // prettier-ignore
    // A new version keeps the design's title, words and tags: they show,
    // greyed, and only your name (and what changed) is asked.
    const version = active() && asVersion();
    if (version && !typed) {
      typed = keptFields.map((f) => f.value);
      title.value = linkedEntry.title ?? "";
      description.value = linkedEntry.description ?? "";
      tags.value = (linkedEntry.tags ?? []).join(", ");
      for (const f of keptFields) f.disabled = true;
    } else if (!version && typed) {
      keptFields.forEach((f, i) => {
        f.value = typed[i];
        f.disabled = false;
      });
      typed = null;
    }
    // Greyed for as long as it shows — however often the side is shown
    // again (a press on the switch's side already on re-enables the fields).
    if (version) for (const f of keptFields) f.disabled = true;
    // The link that could not be read is said whenever its own store is the
    // one picked — also when the pick moved away and back while it was read.
    if (linked) linkNote.hidden = !(linkLost && storePick.value === linked.store); // prettier-ignore
    noteField.hidden = !asVersion();
    const says = fieldProblem(entryFields().problems);
    fieldNote.textContent = says ?? "";
    fieldNote.hidden = !says;
    send.disabled = saving || reading || running || Boolean(designSays) || Boolean(says); // prettier-ignore
  };
  for (const input of [title, author, description, tags, note]) input.addEventListener("input", refresh); // prettier-ignore
  for (const input of [storePick, modeVersion, modeNew]) input.addEventListener("change", refresh); // prettier-ignore
  // Save as follows the store: another store can only take a new design,
  // and coming back to the desktop's own store offers its next version again.
  if (linked) {
    storePick.addEventListener("change", () => {
      (storePick.value === linked.store && !linkLost ? modeVersion : modeNew).checked = true; // prettier-ignore
      refresh();
    });
  }
  // A "someone saved first" answer is about the store and mode it was
  // given for: choosing another puts it away and brings Save back.
  for (const input of [storePick, modeVersion, modeNew]) {
    input.addEventListener("change", () => {
      if (behind.hidden) return;
      behind.hidden = true;
      send.hidden = false;
      refresh();
    });
  }

  // The linked entry's title and newest revision, read from its store.
  // Not found (offline, not synced yet, or gone), the card SAYS so: it
  // will be a new design, not quietly.
  if (linked) {
    void bridge.stores
      .view(linked.store)
      .catch(() => null)
      .then((res) => {
        reading = false;
        const entry = res?.ok ? res.entries.find((e) => e.id === linked.entry) : null; // prettier-ignore
        if (entry) {
          linkedEntry = entry;
          versionLabel.textContent = say("asVersion", { title: entry.title });
        } else {
          linkLost = true;
          // It WILL be a new design: Save as says so, not a greyed tick on
          // a version that cannot be made.
          modeNew.checked = true;
          linkNote.textContent = say("linkLost");
        }
        if (!closed) refresh();
      });
  }

  const save = async ({ fork = false } = {}) => {
    const { value, problems } = entryFields();
    if (problems.length || saving) return;
    saving = true;
    onBusy(true);
    failure.hidden = true;
    // A fork keeps its panel up (its buttons waiting) until it lands, so a
    // fork that fails can be pressed again — the card never ends up with
    // nothing to press but Cancel.
    if (!fork) behind.hidden = true;
    for (const b of behind.querySelectorAll("button")) b.disabled = true;
    send.textContent = say("saving");
    refresh();
    const version = asVersion();
    let res;
    try {
      res = await bridge.stores.save({
        id: storePick.value,
        entry: version ? linked.entry : null,
        base: version ? linked.rev : null,
        fork,
        fields: value,
        note: version ? note.value : "",
        desktop: { doc: desktop.doc, customChips: desktop.customChips },
        derived: check.derived ?? null,
        thumbToken,
      });
    } catch (err) {
      console.error("[stores] the save failed:", err);
      res = { ok: false, code: "unavailable" };
    }
    saving = false;
    onBusy(false);
    send.textContent = say("save");
    if (res?.ok) {
      saved = { entry: res.entry, rev: res.rev };
      setStoreFrom(tabId, { store: storePick.value, entry: res.entry, rev: res.rev }); // prettier-ignore
      void saveSettings({ galleryAuthor: value.author, storeLast: storePick.value }); // prettier-ignore
      // Closed while it was on its way: said now, and nothing else closed.
      if (closed) tellSaved();
      else PopupManager.close();
      return;
    }
    // Closed while it was on its way and it did NOT land: said too — the
    // card is gone, and silence would read as saved.
    if (closed) {
      PopupManager.notify({ title: say("notSavedTitle"), message: say("notSaved", { store: storeNameNow(), why: storeError(res?.code) }) }); // prettier-ignore
      return;
    }
    if (res?.code === "behind") {
      const when = res.head?.at ? formatDate(Date.parse(res.head.at), { dateStyle: "medium", timeStyle: "short" }) : ""; // prettier-ignore
      const theirs = el("button", {
        class: "btn popup-btn btn--secondary",
        type: "button",
        text: say("openTheirs"),
        onClick: () => {
          PopupManager.close();
          // No head named (an older main): the entry's newest is "theirs".
          openRevision({ store: linked.store, entry: linked.entry, rev: res.head?.rev ?? linkedEntry?.head?.rev ?? linked.rev }); // prettier-ignore
        },
      });
      behind.replaceChildren(
        el("p", { class: "store-setup-text", text: say("behind", { who: res.head?.author || t("stores.browse.someone"), when }) }), // prettier-ignore
        el("div", { class: "store-setup-footer" }, [
          theirs,
          el("button", { class: "btn popup-btn btn--primary", type: "button", text: say("saveAlongside"), onClick: () => void save({ fork: true }) }), // prettier-ignore
        ]),
      );
      behind.hidden = false;
      // The choice is the card's now: Save steps aside, and focus (and a
      // screen reader) goes to it.
      send.hidden = true;
      theirs.focus();
      refresh();
      return;
    }
    for (const b of behind.querySelectorAll("button")) b.disabled = false;
    // Save is back for a plain save that failed; a failed fork leaves the
    // "behind" choice standing instead.
    if (!fork) send.hidden = false;
    failure.textContent = storeError(res?.code);
    failure.hidden = false;
    refresh();
  };
  send.addEventListener("click", () => void save());

  return {
    usesFields: true,
    fields,
    store: storePick,
    modes,
    after: [
      noteField,
      fieldNote,
      designSays
        ? el("p", { class: "gallery-share-verdict gallery-share-verdict--bad", text: designSays }) // prettier-ignore
        : el("p", { class: "gallery-share-verdict", text: say("private") }),
      linkNote,
      running && el("p", { class: "gallery-share-problem", text: say("running") }), // prettier-ignore
      behind,
      failure,
    ].filter(Boolean),
    send,
    refresh,
    closed: () => {
      closed = true;
      if (saved) tellSaved();
      return saved;
    },
  };
}
