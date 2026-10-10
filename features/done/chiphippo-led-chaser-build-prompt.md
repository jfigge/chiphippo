# Claude Code Prompt: Build an NE555 + CD4017 LED Chaser Verification Circuit in ChipHippo

## Goal

Create a real-world (not synthetic test) demonstration circuit that exercises the newly added ChipHippo components, then produce a ChipHippo project save file I can load onto a desktop and run to verify the components behave correctly.

The circuit is the classic **LED chaser**: an NE555 astable oscillator clocks a CD4017 decade counter, which lights ten LEDs one at a time in sequence.

## Step 1: Learn the codebase first (do not guess)

Work in the ChipHippo repo (github.com/jfigge/chiphippo). Before writing anything:

1. Find the project save-file format (serialisation/deserialisation code, any existing example or fixture files). Match it exactly, including version fields, desktop/tab structure, breadboard, chip, wire and signal representations.
2. Find the part IDs/type names for: the 555 timer (under COMPONENTS -> OSCILLATORS), the CD4000 series parts, resistors, capacitors (ceramic and electrolytic), diodes/LEDs, and any other recently added components (check recent commits and the parts panel definitions for anything else new, including any zener-type diode).
3. Find how the properties fields work for resistors (resistance value, colour bands) and capacitors (farad value that must parse), so the values I set are valid.
4. Find how wires, breadboard pin addressing and power rails are represented, so generated wiring is valid and passes board validation (no unconnected-pin flags where a capacitor is the only connection).
5. Find how Signals (input markers) are defined, since I want at least one manual input.

If any component named below does not exist in the repo, say so plainly and substitute the nearest existing one rather than inventing a part.

## Step 2: The circuit

Single breadboard, 5V supply rails, one desktop.

**555 astable (self-detected from wiring, no mode selection):**
- Pin 1 (GND) to ground
- Pin 8 (VCC) to +5V
- Pin 4 (RESET) to +5V
- R1 from +5V to pin 7 (DISCH): 1k ohm
- R2 from pin 7 to pin 6 (THRES): 47k ohm
- Pin 2 (TRIG) tied to pin 6
- C1 from pin 6/2 to ground: 10uF electrolytic (observe polarity: positive to the timing node)
- C2 from pin 5 (CTRL) to ground: 10nF ceramic
- Pin 3 (OUT) is the clock

Expected frequency is about 1.44 / ((R1 + 2*R2) * C1), roughly 1.5 Hz. ChipHippo caps reported 555 frequency at 100, so this slow rate should be fully representable and clearly visible. Confirm the simulator's reported frequency is consistent with this figure.

**CD4017 decade counter:**
- Pin 16 (VDD) to +5V, pin 8 (VSS) to ground
- Pin 14 (CLOCK) from 555 pin 3
- Pin 13 (CLOCK INHIBIT) to ground
- Pin 15 (RESET) to a Signal input (momentary, default low) so I can reset the count manually
- Outputs Q0 to Q9 on pins 3, 2, 4, 7, 10, 1, 5, 6, 9, 11
- Pin 12 (CARRY OUT) to a spare LED or left as an observable output

**Outputs:**
- Ten LEDs, one per Q0 to Q9, each in series with a 330 ohm resistor to ground
- One extra LED on the 555 output (pin 3) with its own 330 ohm resistor, so the raw clock is visible

**Optional extras that exercise more new parts (include only if the parts exist and behave sensibly):**
- A diode from Q5 to RESET (via the same reset node) to demonstrate a shortened six-step chase, behind a second Signal toggle so it can be switched in and out
- Any other new component from Step 1 used in a real role (for example a zener or clamp on the supply), not decoration

## Step 3: Deliverables

1. The ChipHippo save file, saved to a sensible location in the repo (for example an examples or samples folder, following existing convention), named `led-chaser-555-4017.<ext>` using the project's real extension. It must load cleanly onto a desktop with no manual rewiring.
2. A short `led-chaser-555-4017.md` next to it containing: the parts list with values, a pin-by-pin wiring table, and the expected behaviour.
3. A verification checklist I can follow in the running app:
   - 555 reports roughly the expected frequency
   - Exactly one of Q0 to Q9 is high at any time and it advances on each clock
   - After Q9 it wraps to Q0
   - Pulsing the reset Signal returns the count to Q0
   - Changing C1 or R2 in the properties dialogue changes the chase speed accordingly
   - Resistor colour bands render for the entered values
   - No unconnected-pin warnings on the capacitor pins

## Step 4: Verify before reporting

- Load the generated file through the project's own loader (a unit test or script, not just a visual check) and confirm it deserialises without errors.
- If the simulator can run headless, step it and confirm the Q0 to Q9 sequence. If it cannot, say so and list exactly what I need to check by hand.
- Run the existing test suite and confirm nothing regressed.

## Constraints

- Keep scope tight: build the circuit and the save file only. Do not refactor, add features, or change component behaviour. If you find a bug in a new component, report it with a minimal reproduction instead of fixing it.
- Do not invent save-file fields. Derive everything from the code.
- Report anything surprising about how the new components behaved while wiring this up.
