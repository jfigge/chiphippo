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

// popup-manager.js — a single shared modal host, ported from Port Hippo. One
// active popup at a time; later popups QUEUE behind it, never replace it. A
// "popup" is any `{ element: HTMLElement, onMaskClick?: () => void }`. The
// `confirm` / `notify` helpers build the standard dialog skeleton, and `menu`
// shows a lightweight positioned context menu (dismissed by mask click or
// Escape) — the board right-click menu and the toolbar split-button use it.
//
// This is the only app-wide dialog/menu seam in the renderer.

import { el } from "./dom.js";

const state = {
  active: null, // { popup, dialogEl } currently shown, or null
  queue: [], // popups waiting behind the active one — QUEUED, never dropped
};

function dismiss(popup) {
  (popup.onMaskClick || PopupManager.close)();
}

// Mount a popup as a native modal <dialog>. showModal() puts it in the browser
// TOP LAYER, so a popup raised while another dialog is open stacks ABOVE it.
// Escape → native `cancel`; a click landing on the dialog itself (not its
// content) is a backdrop click.
function mount(popup) {
  const dialogEl = el(
    "dialog",
    {
      class: `popup-dialog${popup.variant ? ` popup-dialog--${popup.variant}` : ""}`,
    },
    [popup.element],
  );
  dialogEl.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss(popup);
  });
  dialogEl.addEventListener("click", (event) => {
    if (event.target === dialogEl) dismiss(popup);
  });
  document.body.appendChild(dialogEl);
  state.active = { popup, dialogEl };
  dialogEl.showModal();

  const focusTarget =
    popup.element.querySelector("[data-autofocus]") ||
    popup.element.querySelector("button:enabled");
  focusTarget?.focus();
}

export const PopupManager = {
  /**
   * Mount a popup. If one is already open the new popup is QUEUED (shown when
   * the current one closes) rather than replacing it. Focuses the first
   * `[data-autofocus]` control, or the first enabled button.
   * @param {{ element: HTMLElement, onMaskClick?: () => void, variant?: string }} popup
   */
  open(popup) {
    if (!popup || !popup.element) return;
    // Defensive: a detached active dialog means the previous popup is gone
    // (e.g. the DOM was reset under tests) — treat the host as idle rather
    // than queueing behind a ghost.
    if (
      state.active &&
      (!state.active.dialogEl.isConnected ||
        state.active.dialogEl.ownerDocument !== document)
    ) {
      state.active = null;
      state.queue = [];
    }
    if (state.active) {
      state.queue.push(popup);
      return;
    }
    mount(popup);
  },

  /** Close the active popup, then show the next queued one. Safe to call idle. */
  close() {
    const active = state.active;
    state.active = null;
    if (active) {
      try {
        active.dialogEl.close();
      } catch {
        // already closed
      }
      active.dialogEl.remove();
      // A one-way notice for stateful dialogs (About/Settings) that need to
      // reset an "is open" guard however they were dismissed (button, mask,
      // or Escape). Fired after the DOM is torn down.
      window.dispatchEvent(new CustomEvent("chiphippo:popup-closed"));
    }
    const next = state.queue.shift();
    if (next) mount(next);
  },

  /**
   * A lightweight context/dropdown menu at screen coordinates (clamped into
   * the viewport). Items: `{ label, disabled?, danger?, onSelect? }`, or
   * `{ separator: true }` for a divider rule — a selection closes the menu
   * first, then runs onSelect. Mask click / Escape dismiss with no selection.
   * @param {{ x: number, y: number, items: Array<object> }} opts
   */
  menu({ x = 0, y = 0, items = [] } = {}) {
    const menuEl = el(
      "div",
      { class: "popup-menu", role: "menu" },
      items.map((item) =>
        item.separator
          ? el("div", { class: "popup-menu-separator", role: "separator" })
          : el("button", {
              class: `popup-menu-item${item.danger ? " popup-menu-item--danger" : ""}`,
              type: "button",
              role: "menuitem",
              text: item.label,
              disabled: Boolean(item.disabled),
              onClick: () => {
                this.close();
                item.onSelect?.();
              },
            }),
      ),
    );
    this.open({ element: menuEl, variant: "menu" });
    // Position after mount so the menu's size is measurable; keep it fully
    // on-screen with a small margin.
    const rect = menuEl.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(
      pad,
      Math.min(x, window.innerWidth - rect.width - pad),
    );
    const top = Math.max(
      pad,
      Math.min(y, window.innerHeight - rect.height - pad),
    );
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
  },

  /**
   * A two-button confirmation dialog. `onConfirm` / `onCancel` fire after the
   * dialog closes. `confirmClass` styles the confirm button (e.g.
   * "btn--danger").
   * @param {object} opts
   */
  confirm({
    title,
    message,
    note,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    confirmClass = "btn--primary",
    onConfirm,
    onCancel,
  } = {}) {
    const done = (fn) => () => {
      this.close();
      fn?.();
    };

    const element = el(
      "div",
      {
        class: "popup popup-confirm",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title || message || "",
      },
      [
        title &&
          el("div", { class: "popup-header" }, [
            el("span", { class: "popup-title", text: title }),
          ]),
        el(
          "div",
          { class: "popup-body" },
          [
            message && el("p", { class: "popup-message", text: message }),
            note && el("p", { class: "popup-note", text: note }),
          ].filter(Boolean),
        ),
        el("div", { class: "popup-footer" }, [
          el("button", {
            class: "btn popup-btn btn--secondary",
            type: "button",
            text: cancelLabel,
            onClick: done(onCancel),
          }),
          el("button", {
            class: `btn popup-btn ${confirmClass}`,
            type: "button",
            text: confirmLabel,
            onClick: done(onConfirm),
            "data-autofocus": true,
          }),
        ]),
      ].filter(Boolean),
    );

    this.open({ element, onMaskClick: done(onCancel) });
  },

  /**
   * A single-button acknowledgement dialog (no cancel).
   * @param {object} opts
   */
  notify({
    title,
    message,
    okLabel = "Dismiss",
    okClass = "btn--primary",
    onClose,
  } = {}) {
    const element = el(
      "div",
      {
        class: "popup popup-notify",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-label": title || message || "",
      },
      [
        title &&
          el("div", { class: "popup-header" }, [
            el("span", { class: "popup-title", text: title }),
          ]),
        el("div", { class: "popup-body" }, [
          message && el("p", { class: "popup-message", text: message }),
        ]),
        el("div", { class: "popup-footer" }, [
          el("button", {
            class: `btn popup-btn ${okClass}`,
            type: "button",
            text: okLabel,
            onClick: () => {
              this.close();
              onClose?.();
            },
            "data-autofocus": true,
          }),
        ]),
      ].filter(Boolean),
    );

    this.open({
      element,
      onMaskClick: () => {
        this.close();
        onClose?.();
      },
    });
  },
};
