# Feature 130 — Buses: bundled multi-bit signals

## Context

Wires today are one `{ id, from, to, color }` at a time (Feature 50). That is fine for
a handful of gate connections, but the moment a design has an 8-bit data path or a
16-bit address path — exactly what the memory chips of Features 170–190 need — the desk
becomes an unreadable thicket, and laying sixteen wires one click-pair at a time is
tedious and error-prone.

Real bench builds group these into a labelled ribbon or a mental "bus": `D0..D7`,
`A0..A15`. A bus is not a new electrical object — each bit is still its own net on its
own hole — it is a **naming + drawing convenience** that makes parallel signals legible
and fast to route.

Prerequisites: Features 50 (wires), 120 (net names — a bus is a named set of nets).

## Goal

Introduce a **bus**: a named, ordered set of single-bit nets (`name[hi:lo]`) that draws,
routes, and reads as one unit, while remaining N independent wires and N independent
nets underneath. Attaching a bus to a chip's pin-range lays all its wires in one
gesture.

## Design decisions (settled)

### A bus is metadata over wires, not a new wire type

`doc.buses`: `{ id: "bus<n>", name, width, color, members: [wireId…] }`. Each member is
an ordinary wire that already exists in `doc.wires`; the bus just records which wires
belong to bit 0..width-1 and in what order. Deleting a bus offers "keep wires" (unbundle)
or "delete wires" (cascade). Deleting a member wire shrinks the bus, never corrupts it.
The netlist, occupancy, and engine are **completely unchanged** — they still see plain
wires. This is the Feature 110 "strips stay in `doc.boards`" move applied to wires.

### The bus tool lays a run at once

Arming the bus tool (shortcut `B`) and clicking a **start hole then an end hole** on two
parallel hole-runs lays `width` wires between the two aligned ranges (bit *i* → column
*i* offset on each side), snapping to consecutive holes. A second mode taps a bus onto a
**chip pin-range**: pick the chip, pick the first pin of a labelled group (the catalog
marks pin groups — see below), and the tool fans the bus's bits to that pin run. Illegal
targets (occupied holes, wrong width) tint red exactly like the wire rubber-band.

### Bus width and bit order come from its name

The name grammar `D[7:0]` (msb:lsb) or `A[0:15]` sets width and direction; a bare name
defaults to width 1 (a degenerate bus, i.e. a named single wire). Bit order drives which
member maps to which chip pin, so a `[7:0]` data bus wires D7 to the high pin.

### Catalog pin groups

Add an optional `pinGroups` block to chip defs (pure data): `{ name: "D", pins: [8,9,…],
dir: "io" }`. It names contiguous functional pin runs (data, address, control) so the
bus-tap mode knows where a bus lands and the schematic view (150) can draw a bus stub
instead of eight pin stubs. Existing chips get no groups and behave exactly as today.

### Rendering: one fat line, N thin wires

A bus renders in `WireLayer` as its member wires PLUS a translucent "bundle" band traced
along their shared corridor (a hull of the member paths, `desk/rect-outline.js`-style),
carrying the bus name at its midpoint. Selecting the band selects the bus (whole-bus
drag/recolor/delete); the individual wires remain independently selectable underneath.

## Implementation steps

1. **`model/desk-doc.js`** — `buses` array + `nextBusId`; `addBus(name, memberIds)`,
   `updateBus`, `removeBus(id, { cascadeWires })`; a bus-name parser
   (`parseBusName → { base, width, order }`). `normalizeDocument` drops dangling member
   ids and repairs width.
2. **`app/store/migrations.js`** — additive: default `buses: []`.
3. **`catalog/*.js` + `catalog/index.js`** — optional `pinGroups` on chip defs; a
   catalog-integrity test asserting group pins exist and don't overlap.
4. **`components/bus-tools.js`** (new, sibling to `wire-tools.js`) — the `B` tool: the
   two-hole run mode and the pin-tap mode, both emitting a batch `addWire` + `addBus`
   in one doc change. Shares `#mode` through the host facade, like `wire-tools.js`.
5. **`components/wire-layer.js`** — draw the bundle band + name for each bus; band hit
   target selects the bus; member wires keep their own hit strokes.
6. **`components/desk-controller.js`** — mount/route the bus tool; whole-bus drag moves
   all member endpoints that ride a board (reuses the wire whole-drag path per member);
   bus context menu (rename, recolor, unbundle, delete).
7. **`sim/` guard test** — settling a doc is byte-identical whether its wires are bare
   or bundled into buses (buses are inert to the engine).
8. **Tests** — bus name parsing; a run-tap lays width consecutive wires on aligned
   holes; a pin-tap fans to a `pinGroups` run in bit order; delete-with/without cascade;
   shrinking a bus by deleting one member.

## Acceptance criteria

- Naming a bus `D[7:0]` and dragging start→end lays eight wires and one bundle band.
- Tapping that bus onto a chip's `D` pin group wires all eight to the right pins in bit
  order, refusing an illegal landing with a red tint.
- The bundle selects/drags/recolors as one; individual wires still select underneath.
- The netlist and every simulated level are identical to the same wires drawn by hand.

## Constraints

- A bus is metadata; the netlist/occupancy/engine never learn buses exist.
- Wires re-render only on doc change or board drag (bundle band included) — never on
  pan/zoom.
- One hole still holds at most one lead; a bus lays one wire per hole, no exceptions.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: place two chips, define `D[7:0]`, run the bus between their data pins in one
gesture; recolor and drag the bundle; probe bit 3 and confirm it is its own net; delete
the bus keeping wires, then re-bundle them.
