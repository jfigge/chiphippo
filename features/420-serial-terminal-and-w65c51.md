# Feature 420: The serial line, a USB-serial adapter, the Terminal, and the W65C51 ACIA

**Prerequisites:**
- 90/100: the engine, and sequential chips with `{state0, step, outputs}`.
- The timed parts' wake contract (`sim/timing.js`, `chip-eval.js` `wakeAtOf`).
- Batched ticks (`sim/schedule.js`, `SimController#nextEvent`).
- The sim Worker (`sim-host.js` / `sim-worker-host.js`).
- 170/180: memory and ROM images.
- The CPU monitor's aux-window relay (`cpu-monitor-bridge.js`).
- The memory inspector's per-part windows.
- The CPU examples (`scripts/demo-computers.mjs`) and the `eater-core` stage (`scripts/make-demos.mjs` `eaterCore`).
- 210: the analyzer.
- Spice Lite.

> **Numbering note:** `features/done/` tops out at **410**, and no code comment claims
> 420 or 430. This stage is **420**. Its sibling, the MC68B50 for the Z80, is **430**
> (`430-mc68b50-z80-serial.md`), which builds on Phase A here.

## Status (2026-10-15)

**Phase A is built**; Phases B and C are not. What landed differs from the plan below
in these places:

- **The wake split is a separate hook.** The plan gated every wake on
  `typeof logic.wakeAt === "function"` and routed some to `lineWakeAt`. What landed is
  simpler: a part declares `logic.lineWakeAt(state)` (`chip-eval.js` `lineWakeAtOf`),
  the engine collects it into `result.lineWakeAt`, and `wakeAt` and everything keyed to
  `isTimed` are untouched. So the 555 and the CD4000 timers cannot have moved.
- **`env.params`.** Every `step` is now handed the part's own params (the adapter's
  baud and format).
- **The adapter stands on its header.** It is drawn edge-on over its row, as a SIP
  is, not as a board lying over the holes. A board lying flat covered holes the
  auto-router then plugged wires into.
- **It is shelved under COMPONENTS ▸ I/O, not Interface.** "Interface" is a CHIPS
  group that `PROGRAM_ONLY` and `PROTOCOL_GROUPS` key on. (First named Serial; renamed
  I/O and moved to follow Displays at Jason's word, 2026-10-15.)
- **A receiver listens only once it has seen the line HIGH.** A line LOW at Run is not
  a start bit. Otherwise the example's shift registers, powering up full of zeros,
  printed ▒ at every Run.
- **A "Received CR" setting** (CR, or CR LF) was added for monitors that end a line
  with CR alone.
- **The screen is kept in the main renderer** (`terminal-bridge.js`), not the window.
  What arrives while the window is closed is there when it opens.
- **Not built:**
  - double-click to open the Terminal (the context menu's **Open Terminal…** only);
  - the TX/RX lamps in 3D.
- **A SimController fix the line needed:** an input that arrives while the run is
  BEHIND now lands at the run's present (`#inputMoment`), not the sim clock's. Before,
  every edge the run still owed then ran AT the input's moment, bunched into one
  instant, which collapsed the example's frame (`'P'` for `'A'` in the real app).
- **The example's pull-down is 1 kΩ**, not 10 kΩ. A 74LS input's own current through
  10 kΩ holds it past VIL, and Spice Lite reads it X.

---

## Context

A Chip Hippo computer can show its work on LEDs, 7-segment digits and the 16×2/20×4
LCD. It can take input from switches, buttons and the signal keys. It has **no
character channel**: no way to type a line into a program and no way to read pages
of its output.

Every 65xx and Z80 homebrew machine gets that channel the same way: an ACIA on the
bus, its TxD/RxD wired to a USB-serial adapter, and a terminal program on the PC.
Ben Eater's whole serial series is built this way. His Microsoft BASIC machine
(`github.com/beneater/msbasic`, target `eater`) needs it to exist at all.

This came out of reviewing WireSim (`~/src/clones/WireSim`). WireSim runs that
machine with a W65C51 that passes whole bytes to a TCP console. Chip Hippo's version
should be a **real serial line**: bits on a net, in simulated time. Then the same
terminal serves:
- an ACIA;
- a CPU toggling a VIA pin by hand;
- a UART designed in the custom chip designer;
- a UART built from 74LS shift registers.

The logic analyzer shows the frames for free.

**Measured facts this plan is sized against** (2026-10-15):
- The engine runs the 6-chip `hello-w65c02` computer at **~2,800 CPU cycles/s**
  headless.
- The W65C02 core alone runs at ~5 M cycles/s and passes both of Klaus Dormann's
  suites.
- msbasic's `CHROUT` (`bios.s`) spends a fixed **1,275-cycle** delay loop per
  character, to cover the W65C51N's transmit bug at 1 MHz.
- BASIC's `MEMORY SIZE?` probe costs ~39 cycles a byte over ~15.4 K of RAM, about
  **600 K cycles**. Typing a number at the prompt skips it.

## Goal

1. **A serial line in simulated time**: one pure UART frame module shared by every
   part that speaks it.
2. **A USB-serial adapter**: an FTDI-style 6-pin module seated on the breadboard. Its
   cable is the **Terminal** window: scrollback, keyboard, paste, line settings.
3. **The W65C51N ACIA** (WDC, DIP-28, 600 mil), with its registers, baud generator,
   interrupts and its silicon's transmit bug.
4. **Ben Eater's Microsoft BASIC computer** as the W65C51's example: a third
   `eater-*` stage, typed into through the Terminal.

---

## Design decisions (settled unless marked *proposed*)

### Phase A: the line, the adapter, the Terminal

- **The line is ordinary levels on an ordinary net.** Idle (mark) is H. A frame is a
  start bit (L), 5–8 data bits LSB first, optional parity, and 1, 1.5 or 2 stop bits
  (H).
  - No new level, no new net type and no byte-carrying side channel. So the analyzer,
    the probe, Spice Lite, the netlist and the exports need nothing new.
  - Any circuit that produces those edges at the right times is understood.
- **`sim/uart.js` is the one statement of a frame** (pure, DOM-free):
  - `frameBits(byte, format)` gives the bit sequence.
  - `edgesOf(byte, format, t0, baud)` gives the transmit schedule as absolute times.
  - `decodeFrame(history, t0, format, baud)` returns `{byte, framingError,
    parityError, break}`.
  - Every transmitter and receiver (adapter, W65C51, the 68B50 in 430) uses it, so
    no two parts can disagree about a frame.
- **A receiver reconstructs; it does not need mid-bit wakes.**
  - A net changes level only at a tick. So a receiver that records `(time, level)` at
    every tick it is stepped through (it gets `env.now` and `prev` already) knows the
    exact line level at every mid-bit sample time.
  - It needs one wake, at the frame's end (start + (1 + data + parity + stop/2) bit
    times), to commit the byte, set its flags and raise its interrupt at the right
    moment.
  - This halves the wake count and makes reception exact whatever produced the edges.
- **A transmitter needs EXACT wakes.**
  - `MIN_SHOWN_S` (0.5 ms, `sim/timing.js:46`) clamps every timed wake
    (`SimController#nextEvent`, `sim-controller.js:1028`). That would smear 19200-baud
    bits (52 µs) into each other.
  - Switch bounce already has the one unclamped exemption. The line gets a second,
    with the same justification: the edges ARE the information.
  - The engine returns `result.lineWakeAt` beside `wakeAt`, from parts flagged
    `logic.lineWakes`. `#nextEvent` takes it unclamped.
  - The cost is one tick per bit **edge**, only while a frame is on the wire: at most
    10 per 8N1 byte, fewer for runs of equal bits. An idle line costs nothing.
- **Being woken is separated from being a TIMER.**
  - Today `wakeAtOf` and the engine's wake collection (`engine.js:1488-1495`) gate on
    `isTimed` (`def.logic.timing`).
  - That brings a timing readout, a Properties Timing row, AI-card exclusion, a
    `sim-state.timing` entry and a Spice Lite re-analysis. None of these mean anything
    for a UART.
  - The gate becomes `typeof def.logic.wakeAt === "function"`, with every
    `isTimed`-driven UI left keyed to `timing`.
  - A test holds that the 555 and the CD4000 timers behave byte for byte as before.
- **The adapter is a SEATED module, not a desk brick.**
  - Real benches plug an FTDI breakout's 6-pin header into the breadboard.
  - The engine's behavioural path only serves seated parts: `fixedFacts` excludes
    bricks by kind (`engine.js:319-336`), and the LCD left brick-hood for exactly this
    reason.
  - So the adapter is a `kind: "discrete"` part with a one-row 6-pin header, like the
    LCD's 16-pin one.
  - id `usb-serial`, title **"USB-serial adapter (FTDI, 5 V)"**, group **Interface**
    (the same tray folder as the ACIAs, so the pair is found together).
  - Pinout, in the FTDI TTL-232R cable order: **1 GND · 2 CTS# · 3 VCC · 4 TXD ·
    5 RXD · 6 RTS#**.
    - TXD is the adapter's OUTPUT (to the circuit's RxD). RXD is its input.
    - RTS# is held low ("ready"). CTS#, low or open, lets the adapter send. Its
      FT232R pull-up does NOT apply, because hardware flow control is OFF unless set.
- **The adapter's USB power is not modelled** (*proposed*).
  - VCC is a no-connect with a hover note: "USB 5 V, not modelled: power the board
    from a PSU".
  - The adapter is `passive` (no supply roles), so it is always OK.
  - It warns **`no-common-ground`** when its GND pin's net is not the circuit's
    ground. A forgotten common ground is the most common serial mistake there is.
- **RXD floating reads H** (the FT232R's internal pull-up). An unwired adapter
  receives nothing rather than a stream of break frames.
- **The Terminal is a window per adapter**, keyed by compId: the memory inspector's
  pattern (`memoryWindows`, `memory:to-inspector|to-host`).
  - It is opened from the adapter's context menu (**Open Terminal…**) or by
    double-clicking it.
  - `closeAuxWindows` closes it on New, Open and tab switch.
  - The window title names the adapter's ref, so two adapters cannot be confused.
- **The Terminal is a glass TTY, not VT100** (v1).
  - It renders printable ASCII, CR, LF, BS, TAB, BEL (a flash) and FF (clear). Other
    control bytes show as `^X`. ESC sequences show raw, as `^[`.
  - It wraps at the configured column count and keeps a 2,000-line scrollback.
  - The screen model is **pure**: `model/terminal-screen.js`, with a sibling test.
  - The window is a thin canvas or `<pre>` over it.
  - ANSI/VT100 is backlog.
- **Line settings live on the PART** (params, in Properties):
  - baud: presets 50–115 200 plus Custom…, reusing the clock Rate's `"preset"`
    field;
  - data bits 5–8; parity N/E/O; stop bits 1/2;
  - flow control: None or RTS/CTS;
  - Enter sends CR / LF / CR LF; Backspace sends BS or DEL;
  - local echo; columns (40/80/132).
  
  They are durable, travel with design clips, and are what an example presets. The
  window only shows them.
- **Typing works only while running.**
  - While stopped, the window shows the transcript read-only: "Run the circuit to
    type".
  - A key while running sends `SimHost.queueSerial(compId, bytes)`. It is a new
    `CALLS` entry modelled on `setCpuRegister` (`sim-controller.js:1946`): a new
    state object for the part, then `wake()`.
  - **Paste** is queued in the window and fed as the part's bounded transmit queue
    drains (the part publishes `txFree`). A 10 KB paste does not grow engine state.
- **Received bytes leave the Worker as their own event.**
  - The part keeps a monotonic `rxSeq` and a bounded ring of recent bytes, which
    keeps state small for `sameState`.
  - SimController collects new bytes every TICK (a publish sees only the last tick of
    a batch) into an owed buffer, like `#memOwed`.
  - It flushes the buffer as **`chiphippo:serial-rx {compId, bytes}`** at publish.
    That event joins `FORWARDED`.
  - A `TerminalBridge` relays it to the window, append-only, throttled to the CPU
    monitor's 100 ms.
- **The transcript is run-volatile and window-owned.**
  - It is not saved in the project.
  - Run does not clear it, as a real terminal does not. A **Clear** button does.

### Phase B: the W65C51N

- **Pinout (W65C51N, DIP-28, 600 mil):**
  1 VSS · 2 CS0 · 3 CS1B · 4 RESB · 5 RxC · 6 XTLI · 7 XTLO · 8 RTSB · 9 CTSB ·
  10 TxD · 11 DTRB · 12 RxD · 13 RS0 · 14 RS1 · 15 VDD · 16 DCDB · 17 DSRB ·
  18–25 D0–D7 · 26 IRQB · 27 PHI2 · 28 RWB.
  - Verify every pin against WDC's sheet when cropping it.
  - Family-less, in `chips-io.js` beside the VIA. Group Interface, so `PROGRAM_ONLY`
    and `PROTOCOL_GROUPS` cover it with no list edits.
- **The bus is the VIA's:**
  - selected = CS0 H ∧ CS1B L;
  - a transfer commits on PHI2's falling edge;
  - D is driven only while selected ∧ RWB H ∧ PHI2 H;
  - RESB L is an asynchronous reset;
  - IRQB is open-drain in the unit (`irq ? L : Z`), as the VIA's is.
- **Registers (RS1 RS0):**

  | RS1 RS0 | Read | Write |
  |---|---|---|
  | 00 | RDR (read clears RDRF) | TDR |
  | 01 | status (read clears its IRQ bit) | programmed reset |
  | 10 | command | command |
  | 11 | control | control |

  - **Control:**
    - SBR, bits 0–3:
      - `0000` = 16× external clock on RxC;
      - `0001`–`1111` = 50, 75, 109.92, 134.58, 150, 300, 600, 1200, 1800, 2400,
        3600, 4800, 7200, 9600, 19 200;
    - RCS, bit 4;
    - WL, bits 5–6 (8/7/6/5);
    - SBN, bit 7.
  - **Command:**
    - DTR, bit 0;
    - IRD, bit 1 (1 = receiver IRQ off);
    - TIC, bits 2–3 (RTSB and the transmit IRQ, `11` = break);
    - REM, bit 4 (echo);
    - PME/PMC, bits 5–7.
  - **Status:** PE, FE, OVRN, RDRF, TDRE, DCDB, DSRB, IRQ (bits 0–7).
  - Check every value against the sheet. msbasic's `$1F` (19200 8N1, internal clock)
    and `$89` (DTR on, receive IRQ on, RTSB low) must decode as Ben's comments say.
- **The baud generator runs on an implied crystal, in SIMULATED seconds.**
  - The W65C51 times itself from a 1.8432 MHz crystal across XTLI/XTLO. Chip Hippo has
    no crystal part, and a clock brick tops out at 10 kHz.
  - So the crystal is a **param of the chip** (Properties, "Crystal": 1.8432 MHz
    default; the presets are the standard UART crystals).
  - XTLI/XTLO are drawn but electrically unused, with the hover note "crystal fitted".
  - SBR `0000` (16× external clock on RxC) IS modelled. A clock brick can drive RxC,
    and baud = RxC/16 counted on RxC edges, with no wakes. RxC as the generator's 16×
    OUTPUT is not modelled (documented).
  - A crystal PART is backlog. It would replace the param without changing the
    timing model.
- **The W65C51N's transmit bug is modelled, because that is the chip.**
  - TDRE always reads 1.
  - A TDR write while a frame is shifting does what WDC's errata say it does.
    *Read the errata text first. If it says "corrupts", define the corruption exactly
    (the shifter is reloaded mid-frame) and hold it with a test.*
  - The transmit IRQ (TIC = `01`) therefore fires continuously, as on silicon.
  - Ben's delay loop exists because of this bug; that is the lesson the example
    teaches.
- **CTSB high holds the transmitter.** DCDB and DSRB changes raise the IRQ when it is
  enabled. The status reports their levels.
- **REM echo and overrun:** echo mode, and the overrun flag on a byte arriving into a
  full RDR, are both modelled.
- **No new Spice Lite work:** family-less means `MOS_STAGE` outputs and the 74LS
  supply gate.

### Phase C: Ben Eater's BASIC computer

- **The `eater-basic` stage**, the third after `eater-core` and `eater-io`, built from
  `eaterCore()` in `scripts/make-demos.mjs`:
  - **Unchanged from the core:**
    - CPU, AT28C256, HM62256;
    - the 74LS00 decode (RAM `$0000–$3FFF`, ROM `$8000–$FFFF`, G4 = the I/O select,
      A15 = 0 ∧ A14 = 1).
  - **VIA:** CS1 ← A13, CS2B ← G4, so it sits at `$6000`.
  - **W65C51:**
    - CS0 ← A12, CS1B ← G4 (`$5000`);
    - RS0/RS1 ← A0/A1;
    - IRQB shares the CPU's pulled-up IRQB with the VIA's;
    - CTSB, DCDB and DSRB tied low.
    - Ben's decode makes `$7000` select both chips. msbasic never touches it; keep it,
      it is his circuit.
  - **The LCD in 4-bit mode,** as `lcd.s` drives it: PB0–PB3 → DB4–DB7, PB4 RS,
    PB5 RW, PB6 E.
  - **PB7 → the speaker** (Spice Lite only; `BEEP`), or left open (*proposed*: open,
    with an annotation, so the example runs in both engines).
  - **The adapter:**
    - TXD → ACIA RxD; ACIA TxD → adapter RXD;
    - adapter CTS# ← VIA PA0 (msbasic's software RTS: high = "stop sending");
    - flow control RTS/CTS; 19200 8N1; Enter = CR.
  - **A reset button.**
  - Read every wire against Ben's published serial schematic (eater.net) at
    implementation. Where this plan and his drawing differ, his drawing wins.
- **The ROM** is msbasic's `eater` target (`ca65 -D eater msbasic.s` +
  `ld65 -C eater.cfg`), 32 KB, `$8000–$FFFF`, BASIC plus WozMon.
  - cc65 is NOT a build dependency. The image is built once, committed under
    `scripts/roms/msbasic-eater/`, with a README giving:
    - the upstream commit;
    - the exact commands;
    - the SHA-256;
    - the patch, if any (below).
  - The README follows the pattern of `tests/dormann/`. A `make rom-msbasic` target
    rebuilds and checks the hash when cc65 is present.
- ***Proposed*: patch ONE constant, the `CHROUT` delay** (`lda #$FF` → `lda #$01` in
  `bios.s`).
  - The loop exists to wait out one character at 19200 baud at **1 MHz**, about 520
    cycles.
  - Here the ACIA keeps real time and the CPU runs at ~2 kHz, so a character takes
    about one CPU cycle. The unpatched loop costs 1,275 cycles a character, about
    **0.6 s per echoed key**.
  - Patched, the same output takes ~25 cycles and the machine is usable. The bug is
    still modelled: firmware with NO wait still garbles, and a test holds that.
  - The patch is a documented, one-byte, source-level change. The example's
    description explains it.
  - The alternative is to ship Ben's ROM untouched and accept the speed. → **Jason
    decides** (see Open questions).
- **The clock** is the fastest rate that runs true on a reference Mac, measured with
  the finished machine.
  - Expect ~2 kHz: Custom, with the amber (i) above 2 kHz.
  - The sim stays consistent in simulated seconds when the run falls behind, so a
    faster nominal rate is still correct, just slower in wall time.
- **The example is offered from the W65C51's pinout window.**
  - `COMPUTERS`/`BUILDERS` gain `W65C51`. `gate-demos.test.js:297-311` already allows
    a program-only part a bundled file when its ref is listed there.
  - The W65C02's example stays Hello World. A second desktop on the CPU would change
    its tab identity ("W65C02 example") for no gain.
  - `demos/eater-basic.chiphippo` is written beside the other `eater-*` stages, and
    `demos/README.md` gains its section.
- **The proof is scripted through the line.**
  - `validateComputer` is hard-wired to the LCD greeting. The BASIC machine gets a
    **serial script** validator: a list of `{send}`/`{expect}` steps driven through
    the adapter part's state (the same entry `queueSerial` uses), with the received
    stream decoded through `sim/uart.js`.
  - The script:
    1. `8000R⏎`;
    2. expect `MEMORY SIZE?`, send `16384⏎`, which skips the probe;
    3. expect `TERMINAL WIDTH?`, send `⏎`;
    4. expect `BYTES FREE` and then `OK`;
    5. send `PRINT 2+2⏎`, expect `4`;
    6. send `LCDPRINT "HI"⏎`, expect the LCD's DDRAM to read `HI`.
  - Every chip `ok`, no warning, in the logic engine.
  - Budget it in cycles. If it runs past ~90 s headless, it is `make demos` only, and
    `gate-demos.test.js` re-proves a shorter script (WozMon's `\` prompt and an echo).

---

## Implementation steps

### Phase A: line, adapter, Terminal

1. **`sim/uart.js` + `tests/uart.test.js`.**
   - Formats from 5N1 to 8O2, LSB first.
   - Parity and framing errors; a break (an all-zero frame with a low stop bit).
   - Decode from a level history whose changes land at arbitrary times, including
     changes exactly on a sample time (convention: the level AT a time is the level
     after any change at that time).
2. **The wake split.**
   - `chip-eval.js` `wakeAtOf` and `engine.js:1488-1495` gate on
     `typeof logic.wakeAt === "function"`.
   - `logic.lineWakes` routes a part's wake to `result.lineWakeAt`.
   - Thread both through Spice Lite's pickup (`spice/engine.js:3549, :3657`). Note its
     chattering-island postponement (:3650) and decide whether line wakes are exempt.
     They should be: a line edge is not an animation.
   - `SimController#nextEvent` takes `lineWakeAt` unclamped, beside the bounce.
   - Tests:
     - every existing timed part is byte-identical
       (`engine-incremental.test.js`, the timer suites);
     - a `lineWakes` stub is ticked at its exact times;
     - `sim-worker.test.js` runs a scripted line identically on and off the Worker.
3. **The `usb-serial` part.**
   - The catalog def in `catalog/parts.js`, beside the LCD: one-row header footprint,
     params, `normalizeParams`, value fields.
   - The logic unit `sim/usb-serial.js`:
     - the transmit queue and the CTS# gate;
     - TXD from state;
     - the receive history with an end-of-frame wake;
     - `rxSeq` and the ring;
     - the `no-common-ground` warning.
   - Unit tests, plus an engine test: TXD looped to RXD echoes every byte, in every
     format, at 50 and at 115 200 baud.
4. **SimController and Worker plumbing.**
   - `queueSerial(compId, bytes)` in SimController, `CALLS` and SimHost.
   - The per-tick rx collection and the `chiphippo:serial-rx` event (in `FORWARDED`).
   - `txFree` on `sim-state`.
   - Tests in the shape of `sim-worker.test.js`.
5. **`model/terminal-screen.js` + test.**
   - Glass-TTY semantics, wrap, scrollback cap, BEL, FF, `^X` rendering, CR/LF
     handling per the part's settings.
6. **The Terminal window.**
   - `web/terminal.html` + `scripts/terminal.js`.
   - Main: `terminalWindows` per compId, `terminal:open|to-window|to-host`, sender
     checks in `ipc-guard.js` + `identifySender`, `closeAuxWindows`.
   - `preload.js` and `ipc-parity.test.js` / `ipc-guard.test.js`.
   - `components/terminal-bridge.js`: the host side, after `cpu-monitor-bridge.js`.
   - Keyboard capture, with Ctrl-letter mapped to control codes. App accelerators must
     still reach the menu; check ⌘R and ⌘. on macOS inside the focused window.
   - Paste with backpressure; Clear; Copy.
   - CSS on the tokens, with `--font-mono` and `--font-size-*`.
7. **The adapter's view and its touchpoints.**
   - The desk view: a small PCB on its header, lit TX/RX lamps from line activity
     published on `sim-state`.
   - `#terminalMenuItems` (Open Terminal…) and double-click.
   - Schematic symbol: a connector (`J`).
   - 3D model (`scene3d/part-models.js`).
   - Pinout `TERMINAL_INFO` and hover notes.
   - BOM line: "USB-serial adapter, FTDI TTL-232R-5V or equivalent".
   - Build-guide step; desk-brief params.
   - KiCad: `Conn_01x06` + `PinHeader_1x06_P2.54mm`.
   - Digital: unsupported, with a reason.
   - Off the AI card (*proposed*: the AI builder cannot type).
8. **The adapter's own example** (*proposed*: a 74LS-only transmitter, which is the
   proof that the line is general).
   - Eight DIP switches on a 74LS165 loaded by a button.
   - Shifted LSB first at the baud rate off a clock brick (300 Hz → 300 baud), with the
     start and stop bits framed by a 74LS161 bit counter.
   - Press the button, and the switches' byte appears in the Terminal.
   - Hand-built (`HAND_BUILT`), proven by `validateHandBuilt` plus a line decode.
   - If a clean 74LS framing proves awkward, fall back to a loopback desk: TXD
     straight to RXD, so typing echoes.
9. **i18n and docs.**
   - Titles, menu, window chrome and Properties labels in all seven catalogs.
   - A user-guide page "Serial and the Terminal": the line, the adapter, flow
     control, the common ground, baud versus clock rate, the analyzer view of a
     frame.
   - `.claude/rules/`: a new `serial-line.md` with `paths:`, and a row in CLAUDE.md's
     table.

### Phase B: the W65C51N

10. **`sim/w65c51.js` + `tests/w65c51.test.js`.**
    - Registers, reset (hardware and programmed), the baud table, the crystal param
      and SBR `0000` RxC mode.
    - Interrupts; CTSB/DCDB/DSRB.
    - Echo, overrun, parity, framing, break.
    - The TDRE-stuck bug.
    - A firmware-style test: a no-delay TDR loop garbles, and a delayed loop is clean.
11. **The catalog def in `chips-io.js`,** with `pinGroups`.
    - Bump `PALETTE_DEFS.length` and add `IO_WAVE` in `chips-catalog.test.js`.
    - `engine-io.test.js`: a `PINS` row and a bench (W65C02 + ROM + W65C51 + adapter;
      the ROM prints `OK` through the line).
    - `DIGITAL_UNSUPPORTED` (`"processor"`).
    - WDC datasheet source (the `wdc` block in `app/datasheets/sources.js`).
    - The pinout crop `src/web/datasheets/W65C51.png`.
    - `parts.W65C51.title` ×7.
    - `chip-library.md`'s Interface table (its "two … DIP-40" wording changes).
    - `website/chips.html` via `make docs`.

### Phase C: the BASIC computer

12. **The msbasic ROM**, under `scripts/roms/msbasic-eater/` with its README, the
    licence notes, and `make rom-msbasic`. It is assembled once with cc65 on the dev
    machine, after confirming the licences (see Open questions).
13. **`eaterBasic()`** in `make-demos.mjs` from `eaterCore()`, the serial-script
    validator, and the W65C51's `COMPUTERS`/`BUILDERS` entry.
    - Auto-routing as the CPU examples do.
    - `demos/eater-basic.chiphippo` + `src/web/demos/W65C51.json`.
    - `gate-demos.test.js` holds both; `engine-parity.test.js` sweeps them.
14. **Docs:**
    - `demos/README.md` "`eater-basic`" section (memory map, the wiring table, how to
      start BASIC, the `MEMORY SIZE?` advice, what the patch is and why);
    - CLAUDE.md status line;
    - the rule files (`generated-circuits.md`'s CPU-examples bullet now says "and the
      W65C51's").

---

## Acceptance criteria

- **The line in the analyzer:** a byte sent by the adapter appears in the analyzer as
  a start bit, eight LSB-first data bits and a stop bit, each exactly one bit time
  long at 19 200 baud. At 0.5 ms-clamped wakes it would not be.
- **The engine is unchanged for timed parts:** every timed part and every existing
  example behaves byte for byte as before, in both settle modes and under Spice Lite.
- **Loopback:** an adapter with TXD wired to RXD echoes everything typed into its
  Terminal, in every format.
  - A mismatched baud shows framing errors (`^`-marked).
  - An unwired RXD shows nothing.
  - GND off the circuit's ground raises `no-common-ground`.
- **Paste:** pasting 10 KB into the Terminal with RTS/CTS on, against a receiver that
  holds CTS# high, loses nothing and grows no engine state.
- **The W65C51 unit suite** passes. A no-delay transmit loop garbles, as on silicon.
- **`eater-basic`:**
  - from Run, `8000R` reaches BASIC;
  - `PRINT 2+2` prints `4`;
  - `LCDPRINT "HI"` shows `HI` on the LCD;
  - a 10-line BASIC program runs, all in the Terminal;
  - in the logic engine, with every chip `ok` and no warning.
- **Under Spice Lite** the same machine runs (`engine-parity`), PB7 aside.
- **Gates:** `make fmt && make lint && make test && make test-i18n` are green.

## Constraints

- No new level, net type or engine side channel for serial data: the line is levels.
- `sim/` stays DOM-free, and `model/terminal-screen.js` imports nothing from `sim/`.
- No new outbound network call. The Terminal is local; a real-port bridge is backlog.
- The renderer still never touches a port.
- No `z-index`.
- Every `font-size` is a token (`type-scale.test.js`).
- `MIN_SHOWN_S` still binds everything but line wakes and bounce.
- Committed third-party binaries (the msbasic ROM) carry a README with provenance, a
  hash and the licence, and a NOTICE entry.

## Verify

`make lint && make test && make test-i18n`, then `make demos` (the BASIC proof). Then
`make debug`:
1. Open the W65C51's pinout and click its example.
2. Open Terminal… on the adapter and Run.
3. At `\` type `8000R`, answer `16384` and Enter.
4. Type `10 FOR I=1 TO 5:PRINT I:NEXT` and `RUN`.
5. Add `TXD` and `RXD` to the analyzer and read one frame.
6. Turn on Spice Lite and repeat.

## Open questions for Jason

1. **The `CHROUT` delay.** Ship Ben's ROM untouched (faithful; ~0.6 s per echoed key
   at ~2 kHz), or with the one-constant patch (usable; documented in the example)?
   *Recommended: the patch.*
2. **WozMon.** The eater ROM includes Ben's `wozmon.s` (Steve Wozniak's Apple-1
   monitor). Its licence is murkier than BASIC's:
   - msbasic is 2-clause BSD over Microsoft's 6502 BASIC, which Microsoft released
     under MIT in Sept. 2025.
   - If WozMon cannot ship, the ROM resets straight into BASIC's cold start and the
     `8000R` step goes away.
3. **Adapter VCC.** Leave it a no-connect (proposed), or model USB 5 V as a weak
   supply that fights a PSU on the same rail?
4. **The adapter's own example:** the 74LS-only transmitter (proposed), or just a
   loopback?

**cc65 needs installing:** step 12 needs cc65 (`brew install cc65`) on the dev machine,
once.
