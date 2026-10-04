# ChipHippo Feature: Capacitors, Resistor Values, the 555 and RC-Timing CD4000 Parts

## Summary

This feature brings capacitors back to ChipHippo, lets resistors and capacitors carry typed values, and adds the parts that need them: the 555 timer and the CD4000 parts that use a resistor and capacitor for timing.

ChipHippo is a digital, event-driven simulator. It does **not** do analog simulation, and this feature does not change that. Capacitors carry a value. Only the components built to understand timing read that value, and each does its own timing calculation internally.

## Before you start

- Study how existing components, the properties dialogue, the parts panel and the KiCad export are implemented, and follow the same patterns.
- Never guess a pinout or a timing formula. Take them from the datasheet for each part. Many CD4000 datasheets are scanned, so render the pages as images to read them.
- Keep ChipHippo's teaching philosophy: wrong wiring should misbehave visibly and realistically, never silently.
- **Do not add a general analog solver or anything SPICE-like.** If a part seems to need one, stop and report back.

## 1. Resistor values

Add a **Resistance** field to the resistor properties dialogue, below the standard name/description section.

- The user types a value. Accept the usual forms: `470`, `470R`, `470Ω`, `4.7k`, `4k7`, `1M`, `2M2`.
- If it parses, store the value in ohms and **draw the matching colour bands** on the resistor.
- If it doesn't parse, show a field-level error and keep the previous value.
- **Nothing else about resistor behaviour changes.** Electrically, resistors work exactly as they do now.

## 2. Capacitors

Add capacitors as a new placeable part with **two types**:

- **Ceramic** (non-polarised)
- **Electrolytic** (polarised; draw its polarity marking)

Each has a **Capacitance** field in its properties dialogue.

- Accept the usual forms: `100p`, `100pF`, `10n`, `100nF`, `4.7µ`, `4.7u`, `4u7`, `100µF`, `1m`.
- If it parses, store the value in farads and show it on or near the part.
- If it doesn't parse, show a field-level error and keep the previous value.

Put both under **COMPONENTS**, in a new **CAPACITORS** folder next to RESISTORS.

### Electrical behaviour

**A capacitor is always an electrical non-connect.** It passes no current and joins no nets, anywhere on the board, including across the power rails. (A charged capacitor blocks DC, so this is physically honest.)

However:

- **For board validation, a pin with a capacitor on it counts as connected.** Don't report it as unconnected or floating just because its only connection is a capacitor.
- **Timing components can trace through a capacitor.** A component such as the 555 can follow a capacitor from its own pin to the net on the far side (for example, to find that it goes to ground or the positive rail) and read its capacitance. Provide this as a shared helper that every timing component uses. Don't reimplement it in each part.
- Provide the same kind of helper to read a resistor's value and find the net at its far end, so timing components can find their R and C values from the wiring.

### Drag-time note

When a capacitor is dragged onto the board, show a short, non-blocking note: it is a value-carrying part that does not filter, smooth or store charge in the simulator, but timing chips read its value and it exports correctly to KiCad. Follow the app's existing pattern for hints, and let the user dismiss it permanently.

### KiCad export

Capacitors and resistors must export with their values and the right symbols: ceramic as a standard capacitor, electrolytic as a polarised capacitor. This is the main reason capacitors are allowed anywhere on the board, so test it.

## 3. The 555 timer

Add the 555 under **COMPONENTS → OSCILLATORS**, next to the existing oscillators. It is not a 74LS or CD4000 part, so it does not go under CHIPS and has no `family` value.

Pinout and formulas come from TI's NE555 datasheet: https://www.ti.com/lit/ds/symlink/ne555.pdf (confirm the link resolves).

### No mode switch

**The 555 must not have a user-selected astable/monostable mode.** A previous attempt used one and it was rejected. The 555 works out its own configuration from its wiring, the way the real chip does:

- **Astable:** Trigger (pin 2) and Threshold (pin 6) tied together to the timing capacitor, with Discharge (pin 7) between the two resistors. Use the datasheet frequency and duty-cycle formulas with the R1, R2 and C values found by tracing.
- **Monostable:** Threshold and Discharge tied to the capacitor, with Trigger driven by an external signal. A falling edge on Trigger starts a pulse whose length comes from the datasheet formula.
- **Anything else** (missing capacitor, missing resistor, unrecognised wiring): don't guess. Show a visible, explanatory warning on the chip and leave the output in a defined state.

Respect Reset (pin 4). Control Voltage (pin 5) is usually tied to ground through a capacitor. Don't model a changed control voltage; treat it as standard.

### Frequency reporting and the cap

The simulator cannot animate very fast oscillation, so:

- The 555 always **reports the frequency** it has calculated (or the pulse length in monostable mode), where the user can see it, following the app's existing pattern for showing component information.
- **Cap the frequency at 100 _(confirm units with Jason: Hz or MHz)_.** Above the cap, don't try to animate every edge. Show the output as oscillating, and report the true calculated frequency alongside it.

## 4. RC-timing CD4000 parts

Add the CD4000 parts that need a resistor and capacitor. They go on the **CD4000 branch** of CHIPS, with `family: CD4000`, using the same family, mode and voltage machinery as Batches 1 and 2.

| Part | Description | Datasheet |
|---|---|---|
| CD4047B | Monostable/astable multivibrator | https://www.ti.com/lit/ds/symlink/cd4047b.pdf |
| CD4060B | 14-stage ripple counter with oscillator | https://www.ti.com/lit/ds/symlink/cd4060b.pdf |
| CD4098B | Dual monostable multivibrator | https://www.ti.com/lit/ds/symlink/cd4098b.pdf |
| CD4528B | Dual monostable multivibrator | https://www.ti.com/lit/ds/symlink/cd4528b.pdf |
| CD4538B | Dual precision monostable multivibrator | https://www.ti.com/lit/ds/symlink/cd4538b.pdf |

**None of these links have been checked.** Confirm each one resolves to the right datasheet before using it. If a link is wrong and you can't find the right TI datasheet, leave that part out and report it.

- Each part has **its own implementation** of how it reads its R and C and turns them into timing, using the shared trace helpers and the formulas in its own datasheet.
- **CD4060B:** the oscillator must work from an RC network or a crystal per the datasheet. If a crystal is out of scope, support the RC oscillator only and report it. It must also still work when driven from an external clock.
- The same frequency cap and reporting rules as the 555 apply to every oscillating part.
- The CD4046B (phase-locked loop) is **out of scope** for this feature.

**Folder:** the CD4060B goes in COUNTER. For the monostables there is no existing function folder that fits. Default to a new **TIMER** folder on the CD4000 branch unless Jason says otherwise.

## Open questions for Jason

1. Frequency cap units: **100 Hz or 100 MHz?** _(Fill in before handing this off.)_
2. Should a reversed electrolytic capacitor do anything (for example, a warning)? Default: polarity is visual and exported only, with no simulated effect.
3. TIMER folder for the CD4000 monostables, or somewhere else?

## Testing

- Resistor and capacitor parsing: every accepted format, plus rejection of invalid input.
- Colour bands drawn correctly for a range of resistor values.
- A capacitor never joins two nets, including across the power rails.
- Board validation treats a capacitor-only connection as connected.
- The trace helpers find the correct far-side net and value through a capacitor and through a resistor.
- 555 astable: calculated frequency and duty cycle match the datasheet formulas for several R/C combinations.
- 555 monostable: pulse length matches the datasheet formula; triggers correctly.
- 555 unrecognised wiring: shows the warning instead of guessing.
- Frequency above the cap: output shown as oscillating, true frequency reported.
- Each CD4000 timing part: its datasheet timing behaviour.
- KiCad export of both capacitor types and resistors, with values.

## Deliverables

When you finish, report:

1. What was implemented, and anything skipped or changed, with reasons.
2. How the 555 detects its configuration, and which wirings it recognises.
3. Which datasheet links were confirmed, and any parts dropped.
4. Any follow-ups or open questions.
