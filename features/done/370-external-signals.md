# Feature 370 — External signals

**Prerequisites:** 50 (wires as addresses), 70 (netlist), 90 (the engine's
strength tiers), 100 (the clock source this borrows its driver shape from),
110 (strips), 200 (one commit seam per gesture), 210 (the analyzer this hands
nets to), 240 (design clips).

> Numbering note: `features/done/` topped out at **340**; **350** is claimed by
> the uncommitted CPU-inspector work and **360** by `360-auto-routing.md`, so
> this stage is **370**.

---

## Context

Chip Hippo can build and run a circuit, but it has no way to **stimulate** one
from outside. The only inputs a user can drive by hand are parts seated on a
board — a slide switch, a push button, a manual clock brick. Each costs holes,
columns and jumper wire, each has to be wired to the net it drives, and none of
them can be worked in combination: with one mouse you can hold exactly one push
button at a time, so a design needing "assert `/RESET` while `/OE` is low"
cannot be exercised at all.

A bench has the opposite arrangement. The stimulus lives *off* the board — a
signal generator, a logic pod, a switch box — and reaches the circuit through a
single lead you plant wherever you want to inject.

## Goal

Eight bench stimulus buttons per desktop, pinned down the right edge of the
viewport, each plugged into the circuit by a coloured **flag** whose point sits
in one breadboard hole. A placed signal always drives its net; a **momentary**
button asserts the opposite of its resting level while held, a **toggle** flips
and stays. **`1`–`8` press them from the keyboard while the circuit runs**,
several at once.

## Design decisions (settled)

- **The keyboard is plain `1`–`8`, and only while the simulation runs.**
  Conflict-free by construction: `DeskController.handleKeyDown` consumes `1`–`9`
  *only* when the wire or bus tool is armed, and `setEditingLocked(true)`
  disarms both on Run. No modifier means several digits hold together, which is
  the entire point of the feature.
- **A placed signal always drives its net, at CHIP-OUTPUT strength** — the
  `chipLevels` tier of `sim/resolve.js`, the same tier and the same sentence as
  a clock source. Two signals disagreeing on one net, or a signal fighting a
  chip output, therefore reports `conflict` → `X` with **zero new code**. A
  fourth strength tier would have had to re-define what beats what.
- **A toggle's live level is run-volatile** — seeded from `rest` on Run, cleared
  on Stop, never serialized, exactly like `#clockPhase`. `rest` is the single
  durable answer to "what is this signal holding"; a stored level would be a
  second one.
- **"Signal button" and "signal flag"**, never "net label": `doc.netNames`
  already exists (address→name bindings), and two things called a net label
  would confuse permanently.
- **In scope:** design clips, a schematic symbol, a logic-analyzer hand-off.
  **Out of scope:** the build guide and BOM (a signal is bench stimulus, not a
  part you buy or solder), and user-positionable rails.

## Design

### A signal is neither a component nor decoration

It is the first desk item that is neither. An annotation is invisible to
occupancy, the netlist and the engine; a wire is visible to occupancy and the
netlist; a **flag is visible to occupancy and the engine**, and is neither.

Exactly three modules assume "everything electrical is a component" —
`buildOccupancy`, `buildContext` and `schematic-layout`'s `layout()`. Each
gained **one new loop**, and each must stay the only one. Making a signal a fake
component kind would have dragged in footprints, a catalog def,
`normalizeParams`, `partPinAddresses`, the part context menu's fixed three-item
shape, the BOM and the build guide — none of which has anything to say about a
bench button.

### The record

```js
{ id: "sig1",              // sig<n>, from nextSignalId
  color: "red",            // a WIRE_COLORS token, UNIQUE across doc.signals
  type: "momentary",       // | "toggle"
  rest: "low",             // | "high"
  name?, description?,     // omit-when-empty, via applyMeta
  flag?: { anchor: "bb1.a12", rot: 0 } }   // ABSENT while unplaced
```

`color`/`type`/`rest` are stored **always**, departing from the
omit-when-default convention a wire's `layout` follows: that convention exists
to keep an existing serialized form byte-identical, and a signal has none.

### The cap is derived, never typed

`MAX_SIGNALS = SIGNAL_COLORS.length`, where `SIGNAL_COLORS` is the jumper
palette **minus black** — black is the bench's ground colour, so a black flag
reads as a ground tie and its button's dot vanishes against the dark rail. The
colour is not decoration; it is the identity that ties a flag on the desk to a
button on the rail. So one rule (*a signal owns a signal colour*) has two
consequences, uniqueness and the cap — and withdrawing black took the cap from
8 to **7** with no number edited anywhere. The keyboard is a separate fact:
`SIGNAL_DIGITS = min(MAX_SIGNALS, 9)`, because there are only nine digits.

### One rule for a flag that has nowhere to go

**A flag with nowhere to go stops existing; the signal never does.** Stated once
in `normalizeDocument` and reused verbatim by `removeBoard` and `pasteDesign`.

### Occupancy — and the ordering that is not obvious

A planted flag's point is a lead: one hole, one lead. The claim loop runs
**first** in `buildOccupancy`, before pins and wires. `buildOccupancy` is
last-writer-wins while `normalizeDocument` is first-wins, so appending it last
would invert the precedence. A normalized document never collides, but this also
runs against live mid-mutation documents, and of the two ways a collision could
read, a flag masking a wire END is the harmful one — `canReendWire` would then
refuse to move that wire's own end, wedging it for good.

### The rail must clear two existing tenants

`.desk-viewport`'s right edge already holds `.desk-lock` (top) and `.desk-zoom`
(bottom), and the app has **no `z-index` anywhere**. The existing convention was
extended rather than broken: `--desk-zoom-height` joins `--desk-lock-size` on
`.app-stage`, `.desk-zoom` itself consumes it so the two cannot drift, and the
rail is pinned between them.

### One drag, two entry points

"Drag the flag onto a board" and "move a planted flag" are the same act, so
there is one `drag-signal-flag`, one resolver and one commit. The rail chip is
not a coordinate-space problem: `worldFromEvent` reads client coordinates off
any event. The `drag…` name prefix is load-bearing — `#dragGestureActive`
derives from it.

| drop | result |
|---|---|
| free hole | plant |
| **bare desk** | **unplug** — back to the rail |
| occupied hole | revert (the ghost was red) |
| cancelled, or Run began mid-drag | revert |

`legal` is deliberately `true` over bare desk and `false` over a taken hole: a
mis-aim is not an intent to unplug.

**The preview redraws ONE polygon in place** (`SignalLayer.setPreview`) rather
than re-rendering the layer, and `setSelected` is a class toggle for the same
reason: the press selects the signal before beginning the gesture, and a
re-render there destroys the very `<polygon>` that press is about to capture.

### Simulation

`buildContext` gains a `signals` list; `driversFor` gains one line beside the
clock line; `signalLevels` threads through **all three** `solve` call sites
(`settle`, `tick`'s pre-settle, and `tick`'s inner-loop re-settle — missing the
third would drop every signal on a ripple tick). `sim/resolve.js` is untouched.

`SimController` owns `#signalLevel` (run-volatile), seeds it from each signal's
`rest` on `start()`, clears it on `stop()`, and republishes it on
`chiphippo:sim-state` so the rail lights up from the one broadcast.
**`pressSignal(id, on)` is the only public entry point** and the only place
momentary/toggle is decided — the rail and the keyboard both report down/up and
know nothing about it, so a key and a click can never come to disagree.

### Design clips bend all-or-nothing, once

A signal travels only when its flag is planted on a captured board (the wire
rule); an unplaced one stays behind. `color` is deliberately not captured — it
is a per-desk identity, so it is re-issued on arrival. Paste is **best-effort**:
out of colours → dropped (and reported); hole taken → arrives unplaced. Boards,
parts and wires stay all-or-nothing, because that rule exists to stop half a
design cutting the wires that crossed to the board left behind — and *a signal
cuts nothing*.

## Implementation steps

1. `model/signals.js` (+ test) — the cap, colour allocation, rail order, the
   flag polygon. `WIRE_COLORS` moved to `model/wire-colors.js` (re-exported from
   `desk-doc.js`, so no call site changed) to break the import cycle.
2. `desk-doc.js` — the list, the counter, the normalize block, and the signal
   API; `removeBoard` detaches flags.
3. `occupancy.js` — the claim loop (first) and `canPlaceFlag`.
4. Migration **v12 → v13**, which also repairs the `scopeChannels` drift
   Feature 210 left in main's `defaultDeskDocument()`.
5. `sim/engine.js` + `SimController`.
6. `components/signal-layer.js` (`.layer-signals`) and
   `components/signal-rail.js` + CSS.
7. `drag-signal-flag`, the `"signal"` selection branch, `R`, Delete, the
   context menu, the Properties card.
8. The `SIGNALS` palette folder and `place-signal`.
9. `model/signal-keys.js` and its wiring in `bindShortcuts`.
10. Design clips, the schematic stub, the analyzer hand-off.
11. i18n across all seven catalogs; the user guide.

## Acceptance criteria

- Picking *Signal* and clicking the desk adds a button on the right-edge rail
  with the next free colour; the ninth is refused with a tooltip saying why.
- Dragging a rail chip onto a free hole plants the flag; onto bare desk unplugs
  it; onto a taken hole reddens and reverts.
- `R` rotates a selected flag through four orientations about its point.
- Running, a momentary button (pointer or digit) drives the opposite of its
  resting level and returns on release; a toggle latches. **Holding `1`, `3` and
  `7` asserts three signals at once.**
- Every release path works: keyup, keyup inside a dialog, window blur mid-hold,
  and Stop mid-hold.
- A flag's hole is refused to a wire, a part pin and a wire re-end; deleting the
  board under a flag detaches it and keeps the signal.
- Two signals disagreeing, or a signal fighting a chip output, reports a
  conflict — with no new engine code.

## Constraints

- `parts-catalog.test.js`'s inventory is untouched — a signal is not a catalog
  part even though the palette gains a folder.
- No `z-index` anywhere. `sim/resolve.js` unchanged. `sim/` stays DOM-free, and
  `model/signals.js` must not import from it.

## Verify

`make lint && make test && make test-i18n`, then `make debug`: add two signals,
plant one on a 74LS161's `/CLR` node and one on `ENT`, Run, and hold `1` and `2`
together.
