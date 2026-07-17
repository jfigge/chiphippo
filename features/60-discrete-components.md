# Feature 60 — Switches, LEDs & power sources

## Context
Boards, chips, and wires exist (30–50) but circuits still have no inputs, outputs,
or power. This stage completes the buildable inventory with three **discrete parts**
(slide switch, push button, LED) that seat into board holes through the Feature 40
component framework, and **power supply bricks** (3 V / 5 V / 12 V) that sit
directly on the desk with addressable `+`/`−` terminals for wiring into the rails.
Everything here is placement, rendering, and model contracts — the parts come alive
in Features 70/90.

## Goal
The palette gains a "Parts" group; the user can seat switches, buttons, and LEDs on
boards, drop PSU bricks on the desk, set a PSU's voltage, wire PSU terminals to rail
holes, flip an LED's polarity at placement, and see it all persist — with each
part's electrical contract (pins, internal bridges, source behavior) defined in the
catalog for the netlist and simulator to consume later.

## Design decisions (settled — do not relitigate)
- All three board parts are `kind: "discrete"` components using the Feature 40
  model (`ref`, `board`, `anchor`, `params`) and occupancy rules; the PSU is
  `kind: "psu"`, desk-level: `{ id, kind: "psu", x, y, params: { volts } }` snapped
  to the pitch lattice, **not** seated on a board.
- **Slide switch (SPDT)** — ref `sw-slide`: 3 pins in consecutive columns of one
  row (anchor = pin 1; pins at anchor, +1, +2 columns). Electrical contract: common
  is the center pin; state `params.pos ∈ "1" | "2"` bridges center↔pin1 or
  center↔pin3. Toggled by click (always interactive — no sim needed to flip it).
- **Push button (momentary SPST)** — ref `sw-push`: 2 pins two columns apart
  (anchor, +2 — matching a real 6 mm tactile's span). Bridges its pins only while
  pressed (`pointerdown`→`pointerup` on its cap); `params` stores nothing durable.
- **LED** — ref `led`: 2 pins in adjacent columns of one row; `params.color ∈ red |
  green | yellow | blue`, `params.flip` swaps anode/cathode (anode at anchor by
  default). Rendered as a dome + flat-side cathode cue; unlit (dim body tint) until
  the simulator drives it. Placement ghost supports `F` to flip and color chosen
  from a swatch popover on the palette entry. **Idealized: no resistor required**
  (a deliberate simplification noted in the palette blurb; resistors are backlog).
- **PSU brick** — refs share one def with `params.volts ∈ 3 | 5 | 12`: a small desk
  widget (rounded brick, voltage badge, red `+` and black `−` terminal pads).
  Terminals are addressable as `psu1.+` / `psu1.−` and participate in occupancy and
  wiring exactly like holes (Feature 50's wire tool accepts them) — this requires
  the address scheme's owner segment to resolve components as well as boards, which
  lands here as a small extension to `parseAddress`/occupancy/wire endpoint
  resolution. Voltage is switchable after placement via context menu. Multiple PSUs
  allowed.
- **Electrical contracts live in the catalog** (`catalog/parts.js`): each def
  declares `pins`, plus for discretes an `internalBridges(params, state)` function
  (switch/button connectivity) and for the PSU a `source` marker
  (`{ plus: volts, minus: 0 }`). Feature 70 consumes bridges; Feature 90 consumes
  sources. Defs are pure data + pure functions, tested.
- **Rendering**: CSS-drawn like chips — switch body with visible slider position,
  button cap that depresses while pressed, LED dome colored per `params.color`,
  PSU brick with badge. All in `.layer-parts`; selection/drag/delete behavior
  identical to chips (PSU drags on the desk like a board).

## Implementation steps
1. **Catalog defs + tests.** `parts.js` with the four defs, footprint offsets,
   `internalBridges`, PSU `source`; integrity tests (pin uniqueness, bridge pins
   exist, volts enum).
2. **Address/occupancy extension.** Component-terminal addresses (`psu1.+`) parse,
   occupy, and resolve to world positions; wire endpoints accept them. Tests.
3. **Desk-doc ops.** Add/move/remove for discretes (reuse chip paths) and PSUs
   (desk-level, overlap allowed with nothing — bricks just can't cover boards);
   voltage change op; LED flip at placement.
4. **Views.** `DiscreteView` (switch/button/LED variants from the def) and
   `PsuView`; interactive slider click and button press states (visual only for
   now, but state changes emit `chiphippo:part-state` for later stages); palette
   "Parts" group with LED color swatches.
5. **jsdom tests.** Views render per params; slider click flips `params.pos`;
   button press toggles a pressed class; PSU badge shows volts.

## Acceptance criteria
- All four part types place with legality ghosts, render distinctly, move/delete,
  and persist (including switch position, LED color/flip, PSU volts).
- A wire can run from `psu1.+` to `bb1.t+3` and from a switch pin to a chip pin's
  neighboring hole; terminals respect one-lead-per-point.
- Clicking a slide switch flips it visibly; holding a push button depresses it;
  both emit `chiphippo:part-state`.
- Catalog contracts pass their tests; `make fmt && make lint && make test` green.

## Constraints
- Contracts (bridges/sources) are catalog data + pure functions — no electrical
  logic in views, none in the netlist yet.
- Everything flows through `desk-doc` + occupancy; addresses only, no pixels.
- House rules: theme tokens (LED/wire reds must share tokens), class naming,
  pointer-capture drags, popup-manager menus.

## Verify
`make fmt && make lint && make test`, then `make debug`: build the classic starter
board — PSU(5 V) wired to the rails, rails wired to a 7400's VCC/GND holes, a slide
switch and a push button feeding gate inputs, an LED on the output column — flip
the switch and press the button (visual state only), change PSU to 12 V via its
menu, relaunch and confirm the whole bench restores.
