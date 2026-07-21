# Feature 200 — Undo / redo & command history

## Context

Every document mutation today goes straight into `DeskDoc` and emits
`chiphippo:doc-changed`; the controller autosaves and (with the schematic-files feature)
tracks dirty against a saved baseline. There is **no undo**. As designs grow — buses,
memory systems, whole schematics — a mis-drag, a wrong delete, or a bad paste has no
recovery except manual reversal. Copy/paste and multi-select already exist, which raises
the stakes: one Delete can remove a marquee of parts and their wires.

This is the reliability floor the memory/schematic work leans on. It is intentionally
sequenced after the goal features so it can wrap **all** of them — a memory binding
change, a bus edit, and a wire drag are all just commands.

Prerequisites: the mutating surface of `DeskDoc` (Features 20–110) and the
`chiphippo:doc-changed` seam.

## Goal

A unified, multi-step **undo/redo** over every document mutation, with a bounded history,
sensible coalescing (a drag is one undo, not forty), and the standard shortcuts — so any
edit is reversible.

## Design decisions (settled)

### Snapshot-based history, not per-op inverse commands

The document is small and already fully serializable (that is how autosave and dirty
tracking work). Rather than write an inverse for every one of the dozens of `DeskDoc`
mutators (and keep them correct forever), history stores **immutable document
snapshots**. Undo = restore the previous snapshot; redo = restore the next. This is
robust, trivially correct for new mutators (they need no undo code), and cheap for a
document of this size. If snapshots ever get heavy, structural sharing or a diff can be
introduced behind the same interface — but not now.

### One choke point: commit through the doc-changed seam

A `HistoryStore` subscribes to committed mutations. The clean seam is a single
`DeskDoc.commit(label)` (or a thin wrapper the controller already funnels through) that
snapshots **after** each logical edit and pushes it with a label ("move board", "paste
7400", "delete selection"). The label drives coalescing and a future history UI. Because
everything already routes through `#emitDocChanged`, this is one well-defined insertion
point, not a scatter of call sites.

### Coalescing by gesture, not by tick

A drag mutates the doc once on commit (drags translate live via overrides, then commit —
Features 30/50/110), so it is naturally one snapshot. For anything that could burst
(e.g. rapid param nudges), the store coalesces consecutive same-label edits within a
short window into one entry. A gesture in flight never lands a half-state in history —
snapshots are taken on commit only.

### Run-volatile state is excluded

Simulation state, clock phase, live memory images, and 12 V damage-during-run are
**run-volatile** and already outside the persisted document. Undo operates on the design,
not on a running simulation; history is cleared or frozen on Run and restored on Stop,
so you cannot "undo" into the middle of a sim. Undo of a *persisted* effect (memory
binding change, applied damage) is a normal document edit and is covered.

### Bounded and reset on load

History is bounded (e.g. 100 entries, oldest dropped) to cap memory, and cleared on
New/Open (a fresh document starts a fresh history). The saved baseline for dirty tracking
is independent — undoing past the last save correctly re-marks dirty.

## Implementation steps

1. **`model/history-store.js`** (new, pure) — a bounded past/future snapshot stack:
   `record(snapshot, label)`, `undo()`, `redo()`, `canUndo`/`canRedo`, `clear()`, with
   same-label coalescing in a time window (window/clock injected, no `Date.now()` in the
   pure core — the controller stamps time).
2. **`model/desk-doc.js`** — a `snapshot()` / `restore(snapshot)` pair (deep clone of the
   plain document) and a `commit(label)` seam that emits `chiphippo:doc-changed` **with**
   the label; audit that every mutator funnels through it.
3. **`components/desk-controller.js`** — own the `HistoryStore`; record on each labelled
   commit; `undo()`/`redo()` restore a snapshot, re-mount the scene (reuse the
   full-rebuild path used by New/Open reload — the sanctioned teardown), and reselect
   sensibly; freeze/clear history on Run/Stop.
4. **`app.js` / `main.js` menu** — Edit ▸ Undo (⌘Z) / Redo (⇧⌘Z) wired through the
   existing `menu:*` push pattern (and the in-renderer `handleKeyDown`); enable/disable
   from `canUndo`/`canRedo`.
5. **Dirty tracking** — reconcile with the saved baseline: undo/redo re-evaluates dirty
   against `savedDoc` so the title marker is correct.
6. **Tests** — a sequence of edits undoes/redoes to byte-identical snapshots; coalescing
   merges a burst into one entry; history clears on Open; undo past the last save marks
   dirty; a drag is exactly one undo step; Run freezes history and Stop restores it.

## Acceptance criteria

- ⌘Z / ⇧⌘Z reverse and replay any sequence of design edits — placement, drag, delete,
  paste, wire, bus, rename, memory binding — restoring the exact prior document.
- A single drag or a marquee delete is one undo step, not many.
- History is bounded, cleared on New/Open, and consistent with the dirty marker.
- No new mutator needs bespoke undo code (snapshots cover them automatically).

## Constraints

- Undo restores through the existing full-rebuild teardown path — no partial, drift-prone
  re-mount.
- Run-volatile simulation state is never in history; history is frozen during a run.
- The pure history core takes no wall-clock of its own (no `Date.now()`), matching the
  engine's determinism rule.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: place and wire several parts, delete a marquee, paste a chip, then ⌘Z
repeatedly back to empty and ⇧⌘Z forward again; confirm a single board drag is one step
and that Open clears the stack.
