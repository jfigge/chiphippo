---
paths:
  - "src/web/scripts/sim/uart.js"
  - "src/web/scripts/sim/usb-serial.js"
  - "src/web/scripts/catalog/usb-serial.js"
  - "src/web/scripts/model/terminal-screen.js"
  - "src/web/scripts/components/terminal-*.js"
  - "src/web/scripts/terminal.js"
  - "src/web/terminal.html"
  - "src/web/docs/serial-terminal.md"
  - "features/420-*.md"
  - "features/430-*.md"
---

## The serial line, the USB-serial adapter and the Terminal (Feature 420)

Plan: `features/420-serial-terminal-and-w65c51.md`. **Phase A is built** (2026-10-15);
Phase B (the W65C51N ACIA) and Phase C (Ben Eater's BASIC computer) are not. 430 (the
MC68B50 and a Z80 serial computer) builds on Phase A.

- **The line is LEVELS on an ordinary net** — no new level, net type or side channel.
  `sim/uart.js` is the ONE statement of a frame (start LOW, 5–8 data bits LSB first,
  optional parity, 1/1.5/2 stop bits HIGH): `frameBits`, `frameAt` (the level at `now`
  and the next moment it CHANGES — runs of equal bits are one level), `decodeFrame`
  (samples each bit's middle through a `read(t)`), `levelAt` (a change AT `t` counts),
  `sampleEnd` (the middle of the first stop bit). Every transmitter and receiver uses
  it, so no two parts can disagree about a frame.
- **Exact line wakes** — `logic.lineWakeAt(state)` (`chip-eval.js` `lineWakeAtOf`, ANY
  sequential part, not only a timed one), collected by `engine.js` `tick` into
  `result.lineWakeAt`, beside `wakeAt`. SimController's `#nextEvent` takes it UNCLAMPED
  (as a bounce), never sooner than `LINE_WAKE_MIN_S` (1e-8 s) after the tick just run;
  `#nextWake()` is the earlier of the two for Step and the CPU step loop; it rides
  `exportRun`. `wakeAt` and everything keyed to `isTimed` are untouched. Under Spice Lite
  a line wake is a `globalNext` (every island ticks), never backed off for chatter.
  Cost: one tick per bit EDGE while a frame is on the wire (≤ 10 per 8N1 byte), nothing
  idle.
- **A receiver reconstructs, it is not woken per bit**: the line moves only at ticks, so
  the `(time, level)` changes a part records while stepped ARE the line; it decodes at
  `sampleEnd` (one wake a frame). Back HIGH before the start bit's middle is a glitch.
  A frame ending LOW (framing error, break) disarms it until the line is HIGH again, and
  **a line already LOW at Run is not a start bit** (`rxLevel: null`, `rxArmed: false` in
  `initialAdapterState`): a receiver listens only once it has seen the line idle — the
  example's shift registers power up full of zeros and would otherwise print ▒ at Run.
- **`env.params`**: `engine.js` hands every `step` the part's own params (the adapter's
  baud and format) beside `now` and `timing`.
- **The adapter is a SEATED discrete** (`catalog/usb-serial.js`, id `usb-serial`, group
  **I/O**, data hook `serialPort` = its pin numbers), not a brick: `fixedFacts` gives
  behaviour to board parts only. Header 1 GND (passive) · 2 CTS# · 3 VCC (`nc`, USB 5 V
  not modelled) · 4 TXD (out) · 5 RXD (in) · 6 RTS# (held LOW). No supply roles → always
  OK (`passive`). Params stored only off their defaults (9600 8N1, flow none, Enter CR,
  Received CR = CR, Backspace BS, echo off, 80 columns). `no-common-ground` (in the
  context's `supplyWarnings`) when its GND is not on a PSU − net: SimController's toast,
  the review's `SERIAL_NO_GROUND`, the AI ladder's sentence. Off the AI card
  (`isBenchPart`). Under Spice Lite its TXD is a level, not a modelled output stage
  (a passive part has no stage).
- **Logic** (`sim/usb-serial.js`): the send QUEUE lives in the state (`TX_QUEUE` 256);
  `queueBytes` returns a NEW state. Received frames are a short window (`RX_LOG` 32)
  numbered by `seq`. `step` returns its state verbatim when nothing moved, and stores
  `wake` (the next change) only when the state changes — a wake still stands until it
  is reached.
- **SimController**: `queueSerial(compId, bytes)` (CALLS on the Worker; SimHost reports
  every byte taken and the Terminal paces by `free`) swaps in a new state and ticks.
  `#oweSerial` reads every tick's received frames by `seq` (`#serialSeen`, exported with
  the run), `#flushSerial` (inside `#flushMem`, so every publish path) dispatches
  **`chiphippo:serial-rx`** `{received: Map(compId → [{byte, framingError, parityError,
  brk}])}` — FORWARDED from the Worker. `sim-state.serialPorts`: compId → `{free, busy,
  seq}` (empty when stopped; SimHost's stopped board carries it too). SimOverlay lights
  the adapter's TX lamp while `busy` and RX for the frame a byte arrived in
  (`DiscreteView.setSerial`).
- **The Terminal**: one window PER ADAPTER (`terminalWindows` in main.js, keyed by
  compId like the memory inspector's; `terminal:open|to-window|to-host`, pushes
  `terminal:inbound|host-inbound`; `ipc-guard.js` lets a Terminal send `to-host` for
  its OWN adapter only and call nothing else; in `closeAuxWindows`). **The screen is kept
  in the main renderer** (`components/terminal-bridge.js`, a `model/terminal-screen.js`
  `TerminalScreen` per adapter): what arrives while the window is closed is there when
  it opens, and Stop keeps it (a desk that loads drops them all; Clear empties one). The
  window (`terminal.js` + `components/terminal-view.js`) only draws the lines the bridge
  sends (`screen` `{from, lines, count, col, bells}`, ≤ every 50 ms) and sends `keys`,
  `paste` and `clear`. Every key is the far end's while running (Escape sends ESC; a ⌘
  chord is the app's); typing is refused while stopped.
- **Glass TTY** (`model/terminal-screen.js`): printable at the cursor, CR, LF (column
  kept), BS (no erase), TAB to 8, BEL (`bells`, a flash), FF (clear), other controls as
  `^X`, bit 7 dropped, a broken frame as ▒, 2000 lines of scrollback. No VT100.
  `keyBytes`/`textBytes` turn keys and pastes into bytes by the adapter's settings.
- **The example** (`demos/usb-serial.chiphippo`, `HAND_BUILT`, authored by a throwaway
  builder, not committed): eight DIP switches over an rnet9 (the network's resistors
  share the switches' nodes, so no wire), two 74LS165s (start bit, the byte, then 1s),
  a 74LS74 + 74LS10 making LOAD = NAND(Q1, /Q2, CLK) — LOW for exactly the first half
  of the bit after a press (FF2 is clocked on the falling edge, so the next rising edge
  sees LOAD HIGH and shifts), a 300 Hz clock, the adapter at 300 8N1. `usb-serial.test.js`
  presses its button and reads one 'A' with no power-up garbage.
