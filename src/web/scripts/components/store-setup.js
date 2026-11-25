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

// store-setup.js — the ADD STORE guide (the private stores work,
// .claude/rules/stores.md): a few short steps, in plain words, that set up a
// private store for someone who has never used GitHub — or join one a friend
// sent a link to. Drawn INTO a container it is handed (Settings ▸ Gallery
// draws it in place of the store list; a link arriving draws it in a card of
// its own), so it never needs a popup over a popup.
//
// Three ways in, the first step's three choices:
//   · A FOLDER YOU SYNC — pick the cloud (Google Drive, Dropbox, OneDrive,
//     iCloud Drive, other), name the store, choose where in that cloud's
//     folder it goes (main's own dialog makes it there). Then: share the
//     folder in that cloud with your friends, and send them the link.
//   · GITHUB — sign in (GitHub's device flow: a code to type at
//     github.com/login/device), name the store (main makes a PRIVATE
//     repository), invite friends by their GitHub name, send them the link.
//   · A LINK FROM A FRIEND — paste it (or it arrived by itself): for a folder,
//     how to get the shared folder onto this computer, then choose it; for
//     GitHub, sign in and join (main accepts the waiting invitation).
//
// Every press that reaches anything is main's (ipc/stores.js); each button
// that opens a web page names a page KEY main holds the address for.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import {
  FOLDER_PROVIDERS,
  MAX_STORE_NAME,
  githubDir,
  parseStoreLink,
} from "../stores/store-format.js";

/** A cloud's install page and its "share a folder" help, by guide key. */
const PROVIDER_PAGES = Object.freeze({
  gdrive: { download: "gdrive-download", share: "gdrive-share" },
  dropbox: { download: "dropbox-download", share: "dropbox-share" },
  onedrive: { download: "onedrive-download", share: "onedrive-share" },
  icloud: { download: null, share: "icloud-share" },
  other: { download: null, share: null },
});

/** How long Copy says "Copied" (ms). */
const COPIED_MS = 2000;

/** A GitHub store's place: `owner/repo`, or `owner/repo/folder`. */
export function repoPath(repo, dir) {
  return dir ? `${repo}/${dir}` : repo;
}

/** The words for a coded failure from main. */
export function storeError(code) {
  const key = `stores.error.${code}`;
  const said = t(key);
  return said === key ? t("stores.error.unavailable") : said;
}

/** A button that copies `text` and says so for a moment. */
export function copyButton(
  text,
  { label = t("stores.copyLink"), className = "settings-action" } = {},
) {
  let timer = null;
  const button = el("button", {
    class: className,
    type: "button",
    text: label,
  });
  button.addEventListener("click", async () => {
    try {
      await button.ownerDocument.defaultView.navigator.clipboard.writeText(
        text,
      );
    } catch (err) {
      console.error("[stores] could not copy:", err);
      return;
    }
    button.textContent = t("stores.copied");
    clearTimeout(timer);
    timer = setTimeout(() => (button.textContent = label), COPIED_MS);
  });
  return button;
}

/** A share link shown so it can be read, selected and copied. */
export function linkBox(link) {
  const field = el("input", {
    class: "store-setup-link-text",
    type: "text",
    readOnly: true,
    value: link,
    "aria-label": t("stores.linkLabel"),
  });
  field.addEventListener("focus", () => field.select());
  return el("div", { class: "store-setup-link" }, [field, copyButton(link, { className: "settings-action settings-action--primary" })]); // prettier-ignore
}

/**
 * Draw the guide into `root`.
 * @param {HTMLElement} root
 * @param {object} opts
 * @param {object} opts.bridge - window.chiphippo.
 * @param {object|null} [opts.ref] - a store ref from a link that arrived.
 * @param {(store: object) => void} [opts.onDone] - a store was added.
 * @param {() => void} [opts.onClose] - the guide is finished with.
 * @param {(store: object) => void} [opts.onBrowse] - "Show its designs".
 * @returns {{destroy: () => void}}
 */
export function mountStoreSetup(
  root,
  { bridge, ref = null, onDone, onClose, onBrowse } = {},
) {
  const api = bridge?.stores;
  let alive = true;
  let signingIn = false;
  let signInTries = 0;
  root.classList.add("store-setup");

  const say = (key, params) => t(`stores.setup.${key}`, params);
  const draw = (...nodes) => {
    if (!alive) return;
    root.replaceChildren(...nodes.flat().filter(Boolean));
    // Focus goes to the step's first field — or, with none, its heading:
    // the button that was pressed has just gone, and focus must not fall to
    // the page.
    (root.querySelector("[data-autofocus]") ?? root.querySelector(".store-setup-title"))?.focus?.(); // prettier-ignore
  };
  /** As `draw`, for a part of a step redrawn in place (the sign-in): the
      focus follows only when it was in that part — the button just pressed
      has gone — or had already fallen out of the guide. */
  const refill = (box, ...nodes) => {
    const active = root.ownerDocument.activeElement;
    const follow = box.contains(active) || !root.contains(active);
    box.replaceChildren(...nodes.flat().filter(Boolean));
    if (follow) (box.querySelector("[data-autofocus]") ?? root.querySelector(".store-setup-title"))?.focus?.(); // prettier-ignore
  };
  const heading = (text) =>
    el("h3", { class: "store-setup-title", text, tabIndex: -1 });
  /** An answer that arrives after its step has gone is dropped: `node` is
      one of the step's own elements, still in the guide or not. */
  // Asked of the GUIDE, not the page: a guide mounted in a card that is
  // still QUEUED behind another (a friend's link arriving over Settings) is
  // not on the page yet, and its answers must land all the same.
  const stillOn = (node) => alive && root.contains(node);
  /** A field the browser must not spell-check (a username, a folder). */
  const noSpellcheck = (node) => {
    node.setAttribute("spellcheck", "false");
    return node;
  };
  const para = (text, extra = "") => el("p", { class: `store-setup-text ${extra}`.trim(), text }); // prettier-ignore
  const problem = () => el("p", { class: "store-setup-problem", role: "alert", hidden: true }); // prettier-ignore
  const showProblem = (node, code) => {
    node.textContent = storeError(code);
    node.hidden = false;
  };
  const button = (
    text,
    onClick,
    { primary = false, disabled = false, autofocus = false } = {},
  ) =>
    // prettier-ignore
    el("button", {
      class: `settings-action${primary ? " settings-action--primary" : ""}`,
      type: "button",
      text,
      disabled,
      onClick,
      "data-autofocus": autofocus || null,
    });
  // A page the guide opens (a key main holds the address for): link-weight,
  // since it sits inside a sentence.
  const pageButton = (key, text) =>
    key && el("button", { class: "store-setup-inline", type: "button", text, onClick: () => void api.guide(key).catch(() => false) }); // prettier-ignore
  const footer = (...buttons) => el("div", { class: "store-setup-footer" }, buttons.filter(Boolean)); // prettier-ignore
  /** A sign-in still waiting on GitHub stops when its step is left. */
  const cancelSignIn = () => {
    if (!signingIn) return;
    signingIn = false;
    void api.githubSignInCancel?.()?.catch?.(() => {});
  };
  const back = (to) =>
    button(t("stores.back"), () => {
      cancelSignIn();
      to();
    });
  const close = () => {
    cancelSignIn();
    alive = false;
    onClose?.();
  };
  const steps = (items) =>
    el("ol", { class: "store-setup-steps" }, items.filter(Boolean).map((item) => el("li", {}, item))); // prettier-ignore
  const nameField = (value = "") =>
    el("input", {
      class: "settings-text-input store-setup-name",
      type: "text",
      value,
      maxLength: MAX_STORE_NAME,
      placeholder: say("namePlaceholder"),
      "aria-label": say("nameLabel"),
      "data-autofocus": true,
    });
  const labelled = (text, control) =>
    el("label", { class: "store-setup-field" }, [el("span", { class: "store-setup-label", text }), control]); // prettier-ignore

  // ── Step 1: where should the designs live? ──
  function start() {
    const choice = (key, onClick) =>
      el("button", { class: "store-setup-choice", type: "button", onClick }, [
        el("span", { class: "store-setup-choice-title", text: say(`choice.${key}.title`) }),
        el("span", { class: "store-setup-choice-text", text: say(`choice.${key}.text`) }),
      ]); // prettier-ignore
    // Drawn once the status is known: GitHub is offered only where this
    // build can use it (a choice that can't be taken is not shown greyed
    // as "coming soon" — App Review refuses placeholder features).
    const mark = el("span", { hidden: true });
    root.replaceChildren(mark);
    void api
      .status()
      .catch(() => null)
      .then((s) => {
        if (!stillOn(mark)) return;
        const github = s?.github?.configured === true;
        draw(
          heading(say("startTitle")),
          para(say("startIntro")),
          el("div", { class: "store-setup-choices" }, [
            choice("folder", () => folderCreate()),
            github && choice("github", () => githubCreate()),
            choice("link", () => pasteLink()),
            choice("local", () => folderOpen()),
          ].filter(Boolean)), // prettier-ignore
          footer(button(t("common.cancel"), close)),
        );
      });
  }

  // ── A folder: make one ──
  function folderCreate() {
    const provider = el("select", { class: "settings-select store-setup-provider", "aria-label": say("folder.provider") }, // prettier-ignore
      FOLDER_PROVIDERS.map((p) => el("option", { value: p, text: say(`provider.${p}`) }))); // prettier-ignore
    const name = nameField();
    const help = el("div", { class: "store-setup-provider-help" });
    const fault = problem();
    // While a make is under way the button stays off, whatever is typed:
    // a second press would make a second store.
    let busy = false;
    const go = button(say("folder.choose"), async () => {
      fault.hidden = true;
      busy = true;
      go.disabled = true;
      const res = await api.addFolder({ mode: "create", name: name.value, provider: provider.value }).catch(() => ({ ok: false, code: "unavailable" })); // prettier-ignore
      busy = false;
      go.disabled = false;
      if (res == null || !stillOn(go)) return; // the dialog was cancelled
      if (!res.ok) return showProblem(fault, res.code);
      onDone?.(res.store);
      await folderMade(res.store);
    }, { primary: true }); // prettier-ignore
    const refresh = () => {
      const p = provider.value;
      const pages = PROVIDER_PAGES[p];
      help.replaceChildren(
        para(say(`folder.where.${p}`)),
        pages.download && el("p", { class: "store-setup-text store-setup-quiet" }, [say("folder.noApp"), " ", pageButton(pages.download, say("folder.getApp", { app: say(`provider.${p}`) }))]), // prettier-ignore
      );
      go.disabled = busy || !name.value.trim();
    };
    provider.addEventListener("change", refresh);
    name.addEventListener("input", refresh);
    draw(
      heading(say("folder.title")),
      para(say("folder.intro")),
      labelled(say("folder.provider"), provider),
      help,
      labelled(say("nameLabel"), name),
      fault,
      footer(back(start), go),
    );
    refresh();
  }

  // ── A folder: made — now share it ──
  async function folderMade(store) {
    const link = await api.link(store.id).catch(() => null);
    const pages = PROVIDER_PAGES[store.provider] ?? PROVIDER_PAGES.other;
    draw(
      heading(say("folder.madeTitle", { name: store.name })),
      para(say("folder.madeWhere", { path: store.path })),
      steps([
        [say(`folder.share.${store.provider}`), " ", pageButton(pages.share, say("folder.howToShare"))], // prettier-ignore
        say("folder.sendLink"),
      ]),
      link && linkBox(link.web),
      para(say("folder.friendSees"), "store-setup-quiet"),
      footer(onBrowse && button(say("browse"), () => { onBrowse(store); close(); }), button(t("stores.done"), close, { primary: true })), // prettier-ignore
    );
  }

  // ── A folder already here (no link): which service, then the folder ──
  function folderOpen() {
    const provider = el("select", { class: "settings-select store-setup-provider", "aria-label": say("folder.provider") }, // prettier-ignore
      FOLDER_PROVIDERS.map((p) => el("option", { value: p, text: say(`provider.${p}`) }))); // prettier-ignore
    const fault = problem();
    const go = button(say("join.chooseFolder"), async () => {
      fault.hidden = true;
      go.disabled = true;
      const res = await api.addFolder({ mode: "open", provider: provider.value }).catch(() => ({ ok: false, code: "unavailable" })); // prettier-ignore
      go.disabled = false;
      if (res == null || !stillOn(go)) return;
      if (!res.ok) return showProblem(fault, res.code);
      onDone?.(res.store);
      joined(res.store);
    }, { primary: true }); // prettier-ignore
    draw(
      heading(say("local.title")),
      para(say("local.intro")),
      labelled(say("folder.provider"), provider),
      fault,
      footer(back(start), go),
    );
  }

  // ── GitHub: sign in (shared by making and joining) ──
  /** The sign-in block — who is signed in, or the button and the code — and
      `recheck()` — asked again when a step learns
      the sign-in is gone (a token revoked on GitHub: main has forgotten
      it), so Sign In is offered right there. */
  function signInBlock(onSignedIn, onSignedOut) {
    const box = el("div", { class: "store-setup-signin" });
    const fault = problem();
    const render = async () => {
      const s = (await api.status().catch(() => null))?.github ?? {};
      if (!stillOn(box)) return;
      if (s.signedIn) {
        refill(box, para(s.login ? say("github.signedInAs", { login: s.login }) : say("github.signedIn"))); // prettier-ignore
        onSignedIn?.(s);
        return;
      }
      onSignedOut?.();
      refill(
        box,
        para(say("github.signInWhy")),
        el("p", { class: "store-setup-text store-setup-quiet" }, [say("github.noAccount"), " ", pageButton("github-signup", say("github.signUp"))]), // prettier-ignore
        footer((signInButton = button(say("github.signIn"), begin, { primary: true, autofocus: true }))), // prettier-ignore
        fault,
      );
    };
    let signInButton = null;
    const begin = async () => {
      // One press, one sign-in: a double click must not start two.
      if (signInButton) signInButton.disabled = true;
      fault.hidden = true;
      // From the press on, leaving the step stops the sign-in — even while
      // GitHub is still answering the start (main stands a cancelled start
      // down when it arrives).
      const mine = ++signInTries;
      signingIn = true;
      const res = await api.githubSignIn().catch(() => null);
      if (!stillOn(box) || mine !== signInTries) return;
      if (!res?.ok) {
        signingIn = false;
        if (signInButton) signInButton.disabled = false;
        if (res?.code !== "cancelled") showProblem(fault, res?.code);
        return;
      }
      const code = el("code", {
        class: "store-setup-code",
        text: res.userCode,
      });
      refill(
        box,
        para(say("github.typeCode")),
        el("div", { class: "store-setup-code-row" }, [
          code,
          button(say("github.copyAndOpen"), async () => {
            try {
              await root.ownerDocument.defaultView.navigator.clipboard.writeText(res.userCode); // prettier-ignore
            } catch {
              /* the code is on screen to type */
            }
            void api.guide("github-device").catch(() => false);
          }, { primary: true, autofocus: true }), // prettier-ignore
        ]),
        para(say("github.waiting"), "store-setup-quiet"),
        fault,
      );
      const done = await api.githubSignInWait().catch(() => null);
      // Only THIS sign-in's end clears the flag (an older one finishing
      // late must not clear a newer one's).
      if (mine === signInTries) signingIn = false;
      // The step was left meanwhile (Back, Settings closed): nothing to draw.
      if (!stillOn(box)) return;
      if (done?.ok) return render();
      if (done?.code === "cancelled") return;
      await render();
      showProblem(fault, done?.code);
    };
    void render();
    return { node: box, recheck: () => void render() };
  }

  // ── GitHub: make a store — in a new repository, or one already there ──
  function githubCreate() {
    const name = nameField();
    const fault = problem();
    // Where it goes: a NEW private repository (the default), or a folder of
    // its own in one of the user's private repositories.
    const where = (value, checked) =>
      el("input", { type: "radio", name: "store-github-where", value, checked }); // prettier-ignore
    const whereNew = where("new", true);
    const whereExisting = where("existing", false);
    const repoPick = el("select", { class: "settings-select store-setup-repo", "aria-label": say("github.repo") }); // prettier-ignore
    const repoNote = el("p", { class: "store-setup-text store-setup-quiet", text: say("github.privateOnly") }); // prettier-ignore
    const folder = noSpellcheck(
      el("input", {
        class: "settings-text-input store-setup-folder",
        type: "text",
        value: "chiphippo",
        maxLength: 120,
        "aria-label": say("github.folder"),
      }),
    );
    // null until asked; "failed" after a read that failed (asked again only
    // by Try Again — never by itself, which would ask GitHub without end);
    // [] when there are none.
    let repos = null;
    const retry = el("button", {
      class: "store-setup-inline",
      type: "button",
      text: say("github.repoRetry"),
      hidden: true,
      onClick: () => {
        repos = null;
        retry.hidden = true;
        fault.hidden = true;
        refresh();
      },
    });
    const existingBox = el("div", { class: "store-setup-existing", hidden: true }, [
      labelled(say("github.repo"), repoPick),
      retry,
      repoNote,
      labelled(say("github.folder"), folder),
      para(say("github.folderHint"), "store-setup-quiet"),
    ]); // prettier-ignore
    const choices = el("fieldset", { class: "store-setup-where" }, [
      el("legend", { class: "store-setup-label", text: say("github.where") }),
      el("label", { class: "store-save-mode" }, [whereNew, el("span", { text: say("github.whereNew") })]), // prettier-ignore
      el("label", { class: "store-save-mode" }, [whereExisting, el("span", { text: say("github.whereExisting") })]), // prettier-ignore
      existingBox,
    ]);
    const loadRepos = async () => {
      if (repos !== null) return;
      repos = [];
      repoPick.replaceChildren(el("option", { value: "", text: say("github.repoLoading") })); // prettier-ignore
      const res = await api.githubRepos().catch(() => null);
      if (!stillOn(repoPick)) return;
      if (!res?.ok) {
        repos = "failed";
        repoPick.replaceChildren();
        showProblem(fault, res?.code);
        retry.hidden = false;
        return refresh();
      }
      repos = res.repos;
      repoPick.replaceChildren(...repos.map((r) => el("option", { value: r.repo, text: r.repo }))); // prettier-ignore
      // prettier-ignore
      repoNote.textContent = [repos.length ? say("github.privateOnly") : say("github.repoNone"), res.more ? say("github.repoMore", { count: repos.length }) : ""].filter(Boolean).join(" ");
      refresh();
    };
    const existing = () => whereExisting.checked;
    let busy = false;
    // Back is off while the store is being made: leaving then would drop the
    // answer of a store main HAS made (and its link) with nothing said.
    const leave = back(start);
    const go = button(say("github.make"), async () => {
      fault.hidden = true;
      busy = true;
      go.disabled = true;
      leave.disabled = true;
      go.textContent = say("github.making");
      const res = existing()
        ? await api.addGitHub({ mode: "existing", repo: repoPick.value, dir: folder.value, name: name.value }).catch(() => ({ ok: false, code: "unavailable" })) // prettier-ignore
        : await api.addGitHub({ mode: "create", name: name.value }).catch(() => ({ ok: false, code: "unavailable" }));
      busy = false;
      leave.disabled = false;
      if (!stillOn(go)) return;
      go.textContent = say("github.make");
      refresh();
      if (!res?.ok) {
        if (res?.code === "signedOut") signin.recheck();
        return showProblem(fault, res?.code);
      }
      onDone?.(res.store);
      githubInvite(res.store);
    }, { primary: true, disabled: true }); // prettier-ignore
    let signedIn = false;
    const refresh = () => {
      choices.hidden = !signedIn;
      existingBox.hidden = !existing();
      if (signedIn && existing()) void loadRepos();
      go.disabled =
        busy ||
        !signedIn ||
        !name.value.trim() ||
        (existing() && (!repoPick.value || !githubDir(folder.value)));
    };
    for (const input of [name, folder])
      input.addEventListener("input", refresh);
    for (const input of [whereNew, whereExisting, repoPick]) input.addEventListener("change", refresh); // prettier-ignore
    const signin = signInBlock(
      () => {
        signedIn = true;
        refresh();
      },
      () => {
        signedIn = false;
        refresh();
      },
    );
    draw(
      heading(say("github.title")),
      para(say("github.intro")),
      signin.node,
      choices,
      labelled(say("nameLabel"), name),
      para(say("github.private"), "store-setup-quiet"),
      fault,
      footer(leave, go),
    );
    refresh();
  }

  // ── GitHub: invite friends, send the link ──
  async function githubInvite(store) {
    const link = await api.link(store.id).catch(() => null);
    draw(
      heading(say("folder.madeTitle", { name: store.name })),
      para(say("github.madeWhere", { repo: repoPath(store.repo, store.dir) })),
      inviteBlock(bridge, store),
      para(say("github.sendLink")),
      link && linkBox(link.web),
      para(say("github.friendSees"), "store-setup-quiet"),
      footer(onBrowse && button(say("browse"), () => { onBrowse(store); close(); }), button(t("stores.done"), close, { primary: true })), // prettier-ignore
    );
  }

  // ── A link from a friend ──
  function pasteLink() {
    const field = el("input", {
      class: "settings-text-input store-setup-paste",
      type: "text",
      placeholder: say("link.placeholder"),
      "aria-label": say("link.label"),
      "data-autofocus": true,
    });
    const fault = el("p", { class: "store-setup-problem", role: "alert", hidden: true }); // prettier-ignore
    const go = button(say("link.next"), () => {
      const got = parseStoreLink(field.value);
      if (!got) {
        fault.textContent = say("link.bad");
        fault.hidden = false;
        return;
      }
      join(got, pasteLink);
    }, { primary: true }); // prettier-ignore
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go.click();
    });
    draw(heading(say("link.title")), para(say("link.intro")), field, fault, footer(back(start), go)); // prettier-ignore
  }

  /** Join the store `got` names; Back goes to `from` — the paste step for
      a pasted link, the first step for one that arrived by itself. */
  function join(got, from = start) {
    if (got.kind === "github") return joinGitHub(got, from);
    return joinFolder(got, from);
  }

  // ── Joining a folder store ──
  function joinFolder(got, from = start) {
    const p = got.where.provider;
    const pages = PROVIDER_PAGES[p] ?? PROVIDER_PAGES.other;
    const fault = problem();
    const go = button(say("join.chooseFolder"), async () => {
      fault.hidden = true;
      // One press, one folder dialog.
      go.disabled = true;
      const res = await api.addFolder({ mode: "join", ref: got }).catch(() => ({ ok: false, code: "unavailable" })); // prettier-ignore
      go.disabled = false;
      if (res == null || !stillOn(go)) return;
      if (!res.ok) return showProblem(fault, res.code === "missing" ? "notSynced" : res.code); // prettier-ignore
      onDone?.(res.store);
      joined(res.store);
    }, { primary: true, autofocus: true }); // prettier-ignore
    draw(
      heading(say("join.title", { name: got.name })),
      para(p === "other" ? say("join.folderIntroOther") : say("join.folderIntro", { app: say(`provider.${p}`) })), // prettier-ignore
      steps([
        [say(`join.accept.${p}`), " ", pages.download && pageButton(pages.download, say("folder.getApp", { app: say(`provider.${p}`) }))], // prettier-ignore
        say(`join.sync.${p}`),
        say("join.pick"),
      ]),
      fault,
      footer(back(from), go),
    );
  }

  // ── Joining a GitHub store ──
  function joinGitHub(got, from = start) {
    const fault = problem();
    // Off while the join is under way, as Make's is.
    const leave = back(from);
    const go = button(say("join.join"), async () => {
      fault.hidden = true;
      go.disabled = true;
      leave.disabled = true;
      const res = await api.addGitHub({ mode: "join", ref: got }).catch(() => ({ ok: false, code: "unavailable" }));
      leave.disabled = false;
      if (!stillOn(go)) return;
      go.disabled = false;
      if (!res?.ok) {
        if (res?.code === "notInvited") {
          const s = (await api.status().catch(() => null))?.github ?? {};
          fault.textContent = s.login ? say("join.notInvited", { login: s.login }) : storeError("notInvited"); // prettier-ignore
          fault.hidden = false;
          return;
        }
        if (res?.code === "signedOut") signin.recheck();
        return showProblem(fault, res?.code);
      }
      onDone?.(res.store);
      joined(res.store);
    }, { primary: true, disabled: true }); // prettier-ignore
    const signin = signInBlock(
      () => (go.disabled = false),
      () => (go.disabled = true),
    );
    draw(
      heading(say("join.title", { name: got.name })),
      para(say("join.githubIntro", { repo: repoPath(got.where.repo, got.where.dir) })), // prettier-ignore
      signin.node,
      fault,
      footer(leave, go),
    );
  }

  // ── Joined ──
  function joined(store) {
    draw(
      heading(say("joinedTitle", { name: store.name })),
      para(say("joinedText")),
      footer(onBrowse && button(say("browse"), () => { onBrowse(store); close(); }, { primary: true }), button(t("stores.done"), close, { primary: !onBrowse })), // prettier-ignore
    );
  }

  if (ref) join(ref);
  else start();
  return {
    destroy: () => {
      alive = false;
      if (signingIn) void api.githubSignInCancel?.()?.catch?.(() => {});
    },
  };
}

/**
 * Invite people to a GitHub store by their GitHub name, and see who is in
 * or still invited. Shared by the guide and Settings ▸ Gallery.
 */
export function inviteBlock(bridge, store) {
  const api = bridge.stores;
  const say = (key, params) => t(`stores.setup.${key}`, params);
  const people = el("ul", { class: "store-people" });
  const fault = el("p", { class: "store-setup-problem", role: "alert", hidden: true }); // prettier-ignore
  const login = el("input", {
    class: "settings-text-input store-invite-login",
    type: "text",
    placeholder: say("invite.placeholder"),
    "aria-label": say("invite.label"),
    autocomplete: "off",
  });
  login.setAttribute("spellcheck", "false");
  /** Each read's number: an older answer landing after a newer one (the
      first read, after an invite's re-read) is dropped. */
  let reads = 0;
  const loadPeople = async () => {
    const read = ++reads;
    const res = await api
      .people(store.id)
      .catch(() => ({ ok: false, code: "unavailable" }));
    if (read !== reads || !res?.ok) return;
    people.replaceChildren(
      ...res.people.map((p) =>
        el("li", { class: "store-person" }, [
          el("span", { class: "store-person-login", text: `@${p.login}` }),
          p.pending && el("span", { class: "store-person-pending", text: say("invite.pending") }), // prettier-ignore
        ]),
      ),
    );
  };
  const invite = el("button", {
    class: "settings-action",
    type: "button",
    text: say("invite.invite"),
    onClick: async () => {
      fault.hidden = true;
      const who = login.value.trim();
      if (!who) return;
      invite.disabled = true;
      const res = await api
        .invite(store.id, who)
        .catch(() => ({ ok: false, code: "unavailable" }));
      invite.disabled = false;
      if (!res?.ok) {
        fault.textContent = storeError(res?.code);
        fault.hidden = false;
        return;
      }
      login.value = "";
      void loadPeople();
    },
  });
  login.addEventListener("keydown", (e) => {
    if (e.key === "Enter") invite.click();
  });
  void loadPeople();
  return el("div", { class: "store-invite" }, [
    el("p", { class: "store-setup-text", text: say("invite.intro") }),
    el("div", { class: "store-invite-row" }, [login, invite]),
    fault,
    people,
  ]);
}
