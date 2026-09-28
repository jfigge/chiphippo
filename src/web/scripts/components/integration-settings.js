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

// integration-settings.js — Settings ▸ Serial I/O: the NAMED CONNECTIONS the
// Arduino serial integration talks over.
//
// ONE PICKER, ONE EDITOR. A dropdown at the top names every connection, with +
// (add) and a bin (remove) beside it, and a single editor below edits whichever
// is picked — so the panel is the same height however many connections there
// are. A card per connection grew the panel by a whole form each, and put the
// one being edited below the fold. The editor is modelled on CoolTerm's
// connection options — a port (with Re-scan) and a baud rate up front, the
// framing (data bits, parity, stop bits, flow control) in an Advanced section,
// since a Nano never needs them changed — plus the LANGUAGE Generate writes
// the board's code in (C++ or Python), which is the connection's because it
// is the board's: a Nano and a Pico on one desktop get one file each. Its
// rows are the card's own `.settings-row--field`s, spaced as every other
// tab's: closed, the panel fits the card at every shipped size and language;
// Advanced open, it scrolls.
//
// THE ONE PANEL THAT DOES NOT APPLY LIVE. Everything else in Settings is a
// patch the moment it changes; a connection is edited as a DRAFT and committed
// with Apply, because applying is also where it is VERIFIED: a live port scan
// runs, and a port that is not plugged in is warned about (the user may
// override — they may plug it in later). Applying is what clears a
// connection's "needs configuration" flag, which a connection arrives with
// when a project brought it here from another machine. Each connection keeps
// its own draft while another is picked, so several can be edited in one
// visit; one with unapplied edits carries a • in the list. Only picking,
// adding, removing, applying and a scan rebuild the editor — an edit updates
// what it affects in place, so typing a name never loses the caret.
//
// A connection with a PROBLEM — flagged, no port, or a port the last scan did
// not find — is marked where it is: its entry in the list names the problem,
// and the editor's Port field is red — the same test Run applies before it
// will start. The editor is plain rows on the panel like every other tab's,
// with no card around it. The panel opens on the first connection with a
// problem it can see before the scan returns (Run's refusal sends the user
// here to fix exactly that), else the first of the user's own, else the Mock.
//
// The built-in MOCK heads the list. Picked, the editor says what it is and
// offers its window — no serial settings and no Apply, and the bin is
// disabled, since there is nothing to configure and it cannot go. Its name is
// reserved: Apply refuses a user's connection called "Mock".
//
// Removing takes two clicks, as it did as a button: the first turns the bin
// into a question mark, the second removes. Anything else in between — a
// click elsewhere, Escape, picking another connection — puts the bin back.
// The Escape is caught in the CAPTURE phase and `preventDefault`ed, for
// info-button.js's reason: the panel sits in a modal <dialog>, where Escape
// would otherwise close the whole card.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { buildInfoButton } from "./info-button.js";
import { buildSegmented } from "./segmented-picker.js";
import {
  BAUD_RATES,
  FLOW_CONTROLS,
  LANGUAGES,
  PARITIES,
  STOP_BITS,
  MOCK_ID,
  MOCK_NAME,
  connectionProblem,
  createConnection,
  portPositions,
  normalizeConnection,
  normalizeConnections,
  isReservedConnectionName,
} from "../model/serial-connections.js";

/** A line-drawn 24-unit glyph at the size the Settings card's icons use. */
const lineIcon = (inner) =>
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  `stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

/** + — add a connection. */
const ADD_SVG = lineIcon(
  '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
);

/** A bin — remove the picked connection. */
const TRASH_SVG = lineIcon(
  '<polyline points="3 6 5 6 21 6"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 ' +
    '2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/>' +
    '<line x1="14" y1="11" x2="14" y2="17"/>',
);

/** A question mark in a circle — the bin, armed, awaiting its second click. */
const CONFIRM_SVG = lineIcon(
  '<circle cx="12" cy="12" r="10"/>' +
    '<path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/>' +
    '<line x1="12" y1="17" x2="12.01" y2="17"/>',
);

/**
 * One row of the editor, built as every Settings field is — the AI tab's
 * `.settings-row--field`: the label left, the control filling the rest — so
 * the tab keeps the card's own spacing and type rather than a denser form of
 * its own. `id` is the control's, for the label's `for`.
 */
function field(label, id, control, { problem = false, note = null } = {}) {
  const text = problem ? `${label} *` : label;
  // Tied to its control when there is one to tie to — a segmented track is
  // not labelable, and names itself with its own aria-label.
  const labelable = control.id === id || control.querySelector?.(`#${id}`);
  const labelEl = el("label", {
    class: "settings-label",
    for: labelable ? id : null,
    text,
  });
  // A note is an (i) beside the label and a card floating under the row, as
  // every Settings note is (settings-dialog.js's rowWithNote).
  const card = note
    ? el(
        "div",
        {
          class: "settings-note",
          id: `${id}-note`,
          role: "note",
          hidden: true,
        },
        [el("p", { class: "settings-hint", text: note })],
      )
    : null;
  return el(
    "div",
    {
      class:
        "settings-row settings-row--field integration-field" +
        (problem ? " integration-field--problem" : ""),
    },
    [
      card
        ? el("div", { class: "settings-label-group" }, [
            labelEl,
            buildInfoButton({
              target: card,
              label: t("settings.noteToggle", { label }),
            }),
          ])
        : labelEl,
      control,
      card,
    ],
  );
}

/**
 * A scanned port as the Port list shows it: its path and maker, and — when
 * its board has several — which one it is. A Python connection's board with
 * exactly two is CircuitPython with its data port on (a MicroPython board
 * has one), so there the two are named: the REPL first, then the data port
 * the link wants.
 */
function portLabel(p, language) {
  const base = p.manufacturer ? `${p.path} — ${p.manufacturer}` : p.path;
  if (p.count < 2) return base;
  const where =
    language === "python" && p.count === 2
      ? t("integration.settings.portOfRole", {
          n: p.n,
          count: p.count,
          role:
            p.n === 1
              ? t("integration.settings.portRoleRepl")
              : t("integration.settings.portRoleData"),
        })
      : t("integration.settings.portOf", { n: p.n, count: p.count });
  return `${base} · ${where}`;
}

/** A <select> over values, labelled by `label(value)`. */
function select(values, current, label, onChange, id) {
  return el(
    "select",
    {
      class: "settings-select",
      id,
      onChange: (e) => {
        const v = values.find((x) => String(x) === e.target.value);
        onChange(v ?? e.target.value);
      },
    },
    values.map((v) =>
      el("option", {
        value: String(v),
        text: label(v),
        selected: v === current,
      }),
    ),
  );
}

/**
 * Build the panel's content.
 *
 * @param {object} settings the settings document
 * @param {(patch: object) => void} emitPatch the dialog's own emitter
 * @param {object} [bridge] window.chiphippo
 * @returns {{rows: HTMLElement[]}}
 */
export function buildIntegrationPanel(settings, emitPatch, bridge) {
  let list = normalizeConnections(settings.serialConnections);
  const drafts = new Map(); // id → the connection's unapplied edits
  const notes = new Map(); // id → { text, kind: "warn"|"ok", override }
  let advancedOpen = false;
  let ports = null; // the last scan: [{path, manufacturer}], or null (none yet)
  let scanning = false;
  let armed = false; // the bin has had its first click

  const presentPaths = () => ports?.map((p) => p.path) ?? null;
  const problemOf = (conn) => connectionProblem(conn, presentPaths());
  const draftOf = (conn) => drafts.get(conn.id) ?? { ...conn };
  const isDirty = (conn) =>
    JSON.stringify(normalizeConnection(draftOf(conn))) !==
    JSON.stringify(normalizeConnection(conn));
  /** The words a problem earns in the list — none for a bare missing port. */
  const flagOf = (conn) =>
    conn.needsConfig === true
      ? t("integration.settings.needsConfig")
      : problemOf(conn) === "port-missing"
        ? t("integration.settings.portUnavailable")
        : null;

  let selectedId = list.find((c) => problemOf(c))?.id ?? list[0]?.id ?? MOCK_ID;
  const current = () => list.find((c) => c.id === selectedId) ?? null;

  // ── The picker bar ──────────────────────────────────────────────────────
  const picker = el("select", {
    class: "settings-select integration-picker-select",
    "aria-label": t("integration.settings.connection"),
    onChange: (e) => {
      selectedId = e.target.value;
      setArmed(false);
      render();
    },
  });

  const addBtn = el("button", {
    class: "integration-picker-btn",
    type: "button",
    title: t("integration.settings.add"),
    "aria-label": t("integration.settings.add"),
    onClick: () => {
      const conn = createConnection(
        list,
        t("integration.settings.defaultName"),
      );
      selectedId = conn.id;
      setArmed(false);
      commitList([...list, conn]);
      // A new connection is named "Arduino 2"; put the caret there, text
      // selected, so typing names it.
      const name = editor.querySelector(".integration-name");
      name?.focus();
      name?.select();
    },
  });
  addBtn.innerHTML = ADD_SVG;

  const removeBtn = el("button", {
    class: "integration-picker-btn integration-picker-btn--danger",
    type: "button",
    onClick: () => {
      const conn = current();
      if (!conn) return;
      if (!armed) {
        setArmed(true);
        return;
      }
      setArmed(false);
      // The neighbour takes the slot: the next one down, else the one above,
      // else the Mock.
      const at = list.indexOf(conn);
      const rest = list.filter((c) => c.id !== conn.id);
      selectedId = (rest[at] ?? rest[at - 1])?.id ?? MOCK_ID;
      drafts.delete(conn.id);
      notes.delete(conn.id);
      commitList(rest);
    },
  });

  // Disarming listeners, live only while the bin is armed. A panel torn down
  // while armed (the dialog closed) must not keep swallowing Escape, hence
  // the `isConnected` test before either acts.
  const onOutside = (e) => {
    if (!removeBtn.isConnected) return setArmed(false);
    if (!removeBtn.contains(e.target)) setArmed(false);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    if (removeBtn.isConnected) {
      e.preventDefault();
      e.stopPropagation();
    }
    setArmed(false);
  };
  function setArmed(on) {
    if (armed === on) return;
    armed = on;
    const method = on ? "addEventListener" : "removeEventListener";
    document[method]("pointerdown", onOutside, true);
    document[method]("keydown", onKey, true);
    renderPicker();
  }

  // ── The editor ──────────────────────────────────────────────────────────
  const editor = el("section", { class: "integration-conn" });

  const commitList = (next) => {
    list = normalizeConnections(next);
    emitPatch({ serialConnections: list.map((c) => ({ ...c })) });
    render();
  };

  const scan = async () => {
    scanning = true;
    renderEditor();
    try {
      ports = (await bridge?.serial?.ports?.()) ?? [];
    } catch (err) {
      console.error("[renderer] serial:ports failed:", err);
      ports = [];
    }
    scanning = false;
    render();
    return ports;
  };

  function render() {
    if (selectedId !== MOCK_ID && !current()) selectedId = MOCK_ID;
    renderPicker();
    renderEditor();
  }

  function renderPicker() {
    const optionLabel = (name, tag) =>
      tag ? t("integration.settings.optionTagged", { name, tag }) : name;
    picker.replaceChildren(
      el("option", {
        value: MOCK_ID,
        text: optionLabel(MOCK_NAME, t("integration.settings.builtin")),
      }),
      ...list.map((c) => {
        const label = optionLabel(c.name, flagOf(c));
        return el("option", {
          value: c.id,
          text: isDirty(c) ? `${label} •` : label,
        });
      }),
    );
    picker.value = selectedId;
    removeBtn.disabled = !current();
    removeBtn.innerHTML = armed ? CONFIRM_SVG : TRASH_SVG;
    removeBtn.classList.toggle("integration-picker-btn--armed", armed);
    const label = armed
      ? t("integration.settings.removeConfirm")
      : t("integration.settings.remove");
    removeBtn.title = label;
    removeBtn.setAttribute("aria-label", label);
  }

  /** Rebuild the editor, keeping focus on the same control if it had it. */
  function renderEditor() {
    const active = document.activeElement;
    const focusId = editor.contains(active) ? active.id : "";
    const conn = current();
    if (conn) buildEditor(conn);
    else buildMockEditor();
    if (focusId) editor.querySelector(`#${focusId}`)?.focus();
  }

  const openWindowButton = (id) =>
    el("button", {
      class: "settings-action",
      type: "button",
      text: t("integration.settings.openWindow"),
      title: t("integration.settings.openWindowTitle"),
      id: "set-serial-open-window",
      onClick: () => void bridge?.serial?.log?.open?.(id),
    });

  function buildMockEditor() {
    editor.className = "integration-conn integration-conn--builtin";
    editor.dataset.connectionId = MOCK_ID;
    editor.replaceChildren(
      el("p", {
        class: "settings-hint integration-mock-note",
        text: t("integration.settings.mockNote"),
      }),
      el("div", { class: "settings-row settings-row--actions" }, [
        openWindowButton(MOCK_ID),
      ]),
    );
  }

  function buildEditor(conn) {
    const draft = draftOf(conn);
    const problem = problemOf(conn);
    const flagged = conn.needsConfig === true;
    const note = notes.get(conn.id);
    editor.className =
      "integration-conn" + (isDirty(conn) ? " integration-conn--dirty" : "");
    editor.dataset.connectionId = conn.id;

    // An edit touches only what it changes — the draft, the dirty marks and
    // Apply — so the control being edited is never rebuilt under the user.
    const edit = (patch) => {
      drafts.set(conn.id, { ...draftOf(conn), ...patch });
      if ("language" in patch) fillPorts();
      if (notes.delete(conn.id)) {
        noteLine?.remove();
        applyBtn.textContent = t("integration.settings.apply");
        override = false;
      }
      const dirty = isDirty(conn);
      editor.classList.toggle("integration-conn--dirty", dirty);
      applyBtn.disabled = !dirty && !flagged && !problem;
      renderPicker();
    };

    const portSelect = el("select", {
      class: "settings-select integration-port",
      id: "set-serial-port",
      onChange: (e) => edit({ port: e.target.value }),
    });
    // The options say which of its board's ports each is — and, for a
    // Python connection on a board with two, which is CircuitPython's REPL
    // and which its data port — so they follow the Language being edited.
    const fillPorts = () => {
      const { port, language } = draftOf(conn);
      const choices = [
        { value: "", label: t("integration.settings.choosePort") },
        ...portPositions(ports ?? []).map((p) => ({
          value: p.path,
          label: portLabel(p, language),
        })),
      ];
      if (port && !choices.some((c) => c.value === port)) {
        choices.push({
          value: port,
          label: t("integration.settings.portNotFound", { port }),
        });
      }
      portSelect.replaceChildren(
        ...choices.map((c) =>
          el("option", {
            value: c.value,
            text: c.label,
            selected: c.value === port,
          }),
        ),
      );
    };
    fillPorts();
    const rescan = el("button", {
      class: "settings-action",
      type: "button",
      text: scanning
        ? t("integration.settings.scanning")
        : t("integration.settings.rescan"),
      disabled: scanning,
      id: "set-serial-rescan",
      onClick: () => void scan(),
    });

    const nameInput = el("input", {
      class: "settings-text-input integration-name",
      id: "set-serial-name",
      type: "text",
      value: draft.name,
      spellcheck: false,
      onInput: (e) => edit({ name: e.target.value }),
    });

    const advanced = el(
      "details",
      { class: "integration-advanced", open: advancedOpen },
      [
        el("summary", { text: t("integration.settings.advanced") }),
        // No data-bits row: the link is binary, so it is always 8.
        field(
          t("integration.settings.parity"),
          "set-serial-parity",
          select(
            PARITIES,
            draft.parity,
            (p) => t(`integration.settings.parityValue.${p}`),
            (parity) => edit({ parity }),
            "set-serial-parity",
          ),
        ),
        field(
          t("integration.settings.stopBits"),
          "set-serial-stop-bits",
          select(
            STOP_BITS,
            draft.stopBits,
            String,
            (stopBits) => edit({ stopBits }),
            "set-serial-stop-bits",
          ),
        ),
        field(
          t("integration.settings.flowControl"),
          "set-serial-flow-control",
          select(
            FLOW_CONTROLS,
            draft.flowControl,
            (f) => t(`integration.settings.flowValue.${f}`),
            (flowControl) => edit({ flowControl }),
            "set-serial-flow-control",
          ),
        ),
      ],
    );
    advanced.addEventListener("toggle", () => {
      advancedOpen = advanced.open;
    });

    const apply = async ({ force = false } = {}) => {
      const next = normalizeConnection({
        ...draftOf(conn),
        needsConfig: false,
      });
      if (!next) return;
      const refuse = (text, extra = {}) => {
        notes.set(conn.id, { kind: "warn", text, ...extra });
        render();
      };
      if (isReservedConnectionName(next.name)) {
        return refuse(
          t("integration.settings.reservedName", { name: MOCK_NAME }),
        );
      }
      if (!next.port) return refuse(t("integration.settings.noPort"));
      if (!force) {
        const found = (await scan()).some((p) => p.path === next.port);
        if (!found) {
          return refuse(
            t("integration.settings.portAbsent", { port: next.port }),
            { override: true },
          );
        }
      }
      drafts.delete(conn.id);
      notes.set(conn.id, {
        kind: "ok",
        text: t("integration.settings.applied"),
      });
      commitList(list.map((c) => (c.id === conn.id ? next : c)));
    };

    const noteLine = note
      ? el("p", {
          class: `settings-hint integration-note integration-note--${note.kind}`,
          role: "status",
          text: note.text,
        })
      : null;

    // A warning that can be overridden turns Apply itself into "Apply anyway"
    // rather than adding a button of its own — the override IS the next apply,
    // and a second row of buttons is room the panel does not have. Any edit
    // clears the warning, and with it the override.
    let override = note?.override === true;
    const applyBtn = el("button", {
      class: "settings-action settings-action--primary",
      type: "button",
      text: override
        ? t("integration.settings.applyAnyway")
        : t("integration.settings.apply"),
      disabled: !isDirty(conn) && !flagged && !problem,
      id: "set-serial-apply",
      onClick: () => void apply({ force: override }),
    });

    // The buttons hug the rows above them and the note follows them, the
    // order the AI tab's key buttons and status line take.
    editor.replaceChildren(
      field(t("integration.settings.name"), "set-serial-name", nameInput),
      field(
        t("integration.settings.port"),
        "set-serial-port",
        el("div", { class: "integration-port-row" }, [portSelect, rescan]),
        { problem: Boolean(problem) },
      ),
      field(
        t("integration.settings.baud"),
        "set-serial-baud",
        select(
          BAUD_RATES.includes(draft.baud)
            ? BAUD_RATES
            : [...BAUD_RATES, draft.baud].sort((a, b) => a - b),
          draft.baud,
          String,
          (baud) => edit({ baud }),
          "set-serial-baud",
        ),
      ),
      field(
        t("integration.settings.language"),
        "set-serial-language",
        buildSegmented({
          options: LANGUAGES.map((value) => ({
            value,
            label: t(`integration.settings.languageValue.${value}`),
          })),
          value: draft.language,
          ariaLabel: t("integration.settings.language"),
          onPick: (language) => edit({ language }),
        }),
        { note: t("integration.settings.languageHint") },
      ),
      advanced,
      el("div", { class: "settings-row settings-row--actions" }, [
        openWindowButton(conn.id),
        applyBtn,
      ]),
      ...(noteLine ? [noteLine] : []),
    );
  }

  render();
  void scan(); // the Port list fills in, and a missing port shows red

  // What a connection is FOR sits behind an (i) at the end of the bar, as
  // every explanatory note in Settings does: printed, it cost the lines the
  // editor needs to fit the card. The card floats over the editor, positioned
  // against the bar (`.settings-note`'s rule).
  const hint = el(
    "div",
    {
      class: "settings-note",
      id: "integration-settings-note",
      role: "note",
      hidden: true,
    },
    [el("p", { class: "settings-hint", text: t("integration.settings.hint") })],
  );
  const info = buildInfoButton({
    target: hint,
    label: t("settings.noteToggle", { label: t("settings.nav.integration") }),
  });

  return {
    rows: [
      el("div", { class: "settings-row integration-picker" }, [
        picker,
        addBtn,
        removeBtn,
        info,
        hint,
      ]),
      editor,
    ],
  };
}
