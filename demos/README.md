# Chip Hippo demos

Two kinds of ready-to-load design:

- **One project per chip GROUP** — `NAND.chiphippo`, `Flip-flop.chiphippo`,
  `Multiplexer.chiphippo` and so on: **every 74xx part in the catalog**, one
  desktop each, wired up on a logic bench you can flip switches on (see below).
- **`65xx-*`** and **`eater-*`** — whole breadboard computers: a
  **`.chiphippo`** schematic (the wired-up circuit) plus a **`.hex`** ROM image
  (the program).

Both are generated and validated by `make demos`, which builds every wire from the
model and then runs each circuit through the simulation engine to prove it actually
works — a truth table enumerated switch by switch, or a program run clock by clock.

## The group projects — a desktop per chip

The groups are the **catalog's own**, so the demos track the parts palette:

| Project | Desktops |
| --- | --- |
| `NAND` | '00 '10 '20 '30 '01 '03 |
| `NOR` | '02 '27 |
| `Inverter` | '04 '05 '14 |
| `AND` | '08 '11 |
| `OR` / `XOR` | '32 · '86 |
| `Buffer` | '125 '240 '244 '245 |
| `Flip-flop` | '73 '74 '76 '107 '175 '112 '174 '273 |
| `Latch` | '75 '279 '259 '533 '573 |
| `Counter` | '161 '193 '169 '90 |
| `Shift-register` | '164 '165 '595 |
| `Decoder` | '138 '139 |
| `Register` | '173 |
| `Multiplexer` | '151 '153 '157 '257 |
| `Display-driver` | '47 |
| `Comparator` | '85 |
| `Encoder` | '148 |
| `Arithmetic` | '283 '83 '181 |

**File ▸ Open…** one of them, then pick a chip from the **desktop tabs** along the
top.

**Or reach one from inside the app.** Every desktop below also ships *within*
Chip Hippo (`src/web/demos/<ref>.json`, written by the same `make demos` pass, so
the two copies cannot drift). Right-click a chip on the desk ▸ **Pin Assignment**,
then click the **circuit button** in that window's top-right corner: the bench for
that part arrives as a desktop of its own, called `74LS00 example`, in whatever
project you already have open. That is the everyday way in — the group projects
here are for comparing a whole family side by side.

Every desktop is the same bench, so once you can read one you can read all
of them:

- a **5 V brick** feeding both power rails, and (for the clocked parts) a **clock**;
- **switched inputs** on the left — each slide switch throws between +5 V and a
  10 kΩ pull-down, so an input is never left floating. Click one while the
  simulation runs. A part with more inputs than that (an adder, the '30) gets an
  **8-way DIP switch bank** over a bussed resistor network instead;
- the **chip under test** in the middle, straddling the trench;
- **LED read-outs** on the right, one per output, each through its own resistor.
  An active-LOW output (the '138's, say) has its LED wired the other way up, so a
  lit LED always means "this output is asserted";
- a **caption** above the bench saying what the demo shows.

Press **Run** (Space) and flip switches. Each desktop opens in a state chosen to
show the part doing something — the '47 reading `5`, the '125 with exactly one
dark lamp, the '148 encoding line 5.

The **Memory**, **Interface** and **PROCESSOR** groups have no project: a RAM or
a CPU can't be demonstrated by flipping switches at it, which is what the 65xx
demos below are.

## Running a 65xx demo

1. **File ▸ Open…** and pick the demo's `.chiphippo`.
2. **Load the program into the ROM.** A fresh ROM comes up filled with random
   noise, so it needs the demo's `.hex`:
   - Double-click the **ROM** chip to open its memory inspector, then **Import**
     the matching `.hex` — or use the external **programmer** menu action and pick
     the `.hex`.
   - The `.hex` is the whole ROM image: the program at the bottom **and** the
     reset vector in the last four bytes, so the CPU boots straight into it. The
     CPU fetches that vector from `$FFFC`, which is the image's `$1FFC` on the
     8 KiB parts (mirrored eight times through `$8000–$FFFF`) and `$7FFC` on the
     32 KiB AT28C256, which covers the half exactly.
3. **Press Run** (Space). The clock starts and the CPU executes — one memory
   access per clock cycle, so you can watch the address bus advance (or **Step**
   the clock by hand).

The W65C02 powers up already in reset and boots the moment you Run — no reset pulse
needed. The clock is deliberately slow (a few Hz) so the output is visible.

## The 65xx demos

### `65xx-blink` — CPU + ROM + VIA, blinking an LED

**W65C02** + an **8 K ROM** + a **W65C22 VIA**, with a single **74LS04** inverter
doing the address decode, and **PB0 → resistor → LED → GND** for the output.

- **Memory map** (split on A15 by the inverter): **ROM** at `$8000–$FFFF`
  (program + vectors), **VIA** at `$0000–$7FFF`.
- **Program:** set `DDRB = $FF` (Port B all outputs), then loop toggling `ORB`
  bit 0 — so **PB0 blinks the LED**.

```asm
      LDA #$FF   ; STA $0002   ; VIA DDRB = outputs
      LDA #$01
loop: STA $0000   ; VIA ORB = A (PB0 → LED)
      EOR #$01    ; toggle bit 0
      JMP loop
```

### `65xx-lcd` — CPU + ROM + HD44780, printing "HI"

**W65C02** + an **8 K ROM** + a **16×2 character LCD (HD44780)**, decoded by a
**74LS04** (inverter) and a **74LS08** (AND gate). The AND gate makes the LCD
strobe **`E = /A15 AND PHI2`**, so every write to low memory pulses `E` and latches
a byte; **`RS = A0`** (0 = instruction, 1 = data) and **`RW = RWB`**.

- **Memory map:** ROM at `$8000–$FFFF`, LCD at `$0000–$7FFF` (any low-memory write
  clocks the LCD).
- **Boards:** four, and the LCD's own is the top one. The module's 16-way header
  is along its BOTTOM edge, so its body stands UP off the row it plugs into —
  seated on row `j` of a board with clear desk above it, it hangs off the bench
  as a real one would instead of covering the board below.
- **Program:** the HD44780 init sequence (function set, display on, clear, entry
  mode) then two data writes — the screen shows **`HI`**.

```asm
LDA #$38 : STA $0000   ; function set (8-bit, 2 lines)
LDA #$0C : STA $0000   ; display on
LDA #$01 : STA $0000   ; clear
LDA #$06 : STA $0000   ; entry mode (increment)
LDA #'H' : STA $0001   ; data
LDA #'I' : STA $0001   ; data
JMP *                  ; done
```

Both of those programs are **stack-free** on purpose: there's no RAM in either
minimal computer, so nothing may touch page 1. `eater-core` below is what adding
the RAM chip buys you.

### `eater-core` — the Ben Eater 65C02 computer, CPU + ROM + RAM

The core of [Ben Eater's 6502 computer](https://eater.net/6502): a **W65C02**, an
**AT28C256** 32 K EEPROM, a **62256** 32 K SRAM, and **one 74LS00** doing the
whole address decode. This is step one — the VIA, the LCD, the buttons and the
address/data bus LEDs hang off it and change none of its wiring.

- **Memory map:** **RAM** `$0000–$3FFF` (A15 = 0, A14 = 0) · **VIA**
  `$4000–$7FFF` (decoded here, wired when the VIA lands) · **ROM**
  `$8000–$FFFF` (A15 = 1).
- **The decode is four NAND gates**, which is the whole reason a quad NAND is
  the one glue chip on the board:

  | Gate | Function | Drives |
  | --- | --- | --- |
  | G1 | `NAND(A15, A15)` = `/A15` | ROM `/CE` |
  | G2 | `NAND(A14, A14)` = `/A14` | — |
  | G3 | `NAND(/A15, /A14)` | RAM `/CE` (low iff A15 = 0 **and** A14 = 0) |
  | G4 | `NAND(/A15, A14)` | VIA `/CS2B` (spare until the VIA arrives) |

- **The two memories share one pin map.** The AT28C256 and the 62256 are
  pin-for-pin identical, which is why a real board takes either in the same
  socket — the generator states that map once rather than typing it twice.
- **Strapping**, as a real board does it: both `/OE` tied low (a deselected part
  floats on `/CE` alone, and a RAM mid-write floats on `/WE`), the EEPROM's
  `/WE` tied **high** because the circuit never programs it, and the RAM's `/WE`
  straight off the CPU's `R/W̄`.
- **Program:** count to five in RAM — through a **subroutine**, so the return
  address goes onto a stack that only exists because the RAM is there.

```asm
        LDX #$FF
        TXS              ; stack pointer → $01FF, in the SRAM
        LDA #$00
        STA $0200        ; RAM counter := 0
loop:   JSR bump         ; pushes the return address into RAM
        LDA $0200
        CMP #$05
        BNE loop
        JMP *            ; halt
bump:   INC $0200        ; read-modify-write in RAM
        RTS              ; pulls the return address back out
```

The build asserts all of it through the engine: `$0200` reaches 5, **and** the
return address `$800A` is sitting at `$01FE/$01FF` — which the CPU has no memory
of its own to fake.

### `eater-io` — the same machine with its VIA, LCD and buttons

`eater-core` plus the I/O that makes it Ben Eater's computer: a **W65C22 VIA** at
`$6000` driving a **16×2 HD44780** off its two ports, and **five buttons** on
PA0–PA4. Not a wire of the core changes — the VIA's chip select is the decoder's
fourth gate, which step one left spare for exactly this.

| VIA | Wired to |
| --- | --- |
| PB0–PB7 | LCD DB0–DB7 — the data byte |
| PA7 · PA6 · PA5 | LCD RS · RW · E — the strobe the program pulses by hand |
| PA0–PA4 | SW1–SW5, each held high by a pull-up and shorted to GND when pressed |

- **The LCD is driven by software, not by the bus.** In `65xx-lcd` above, `E`
  comes from an AND gate, so a write to low memory clocks the display. Here the
  program owns all three control lines: it puts a byte on port B, raises `E`, and
  drops it again — the controller latches on that **falling** edge.
- **Program:** bring the VIA up (`DDRB = $FF`, `DDRA = $E0` — PA5–7 out, PA0–4
  in), run the HD44780 init, print `Hello, world!`, then poll the buttons for
  ever. A press prints its digit `1`–`5` and waits for release.
- **Validated twice**, because a button's pressed-ness is transient runtime
  state rather than anything the document can hold: once untouched (the screen
  must read `Hello, world!`) and once holding **SW3** (it must read
  `Hello, world!3`). That one character is the whole input path — the pull-up
  holds PA2 high, the press pulls it low against that pull, the VIA reads the
  pin back on IRA, and the program's bit scan turns the right bit into the right
  digit. A wrong digit means the buttons are on the wrong port pins, which
  nothing else would notice.

The program is assembled by a **20-line two-pass assembler** in
`make-demos.mjs` (`asm`/`at`/`rel`): with six forward references, a hand-counted
branch offset is a byte you cannot check by reading.

## Regenerating

```bash
make demos
```

Rebuilds every `.chiphippo` + `.hex` pair from `scripts/make-demos.mjs`, then
every group project **and every bundled per-chip example** from
`scripts/make-gate-demos.mjs` — one `buildDemo` call feeding both outputs, so
`demos/<Group>.chiphippo` and `src/web/demos/<ref>.json` come from the same build
and are held to byte-for-byte agreement by the tests. `src/web/demos/` is swept
on every run, so a chip dropped from the catalog cannot leave a live example
button behind. Everything is re-validated through the engine. Both are guarded by
`make test` as well
(`tests/demos.test.js` and `tests/gate-demos.test.js` load the committed files
and run them), so a catalog or engine change that breaks a demo fails CI.

A chip added to the catalog **fails the run** until it has a demo: the group set,
the membership and the desktop order all come from `CHIP_DEFS`, so there is no
way to add a part and quietly leave it undemonstrated. Writing one means adding
an entry to `scripts/demo-specs.mjs` — which pins the switches feed, which pins
get LEDs, and the truth table it must satisfy — and re-running `make demos`. The
bench (`scripts/demo-bench.mjs`) works out every hole, rail and resistor from the
model, and the build refuses any layout you could not have placed by hand.
