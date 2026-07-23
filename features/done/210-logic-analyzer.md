# Feature 210 — Logic analyzer & timing / bus waveform view

## Context

The simulation runs and the desk/schematic tint live by level (Features 90/100/150), but
there is no way to see a signal **over time**. Debugging anything sequential — a counter,
a shift register, and especially a memory system with a clock, address bus, and data bus
— means watching values change tick by tick. A single lit LED cannot show you a setup
violation, a glitch, or the relationship between `/WE`, the address, and the data.

The engine already advances in discrete `tick`s driven by `SimController`'s transport
(Run / Pause / Step / speed) and publishes `chiphippo:sim-state` every tick. That is a
ready-made sample stream — a logic analyzer is a **recorder + renderer** of it.

Prerequisites: Features 90/100 (engine ticks + sim-state broadcast + transport), 120 (net
names — channel labels), 130 (buses — grouped bus channels), 170 (memory — the headline
thing to observe).

## Goal

A **logic analyzer**: pick nets and buses as channels, record their value each tick while
the sim runs, and render a scrolling timing diagram (per-bit waveforms + multi-bit bus
lanes showing hex values), with cursors and a bus-value readout — so a design's behavior
over time is legible and the resulting timing chart is itself a followable artifact.

## Design decisions (settled)

### Record from the existing sim-state stream

No engine change. A `ScopeRecorder` subscribes to `chiphippo:sim-state` (already emitted
per tick with net levels + chip status + clock levels). Each selected channel samples its
net's level (or a bus's decoded integer) into a ring buffer keyed by tick index. Sampling
is a pure fold over the broadcast the views already consume — the analyzer never queries
the engine and adds nothing to the settle loop.

### Channels are nets and buses, referenced stably

A channel binds to a **net name** (Feature 120) or a **bus** (Feature 130), falling back
to a member address, so a channel survives edits the way a net name does. A bus channel
decodes its member bits (msb:lsb order) to an integer per tick and renders as a labelled
value lane (`A: 0x1F00 → 0x1F01`); single nets render as classic high/low waveforms with
`X`/`Z` shown distinctly (hi-Z as a mid-level band, unknown as hatching).

### Bounded ring buffer, tick-indexed

Samples live in a bounded per-channel ring (e.g. last N ticks), tick-indexed so all
channels share one time axis. The transport already defines "a tick"; free-running clocks
and single-step both feed the same stream, so Step produces one column and Run scrolls.
No wall-clock — time is tick count (matching the engine's timerless determinism).

### A dockable waveform panel with cursors

`ScopeView` renders a horizontally-scrolling canvas/SVG: a channel gutter (name +
add/remove/reorder), one lane per channel, a shared time grid, and two draggable cursors
with a delta readout (Δticks, and Δ in ms given the clock speed). Clicking a bus lane
shows the decoded value at the cursor. The panel is toggled from the header and reads the
recorder; it never blocks or drives the sim.

### Export ties back to the documentation goal

The waveform is exportable (SVG/PNG via Feature 160's export path) so a timing diagram —
"here is what the bus does each cycle" — becomes part of the followable build
documentation, not just a live debug aid.

## Implementation steps

1. **`model/scope-recorder.js`** (new, pure) — a bounded, tick-indexed multi-channel ring
   buffer; `sample(simState, channels)` folds one broadcast into new columns; bus decode
   (bits → int) shared with tests; no DOM, no timers.
2. **`components/scope-view.js`** (new) — the waveform panel: channel gutter, per-lane
   render (bit waveform / bus value lane), time grid, draggable cursors + delta readout,
   add-channel picker over named nets + buses.
3. **`components/sim-controller.js` / `sim-overlay.js`** — feed the recorder from the same
   `chiphippo:sim-state` subscription; reset the buffer on Run, hold on Pause, append on
   Step; expose the current clock speed for the Δ-time readout.
4. **Channel selection** — add-channel from the probe ("Add to analyzer"), from a bus
   context menu, or the picker; channels persist in the document (`doc.scopeChannels`,
   additive) so a saved design keeps its instrument setup.
5. **Export hook** — the waveform surface plugs into Feature 160's `svg-export`/raster
   path for a timing-diagram export.
6. **Tests** — recorder samples a scripted sim-state sequence into the right columns and
   evicts past the bound; bus decode matches bit order (msb:lsb); a channel bound to a net
   name survives a net-key change; Step appends exactly one column while Run scrolls.

## Acceptance criteria

- Selecting nets/buses as channels and running the sim draws their waveforms scrolling in
  time; single-step adds one column at a time.
- Bus channels show decoded hex values and transitions; `X`/`Z` are visually distinct
  from high/low.
- Two cursors give a Δticks / Δms readout; clicking a bus lane reads its value at the
  cursor.
- The recorder is a pure fold over `sim-state` (no engine change) and the waveform
  exports to SVG/PNG.

## Constraints

- No engine or tick-loop change — the analyzer only consumes `chiphippo:sim-state`.
- Tick-indexed, bounded buffers; no wall-clock in the pure core (Δms is derived from the
  clock speed for display only).
- The panel never drives or stalls the simulation; it is a passive recorder.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: build a counter clocking a ROM's address bus, add `CLK`, `A[0:12]`, and
`D[0:7]` as channels, Run, and watch the address climb and the data bytes follow; drop
two cursors across one clock period and read the delta; export the timing diagram.
