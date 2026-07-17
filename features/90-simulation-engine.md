# Feature 90 — Simulation engine v1

## Context
Everything is in place: topology (Feature 70 netlist), behavior (Feature 80 chip
library), sources and indicators (Feature 60 contracts). This stage connects them
into the first **living circuit**: a rudimentary but honest engine that seeds power
from the PSUs, checks each chip's VCC/GND, evaluates chip logic against net levels,
and **ripples** outputs back through the nets until the circuit settles — then keeps
reacting live as the user flips switches and holds buttons. LEDs finally light.

## Goal
Press **Run**: rails energize, powered chips compute, LEDs glow per net state, slide
switches and push buttons drive the circuit interactively, driver conflicts and
oscillations are detected and surfaced, and **Stop** returns to editing. An SR latch
built from two 7400 gates holds state — the proof the settle loop is real.

## Design decisions (settled — do not relitigate)
- **Engine is pure and renderer-hosted**: `src/web/scripts/sim/engine.js`
  (DOM-free, `node --test`-covered) consumes `{ document, partState, netlist }` and
  produces `{ netLevels: Map<netId, level>, chipStatus, warnings }`. UI layers
  subscribe; nothing in the engine touches DOM or IPC.
- **Digital abstraction with drive strengths.** Net level resolution per net, in
  precedence order: **supply** (any member PSU terminal: `+`→`H`, `−`→`L`;
  opposing supplies on one net → `X` + "short" warning) beats **chip output**;
  multiple chip outputs disagreeing → `X` + conflict warning (totem-pole TTL
  fighting); `Z` from 74125 contributes nothing; an undriven net is `Z`. No analog
  voltages on nets in v1 — voltage matters only at PSU/power checks.
- **Chip power gating.** A chip is *powered* iff its `vcc` pin's net is driven by a
  **5 V** PSU `+` and its `gnd` pin's net by a PSU `−`. Unpowered → all outputs
  `Z`, palette-grey badge. **3 V** on VCC → "underpowered": outputs `Z`, amber
  badge + warning (real TTL below min V_CC is unreliable; we choose inert).
  **12 V** on VCC → the chip is **damaged**: red badge, a one-time "magic smoke"
  notification, outputs `Z` permanently until the user resets it via the chip's
  context menu ("Replace chip"). Damage persists in `params.damaged`.
- **Settle loop with warm start.** Each evaluation pass: resolve all net levels
  from current drivers → `evaluate()` every powered chip on its input-pin levels →
  update output drivers → repeat until a fixpoint or **200 iterations**, then mark
  still-changing nets `X` with an "oscillation" warning (naming the nets). Net
  levels **warm-start from the previous stable state**, which is precisely why
  cross-coupled NAND latches hold state across input changes. A settle runs on
  Run-press and on every input event (switch flip, button down/up, PSU voltage
  change); zero-delay semantics — real propagation-delay ticks arrive with
  Feature 100's clocking.
- **Run/Stop mode.** A prominent header Run/Stop toggle (shortcut `Space` when no
  tool is armed). While running: placement/wiring/board tools are **locked**
  (toolbar disabled, edits rejected) — only switch/button interaction, probe mode,
  and pan/zoom remain. Stopping clears live state but keeps damage. This keeps v1's
  invariant simple: topology is frozen while simulating (switch bridges are part
  state, not topology edits — the netlist already rebuilds on them).
- **Visualization**: LEDs light (bright body + glow halo in `params.color`) when
  anode net is `H` and cathode net is `L` (idealized diode; reversed → dark).
  Probe/inspector mode gains sim awareness: highlighted nets tint by level
  (H=green, L=dim blue, Z=grey, X=flashing amber — tokens in `theme.css`) and the
  summary shows the level. Conflict/oscillation/short warnings surface via a small
  notification stack (port the sibling notifications pattern) and badge the
  offending chips/nets.
- **Engine tests are circuit fixtures**: helpers build documents in code (board +
  parts + wires), then assert settled levels — inverter chain, NAND with floating
  input (reads H), 74125 bus with both buffers enabled onto one net (conflict),
  SR latch set/reset/hold, ring-of-three-inverters (oscillation detected),
  unpowered/underpowered/damaged chips, two PSUs shorted.

## Implementation steps
1. **Net resolution.** `sim/resolve.js`: drivers → level with strength precedence +
   warning taxonomy; tests.
2. **Engine core.** `engine.js`: power gating, settle loop, warm start, iteration
   cap, damage bookkeeping (via a callback that mutates `params.damaged` through
   `desk-doc`); the circuit-fixture test suite.
3. **SimController (renderer).** Owns run state; bridges events: part-state/PSU
   changes → re-settle; publishes `chiphippo:sim-state` with net levels + statuses;
   locks/unlocks tools via the toolbar controller.
4. **Live views.** LED lit rendering, chip status badges, level-tinted probe
   highlights + level in the net summary, Run/Stop toggle UI.
5. **Notifications.** Minimal notification stack component (sibling pattern);
   short/conflict/oscillation/smoke messages route through it.
6. **jsdom tests.** LED lights for H/L across it and not when reversed; toolbar
   locks while running; badge classes per chip status.

## Acceptance criteria
- The Feature 60 starter bench runs: PSU 5 V → rails → 7400 powered; switch drives
  a gate input; LED follows the gate output; button works momentarily.
- An SR latch from one 7400 sets, resets, and **holds** through repeated settles.
- Floating TTL inputs read H (a NAND with one wired-low input and one floating
  input outputs H… and with both floating outputs L — verified in-app via probe).
- Conflicts, shorts, oscillations, and 12 V damage are each detected, surfaced via
  notifications + badges, and never hang the app (iteration cap holds).
- Editing is locked while running and restored on Stop; sim state clears, damage
  persists until "Replace chip".
- Engine + resolver are DOM-free with the full fixture suite passing;
  `make fmt && make lint && make test` green.

## Constraints
- Engine/resolver/netlist stay pure ES modules under `src/web/scripts/sim/` — no
  DOM, no Electron, no timers (Feature 100 adds the clock *outside* the engine).
- No analog modelling beyond the PSU voltage checks; no propagation delay in v1.
- All user-visible state (LEDs, badges, tints) renders from `chiphippo:sim-state`
  events — views never query the engine directly.
- House rules: theme tokens for all sim colors, class naming, popup-manager
  notifications.

## Verify
`make fmt && make lint && make test`, then `make debug`: build the starter bench and
run it (switch + button + LED behave); build the SR latch and toggle it; float a
NAND input and probe it (reads H); wire two 74125 outputs together, enable both, and
watch the conflict warning; feed a 7404 loop of three inverters and get the
oscillation warning; move VCC to a 12 V PSU, enjoy the smoke notification, then
"Replace chip" and re-run at 5 V.
