# Feature 150 — Schematic view (derived logical diagram)

## Context

The desk is a **physical** layout — where each DIP actually sits, which hole each lead
occupies. That is what you build, but it is not how an engineer reasons about a circuit.
A **schematic** is the *logical* view: gate/chip symbols connected by named nets, laid
out for readability, with none of the breadboard geometry. The build guide (Feature 140)
gives the textual half of "a schematic that can be followed"; this feature gives the
graphical half.

Everything needed is already derivable: the netlist (Feature 70) is the connection
graph, the catalog carries pin names/roles, Feature 120 gives nets their names, and
Feature 130 gives buses. What is missing is a second **rendering** of that graph as a
symbol diagram.

Prerequisites: Features 70 (netlist), 80/100 (chip defs + pin roles), 120 (net names),
130 (buses).

## Goal

A **read-derived schematic view**: toggle from the breadboard to a logical diagram where
each chip is a labelled symbol, each net is a routed connection (named nets as labels,
power/ground as bus symbols, buses as fat lines), auto-laid-out with manual nudge. It
stays in sync with the desk — the desk remains the source of truth; the schematic is a
projection.

## Design decisions (settled)

### Derived, not a parallel editor (this stage)

The schematic is generated from the document + netlist, never hand-authored. This
sidesteps the hardest problem (two editable representations kept in sync) and delivers
the goal — a followable diagram — with far less risk. Manual adjustments are limited to
**symbol position** (drag a symbol; its net routing reflows) and are stored as a
per-component `schematicPos` hint, so a re-layout never destroys the user's arrangement.
A future feature can promote it to a full editor.

### Symbols are data, like footprints

`catalog/symbols.js` (pure data) gives each chip a logical symbol: a box with named pin
stubs grouped by side (inputs left, outputs right, power top/bottom, `pinGroups` from
Feature 130 collapsed to one bus stub). Gates may carry a classic distinctive-shape glyph
(AND/OR/XOR/NOT/buffer) keyed off the same `logic.units` the evaluator uses; everything
else is a rectangle with pin labels. No per-chip drawing code — a new part is a symbol
record, exactly as it is a footprint record.

### Layout: layered, deterministic, nudgeable

A pure `model/schematic-layout.js` assigns symbols to columns by signal-flow depth
(inputs → gates → outputs, power rail pinned to the margins) and rows to minimize
crossings with a cheap barycentric pass. Deterministic (no `Math.random`, per the
engine rules) so the same design always lays out the same way. Net routing is
orthogonal (Manhattan) between pin stubs; named power/ground nets do **not** route — they
drop a `VCC`/`GND` symbol at each pin, the way real schematics avoid rail spaghetti.

### A separate surface, same camera discipline

The schematic renders on its own pannable/zoomable surface (`SchematicView`, reusing
`desk/desk-geometry.js` camera math and the transform-only pan/zoom rule). A header
toggle (or `Tab`) switches Breadboard ⇄ Schematic; both read the one `DeskDoc`. Probing
a net highlights it in **both** views (shared net id), tying the physical and logical
pictures together.

### The simulation drives it live

When running, symbol pins and net wires tint by level from `chiphippo:sim-state`
(Feature 90/100) exactly as the breadboard does — LEDs, chip health, and net levels read
identically in the schematic. The schematic never queries the engine; it renders the
same broadcast the desk does.

## Implementation steps

1. **`catalog/symbols.js`** (new, pure) — a symbol record per chip def (sides, pin
   labels, optional gate glyph, collapsed bus stubs); integrity test that every catalog
   chip has a symbol and every symbol pin maps to a real pin.
2. **`model/schematic-layout.js`** (new, pure) — `layout(document, netlist, symbols,
   posHints)` → `{ nodes: [{id, x, y, symbol}], edges: [{net, points}], powerStubs }`;
   deterministic layered placement + orthogonal routing; honours `schematicPos` hints.
3. **`model/desk-doc.js`** — optional `schematicPos` per component (a `{x,y}` hint);
   `setSchematicPos(id, x, y)`. Additive migration.
4. **`components/schematic-view.js`** (new) — the schematic surface: render nodes/edges
   as SVG, symbol drag → `setSchematicPos`, camera pan/zoom, net hover/probe highlight,
   live level tint from `chiphippo:sim-state`.
5. **`app.js` / header** — a Breadboard ⇄ Schematic toggle; the probe and selection are
   shared (net id is the common key).
6. **Tests** — layout is deterministic and crossing-reduced on a fixture; power nets
   emit stubs not routes; a `pinGroups` bus renders as one stub; symbol integrity;
   moving a symbol persists and reflows only its edges.

## Acceptance criteria

- Toggling to the schematic shows every chip as a labelled symbol with its nets routed
  and named, power/ground as rail symbols, buses as single fat lines.
- Dragging a symbol reflows its connections and survives reload and re-layout.
- Running the sim tints the schematic live, matching the breadboard.
- Probing a net highlights it in both views at once.

## Constraints

- Schematic is **derived** — the desk stays the single source of truth; only position
  hints are stored.
- No per-chip symbol code and no `Math.random` in layout (deterministic, per engine
  rules).
- Pan/zoom is transform-only; symbols/edges rebuild only on doc or sim-state change.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: build a 2-gate latch, toggle to the schematic, confirm it reads like a
textbook drawing; run it and watch the nets tint; drag a symbol to tidy it and reload to
confirm the arrangement stuck.
