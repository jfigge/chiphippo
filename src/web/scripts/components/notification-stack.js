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

// notification-stack.js — a minimal top-right toast stack (the sibling
// projects' notification pattern, trimmed for Chip Hippo). The simulation
// surfaces short / conflict / oscillation / magic-smoke messages here. Each
// toast auto-dismisses; a `key` de-dupes so a re-settle doesn't pile up
// duplicates of the same standing warning.

import { el } from "../dom.js";

const DEFAULT_TIMEOUT_MS = 6000;

export class NotificationStack {
  #el;
  #live = new Map(); // key → { toast, timer }

  /** @param {HTMLElement} container - typically document.body / the app root. */
  constructor(container) {
    this.#el = el("div", {
      class: "toast-stack",
      role: "status",
      "aria-live": "polite",
    });
    container.append(this.#el);
  }

  /**
   * Show a toast. `key` collapses repeats (the same standing warning refreshes
   * its timer instead of stacking). `variant` styles it
   * (info | warning | danger). `sticky` toasts don't auto-dismiss.
   *
   * `actionLabel` + `onAction` add ONE button to the toast — the shape a toast
   * needs when it is offering something rather than just saying something
   * ("Update ready" → Restart). The whole toast is a dismiss target, so the
   * button stops the click from propagating into it: exactly the discipline
   * the toolbar's pill readouts follow, for the same reason — a control nested
   * inside a bigger one must not also fire what it sits in. The toast dismisses
   * itself afterwards, since the offer has been answered either way.
   *
   * Re-notifying a LIVE key updates the toast's words in place rather than
   * stacking a second one. That is what a standing warning wanted all along
   * (nothing changes when the text is the same), and it is what a job reporting
   * progress needs — replacing the node instead would rebuild its action button
   * under the pointer that is reaching for it.
   *
   * `dismissible: false` takes away the click-anywhere-to-close, for the one
   * shape that needs it: a toast that is a running job's ONLY interface, where
   * a stray click would throw away the Cancel button and leave the job running
   * with no way to stop it. Such a toast is the caller's to dismiss.
   *
   * @param {{ key?: string, variant?: string, title?: string, message: string,
   *           sticky?: boolean, dismissible?: boolean, actionLabel?: string,
   *           onAction?: () => void }} opts
   */
  notify({
    key,
    variant = "info",
    title,
    message,
    sticky = false,
    dismissible = true,
    actionLabel,
    onAction,
  } = {}) {
    const id = key ?? `${variant}:${message}`;
    const existing = this.#live.get(id);
    if (existing) {
      clearTimeout(existing.timer);
      const titleEl = existing.toast.querySelector(".toast-title");
      if (titleEl && title != null) titleEl.textContent = title;
      const messageEl = existing.toast.querySelector(".toast-message");
      if (messageEl) messageEl.textContent = message;
      if (!sticky) existing.timer = this.#arm(id);
      return;
    }
    const action =
      actionLabel &&
      el("button", {
        class: "toast-action",
        type: "button",
        text: actionLabel,
        onClick: (e) => {
          e.stopPropagation();
          this.dismiss(id);
          onAction?.();
        },
      });
    const toast = el(
      "div",
      { class: `toast toast--${variant}`, dataset: { key: id } },
      [
        title && el("div", { class: "toast-title", text: title }),
        el("div", { class: "toast-message", text: message }),
        action,
      ].filter(Boolean),
    );
    if (dismissible) toast.addEventListener("click", () => this.dismiss(id));
    this.#el.append(toast);
    this.#live.set(id, { toast, timer: sticky ? null : this.#arm(id) });
  }

  #arm(id) {
    return setTimeout(() => this.dismiss(id), DEFAULT_TIMEOUT_MS);
  }

  dismiss(id) {
    const entry = this.#live.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.toast.remove();
    this.#live.delete(id);
  }
}
