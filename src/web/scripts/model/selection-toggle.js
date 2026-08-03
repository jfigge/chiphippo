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

// selection-toggle.js — the pure half of the ADDITIVE selection gesture: the
// modifier-click that adds ONE item to the selection, or takes one back out,
// beside the shift-drag marquee that REPLACES the whole thing.
//
// It lives out here for the reason part-move.js does — the two halves that are
// easy to get wrong are pure, and one of them is a PLATFORM branch, i.e. a
// piece of logic that by construction is only ever exercised on one side.

/**
 * Is this pointer event the add-to-selection chord?
 *
 * **⌘ on macOS, Ctrl everywhere else** — each platform's own additive-select
 * modifier, and the same split the app's shortcut glyphs already make.
 *
 * CTRL CANNOT BE IT ON A MAC, and the reason is worth keeping written down
 * because the key is the obvious one to reach for: there Ctrl-click IS the
 * system's secondary click. Admitting it would mean the press arriving as
 * button 2, and raising a `contextmenu` the desk would then have to SWALLOW —
 * one press cannot both toggle the selection and open a menu over the top of
 * it — so Ctrl-click would stop opening any context menu on the desk. ⌘ costs
 * none of that and is what every other list on the platform answers to.
 *
 * Shift and Option are excluded rather than merely ignored. Shift-drag
 * rubber-bands a marquee and Option-drag carries a part's wiring (or tears a
 * board run off its group), so a chord carrying either belongs to that
 * gesture — a modifier-click must never quietly claim the press first.
 *
 * @param {{metaKey?:boolean, ctrlKey?:boolean, shiftKey?:boolean,
 *          altKey?:boolean, button?:number}|null} e
 * @param {boolean} isMac
 * @returns {boolean}
 */
export function isToggleSelectEvent(e, isMac) {
  if (!e || e.shiftKey || e.altKey) return false;
  if (!(isMac ? e.metaKey : e.ctrlKey)) return false;
  // The PRIMARY button, so Ctrl+right-click off a Mac stays a right-click. An
  // event carrying no button at all is judged on its modifiers alone.
  return e.button == null || e.button === 0;
}

const KINDS = ["parts", "wires", "boards"];

/**
 * Toggle `ids` of one kind in a selection, returning the whole new selection.
 *
 * A call is **all-or-nothing**: a set already fully selected comes out, and
 * anything else goes in. That is what makes a BOARD work — a modifier-click on
 * one strip of a snapped kit toggles the whole group, and a group only PARTLY
 * selected (a marquee that caught two strips of three) completes rather than
 * half-clearing, which is an answer the next click can undo.
 *
 * The three sets are kept apart because that is how the desk's selection is
 * held: parts, wires and boards each drive their own highlight, and a design
 * clip reads boards and parts separately.
 *
 * @param {{parts?:Iterable<string>, wires?:Iterable<string>,
 *          boards?:Iterable<string>}|null} current
 * @param {"parts"|"wires"|"boards"} kind
 * @param {Iterable<string>} ids
 * @returns {{parts:string[], wires:string[], boards:string[]}}
 */
export function toggleSelection(current, kind, ids) {
  const next = {
    parts: new Set(current?.parts ?? []),
    wires: new Set(current?.wires ?? []),
    boards: new Set(current?.boards ?? []),
  };
  const targets = [...(ids ?? [])];
  if (KINDS.includes(kind) && targets.length > 0) {
    const set = next[kind];
    const selected = targets.every((id) => set.has(id));
    for (const id of targets) {
      if (selected) set.delete(id);
      else set.add(id);
    }
  }
  return {
    parts: [...next.parts],
    wires: [...next.wires],
    boards: [...next.boards],
  };
}

/**
 * The one item a selection holds, as a `{kind, id}` single pick — or null when
 * it holds none or several.
 *
 * A modifier-click that lands on exactly one item COLLAPSES to the desk's
 * ordinary single pick, so an item selected this way behaves exactly as one
 * selected by a plain click: R rotates it, its Properties dialog opens, the
 * Option ride hint rings its wires. A one-item multi-selection would look
 * identical and quietly do none of that.
 *
 * @param {{parts:string[], wires:string[], boards:string[]}} sel
 * @returns {{kind:"part"|"wire"|"board", id:string}|null}
 */
export function singlePick(sel) {
  const total = sel.parts.length + sel.wires.length + sel.boards.length;
  if (total !== 1) return null;
  if (sel.parts.length) return { kind: "part", id: sel.parts[0] };
  if (sel.wires.length) return { kind: "wire", id: sel.wires[0] };
  return { kind: "board", id: sel.boards[0] };
}
