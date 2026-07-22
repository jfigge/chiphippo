# Feature 140 — Build guide, wiring list & BOM

## Context

The whole point of Chip Hippo is to design a circuit you can then **build on a real
breadboard**. Everything needed to describe that build already exists in the document:
boards and their positions, chips with `ref`/`anchor`/orientation, discretes, PSU/clock
bricks, wires as hole-to-hole addresses, and (after Features 120/130) net names and
buses. What is missing is the *rendering of that data as instructions a person can
follow at the bench*.

This is the first half of the "schematic diagrams that can be followed" goal — the
textual, checklist half. The graphical schematic is Feature 150; exporting either as a
file is Feature 160.

Prerequisites: Features 40–60 (components/wires/discretes), 70 (netlist), 120 (net
names), 130 (buses, optional but used when present).

## Goal

Generate, from the live document, three linked artifacts: a **bill of materials** (what
to buy), a **wiring list** (every connection as `from → to`, grouped by net), and an
ordered **build guide** (place these parts, then run these wires, step by step) — all
pure derivations, all readable, all export-ready for Feature 160.

## Design decisions (settled)

### A pure builder module, DOM-free and tested

`model/build-plan.js` takes a plain document (+ the netlist) and returns a structured
plan object: `{ bom, nets, steps, warnings }`. No DOM, no formatting — just data, so it
is unit-testable with `node --test` against in-code fixtures, exactly like the sim
package. The view and the exporter (160) format this object; they never re-derive it.

### BOM counts by catalog identity

`bom` groups components by `ref` with a count and the catalog title/blurb
(`74LS245 ×2`, `LED (red) ×4`, `Full 830 breadboard ×1`). PSU/clock bricks and boards
are line items too — a build needs them. Quantities come straight from `doc.components`
+ `doc.boards`.

### The wiring list is net-centric and human-addressed

For each net (Feature 70), list its members as human addresses, preferring a **net
name** when present (`VCC`, `D3`) and a **component-relative label** where possible
("7400 pin 3", "LED anode") over a bare `bb1.a5`. Rail members collapse to
"+ rail (top)". A net with one member is flagged (a likely-forgotten connection). Buses
render as one grouped block (`D[7:0]: chip U1 pins 11–4 → RAM pins 9–17`).

### Build order is dependency-lite but sensible

`steps` orders the build the way a person actually works: (1) place boards, (2) seat
power bricks and run rail power, (3) seat chips (with orientation + the exact anchor
rows, "7400 straddling e5–f11, pin 1 at e5"), (4) seat discretes, (5) run signal
wires grouped by net, buses first. Each step is a checklist item with a stable id so a
future interactive mode can tick them off. This is ordering, not a solver — no attempt
at electrical build-sequencing beyond "power and parts before signal wires".

### Warnings surface un-buildable or suspect design

Floating leads (Feature 110), single-member nets, un-powered chip VCC/GND, and a chip
pin left unconnected that the datasheet marks "do not float" become plan `warnings` —
the build guide says so up front rather than letting someone wire a dud.

## Implementation steps

1. **`model/build-plan.js`** (new, pure) — `buildPlan(document, netlist)` →
   `{ bom, nets, steps, warnings }`; helpers to turn an address into the friendliest
   label (net name → component-pin → rail → bare hole), reusing `occupancy.js`
   `partPinAddresses` and the catalog pin metadata.
2. **`components/build-guide.js`** (new view) — a dockable/toggled panel (or a
   PopupManager modal) rendering the plan as three tabs (BOM / Wiring / Steps) with
   live counts; refreshes on `chiphippo:doc-changed`.
3. **`components/desk-controller.js`** or `app.js` — a header/menu action "Build guide"
   that opens the panel; the panel reads the same `DeskDoc` + `NetlistCache` the
   controller already owns.
4. **Net-name + bus integration** — prefer names from Feature 120 and group by bus from
   Feature 130 when those arrays are populated; degrade cleanly to bare addresses when
   they are not.
5. **Tests** — a fixture desk (two chips, an LED, a PSU, a few wires) yields the
   expected BOM counts, a net-grouped wiring list with friendly labels, an ordered step
   list (boards→power→chips→discretes→wires), and the right warnings (inject a floating
   lead + a one-member net).

## Acceptance criteria

- Opening the build guide on any design lists every part with correct counts, every net
  with its connections in human terms, and an ordered set of build steps.
- Named nets and buses appear by name; unnamed nets fall back to component-relative
  addresses, never raw net keys.
- Floating leads and single-member nets are called out as warnings.
- The builder is a pure function with full unit coverage; the panel only formats it.

## Constraints

- `build-plan.js` is DOM-free and import-clean of any view code (mirrors `sim/`).
- No new document fields — the plan is a *derivation*, recomputed, never stored.
- The guide reflects the live doc; it must not drift after edits (rebuild on change).

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: build a small counter, open the build guide, and confirm you could hand it
to someone with a breadboard and a parts bin and they would wire the same circuit;
introduce a floating LED lead and watch the warning appear.
