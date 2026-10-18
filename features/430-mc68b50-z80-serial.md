# Feature 430: The MC68B50 ACIA and a Z80 serial computer

**Prerequisites:**
- **420 Phase A:** the serial line (`sim/uart.js`), the `usb-serial` adapter, the
  Terminal window and its Worker plumbing.
- The Z80A core (`sim/z80.js`: M-cycles, T-states and INTACK).
- 170/180: memory and ROM images.
- The CPU examples (`scripts/demo-computers.mjs`).

420 Phase B (the W65C51) is NOT a prerequisite. The two ACIAs share only the line.

---

## Context

420 gives the 65xx machines a serial port. The Z80 has none:
- The W65C51 times its bus transfers on PHI2, which a Z80 does not have.
- Real Z80 builds use the **Motorola MC6850 / MC68B50**. Examples are Grant Searle's
  7-chip Z80 and the RC2014's serial card.
- The 68B50 also suits the 6502: it is the classic 6800-family part and has an E
  clock input, as PHI2 is.

It is a simpler chip than the W65C51 and the better first ACIA to understand:
- **No baud generator.** It shifts on external TxClk/RxClk edges divided by 1, 16 or
  64.
- **No hardware reset pin.** A *master reset* written to its control register is the
  first thing every program does.
- **Two registers.**

So in Chip Hippo it is **purely edge-stepped**. A clock brick on TxClk/RxClk drives
it, and it needs none of 420's line wakes on its transmit side.

## Goal

1. **The MC68B50 ACIA** (DIP-24, 600 mil), family-less, in the Interface group beside
   the W65C51.
2. **A Z80A serial computer** as its example, typed into through the 420 Terminal.

---

## Design decisions (settled unless marked *proposed*)

### The chip

- **Pinout (MC6850/MC68B50, DIP-24):**
  1 VSS · 2 RxData · 3 RxClk · 4 TxClk · 5 RTS# · 6 TxData · 7 IRQ# · 8 CS0 · 9 CS2# ·
  10 CS1 · 11 RS · 12 VCC · 13 R/W · 14 E · 15–22 D7…D0 · 23 DCD# · 24 CTS#.
  - Note D7 is on pin 15. Verify every pin against the Motorola sheet when cropping
    it.
  - id `MC68B50`, title "MC68B50 ACIA".
  - `MC6850` (1 MHz) and `MC68A50` (1.5 MHz) are the same part at other speed grades.
    The tray offers only the B part (*proposed*); the blurb names its siblings.
- **The bus:**
  - selected = CS0 H ∧ CS1 H ∧ CS2# L;
  - a transfer commits on **E's falling edge** while selected;
  - D is driven only while selected ∧ R/W H ∧ E H;
  - IRQ# is open-drain in the unit, as the VIA's is.
  - **A read of RDR clears RDRF on that edge, and only once per access.** Every I/O
    cycle must produce exactly ONE E fall (see the computer, below), and a test holds
    the chip to it.
- **Registers (RS):**

  | RS | Read | Write |
  |---|---|---|
  | 0 | status | control |
  | 1 | RDR | TDR |

  - **Control:**
    - CR0–1: ÷1, ÷16, ÷64, or master reset;
    - CR2–4: word select (7E2, 7O2, 7E1, 7O1, 8N2, 8N1, 8E1, 8O1);
    - CR5–6: RTS# and the transmit IRQ, `11` = RTS# low + break;
    - CR7: receive IRQ enable.
  - **Status:** RDRF, TDRE, DCD#, CTS#, FE, OVRN, PE, IRQ (bits 0–7).
  - Check every value against the sheet.
- **Power-up:** the real part is undefined until master reset.
  - The model powers up deterministically *held in master reset*: TxData H (mark),
    IRQ# released, RTS# H, status reading as in reset.
  - It refuses to transmit until a master reset and a control write. That is the
    behaviour a program relying on the undefined state would hit on silicon.
- **Shifting is clock-edge driven.**
  - TxData changes on TxClk's falling edges, at the divide ratio.
  - RxData is sampled on RxClk's rising edges. The ÷16/÷64 receiver finds the start
    bit's middle, as the sheet describes, and samples each bit there.
  - `sim/uart.js` (420) is still the statement of a frame (bit order, parity, framing
    error), so the 68B50 and the adapter agree by construction.
  - **÷1 mode** needs a clock synchronised to the data. Model it literally: it samples
    on each rising edge, with no start-bit search. Document that it only works with a
    synchronised clock, as on silicon.
- **CTS# high inhibits TDRE** (as the sheet says, not the transmitter itself).
- **DCD#:**
  - DCD# going high sets the DCD status bit. With CR7 set, it also raises the
    interrupt.
  - That latched DCD status and interrupt are cleared by reading status and then RDR.
- **Overrun, framing and parity** are reported per the sheet.

### The computer

- **The machine** (*proposed*), sized to the 420 BASIC machine and to Grant Searle's
  well-known design:
  - Z80A;
  - AT28C256 ROM at `$0000–$7FFF`;
  - HM62256 RAM at `$8000–$FFFF`;
  - MC68B50 on I/O ports `$80/$81`;
  - the `usb-serial` adapter;
  - a reset button;
  - **one 74LS00**: ROM /CE ← A15, RAM /CE ← /A15 (a NAND as inverter); MREQ gating
    as the chips need.
  - Read Grant Searle's published schematic for the decode at implementation. Copying
    his circuit is fine; his ROM is not (see Firmware).
- **ACIA select excludes the interrupt acknowledge:** CS2# ← /IORQ, CS1 ← A7,
  CS0 ← /M1.
  - During INTACK, /IORQ and /M1 are both low (`z80.js:183-191`). Without /M1 the
    ACIA would read a selected READ and drive the bus during the acknowledge.
  - RS ← A0; R/W ← /WR.
- **E ← NOT /IORQ**, through a spare NAND of the 74LS00.
  - E rises when /IORQ asserts (T2↑) and falls when it releases (T3↓). That is
    exactly one fall per I/O cycle.
  - On an OUT the byte is still on the bus at that edge (`z80.js:176`: /WR rises at
    T3↓ "while the byte is still on the bus").
  - On an IN the ACIA drives D for the whole of E high, which spans the Z80's sample.
  - Do NOT feed E from the CPU clock, as the Z80A Hello World computer does the VIA's
    PHI2. /IORQ spans two or three clock falls, and each would clear RDRF again. The
    VIA example gets away with it because it only writes.
  - A test reads RDR once through a real IN and checks RDRF cleared exactly once.
- **Interrupts:** IRQ# → the Z80's /INT, pulled up. The firmware runs IM 1
  (RST `$38`) and buffers received bytes in RAM, as Ben's msbasic does on the 6502.
- **TxClk/RxClk ← the CPU's own clock brick, ÷16.**
  - So the line costs no extra clock edges. A second, faster brick would roughly
    double the ticks.
  - baud = clock/16. At a 4.8 kHz clock that is a standard **300 baud**; at ~2 kHz,
    125.
  - **Pick the rate by measurement,** as 420 does. The sim stays correct in simulated
    seconds when it falls behind, so 4.8 kHz → 300 baud is right even if the run
    shows amber.
  - The adapter is preset to match: 300 (or the measured rate) 8N1, RTS/CTS with its
    CTS# ← the ACIA's RTS#.

### Firmware: the licensing question decides it

- **NASCOM BASIC 4.7** (Grant Searle's ROM) is **Microsoft's Z80 BASIC**, and it is
  NOT openly licensed. Microsoft's Sept. 2025 MIT release covered only the 6502
  BASIC. It cannot ship.
- Candidates:
  - ***Proposed*: BBC BASIC (Z80)** by R.T. Russell.
    - Russell agreed to distribute the source under the **zlib** licence; it ships in
      the cpmish project, and an Agon port states the same terms.
    - It expects a small host layer (`OSWRCH`, `OSRDCH`, `OSLINE` and friends), which
      here is ~100 lines over the ACIA.
    - A real BASIC, far richer than Tiny BASIC.
    - Confirm the repository and its `COPYING` before relying on it.
  - **Palo Alto Tiny BASIC** (Li-Chen Wang, 1976, Z80 ports).
    - ~2 KB, trivial to host.
    - Its "@COPYLEFT ALL WRONGS RESERVED" is a dedication, not a licence. Usually
      treated as public domain, but legally soft.
  - **A small monitor** (dump, deposit, go), written for this example.
    - Clean licence, least exciting.
- Whichever is chosen:
  - it is assembled once with an external Z80 assembler (sjasmplus or z80asm,
    *proposed*);
  - it is committed under `scripts/roms/<name>/` with a README (upstream, commit,
    command, SHA-256, licence), plus a NOTICE entry;
  - a `make rom-<name>` target rebuilds and checks it when the assembler is present;
  - `demo-machine.mjs`'s 20-line assembler is not asked to grow into a Z80 assembler.

### Where the example lives

- The **MC68B50's pinout window** offers the machine: `COMPUTERS`/`BUILDERS` gain
  `MC68B50`.
- The Z80A's own example stays Hello World (the same tab-identity reasoning as 420).
- `demos/z80-serial.chiphippo` is written beside it, and `demos/README.md` gains its
  section.
- **The proof uses 420's serial-script validator:**
  - reset;
  - expect the banner;
  - send `PRINT 2+2⏎`, expect `4`;
  - send a 3-line program and `RUN`, expect its output.
  - Every chip `ok`, no warning, in the logic engine.

---

## Implementation steps

1. **`sim/mc68b50.js` + `tests/mc68b50.test.js`.**
   - Registers, master reset and the power-up hold.
   - ÷1/16/64, every word select, and break.
   - CTS#/DCD#, overrun, parity and framing.
   - Interrupts, and the one-clear-per-access rule.
   - Shift timing against `sim/uart.js` decode at every ratio.
2. **The catalog def in `chips-io.js`.**
   - Bump `PALETTE_DEFS` and add `IO_WAVE`.
   - `engine-io.test.js` bench: Z80A + ROM + MC68B50 + adapter. The ROM prints `OK`;
     typing `A` reaches RDR and raises /INT.
   - `DIGITAL_UNSUPPORTED`.
   - A datasheet source: the 68B50 is obsolete, so find a stable host for the
     Motorola/ST/Hitachi (HD6850) sheet; `datasheet-sources.test.js` checks it.
   - The pinout crop.
   - `parts.MC68B50.title` ×7.
   - `chip-library.md`.
   - `website/chips.html`.
3. **The firmware**, per the decision above, under `scripts/roms/`, with its README,
   NOTICE and `make` target.
4. **`z80Serial()` in `demo-computers.mjs`:**
   - the decode, E gating, IM 1 wiring and adapter preset;
   - auto-routed;
   - the serial-script proof;
   - `src/web/demos/MC68B50.json` + `demos/z80-serial.chiphippo`;
   - `gate-demos.test.js` and `engine-parity.test.js` cover it.
5. **Docs:**
   - `demos/README.md`: memory and port map, the E/CS gating and why, the baud
     arithmetic;
   - a user-guide paragraph in 420's "Serial and the Terminal" page (the two ACIAs
     compared);
   - the CLAUDE.md status line;
   - the rule-file notes.

---

## Acceptance criteria

- **Unit suite:** the MC68B50 suite passes, including RDRF clearing exactly once per
  IN through a real Z80 I/O cycle.
- **Line match:** a byte the 68B50 sends at ÷16 off a 4.8 kHz clock decodes in the
  Terminal set to 300 8N1. At 1200 the Terminal shows framing errors.
- **Interrupt acknowledge:** no bus conflict during an interrupt acknowledge with the
  ACIA selected by /IORQ, which the /M1 term guarantees.
- **The Z80 serial computer** boots to its banner and runs a typed program, in the
  logic engine, with every chip `ok` and no warning. It also passes `engine-parity`.
- **Gates:** `make fmt && make lint && make test && make test-i18n` are green.

## Constraints

- All of 420's: the line is levels, and `sim/` is DOM-free.
- No third-party firmware without a confirmed licence and a provenance README.
- The 68B50 needs no line wakes.
- It must not depend on 420 Phase B (the W65C51).

## Verify

`make lint && make test && make test-i18n`, then `make demos`. Then `make debug`:
1. Open the MC68B50's pinout and click its example.
2. Open Terminal… and Run.
3. Type a three-line program and `RUN` it.
4. Put TxData and E on the analyzer: one E fall per IN/OUT, one frame per character.

## Open questions for Jason

1. **Firmware:** BBC BASIC Z80 (zlib; proposed, pending the licence check), Palo Alto
   Tiny BASIC, or a monitor?
2. **Memory map:** Grant Searle's map (ROM low, RAM high, ACIA at `$80`; proposed), or
   one shaped like Ben's 6502 so the two examples read alike?
3. **Speed grades:** offer only the MC68B50 (proposed), or also the MC6850 as its own
   tray entry?
