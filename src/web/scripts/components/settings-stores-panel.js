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

// settings-stores-panel.js — Settings ▸ Gallery ▸ Private ▸ Private stores (the
// private stores work, .claude/rules/stores.md): the stores this computer has added,
// one row each — where it lives, Copy link (the one link a friend needs),
// Invite (a GitHub store), Show (the folder, or the repository), Browse,
// and a two-step Remove that forgets it HERE only — and Add store…, which
// draws the Add Store guide (store-setup.js) in the list's place, inside this
// card, since a card cannot open over Settings.
//
// The list is main's (ipc/stores.js — a folder store's path is an allowlist),
// so it is READ from the bridge and changed only through it; nothing here is
// in the settings patch the dialog emits.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import {
  inviteBlock,
  linkBox,
  mountStoreSetup,
  repoPath,
  storeError,
} from "./store-setup.js";

/** A store's "where" line: its cloud and folder, or its repository. */
export function storeWhere(store) {
  if (store.kind === "github") return t("stores.whereGitHub", { repo: repoPath(store.repo, store.dir) }); // prettier-ignore
  return t("stores.whereFolder", {
    app: t(`stores.setup.provider.${store.provider ?? "other"}`),
    path: store.path ?? "",
  });
}

/**
 * The panel's rows for the private stores.
 * @param {{rowWithNote: Function, bridge: object,
 *   onBrowse?: (store: object) => void}} opts
 * @returns {{rows: HTMLElement[], destroy: () => void}} `destroy` stops
 *   what the guide still has going (a GitHub sign-in waiting) when Settings
 *   closes.
 */
export function buildStoresRows({ rowWithNote, bridge, onBrowse = null }) {
  const api = bridge.stores;
  const box = el("div", { class: "settings-stores" });
  const add = el("button", {
    class: "settings-action",
    type: "button",
    text: t("stores.add"),
  });
  const account = el("div", { class: "settings-stores-account", hidden: true });
  let setup = null;

  /** Each list read's number: a slow one landing after the guide opened (or
      a newer read) is dropped. */
  let reads = 0;
  /** `focus`: the press that led here took its button away (Remove, Sign
      out, the guide's Done) — focus goes to Add Store…, never the page. */
  const showList = async ({ focus = false } = {}) => {
    setup?.destroy();
    setup = null;
    add.hidden = false;
    if (focus) add.focus();
    const read = ++reads;
    // A failed read draws an empty list rather than leaving the last one.
    const [stores, status] = await Promise.all([
      api.list().catch(() => []),
      api.status().catch(() => null),
    ]);
    if (read !== reads || setup) return;
    box.replaceChildren(
      stores.length
        ? el("ul", { class: "settings-stores-list" }, stores.map(storeItem))
        : el("p", { class: "settings-stores-empty", text: t("stores.empty") }),
    );
    drawAccount(status?.github);
  };

  const drawAccount = (github) => {
    account.hidden = !github?.signedIn;
    if (!github?.signedIn) return;
    account.replaceChildren(
      el("span", { class: "settings-stores-account-who", text: github.login ? t("stores.setup.github.signedInAs", { login: github.login }) : t("stores.setup.github.signedIn") }), // prettier-ignore
      el("button", {
        class: "store-setup-inline",
        type: "button",
        text: t("stores.signOut"),
        onClick: async () => {
          await api.githubSignOut().catch(() => false);
          void showList({ focus: true });
        },
      }),
    );
  };

  const showSetup = (ref = null) => {
    add.hidden = true;
    // Sign out is not offered while the guide is up (it would end the guide).
    account.hidden = true;
    reads += 1;
    const holder = el("div");
    box.replaceChildren(holder);
    setup = mountStoreSetup(holder, {
      bridge,
      ref,
      onClose: () => void showList({ focus: true }),
      onBrowse,
    });
  };

  /** One store's line, and what can be done with it. */
  function storeItem(store) {
    const extra = el("div", { class: "settings-store-extra", id: `settings-store-extra-${store.id}`, hidden: true }); // prettier-ignore
    let asked = 0;
    /** The buttons that open the panel below, each saying whether its own
        part of it is open (aria-expanded). */
    const togglers = {};
    const showExpanded = () => {
      for (const [what, b] of Object.entries(togglers)) {
        b.setAttribute("aria-expanded", String(!extra.hidden && extra.dataset.what === what)); // prettier-ignore
      }
    };
    /** Show the folder (or the repository) — and SAY when it is not there
        (moved, or not synced yet), rather than a press that does nothing. */
    const reveal = async () => {
      const shown = await api.reveal(store.id).catch(() => false);
      if (shown) return;
      asked += 1;
      extra.dataset.what = "reveal";
      extra.replaceChildren(el("p", { class: "store-setup-problem", role: "alert", text: storeError("missing") })); // prettier-ignore
      extra.hidden = false;
      showExpanded();
    };
    const hideExtra = () => {
      extra.hidden = true;
      showExpanded();
    };
    const toggle = async (what) => {
      if (!extra.hidden && extra.dataset.what === what && what !== "link") {
        hideExtra();
        return;
      }
      extra.dataset.what = what;
      const mine = ++asked;
      if (what === "link") {
        // Copy link COPIES — and opens what the friend also needs to know,
        // with the link to read and copy again.
        const link = await api.link(store.id).catch(() => null);
        if (mine !== asked) return;
        let copied = false;
        try {
          if (link) await extra.ownerDocument.defaultView.navigator.clipboard.writeText(link.web); // prettier-ignore
          copied = Boolean(link);
        } catch (err) {
          console.error("[stores] could not copy:", err);
        }
        if (mine !== asked) return;
        extra.replaceChildren(
          copied && el("p", { class: "store-setup-text store-setup-done", role: "status", text: t("stores.linkCopied") }), // prettier-ignore
          el("p", { class: "store-setup-text", text: linkHint(store) }),
          link && linkBox(link.web),
        );
      } else if (what === "invite") {
        extra.replaceChildren(
          inviteBlock(bridge, store),
          el("button", { class: "store-setup-inline", type: "button", text: t("stores.peopleOnGitHub"), onClick: () => void api.reveal(store.id, { people: true }).catch(() => false) }), // prettier-ignore
        );
      } else if (what === "remove") {
        extra.replaceChildren(
          el("p", { class: "store-setup-text", text: t("stores.removeAsk", { name: store.name }) }), // prettier-ignore
          el("div", { class: "store-setup-footer" }, [
            el("button", { class: "settings-action", type: "button", text: t("common.cancel"), onClick: hideExtra }), // prettier-ignore
            el("button", {
              class: "settings-action settings-action--danger",
              type: "button",
              text: t("stores.removeConfirm"),
              onClick: async () => {
                await api.remove(store.id).catch(() => false);
                void showList({ focus: true });
              },
            }),
          ]),
        );
      }
      extra.hidden = false;
      showExpanded();
    };
    // Every store has the same buttons, so each also says WHICH store.
    const action = (text, onClick, opens = null) => {
      const b = el("button", { class: "store-setup-inline", type: "button", text, onClick, "aria-label": t("stores.actionFor", { action: text, name: store.name }) }); // prettier-ignore
      if (opens) {
        b.setAttribute("aria-controls", extra.id);
        b.setAttribute("aria-expanded", "false");
        togglers[opens] = b;
      }
      return b;
    };
    return el("li", { class: "settings-store" }, [
      el("div", { class: "settings-store-head" }, [
        el("span", { class: "settings-store-name", text: store.name }),
        el("span", { class: "settings-store-where", text: storeWhere(store), title: store.path ?? repoPath(store.repo, store.dir) }), // prettier-ignore
      ]),
      el("div", { class: "settings-store-actions" }, [
        action(t("stores.copyLink"), () => void toggle("link"), "link"),
        store.kind === "github" && action(t("stores.invite"), () => void toggle("invite"), "invite"), // prettier-ignore
        onBrowse && action(t("stores.browseStore"), () => onBrowse(store)),
        action(store.kind === "github" ? t("stores.showRepo") : t("stores.showFolder"), () => void reveal()), // prettier-ignore
        action(t("stores.remove"), () => void toggle("remove"), "remove"),
      ]),
      extra,
    ]);
  }

  add.addEventListener("click", () => showSetup());
  void showList();
  return {
    rows: [
      rowWithNote({
        label: t("stores.title"),
        control: add,
        notes: [t("stores.hint")],
      }),
      box,
      account,
    ],
    destroy: () => {
      setup?.destroy();
      setup = null;
      reads += 1;
    },
  };
}

/** What a friend needs besides the link: the folder shared with them in its
    service (said generally for "another synced folder"), or an invitation. */
function linkHint(store) {
  if (store.kind === "github") return t("stores.linkHintGitHub");
  if (!store.provider || store.provider === "other") return t("stores.linkHintFolderOther"); // prettier-ignore
  return t("stores.linkHintFolder", { app: t(`stores.setup.provider.${store.provider}`) }); // prettier-ignore
}
