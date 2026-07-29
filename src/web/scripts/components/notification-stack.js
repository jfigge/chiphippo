/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
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
   * @param {{ key?: string, variant?: string, title?: string, message: string,
   *           sticky?: boolean, actionLabel?: string, onAction?: () => void }} opts
   */
  notify({
    key,
    variant = "info",
    title,
    message,
    sticky = false,
    actionLabel,
    onAction,
  } = {}) {
    const id = key ?? `${variant}:${message}`;
    const existing = this.#live.get(id);
    if (existing) {
      clearTimeout(existing.timer);
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
    toast.addEventListener("click", () => this.dismiss(id));
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

  /** Remove every toast (e.g. on Stop). */
  clear() {
    for (const id of [...this.#live.keys()]) this.dismiss(id);
  }
}
