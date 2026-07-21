# Feature 120 — Net names, labels & annotations

## Context

The netlist (`sim/netlist.js`, Feature 70) already partitions every point into stable
nets keyed by the lexicographically smallest member address (e.g. `bb1.a5`). That key
is an implementation artifact, not a name a human would write on a schematic. To build
a real circuit from a Chip Hippo design someone needs to read "this net is **VCC**",
"this is **CLK**", "these eight are **D0..D7**" — not "net `bb1.a5`".

There is also no way to write anything on the desk: no labels beside a chip, no note
explaining a sub-circuit, no legend. Every later goal — a schematic diagram, a
followable build guide, an exported image — needs nets to have **names** and the desk
to carry **annotations**.

Prerequisites: Features 70 (netlist), 30 (rendering/overlay layer), 50 (wires).

## Goal

Give nets a stable, user-assigned **name** that survives edits, and let the user drop
freeform **labels** and **notes** on the desk. Names flow into the probe readout, the
future schematic view, and the build guide. Nothing about the simulation changes — a
name is metadata on a net, never an electrical fact.

## Design decisions (settled)

### A net name binds to a member address, not the net key

Net keys are derived and can change when the smallest member address changes (delete
the wire on `bb1.a5` and the key becomes `bb1.a6`). A **name binding** is therefore
stored as `{ address, name }` in a new `doc.netNames` array — the user names the net
*by pointing at one hole/terminal on it*. On every netlist rebuild, each binding's
`address` is resolved to its current net; the net inherits the name. If two bindings
land on the same net (a merge), the lexicographically first wins and the loser is
reported as a soft conflict in the notification stack — never silently dropped.

### Reserved names are just names

`VCC`, `GND`, `CLK` carry no special power — the engine still derives power from PSU
volts and rail polarity (Feature 90). Naming a net `GND` is documentation. The palette
offers the common names as quick-picks, but any string is legal.

### Labels and notes live in `doc.annotations`

```
{ id: "an<n>", kind: "label" | "note", x, y, text, color?, anchor? }
```

A **label** is a short one-line caption (optionally `anchor`ed to a component id or an
address, so it rides that thing's drag). A **note** is a free-floating multi-line text
box on the desk. Both are pure desk decoration — pointer-selectable, draggable, and
ignored by occupancy, the netlist, and the engine. Ids come from a persisted
`nextAnnotationId`, mirroring `nextPsuId`/`nextGroupId`.

### One overlay renderer, no per-glyph DOM churn

Labels/notes render in a dedicated `.layer-annotations` between wires and the
interaction overlay (they sit above wires but below ghosts). One `AnnotationLayer` view
rebuilds only on doc change or annotation drag — never on pan/zoom (transform-only,
same discipline as `WireLayer`). Net-name badges render in the overlay near the named
hole, counter-scaled like the hover tooltip so they stay legible at any zoom.

## Implementation steps

1. **`model/desk-doc.js`** — add `netNames` + `annotations` arrays and
   `nextAnnotationId` to the document shape and `emptyDocument()`; `nameNet(address,
   name)` / `clearNetName(address)`; `addAnnotation(kind, x, y, text)` /
   `updateAnnotation(id, patch)` / `removeAnnotation(id)`. `normalizeDocument`
   validates/repairs both (drop a binding whose address no longer parses).
2. **`app/store/migrations.js`** — `DESK_DOC_VERSION` bump; default the two arrays to
   `[]` for older docs (a pure additive migration, no address rewriting).
3. **`sim/netlist.js`** — expose a `names` map on the netlist result: resolve each
   `netNames` binding to its net id and attach the name; report merge conflicts.
4. **`components/probe-inspector.js`** — the net readout shows the net **name** when it
   has one, and the probe menu gains "Name this net…" / "Clear name".
5. **`components/annotation-layer.js`** (new) — the `.layer-annotations` renderer
   (`el()` DOM), pointer-select + drag via the controller's gesture machine, dblclick
   to edit text inline.
6. **`components/desk-controller.js`** — mount the annotation layer; route label/note
   select/drag through the existing `#mode` state machine (a new `drag-annotation`
   kind); "Add label / Add note" enters a place-annotation ghost like a part.
7. **`components/board-toolbar.js`** / palette — an "Annotate" affordance (label, note)
   and the reserved-name quick-picks.
8. **Tests** — binding survives a net-key change (delete the smallest-address wire, name
   holds); merge conflict is reported not dropped; annotations round-trip through
   save/normalize; migration adds empty arrays; the engine result is byte-identical
   with and without names (naming is inert).

## Acceptance criteria

- Right-clicking a probed net offers "Name this net…"; the name shows in the readout
  and persists across reload.
- A named net keeps its name after edits that change its underlying net key.
- Labels and notes can be added, edited, dragged, and deleted; a label anchored to a
  chip rides the chip's drag.
- Naming or annotating never changes a single simulated level.

## Constraints

- Names/annotations are metadata — the engine, netlist partitioning, and occupancy
  stay unaware of them.
- No per-glyph DOM on pan/zoom; the annotation layer is transform-only.
- Addresses remain the only cross-module currency for holes (a name binds *by* address).

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: probe a rail, name it `VCC`; delete and redraw a wire on that net and
confirm the name holds; drop a note titled "clock divider"; drag a chip and watch its
anchored label follow; reload and confirm everything persisted.
