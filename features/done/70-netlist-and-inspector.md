# Feature 70 — Netlist & connectivity inspector

## Context
The desk now holds boards, chips, wires, switches, LEDs, and PSUs (30–60), and every
conductive point has an address. This stage computes what the simulator will run on:
the **netlist** — the partition of all points into electrical nets, derived from
breadboard internal nodes (5-hole strips, rails), wires, component terminals, and
the switch/button `internalBridges` contracts. It also ships the first killer
diagnostic: **hover-to-highlight an entire net**, which makes wiring mistakes
visible long before simulation exists.

## Goal
A pure, tested netlist module that maps every hole/terminal/pin to a stable net,
rebuilt automatically on any topology change (including switch flips), plus an
inspector mode where hovering any hole, pin, wire, or terminal lights up every
point of its net across all boards and shows a summary ("net 14 · 23 holes · 3 chip
pins · 2 wires · rail bb1.t+").

## Design decisions (settled — do not relitigate)
- **Pure module** `src/web/scripts/sim/netlist.js`: input = the desk document +
  volatile part state (switch positions, button pressed); output =
  `{ netOfPoint: Map<address, netId>, nets: Map<netId, NetInfo> }` where `NetInfo`
  lists member points classified (holes, rail, chip pins with roles, wire ids, PSU
  terminals). Implementation: **union-find** over point keys — union each board
  node's holes, each wire's endpoints, each component pin with the hole it sits in,
  each active `internalBridges` pair, each PSU terminal with itself.
- **Stable net ids**: netId = the lexicographically smallest member address —
  deterministic across rebuilds so UI state (and later sim warm-start) can follow a
  net through unrelated edits.
- **Full rebuild, always.** Rebuild on every `chiphippo:doc-changed` and
  `chiphippo:part-state`, memoized per event turn. At this app's scale (thousands of
  points) union-find rebuilds are sub-millisecond; incremental updates are
  complexity with no payoff. A perf test asserts a 10-board, 500-wire document
  builds in < 50 ms.
- **Chip pins are members, not bridges**: a chip pin joins the net of its seated
  hole; chips never conduct between pins in the netlist (their behavior is the
  simulator's job). Switch/button bridges *are* conduction and live here — which is
  why part state is a netlist input.
- **Inspector UX**: a toolbar **probe toggle** (shortcut `I`). While armed, hovering
  any conductive point highlights its whole net in the overlay layer — glow dots on
  every member hole/terminal, glow strokes on member wires, glow rings on member
  chip pins — and a status readout (bottom-left chip) shows the net summary.
  Clicking **pins** the highlight so the user can pan/zoom along the net; `Esc` or
  re-click unpins. Flipping a switch while a pinned net includes it updates the
  highlight live (the demo that sells the feature).
- **Highlight rendering**: computed from the model into the existing overlay layer
  (one SVG regenerated per highlighted net — not per frame); no changes to board
  SVGs. Colors from theme tokens (accent glow).
- This stage also establishes `src/web/scripts/sim/` as the engine package;
  `netlist.js` is deliberately DOM-free so Feature 90 imports it unchanged.

## Implementation steps
1. **Union-find + netlist build.** Small tested `union-find.js`; `netlist.js`
   assembling the unions from document + part state; net id + classification pass.
2. **Model tests.** Strip connectivity (a1–e1 one net, f1 separate), rail spans,
   wire joins, cross-board nets via wires, PSU terminal nets, switch pos-1/pos-2
   alternately bridging, button pressed/released, chip pin membership + roles,
   net-id stability under unrelated edits, the 50 ms perf budget.
3. **Rebuild plumbing.** A `NetlistCache` in the renderer controller that
   invalidates on the two events and lazily rebuilds; exposed to views.
4. **Probe mode + highlight overlay.** Toolbar toggle, hover resolution (reuse
   `holeAt`/pin/terminal/wire hit paths from 30–50), overlay renderer, pin/unpin,
   live refresh on part-state changes.
5. **Net summary readout.** Status chip with counts + notable members (rails, PSU
   terminals called out by name).

## Acceptance criteria
- Netlist tests prove every connectivity rule above, id stability, and the perf
  budget.
- Probe hover highlights exactly the hovered net — including members on other
  boards — and the summary counts match a hand-check.
- A pinned net updates live when a slide switch in it flips; unrelated edits keep
  the same net highlighted (id stability visible in practice).
- Probe mode coexists with pan/zoom and suspends placement/wiring tools while
  armed.
- `make fmt && make lint && make test` green.

## Constraints
- `netlist.js` and `union-find.js` are pure, DOM-free, Electron-free; the overlay
  renderer contains no set arithmetic (it draws what the netlist says).
- No electrical semantics yet — no highs/lows/sources; this stage is topology only.
- House rules: theme tokens, class naming, events (`chiphippo:*`) vs callbacks.

## Verify
`make fmt && make lint && make test`, then `make debug` on the Feature 60 starter
bench: probe the 5-hole strip under a chip pin (whole strip + pin + wire glows),
probe a rail (full rail + PSU wire + terminal glows), pin the switch's common net
and flip the switch watching the highlight jump between gate-input nets, stretch a
wire to a second board and confirm the net spans both.
