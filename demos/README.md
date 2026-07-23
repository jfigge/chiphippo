# Chip Hippo demos

Ready-to-load 65xx breadboard computers. Each demo is a **`.chiphippo`** schematic
(the wired-up circuit) plus a **`.hex`** ROM image (the program). They're generated
and validated by `make demos` (which builds every wire from the model and then runs
each circuit through the simulation engine to prove it actually works).

## Running a demo

1. **File ▸ Open…** and pick the demo's `.chiphippo`.
2. **Load the program into the ROM.** A fresh ROM comes up filled with random
   noise, so it needs the demo's `.hex`:
   - Double-click the **ROM** chip to open its memory inspector, then **Import**
     the matching `.hex` — or use the external **programmer** menu action and pick
     the `.hex`.
   - The `.hex` is the whole 8 KiB image: the program at the bottom **and** the
     reset vector at `$1FFC/$1FFD`, so the CPU boots straight into it.
3. **Press Run** (Space). The clock starts and the CPU executes — one memory
   access per clock cycle, so you can watch the address bus advance (or **Step**
   the clock by hand).

The W65C02 powers up already in reset and boots the moment you Run — no reset pulse
needed. The clock is deliberately slow (a few Hz) so the output is visible.

## The demos

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

Both programs are **stack-free** on purpose: there's no RAM in these minimal
computers, so nothing may touch page 1. Add a RAM chip (and a stack) when you grow
them into something bigger.

## Regenerating

```bash
make demos
```

Rebuilds both `.chiphippo` + `.hex` pairs from `scripts/make-demos.mjs` and
re-validates them through the engine. `tests/demos.test.js` (part of `make test`)
also loads the committed files and runs them, so a catalog or engine change that
breaks a demo fails CI.
