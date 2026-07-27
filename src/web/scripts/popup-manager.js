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

/** A close "×" glyph for a dialog()'s header button. */
const CLOSE_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
  'aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

/** The smaller "×" a removable menu row carries (an Open Recent entry). */
const REMOVE_SVG =
  '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
  'aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';

/** Keep a positioned card (menu or submenu) fully on-screen, with a margin. */
function placeCard(node, x, y) {
  const rect = node.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
  const top = Math.max(
    pad,
    Math.min(y, window.innerHeight - rect.height - pad),
  );
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

/** The disabled placeholder a submenu shows when it has nothing to list. */
function emptyMenuItem(label) {
  return el(
    "button",
    {
      class: "popup-menu-item popup-menu-item--empty",
      type: "button",
      role: "menuitem",
      disabled: true,
    },
    [el("span", { class: "popup-menu-label", text: label })],
  );
}

/**
 * One menu row. Plain items are a single `<button.popup-menu-item>` (so a
 * menu with no icons/accelerators/submenus renders exactly as it always
 * has); a REMOVABLE item is that button wrapped in a row beside its own ×,
 * since a button can't nest another one.
 */
function menuItemNode(item, ctx) {
  if (item.separator) {
    return el("div", { class: "popup-menu-separator", role: "separator" });
  }

  const icon =
    ctx.hasIcons &&
    el("span", { class: "popup-menu-icon", "aria-hidden": "true" });
  if (icon && item.icon) icon.innerHTML = item.icon;

  const swatch =
    item.swatch &&
    el("span", { class: "popup-menu-swatch", "aria-hidden": "true" });
  if (swatch) swatch.style.background = item.swatch;

  const button = el(
    "button",
    {
      class: `popup-menu-item${item.danger ? " popup-menu-item--danger" : ""}`,
      type: "button",
      role: "menuitem",
      title: item.title,
      disabled: Boolean(item.disabled),
      "aria-haspopup": item.submenu ? "menu" : null,
      onClick: () => {
        if (item.submenu) {
          ctx.toggleFlyout(button, item);
          return;
        }
        ctx.close();
        item.onSelect?.();
      },
    },
    [
      icon,
      swatch,
      el("span", { class: "popup-menu-label", text: item.label }),
      item.accelerator &&
        el("span", { class: "popup-menu-accel", text: item.accelerator }),
      item.submenu &&
        el("span", {
          class: "popup-menu-chevron",
          "aria-hidden": "true",
          text: "›",
        }),
    ],
  );
  if (!item.disabled) {
    button.addEventListener("pointerenter", () => {
      if (item.submenu) ctx.openFlyout(button, item);
      else ctx.leaveFlyout(button);
    });
  }
  if (!item.onRemove) return button;

  const removeLabel = item.removeLabel ?? `Remove ${item.label}`;
  const removeBtn = el("button", {
    class: "popup-menu-remove",
    type: "button",
    title: removeLabel,
    "aria-label": removeLabel,
    onClick: (event) => {
      // Dropping an entry is not a selection: the menu stays open so several
      // can go in one visit, and the card falls back to its empty placeholder
      // once the last row is gone.
      event.stopPropagation();
      const row = event.currentTarget.closest(".popup-menu-row");
      const card = row?.parentElement;
      row?.remove();
      item.onRemove();
      if (card && !card.querySelector(".popup-menu-item")) {
        const label = card.dataset.emptyLabel;
        if (label) card.append(emptyMenuItem(label));
      }
    },
  });
  removeBtn.innerHTML = REMOVE_SVG;
  return el("div", { class: "popup-menu-row" }, [button, removeBtn]);
}

/**
 * A menu card: the root menu, or a submenu flyout. `emptyLabel` is both the
 * placeholder for an empty list and — stored on the card — what a row removal
 * falls back to when it empties the card.
 */
function buildCard(items, emptyLabel, ctx) {
  const hasIcons = items.some((item) => item.icon);
  const cardCtx = { ...ctx, hasIcons };
  const card = el(
    "div",
    { class: "popup-menu", role: "menu" },
    items.length
      ? items.map((item) => menuItemNode(item, cardCtx))
      : emptyLabel
        ? [emptyMenuItem(emptyLabel)]
        : [],
  );
  if (emptyLabel) card.dataset.emptyLabel = emptyLabel;
  return card;
}

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
  /** True while any popup (dialog or menu) is mounted and showing. */
  isOpen() {
    return state.active != null;
  },

  /**
   * Mount a popup. If one is already open the new popup is QUEUED (shown when
   * the current one closes) rather than replacing it. Focuses the first
   * `[data-autofocus]` control, or the first enabled button.
   * @param {{ element: HTMLElement, onMaskClick?: () => void, onClose?: () => void, variant?: string }} popup
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
      // Scoped notice: reset the CLOSED popup's own open-guard, whichever way it
      // was dismissed (button, mask, or Escape). This must be per-popup, not a
      // broadcast — a stateful dialog QUEUED behind another popup would reset
      // its guard when the OTHER popup closed (just before it mounts), leaving
      // it visible-but-unguarded and stackable.
      active.popup.onClose?.();
      // The un-scoped broadcast is retained for any incidental listener, but the
      // guard reset above no longer depends on it.
      window.dispatchEvent(new CustomEvent("chiphippo:popup-closed"));
    }
    const next = state.queue.shift();
    if (next) mount(next);
  },

  /**
   * A lightweight context/dropdown menu at screen coordinates (clamped into
   * the viewport). An item is
   * `{ label, disabled?, danger?, swatch?, icon?, accelerator?, title?,
   *    submenu?, emptyLabel?, onSelect?, onRemove?, removeLabel? }`, or
   * `{ separator: true }` for a divider rule:
   *   - `swatch` — a CSS color rendering a dot before the label (the wire/bus
   *     color pickers).
   *   - `icon` — an SVG source string drawn in a leading 16 px slot; when ANY
   *     item in a card has one, the others get an empty slot so every label
   *     still lines up.
   *   - `accelerator` — a right-aligned shortcut hint ("⌘S").
   *   - `submenu` — nested items shown in a flyout card beside this one, which
   *     opens on hover or click; the item's own `emptyLabel` is the disabled
   *     placeholder for an empty (or emptied) flyout.
   *   - `onRemove` — renders a trailing × that DROPS THE ROW in place and
   *     leaves the menu open (removing an Open Recent entry), rather than
   *     selecting anything.
   * A selection closes the whole menu first, then runs onSelect. Mask click /
   * Escape dismiss with no selection. The card's own `emptyLabel` is the
   * disabled placeholder when `items` is empty (or is emptied by an `onRemove`)
   * — without one, an empty list opens an empty card.
   * @param {{ x: number, y: number, items: Array<object>,
   *   emptyLabel?: string }} opts
   */
  menu({ x = 0, y = 0, items = [], emptyLabel = null } = {}) {
    // At most one flyout is open at a time; it lives beside the root card in
    // the same dialog (a fixed-position sibling), so it is never clipped by
    // the card's rounded box and dies with the popup.
    let flyout = null; // { anchor, card }

    const closeFlyout = () => {
      if (!flyout) return;
      flyout.card.remove();
      flyout.anchor.classList.remove("popup-menu-item--open");
      flyout = null;
    };

    const openFlyout = (anchor, item) => {
      if (flyout?.anchor === anchor) return;
      closeFlyout();
      const card = buildCard(item.submenu ?? [], item.emptyLabel, ctx);
      (anchor.closest("dialog") ?? document.body).append(card);
      anchor.classList.add("popup-menu-item--open");
      flyout = { anchor, card };
      const rect = anchor.getBoundingClientRect();
      placeCard(card, rect.right + 2, rect.top - 4);
    };

    const ctx = {
      close: () => this.close(),
      openFlyout,
      // Hovering a plain item closes the open flyout — unless that item IS in
      // the flyout (moving onto its own entries must not shut it).
      leaveFlyout: (button) => {
        if (flyout && !flyout.card.contains(button)) closeFlyout();
      },
      toggleFlyout: (anchor, item) => {
        if (flyout?.anchor === anchor) closeFlyout();
        else openFlyout(anchor, item);
      },
    };

    const menuEl = buildCard(items, emptyLabel, ctx);
    this.open({ element: menuEl, variant: "menu" });
    // Position after mount so the menu's size is measurable.
    placeCard(menuEl, x, y);
  },

  /**
   * The standard "header (title + × close button) over a scrollable body"
   * modal shape — About/Settings/Properties/Keyboard-Shortcuts all build this
   * by hand before; this is that ceremony in one place. The caller supplies
   * only its own body content and its `static #open` guard's reset.
   * @param {object} opts
   * @param {string} opts.title - header title text; also the dialog's default
   *   `aria-label`.
   * @param {string} [opts.ariaLabel] - overrides the dialog's `aria-label`
   *   (defaults to `title`).
   * @param {string} [opts.closeAriaLabel] - the close button's `aria-label`
   *   (e.g. "Close settings"); defaults to `Close ${title}`.
   * @param {string} [opts.className] - an extra class on the popup root
   *   (alongside "popup"), e.g. "settings-popup".
   * @param {string} [opts.bodyClass] - an extra class on the `.popup-body`
   *   wrapper, e.g. "settings-popup-body".
   * @param {Node|Array<Node>} opts.body - the dialog's own content.
   * @param {() => void} [opts.onClose] - fires when THIS popup closes (not
   *   when a popup it was queued behind closes) — reset the caller's guard.
   */
  dialog({
    title,
    ariaLabel,
    closeAriaLabel,
    className,
    bodyClass,
    body,
    onClose,
  } = {}) {
    const closeBtn = el("button", {
      class: "popup-close",
      type: "button",
      title: "Close",
      "aria-label": closeAriaLabel ?? `Close ${title}`,
      onClick: () => this.close(),
      "data-autofocus": true,
    });
    closeBtn.innerHTML = CLOSE_SVG;

    const element = el(
      "div",
      {
        class: `popup${className ? ` ${className}` : ""}`,
        role: "dialog",
        "aria-modal": "true",
        "aria-label": ariaLabel ?? title,
      },
      [
        el("div", { class: "popup-header" }, [
          el("span", { class: "popup-title", text: title }),
          closeBtn,
        ]),
        el(
          "div",
          { class: `popup-body${bodyClass ? ` ${bodyClass}` : ""}` },
          body,
        ),
      ],
    );

    this.open({ element, onMaskClick: () => this.close(), onClose });
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

    // A destructive confirm (btn--danger) autofocuses Cancel, not Confirm, so a
    // reflexive Enter right after the dialog opens never fires the dangerous
    // action. Only a non-destructive confirm autofocuses Confirm.
    const isDanger = confirmClass.includes("danger");

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
            "data-autofocus": isDanger,
          }),
          el("button", {
            class: `btn popup-btn ${confirmClass}`,
            type: "button",
            text: confirmLabel,
            onClick: done(onConfirm),
            "data-autofocus": !isDanger,
          }),
        ]),
      ].filter(Boolean),
    );

    this.open({ element, onMaskClick: done(onCancel) });
  },

  /**
   * A dialog with MORE than two ways out — the "Cancel / Save / Discard"
   * shape a close-with-unsaved-changes has to offer (Feature 240's tab
   * delete). `confirm` can't express it: there the only question is yes or no,
   * and here "no" splits into two different answers.
   *
   * Choices render left-to-right after Cancel, each `{ label, value, class }`;
   * `onChoose(value)` fires after the dialog closes, and a Cancel / mask click
   * / Escape calls it with `null` — one exit path, so a caller can never miss
   * a dismissal. Cancel autofocuses: the safe answer is always the default.
   *
   * @param {object} opts
   * @param {string} [opts.title]
   * @param {string} [opts.message]
   * @param {Array<{label: string, value: *, class?: string}>} opts.choices
   * @param {string} [opts.cancelLabel]
   * @param {(value: *) => void} [opts.onChoose]
   */
  choose({
    title,
    message,
    note,
    choices = [],
    cancelLabel = "Cancel",
    onChoose,
  } = {}) {
    const done = (value) => () => {
      this.close();
      onChoose?.(value);
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
            onClick: done(null),
            "data-autofocus": true,
          }),
          ...choices.map((choice) =>
            el("button", {
              class: `btn popup-btn ${choice.class ?? "btn--primary"}`,
              type: "button",
              text: choice.label,
              onClick: done(choice.value),
            }),
          ),
        ]),
      ].filter(Boolean),
    );
    this.open({ element, onMaskClick: done(null) });
  },

  /**
   * A one-field text-input dialog. `quickPicks` render as buttons that fill
   * (and immediately submit) the field. `onConfirm(value)` fires with the
   * trimmed text after the dialog closes; an empty value is passed through, so
   * the caller decides whether to ignore it. Enter submits, Escape cancels.
   * @param {object} opts
   */
  prompt({
    title,
    message,
    label = "",
    value = "",
    placeholder = "",
    quickPicks = [],
    confirmLabel = "OK",
    cancelLabel = "Cancel",
    onConfirm,
    onCancel,
  } = {}) {
    const input = el("input", {
      class: "popup-input",
      type: "text",
      value,
      placeholder,
      "data-autofocus": true,
    });

    const submit = () => {
      const text = input.value.trim();
      this.close();
      onConfirm?.(text);
    };
    const cancel = () => {
      this.close();
      onCancel?.();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });

    const picks =
      quickPicks.length > 0 &&
      el(
        "div",
        { class: "popup-quickpicks" },
        quickPicks.map((name) =>
          el("button", {
            class: "btn popup-btn btn--secondary popup-quickpick",
            type: "button",
            text: name,
            onClick: () => {
              input.value = name;
              submit();
            },
          }),
        ),
      );

    const element = el(
      "div",
      {
        class: "popup popup-prompt",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title || label || "Enter a value",
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
            label && el("label", { class: "popup-label", text: label }),
            input,
            picks,
          ].filter(Boolean),
        ),
        el("div", { class: "popup-footer" }, [
          el("button", {
            class: "btn popup-btn btn--secondary",
            type: "button",
            text: cancelLabel,
            onClick: cancel,
          }),
          el("button", {
            class: "btn popup-btn btn--primary",
            type: "button",
            text: confirmLabel,
            onClick: submit,
          }),
        ]),
      ].filter(Boolean),
    );

    this.open({ element, onMaskClick: cancel });
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
