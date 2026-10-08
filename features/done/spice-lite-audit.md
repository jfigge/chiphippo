# Spice Lite audit — what still runs on the digital abstraction

**Status:** audit 2026-10-07. Jason's answers are folded in (below). The migration is in
progress — see "Roadmap".

Jason asked for an audit of the Spice Lite implementation looking for missing
migrations from the digital engine. His bar is that, **with Spice Lite on, every
component operates on wire voltage and current**, and that no component imitates analog
behaviour with a digital stand-in.

## Headline

Spice Lite (`sim/spice/`) is the digital engine (`sim/engine.js`) driven through hooks,
with analog overlays. At the time of the audit, voltage or current changed what a chip
reads, drives or does in only five places:

1. **RC nodes.** A net with a capacitor whose far lead goes somewhere, and no strong
   driver. The `input` and `levels` hooks (`spice/engine.js:497–507`) act on those nets
   alone; there each listener reads the node through its own thresholds.
2. **Gate-delay holds** (the `outputs` hook). These are time, not voltage.
3. **Supply droop and wire sag**, through `psuVolts`/`chipDrop`, into the same hard
   power-range cut-off.
4. **The input fan-out budget**, giving brownout and brown smoke (`spice/loads.js`).
5. **LED and segment verdicts** (`spice/lamps.js`). A Newton solve after the settle, drawn
   and never fed back.

**On every net without a capacitor, every level was `resolve.js`'s strength precedence:**
supply > output > pull > Z, with the resistor relaxation, `diodeDrive` and
`channelGroups` of `settle-pass.js`. `spice/output-stage.js` was read by the LED solve and
nothing else; its header said "the digital level is all the rest of the desk needs".

Two current models sat side by side:

- `supply.js` — a level read as a voltage, junctions at a fixed `FORWARD_VOLTS` drop;
- `lamps.js` — Kirchhoff with I–V curves.

## Evidence — repros, run through both engines

Each circuit was built with `tests/timing-fixtures.js`'s `bench()` and run with
`runner(doc, {engine})` at t = 0 (and later where time matters). The "bench truth"
column is what a real bench does.

| #   | Construction                                                                               | Digital                             | Spice Lite (at audit)                               | Bench truth                               |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| A   | CD4069UB at e10 on 5 V, 1A to GND; 100 nF from 1Y to GND; 1Y linked to 2A                  | 1Y=H, 2Y=L                          | **1Y node frozen at 0 V; 1Y reads L, 2Y=H forever** | node charges in ~40 µs                    |
| A′  | CD4066B on 5 V, control 13 to +, pin 1 to +; 100 nF from pin 2 to GND; pin 2 into a 74LS04 | H                                   | **frozen at 0 V**                                   | 470 Ω × 100 nF ≈ 47 µs                    |
| B   | 74LS04, 1A to + (1Y LOW); 10 k from + to N; diode anode N, cathode 1Y; N into 2A           | N=H                                 | N=H                                                 | ≈0.85 V → LOW, 2Y=H                       |
| C   | 10 k from + to N, 1 k from N to GND, N into 74LS04 1A                                      | X                                   | X                                                   | 0.45 V → LOW                              |
| D   | 74LS04 (5 V) 1Y HIGH into CD4069UB 1A on a 12 V supply                                     | H + `marginal-high`, `mixed-supply` | same                                                | 3.6 V < 6 V → LOW                         |
| F   | 74LS04 whose VCC is fed from + through a series diode                                      | unpowered                           | unpowered                                           | 4.3 V; a CD4000 part would run            |
| G   | PSU + wired to − (through the chip's VCC node)                                             | `short` warning                     | PSU holds 5 V, 1.6 mA                               | current limit; rail → ~0 V                |
| H   | 74LS04 1Y HIGH wired to GND                                                                | L, no current                       | same                                                | IOS 20–100 mA                             |
| I   | 74LS04 1Y (H) wired to 2Y (L)                                                              | X + `conflict`, no current          | same                                                | ~24 mA; ≈0.7 V → LOW                      |
| J   | 10 k from 74LS04 1A to GND                                                                 | 1A=L                                | 1A=L                                                | IIL × R ≈ 1.4–4 V → HIGH/marginal         |
| K   | 10 k pot at 90 % across the rails, wiper into 74LS04 1A                                    | X                                   | X                                                   | 0.5 V → LOW                               |
| M   | NPN: base through 10 MΩ from a 74LS HIGH, 1 k collector pull-up, emitter GND               | C=L                                 | C=L                                                 | β·Ib ≈ 30 µA → C stays HIGH               |
| O   | Two 74LS05 outputs wired together (one off, one on), 4.7 k pull-up                         | X + `conflict`                      | same                                                | wired-AND → LOW                           |
| P   | + → diode → red LED → 330 Ω → GND                                                          | anode H, LED lit                    | **LED dark, 0 mA, PSU 0 A**                         | ≈7 mA, lit                                |
| Q   | `outputStage(CD4511B, 5 V, "H")`                                                           | —                                   | **limit 4.2 mA**                                    | sources up to 25 mA (its own def says so) |

## Findings

### Tier 0 — defects in what Spice Lite already claimed

- **0.1 A node frozen under a current-limiting driver (A, A′).**
  - **The path.** `updateNodes` decided "is this node driven?" from
    `result.strongLevels`. While any part on the desk limits LED current
    (`ctx.limitsLed`), that map is the LED-burn resolution (`settle-pass.js:588–610`),
    which drops every ≤ 5 V CD4000 output and every ≤ 5 V switch channel.
  - **The result.** The node counted as undriven, with no resistor and τ = ∞. The
    `levels`/`input` hooks then overwrote the chip's own output net for every reader.
  - **Why it escaped.** `farVolts` fell back to `netLevels`; `updateNodes` did not. The
    Schmitt test runs at 10 V, where no limit applies.
- **0.2 An LED behind a diode solved dark (P).** A regression against the digital engine.
  - A diode was no branch in the LED solve (`lamps.js:78–79, 150–153`).
  - The net between the diode and the LED was neither fixed nor driven, so that network
    had no source.
- **0.3 The CD4511B's HIGH was capped at the CMOS saturation current** (4.2 mA at 5 V).
  - `outputStage` falls back to the family `limitMa` when a def's side gives none, and
    the 4511's high side gave only volts and ohms.
- **0.4 Smaller items.**
  - The CD4007UB borrowed the 4066's on-resistance (`channelOhms` checked only
    `def.transistor`).
  - The 74LS bus drivers' `drive` changed only the fan-out budget.
  - Spice `settle()` returned `lamps: new Map()` rather than null, so a published settle
    would have shown every LED dark.

### Tier 1 — the level resolution itself (the core gap)

1. **A net's level was strength precedence, never a voltage** (`resolve.js:41–74`).
   - Dividers and pots read X (C, K).
   - Chains alternate with the parity of the desk's resistor + diode count.
   - Fights read X with no current (I).
   - A rail silently beats an output (H).
   - A supply short is a warning while the PSU holds its voltage (G).
2. **Inputs read digital levels off RC nodes.** `marginal-high` and `mixed-supply` stand in
   for a threshold comparison nobody made (D). CMOS has no X band on a held net. Schmitt
   pairs act on RC nodes only. An input past its absolute maximum does nothing.
3. **Input pins carry no current.**
   - A pull is the PULL tier whatever the input sources (J).
   - `loads.js` books input current only against a DRIVING output.
   - 51 of the 52 shipped 74LS demo benches pull TTL inputs down through 10 kΩ
     (`scripts/demo-bench.mjs` slide switch and DIP-bank `rnet9`), and so does the AI
     compiler (catalog default 10 kΩ). A real bench reads those OFF positions HIGH.
4. **An output HIGH is its whole supply.**
   - This holds in `highOf`/`farVolts`, in `supply.js` `levelVolts`, and for every input.
   - Open-collector parts (74LS01/03/05, the '181's A=B) were modelled as totem-pole, so
     a wired-AND fights (O).
5. **A resistor was the weakest tier plus a relaxation.** Ohms are discarded by the
   context. RC nodes took only resistors directly on the node. Divider and chain currents
   went unbooked.
6. **Diodes.**
   - `diodeDrive` passes H only, never L (B).
   - A Zener is a plain diode.
   - The 0.7 V drop existed only in `supply.js`.
   - Diodes burned by the digital junction rule even under Spice Lite
     (`sim-overlay.js` `#updateDiodes`, view-only — a "burnt" diode still conducted).
7. **Transistors.**
   - A BJT is on iff its base level equals the on-level. No VBE against the emitter, no β,
     no base current, no VCE(sat) (M).
   - A MOSFET's `holds` is a digital memory standing in for gate charge; VGS is not read
     against the source.
   - The control reads the published level (a node with no listener: H at half the
     desk's HIGHEST supply).
8. **Analog switches** join nets as levels at output strength. rON appeared only in the
   LED solve, and an analog voltage was not carried through a channel.
9. **Power was by topology** — a PSU + terminal on the VCC net — not pin voltage. A chip
   fed through a resistor, diode, transistor or another chip's output was UNPOWERED (F).
   ICC was a family constant counted whether powered or not.
10. **Shorts and fights drew no current** (G, H, I).
11. **Bench sources** (clock brick, signal flags, serial Input tags) were ideal at the
    desk's HIGHEST supply.

### Tier 2 — parts that time by formula (`chiphippo-spice-lite-2.md` covers them)

12. **NE555.**
    - It recognises its wiring and times by formula, with the ln 2 / ln 3 stopgap and a
      back-calculated capacitor voltage.
    - CONT is ignored and DISCH is no output.
    - TRIG and RESET on an RC node read the 74LS 1.4 V point.
13. **CD4047B, 4098B, 4528B, 4538B, and the 4060B/4541B in RC mode.** Each is R·C × a
    constant, and the `owned` set hides their capacitors.
14. **Readouts and the Properties Timing row** show the formula.

### Tier 3 — passives and time

15. **No capacitor coupling.**
16. **An inductor is a wire.** No RL curve; sag does not route through it.
17. **The LED solve was an island.** RC nodes were held fixed, inputs were not loads, and
    chip outputs came from the digital `driven` map.
18. **Jason's LED decision Q3** ("an LED never overloads the chip driving it").

### Tier 4 — structural warnings standing in for measurements

19. **Under a voltage model these become outcomes:**
    - `marginal-high` and `mixed-supply`;
    - `short` and `conflict`;
    - the LED-rule stand-ins (`limitsLedCurrent`, `ledLimit`, `highCurrent`), which were
      also the root of 0.1.

### Tier 5 — what the user sees

20. **Probe and analyzer volts covered only RC nodes and the 555's capacitor.**
21. **The HD44780's V0 and A/K are `nc`.** The backlight draws nothing and contrast never
    blanks the glass.
22. **Integration Output and trigger tags read the published level.**
23. **`loads` and `sag` were not published.** The 3D view reads only lit/burnt.

### Not mimicry (left as is)

- Chip logic.
- Gate-delay holds.
- Switches and buttons as ideal contacts.
- Wire sag.
- Switching spikes and decoupling.
- `TIMING_CAP_HZ` display capping.

## Part-by-part inventory (at audit)

| Part class                       | Spice Lite treatment                                                    | Left digital / ideal                              |
| -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| PSU                              | droop past `currentLimit`, sag vertex, ideal in LED solve               | two PSUs on one rail: first booked                |
| Clock brick                      | ideal source at the desk's highest supply                               | `gnd` unread; no power; current booked to nothing |
| Signal flags, serial Input tags  | ideal source at the desk's highest supply                               | —                                                 |
| Integration Output/trigger tags  | —                                                                       | read published levels                             |
| Switches, buttons, DIP banks     | netlist merge                                                           | no contact resistance, no sag path                |
| Resistor, rnet9, pot             | RC-node conductance, LED-solve branch, supply booking                   | logic level is the PULL tier; divider X           |
| Capacitors                       | RC node (closed form), charge carried, decoupling                       | no coupling; open in LED solve                    |
| Inductor                         | —                                                                       | a wire                                            |
| Diode, Zener                     | supply booking at 0.7 V                                                 | not a solve branch; digital burn; no breakdown    |
| Transistors                      | LED solve joins nets when on                                            | level switch; no VBE/Vth, gain, VCE(sat)          |
| LED                              | Kingbright I–V solve, burn by Tj                                        | never loads the chip; doesn't drain C             |
| Seg/bar displays                 | per-segment solve                                                       | not junctions in `supply.js`                      |
| Oscillator cans, LCD             | family-less generic                                                     | LCD backlight/contrast cosmetic                   |
| 74LS plain                       | generic G (thresholds on nodes, stage in LED solve, budget, ICC, spike) | loaded HIGH reads H                               |
| 74LS open-collector              | totem-pole stage                                                        | not open-collector in either engine               |
| 74LS bus drivers                 | `drive` budget only                                                     | stage is a gate's                                 |
| 74LS14 / CD40106B / CD4093B      | Schmitt pair                                                            | on RC nodes only                                  |
| CD4000 plain                     | generic G, scaled by supply                                             | currents at 5 V figures                           |
| CD4049UB/CD4050B                 | own budget + stage                                                      | `inputsAboveSupply` unused by Spice               |
| CD4511B                          | own HIGH volts/ohms                                                     | HIGH capped at 4.2 mA (0.3)                       |
| CD4066B/405xB                    | rON branch in LED solve                                                 | controls digital; levels not voltages             |
| CD4007UB                         | the 4066's rON                                                          | gates digital                                     |
| RC timers, NE555                 | owned capacitors; the 555's ln 2/ln 3                                   | formula timing                                    |
| Memory, 65xx, CPUs, custom chips | generic family (or 74LS fallback)                                       | —                                                 |

## Jason's answers (2026-10-07)

1. **Fix the issues discovered**, in the roadmap's order.
2. **Every net becomes a voltage**, through one network solve (spice-lite-2's
   "one solve" rule holds: `lamps.js`'s grows, no second one).
3. **The order is fine.**
4. **TTL pulls in generated content become 1 kΩ.**
5. **Parity is an absolute requirement** (`tests/engine-parity.test.js`).
6. **All 74LS chips operate the same.** One common, reasonable value set per family — no
   per-part or manufacturer figures.
7. **A CMOS input in the undefined region** draws one common, reasonable current.
8. **A clock brick must be wired to a power supply** and outputs at that voltage.
   - Clock signals take no current under Spice Lite.
   - Existing clocks stop until powered.
   - A clock wired without power raises a warning in BOTH engines.
9. **Over-limit outcomes:** a warning past the rating, brown smoke past the absolute
   maximum.
10. **Revisit LED Q3** if the unified solve supports it without extensive work.
11. **One common default set for all BJTs and all MOSFETs**, regardless of type.
    Spice-specific settings may follow.
12. **A MOSFET gate becomes a gate capacitance** under Spice Lite.
13. **Open-collector parts become real open-collector.** No migration — Spice Lite is not
    released.
14. **A chip runs at the voltage actually reaching it.**
15. **The structural stand-in warnings retire under Spice Lite.**

Answered 2026-10-07 — Jason: "All default answers are acceptable" (for (a)–(f) here and
spice-lite-2's Q1–Q5):

- **(a) CD4000 special output stages.** Do the CD4049UB/CD4050B and CD4511B keep their
  stages? They are different output structures, not manufacturer variation. Default:
  keep.
- **(b) Signal flags' and serial Input tags' HIGH.** Default: the lowest supply among
  the chips their net feeds; no current.
- **(c) LCD backlight and contrast.** Default taken: the backlight is an LED branch
  (its colour's LED behind the board's 100 Ω — an assumption) and V0 can blank the
  glass (VDD − V0 against the HD44780U's 3.0 V minimum). Landed with E.
- **(d) The proposed common figures:**
  - CMOS band current: 0.5 mA per input;
  - 74LS output: warn at 20 mA, smoke at 100 mA;
  - CD4000 output: warn at 50 mW, smoke at 100 mW;
  - BJT: VBE 0.65 V, β 100, VCE(sat) 0.2 V;
  - MOSFET: Vth 2 V, RDS(on) 1 Ω.

## Roadmap

| Phase | What                                                                                                                                                                                                                              | Status                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0     | This document                                                                                                                                                                                                                     | done                                                  |
| A     | Tier 0 defects, each with a regression test                                                                                                                                                                                       | done                                                  |
| A2    | 1 kΩ TTL pulls; 74LS `drive` removed; open-collector in both engines (the '47 included); powered clock brick in both engines; flag/Input-tag HIGH (provisional)                                                                   | done                                                  |
| B     | One network solve for every net (`spice/network.js` + `spice/voltages.js`): every pin reads its own voltage, `nodeVolts` everywhere, RC nodes linearized from it, currents and supply booking from the solve, output/input limits | done                                                  |
| C     | Diodes, Zeners, BJTs, MOSFETs (gate as capacitance), switches by their control's own voltage                                                                                                                                      | done                                                  |
| D     | Chip power from solved pin voltages; ICC as a load                                                                                                                                                                                | done                                                  |
| E     | spice-lite-2 timers: a plan rebased on B–D, then the timers as silicon                                                                                                                                                            | done (`features/done/spice-lite-2-plan.md`, its "Results") |
| F     | Retire the stand-in warnings under Spice Lite; guide, rules, locales                                                                                                                                                              | done                                                  |

## What landed, and where it went its own way (2026-10-07)

- **One solve, many small networks.** `lamps.js`'s Newton was factored out into
  `spice/network.js` and now serves everything: `spice/voltages.js` groups the nets into
  CLUSTERS (union-find over every branch that could conduct, rails never a join) and
  re-solves, each pass, only the clusters something moved in. `lamps.js` keeps only the
  desk-reading (`lampTopology`, `sourceVolts`); `supply.js` keeps only ICC and the droop
  formula — every other current is the solve's (`report`).
- **Readings.** Every input reads its own pin's voltage: H ≥ VIH, L ≤ VIL, X in between
  (both families — a 74LS input in its 0.8–2 V band is undefined, which is why 10 kΩ
  pull-downs fail); a Schmitt input holds inside its hysteresis. A net nothing holds
  (no resistive path to a fixed net or an active output) keeps the digital level and the
  family reader — a floating 74LS input reads HIGH. The SHOWN level is the readers'.
  A conflict X is overridden by what the readers read (a 74LS LOW beats a HIGH).
- **The 74LS input** is a stage of its own: 1.3 V behind 4.5 kΩ, sourcing only (1 kΩ
  pull-down → 0.24 V; 10 kΩ → 0.9 V, undefined). A CD4000 input carries its protection
  diodes (VDD + 0.5 V / −0.5 V behind 200 Ω — the 200 Ω is an assumption, see (e)).
- **Parity needed one content change beyond A2**: the CD4000 benches' LEDs now go
  through 1 kΩ (`ledSeriesOhms`) — through 330 Ω a 5 V CMOS output sags to 3.2 V, under
  its own VIH, and the CD4013B bench's toggle (Q̄ into D, an LED on Q̄) read X.
- **RC nodes** run from their cluster linearized where they stand, end each curve at the
  next corner (a stage's knee or saturation), and RAMP where nothing gives way. The RC
  tests moved to the charging physics: their fixtures now use a CD4069UB (an input that
  draws nothing, so τ is exactly R·C), and new tests pin what a 74LS input does to an RC.
  A 74LS14 relaxation oscillator through 10 kΩ now STALLS (its input holds the capacitor
  above VT−), as a real one does; the Schmitt tests use a CD40106B.
- **Chip power.** A chip not straight across the rails gets its status from the new
  `chipVolts` hook (V(VCC) − V(GND) of the last solve); its ICC is a load in the solve.
  Rail-fed chips are untouched. Not modelled: an off-rail chip's OUTPUT current drawn
  through its own feed (only its ICC is).
- **Transistors** are devices (`"q"`, `"m"`) of the solve; the CD4007UB's six too. A
  MOSFET gate keeps its voltage while floating (`held`). The published `channels` take
  the solve's conduction (`#shownChannels`); the result's own stay digital for parity.
- **`strongLevels` keeps the LED-limiting rule** under Spice Lite: it is a parity field,
  so the plan's "skip `limitsLed` under hooks" was not done (nothing under Spice Lite
  reads it).
- **Performance**: `make bench` Spice Lite 1.45–1.55 ms/tick (gate: ≤ 2.18).

Also answered with the defaults (kept as they are):

- **(e) The CD4000 input protection resistance**, 200 Ω — the B-series sheets draw the
  network without a value.
- **(f) A 74LS input's floating voltage.** It reads HIGH by the "nothing holds it" rule,
  not by its voltage (the 1.3 V the bias model would put on it is inside the band).

The gate after every phase:

- `make test` passes;
- the parity oracle is green (the three NE555 desktops exempt: they run as silicon);
- `make demos` is clean from A2 on;
- `make bench` Spice Lite stays ≤ 2× the audit-time 1.09 ms/tick, from B on.
