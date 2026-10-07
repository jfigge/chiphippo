# ChipHippo Feature: Spice Lite 2 — Timing Chips That Follow Their Pins

## Summary

Spice Lite (`features/done/spice-lite.md`) made RC nodes real. A capacitor's voltage
follows its actual charge curve, and every input reads it through its own thresholds.
The **timing chips were left out**. Every part that keeps time with an external resistor
and capacitor still does three things:

- reads its R and C off the wiring;
- recognises a textbook circuit;
- schedules its output from the datasheet formula.

Under Spice Lite the 555 only swaps its constants for ln 2 / ln 3, and the capacitor
voltage it shows is worked out backwards from that schedule.

This feature gives each of those chips **two implementations**:

- **Spice Lite off** — the existing logic, exactly as it is today. Not one result may
  change.
- **Spice Lite on** — the chip behaves like its silicon:
  - it reads the voltages on its pins against its own internal thresholds;
  - it drives its pins the way its output stages do;
  - it sinks and sources real current.

  Its timing is not calculated anywhere. It **emerges** from the RC network's curve,
  which Spice Lite solves the same way as any other node.

The test of success has two halves:

- A textbook 555 astable runs at the datasheet's frequency in Spice Lite without any
  code having recognised it as an astable.
- A circuit the formula never covered does what the real part would do: RA made of two
  resistors in series, a voltage on CONT, a trigger fed through a capacitor.

## The parts

| Part | Today (`src/web/scripts/sim/…`) | What it is in silicon |
|---|---|---|
| NE555 | `timer-555.js` | Two comparators on a divider, a flip-flop, an open-collector discharge transistor and a bipolar output. |
| CD4047B | `monostable.js` `cd4047Logic` | An RC oscillator on R / C / RC COMMON, plus the multivibrator logic. |
| CD4098B, CD4528B, CD4538B | `monostable.js` `dualMonostableLogic` | Per section: an RX CX sense, a discharge switch and the trigger/retrigger logic. |
| CD4060B | `ripple-oscillator.js` | A two-inverter RC oscillator (φI, φ̄O, φO) in front of a ripple counter. |
| CD4541B | `programmable-timer.js` | The same oscillator shape (RS, RTC, CTC) in front of a 16-stage counter and a latch. |

The CD4060B's and CD4541B's **external-clock** modes are already ordinary logic and stay
as they are.

Out of scope:
- the Schmitt-trigger RC oscillators (the '14 and the 40106), which are already real
  nodes in Spice Lite;
- custom chips;
- crystals;
- the CD4046B.

**The rule, going forward:** a part with `timing`-role pins (`isTimed`) ships both
implementations. Add a catalog test that fails on one that doesn't.

## Before you start

- **Read the background.** That is `features/done/spice-lite.md`;
  `features/spice-lite-leds.md` (real LEDs, built 2026-10-07 — it added chip output
  stages and a network solve this feature must REUSE, not repeat); the CLAUDE.md
  sections "Spice Lite", "Values, capacitors & timed parts" and "Simulation"; and the
  header of `sim/spice/engine.js`, above all what it says it does NOT model.
- **Write an implementation plan first**, in `features/`, in the shape
  `features/done/spice-lite.md` took. Have Jason review it before writing code.
- **Every internal number comes from the part's datasheet.** That covers:
  - comparator references and divider resistors;
  - discharge on-resistance;
  - output VOH/VOL and current limits;
  - input thresholds and hysteresis;
  - input and threshold currents;
  - ICC.

  The sheets the parts already cite are the sources: SLFS022K, SCHS044C, SCHS049C,
  SCHS065C, SCHS093C, SCHS085E and HGSEMI CD4528B V1.4. Most of the CD4000 ones are
  scans, so render the pages. Cite each number at the def.
- **Never tune a number to make a formula come out.** Model a part's real internals
  honestly. If the period they give disagrees with the sheet's formula by more than a
  few percent, stop and report it. Don't nudge a threshold.
- **Spice Lite's principle stays:** closed-form curves in TIME, never stepped, no
  SPICE. Spice Lite has exactly ONE small static network solve —
  `spice/lamps.js`'s (Kirchhoff at each net round a group of LEDs, by Newton) — and
  this feature must not add a second: where it needs a network solved, it extends or
  factors out that one. Where the chips need more from Spice Lite (section 3), extend
  it in GENERAL ways that every circuit benefits from. Never add a per-part case to
  `spice/engine.js`. If a part genuinely needs more than first-order curves, stop and
  report.

## 1. Two implementations, one seam

- **Keep `logic` as the off implementation**, untouched. The on implementation is a
  second, separate block on the def; name it in the plan.
- **Only Spice Lite's engine chooses the on implementation.** No part's code asks
  whether Spice Lite is on.
- **The digital engine never reads it.** Everything that imports `sim/engine.js`
  directly stays on the off implementation by construction, as today:
  - the AI verifier;
  - the desk review;
  - `make demos`;
  - the exports;
  - the Properties card's Timing row.
- **Remove Spice Lite 1's half-measure.** The `probe.curves` branch in `timer-555.js`
  is superseded: `CURVE_K`, the `first` lead segment and the back-calculated
  `nodeVolts`. The 555's off implementation is then exactly the datasheet constants it
  already uses with Spice Lite off.
- **Don't change pin roles.** Roles feed the KiCad export, the AI card, the pinout
  window and the off implementation. The on implementation states its own electrical
  behaviour per pin.
- **The sequential logic inside each part stays digital**, reused rather than
  rewritten: the 555's flip-flop, the counters, the retrigger rules, MODE/Q-select,
  RESET. Only the TIMING moves to the pins.

## 2. What "following its pins" means

Each on implementation describes the part at its pins, the way its datasheet's
functional diagram does.

**Sensing.** These pins sense: the 555's THRES and TRIG, RX CX, RC COMMON, φI and RS.
- A sensing pin reads its node's voltage against the PART's own reference for that pin.
- The reference may differ pin by pin: THRES against ⅔ VCC, TRIG against ⅓ VCC.
- Another pin may set it, as CONT does.
- References scale with the supply as the sheet says.
- The 555's RESET reads its own threshold, not 74LS's.

**Driving.** A driving pin acts through its real output stage. That is one of:
- a push-pull output, with its VOH/VOL and drive limit. **This already exists**:
  `sim/spice/output-stage.js` (`outputStage`, `stageCurrent`) with each family's stage
  and a part's own `def.outputStage` — the NE555's bipolar OUT is already stated there
  (VCC − 1.35 V behind 3.5 Ω; LOW 7.5 Ω). Use it; don't state a second output model;
- an open-collector or open-drain switch to a rail, with its on-resistance — the 555's
  DISCH, or a monostable discharging Cx. This is new: add it to `output-stage.js` as one
  more kind of stage, beside the push-pull ones;
- nothing at all, when off.

The oscillator pins drive their RC networks this way: φO/φ̄O, RTC/CTC, and the 4047's R
and C.

**Inside the package.** The internal parts the sheet shows are part of the circuit:
- **The 555's divider on CONT.** A capacitor on CONT forms an RC node, and a voltage on
  CONT moves both thresholds.
- **CX tied to VSS** inside the 4098 and 4538.
- **Input protection diodes.**

**Current.** Pin currents are real, and they go through the existing machinery:
- **Supply demand.** Pin currents count in `spice/supply.js`, along with the part's own
  ICC taken from its sheet rather than a family figure.
- **Ratings.** An output or discharge pin past its rated current should misbehave
  visibly: an RA too small for DISCH to sink, or a 555 output driving a load it can't.
  `spice/loads.js` today counts INPUT loads only. Counting an output's real current
  against its rating is the same question `features/spice-lite-leds.md` leaves open as
  its Q3 (an output feeding an LED counted against the chip). Answer it ONCE, for every
  output current the network solve knows — LEDs, resistors, RC charging, DISCH — not
  separately here (open question 5).
- **Input and threshold currents** count where the sheet says they bound the circuit.
  The 555's threshold current is what limits RA + RB.

**There is no wiring recognition** in the on implementation. A 555 doesn't know it is an
astable. Astable, monostable, bistable or anything else is simply what its comparators,
flip-flop and discharge transistor do with whatever is wired to them.

## 3. What Spice Lite needs to grow

Each of these is a gap Spice Lite 1 states it leaves out, and each one is general.

1. **Timing capacitors become ordinary nodes.** For a part with an on implementation,
   drop the `owned` set in `spice/engine.js` `analyze`. Its RC nets become nodes like
   any other: you can probe them and the analyzer draws them.
2. **Per-pin listeners.** Today a chip listens to a node with one `{up, down}` pair, and
   only through `input`/`io` pins. A sensing pin needs its own reference, and that
   reference can move when another pin moves it (CONT).
3. **Resistor-only junctions.**
   - **The problem.** The 555 astable charges along VCC → RA → DISCH → RB → capacitor,
     and DISCH has no capacitor. The RC nodes (`spice/engine.js` `updateNodes`) do not
     follow a resistor chain through an intermediate net, and `supply.js` follows one
     only where `spice/lamps.js` has solved it (round an LED).
   - **The physics.** A net carrying only resistors, inputs and switches settles
     instantly to the conductance-weighted voltage of its neighbours.
   - **The change.** `spice/lamps.js` already solves exactly this kind of network (its
     UNKNOWN nets, reached through resistors, switch channels and output stages) and
     books what it solves to `supply.js` by `resistorKey`. Generalise that solve, or
     factor its solver out, so the same one answers both questions: the voltage of a
     resistor-only junction (DISCH; φI behind Rs) and the Thévenin equivalent an RC node
     sees through such junctions. No second reduction. It stays static, not
     time-stepping.
   - **The seam between the two.** `lamps.js` holds every RC node FIXED ("the LED does
     not drain the capacitor — stated, not modelled"). Once a node's drive comes from the
     shared solve, say in the plan whether that statement goes (an LED off a timing node
     would then load it, as it does on a bench).
4. **Capacitor coupling.**
   - **The physics.** When a capacitor's far side steps (an inverter output switching),
     the near side steps by the same amount, if nothing drives it hard. The charge
     carried in `analog.caps` is conserved. It then clamps only where a protection
     diode is really in the way.
   - **Who needs it.** The two-inverter oscillators (4047, 4060, 4541) depend on it.
     Their junction swings past the rail behind Rs, and that swing is what makes
     2·ln 3·RC ≈ 2.2·RC come out.
   - **What it fixes.** The guide's stated gap: an AC-coupled trigger (a button through a
     capacitor to a 555's TRIG) now works.
5. **Output stages on the far side.** The stages exist (`spice/output-stage.js`), but
   only the LED solve reads them: an RC node's far side (`spice/engine.js` `farVolts`,
   `highOf`) and `supply.js`'s resistor reading still take a chip's HIGH as its whole
   supply. Read every output through its `outputStage` wherever it feeds a node or a
   resistor — through the shared solve in 3, so there is one place an output's voltage
   under load is worked out.
6. **Fast oscillators are shown as they are today.**
   - **The risk.** In Spice Lite 1, a node that crosses faster than the desk can show
     hits `MAX_ANALOG_EVENTS` and is reported as `oscillation`. A timer at 1 kHz must
     not regress to that.
   - **What stays.** A fast timer is:
     - drawn at `TIMING_CAP_HZ` with its duty kept;
     - reported at its TRUE rate (amber readout, `part-chip--capped`);
     - given no warning.

     The CD4060B and CD4541B keep counting their slow stages at the true rate.
   - **How.** A cycle of exponential segments that repeats with nothing else changing
     is itself closed-form: once it has gone round, its period and duty are exact. Use
     that, not a faster event loop.
   - **For the plan:** say whether the 40106-style oscillators get the same treatment.

Where any of these changes a shipped example's behaviour in Spice Lite,
`tests/engine-parity.test.js` will say so. Either exempt that example with its reason (as
the two 555 examples already are) or fix it.

## 4. The parts, one by one

The plan should cover each part's internal diagram as its sheet gives it.

**NE555.** Take the comparators, divider, flip-flop, discharge and output from
SLFS022K's functional block diagram. It should then produce:
- **Astable:** about 0.693·(RA + RB)·C high and 0.693·RB·C low, with a long first HIGH
  from an empty capacitor.
- **Monostable:** about 1.1·RA·C, with TRIG held low keeping the output HIGH.
- **Bistable:** as today.
- **CONT:** a capacitor on CONT is harmless; a voltage on CONT moves the frequency.
- **RESET:** an RC on RESET works as it does now.

**CD4098B / CD4528B / CD4538B.**
- **Timing source.** The sheets give mostly a formula: ½·Rx·Cx, 0.2·Rx·Cx·ln(VDD) and
  Rx·Cx. Where a sheet shows the internal reference, use it. Where it gives only the
  formula, see open question 1.
- **Retrigger and reset.** Retrigger (Cx discharged again) and RESET (the pulse ends)
  must behave through the node.
- **CD4528B:** T1 is still not grounded inside the part.

**CD4047B.**
- **Source.** SCHS044C's logic diagram: the oscillator on R / C / RC COMMON.
- **Two timings.** The astable's 4.40·RC, and the monostable's 2.48·RC, which uses that
  oscillator differently.
- **Rule.** Get both from the internals, or report that you couldn't.

**CD4060B, CD4541B.**
- **Source.** The Fig. 12 / Fig. 2 networks, giving about 2.2·Rx·Cx and 2.3·Rtc·Ctc.
- **Rs.** With Rs missing, or far below the sheet's recommendation, the clamp changes the
  period. That is real, and it stays visible.
- **External clock:** unchanged.

## 5. What the user sees

- **Real voltages.** The probe and the logic analyzer show measured voltages, not
  reconstructed ones, on THRES/TRIG, DISCH, CONT, RX CX, RC COMMON and the oscillator
  junctions.
- **Timing readouts.**
  - **While running in Spice Lite:** the chip's readout (`.part-chip-timing`,
    `model/timing-summary.js`) shows the MEASURED frequency or pulse width.
  - **While stopped:** the Properties card's Timing row is computed from the off
    implementation and keeps showing the datasheet figure.
- **No new settings.** A part's internals are the part, not a user preference.
  `spice/params.js` `inputThresholds` already says so. (`features/spice-lite-leds.md`
  Q2 asks whether the LED numbers should be editable; if that answer is yes, decide
  whether a timer's internals follow it, so the two features don't take opposite
  lines.)
- **Docs and translations.**
  - **User guide** (`src/web/docs/spice-lite.md`): update the "Timers" section, and the
    list of what is left out: coupling and resistor chains come off it, and so does
    "a HIGH output still reads as its supply voltage" once section 3.5 lands. The LED
    work has already rewritten parts of that list, so edit it as it stands.
  - **CLAUDE.md:** the same changes in its Spice Lite section.
  - **Locales:** every new warning sentence goes into all seven.

## Open questions for Jason (defaults given)

1. **Formula-only sheets.** The 4098, the 4528 and possibly the 4538 give a pulse width
   but no internal reference. May the reference be derived from the formula, stated as
   derived at the def? For example, Rx·Cx means the comparator trips at
   VDD·(1 − e⁻¹). Default: yes.
2. **Recognition warnings in Spice Lite**, such as "no capacitor" and
   `ne555Unrecognised`. Should they be dropped while Spice Lite runs, since the part
   simply does what its pins say? Or shown as advice? Default: dropped.
3. **Diodes in the timing network**, as in the 50 %-duty 555 with a diode across RB.
   This is the same question as `features/spice-lite-leds.md` Q5 (diodes and Zeners
   into the LED network solve): LEDs now have an I–V model, plain diodes are still a
   fixed 0.7 V drop. Answer it once there. If diodes join the shared solve, the 50 %-duty
   555 works with no timer code at all. Default: follows Q5; until then, out of scope
   and listed in the guide as left out.
4. **Capacitor coupling for every node on the desk**, not just the timers'. It is
   physics, and it fixes the AC-coupled-trigger gap. Default: yes.
5. **An output's real current against its rating** (DISCH, a 555 OUT, any output): the
   same decision as `features/spice-lite-leds.md` Q3, made once for every output.
   Default: past the pin's rated current is a warning; past the sheet's absolute
   maximum it is brown smoke, through `spice/loads.js`'s existing lifecycle.

## Testing

- **Off is unchanged.**
  - Every existing timer test passes untouched: `timer-555`, `cd4000-timers`,
    `engine-ripple` and `rc-trace`.
  - The digital engine's results are byte-identical.
  - `make demos` and the hand-built NE555 example still validate.
- **Catalog ratchet:** every timed part has both implementations.
- **Each part in Spice Lite, driven from its pins:**
  - its period or width against its sheet's formula, for several R/C values (and
    several supplies for the CD4000 parts), within a stated tolerance;
  - the 555's long first HIGH;
  - retrigger and reset through the node;
  - a pot turned mid-run carrying on from the capacitor's present voltage, with no jump.
- **Circuits the formula never covered:**
  - RA as two resistors in series;
  - a voltage on CONT;
  - an AC-coupled TRIG;
  - a monostable whose capacitor was not empty when it was triggered.
- **Current:**
  - DISCH sinking a too-small RA, and a 555 output over its limit, misbehave as open
    question 5 decides.
  - Supply demand includes the 555's own ICC and RA's current, booked once (the LED
    solve's resistors are not counted twice).
  - Every existing LED test (`spice-leds.test.js`) still passes once the network solve
    is shared.
- **Engine extensions, each tested on its own:**
  - resistor-only junction voltages, from the shared solve;
  - coupling (charge conserved, and the clamp);
  - per-pin references;
  - output-stage reads.
- **Fast oscillators:**
  - A 555, a 4060 and a 4541 running well above the cap are drawn at the cap, with the
    true rate reported and no `oscillation` warning.
  - The 4060's slow stages keep the true count.
  - A desk of them costs no more per tick than a slow one.
- **Parity oracle:** every exemption carries its reason.

## Deliverables

When you finish, report:

1. What was implemented, what was skipped or changed, and why.
2. For each part: the internals used, with sources, and how close its emergent timing
   came to its sheet's formula.
3. Each Spice Lite extension, and what it changed for circuits that aren't timers.
4. Any part that couldn't be done honestly, and why.
5. Follow-ups and open questions.
