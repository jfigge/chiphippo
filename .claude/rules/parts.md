---
paths:
  - "src/web/scripts/catalog/discretes.js"
  - "src/web/scripts/catalog/value-fields.js"
  - "src/web/scripts/catalog/chips-555.js"
  - "src/web/scripts/catalog/chips-cd4000-timers.js"
  - "src/web/scripts/model/component-value.js"
  - "src/web/scripts/model/si-value.js"
  - "src/web/scripts/model/*-format.js"
  - "src/web/scripts/model/resistor-bands.js"
  - "src/web/scripts/model/timing-summary.js"
  - "src/web/scripts/sim/rc-trace.js"
  - "src/web/scripts/sim/timing.js"
  - "src/web/scripts/sim/timer-555.js"
  - "src/web/scripts/sim/monostable.js"
  - "src/web/scripts/sim/ripple-oscillator.js"
  - "src/web/scripts/sim/programmable-timer.js"
  - "src/web/scripts/sim/analog-switch.js"
  - "src/web/scripts/components/value-combobox.js"
  - "src/web/scripts/components/discrete-view.js"
  - "src/web/scripts/tests/discrete*.test.js"
  - "src/web/scripts/tests/component-values.test.js"
  - "src/web/scripts/tests/value-combobox.test.js"
  - "src/web/scripts/tests/timer-555.test.js"
  - "src/web/scripts/tests/rc-trace.test.js"
  - "src/web/scripts/tests/timed-parts-ui.test.js"
  - "src/web/scripts/tests/potentiometer.test.js"
  - "src/web/scripts/tests/ohm-format.test.js"
---

## Values, capacitors & timed parts

**A resistor and a capacitor carry a VALUE, picked or typed the way a drawer is labelled;
only the timing chips read it.** No analog solver, no SPICE: each timed part finds its own R and C
in the wiring and turns them into seconds by its datasheet's formula. That is the DIGITAL
engine's rule, and it stays true there; Spice Lite (spice-lite.md) gives every net a
voltage and every value a current — resistors, pots, diodes and transistors become
branches of its voltage solve, and an RC node runs a closed-form curve off that solve —
and there each TIMED part is its SILICON (`def.silicon`, spice-lite.md → "Silicon"):
comparators on its pins, the RC network's own curve doing the timing, its readout
measured. Everything below is the digital `logic`, which the Properties card's Timing
row, the AI verifier, the exports and every non-Spice consumer still read.

- **ONE parser for every value field** (`model/component-value.js`,
  `features/done/component-value-comboboxes.md`): `parseComponentValue(text, unit, range)` →
  `{value, display}` or `{error: "empty"|"notValue"|"wrongUnit"|"range", …}`, and
  `formatComponentValue(value, unit)` is its canonical display — the Properties field
  and the BOM line say a value through it (`100kΩ`, `4.7µF`, `5.1V`: no spaces, always
  `µ`, three figures or as many as were typed, never rounded away) — and
  `formatComponentValueAscii` is the SAME figures for an exported file (`100k`, `4.7uF`:
  `u` for µ, a resistance with no symbol). Jason asked for the export to stay ASCII as it
  always was (2026-10-04) — SPICE and BOM scripts read a KiCad Value.
  A PLAIN NUMBER IS BASE UNITS (`100` on a capacitor is 100 F, refused by range — the
  old "a capacitance needs a prefix" rule is gone, by the spec); prefixes `p n u/µ/μ m k
  M G` + words (`kilo`, `meg`, …) are case-blind EXCEPT `m` milli vs `M` mega, ALWAYS
  (`1m` on a resistor is a milliohm, refused as out of range, never guessed as mega);
  RKM (`4k7`, `2R2`, `4n7`, `5V1`); spaces anywhere but between two numbers; another
  quantity's unit is `wrongUnit` ("That's a capacitance, not a resistance"). Ranges
  (`VALUE_RANGES`): resistor 0.1 Ω–100 MΩ, ceramic 1 pF–100 µF, electrolytic
  100 nF–100 mF, inductor 1 nH–10 H, Zener 1.8–200 V. Ohms never take `m` in DISPLAY
  either (`0.47Ω`). The default LISTS live beside it (`RESISTOR_VALUES` generated from
  the E12 bases, `CERAMIC_VALUES`, `ELECTROLYTIC_VALUES`, `INDUCTOR_VALUES`,
  `ZENER_DIODES` voltage + part, `TRANSISTOR_PARTS` per type). The `ohm-/farad-/henry-/
  volt-format.js` modules are now FORMATTING only (the 3-figure desk/schematic labels);
  their parsers are gone. The stored param is the NUMBER (`params.ohms`,
  `params.farads`, …), with ONE exception: a document value that will not read is KEPT
  as its raw text (`storedValue` in `catalog/value-fields.js`) and shown red when the
  card opens — every numeric consumer already guards with `Number.isFinite`/`> 0`, so
  such a part is one of NO KNOWN VALUE (no bands, no label, rc-trace skips it, the BOM
  lists it bare; a pot keeps its wiper — which side is a wire is the POSITION's to say).
- **The `"combo"` Properties type** (`catalog/value-fields.js` builds the fields:
  `valueField`, `ZENER_VOLTS_FIELD`, `transistorPartField(type)`;
  `components/value-combobox.js` is the ONE control): an editable `role="combobox"`
  input + ▾ + a `position: fixed` listbox the typing FILTERS (`u` matches `µ`). A field
  is `{options(values), show(values) → {text, error?, warning?}, read(text, values) →
  {text, patch, warning?} | {error}}` and commits a PATCH (several keys at once — a
  Zener pick sets `zenerVolts` AND `partNumber`); the dialog's `applyPatch` writes each
  key and rebuilds every OTHER row it touched. Validates on blur/Enter only (never
  per keystroke, so `4.` is not flagged); an error keeps the typed text, red with
  `aria-invalid` and the stored value UNCHANGED; a WARNING (another type's transistor
  part, "2N3906 is a PNP transistor") is shown but stored and not `aria-invalid`.
  Messages: `properties.combo.*`. Escape shuts an open list without closing the dialog.
- **A capacitor's and a transistor's Type is a PART SWAP** (`partTypeField` → key `ref`,
  `swapsPart: true`; the defs' `swapsWith` + `adoptParams`; `DeskDoc.setComponentRef`,
  which keeps the id, anchor and holes or throws): one undo step, then the card REOPENS
  as the new part (its own list and range). Values cross untouched — a capacitance out
  of the new range shows red rather than being changed; a transistor part number from
  ANOTHER type's list is dropped by `adoptParams` (a typed one is kept). Greyed while
  running, like `movesPins`.
- **Resistor colour code** (`model/resistor-bands.js`): 4 bands when two significant
  figures say the value (gold tolerance), 5 when it needs three (brown), `[]` when no
  multiplier band can encode it. Band colours are `--color-band-*` tokens, tuned against
  the beige body (gold is deliberately darker than the true hue).
- **Capacitors** (`cap-ceramic`, offsets [0,1]; `cap-electrolytic`, offsets [0,1], pin 1
  `+`, stripe on pin 2's side) are rotatable two-lead parts exactly like a resistor, with
  `capacitor: {polarized}` and `internalBridges: []`. **Electrically a capacitor is a
  non-connect, always — across the rails included**: no bridge, no weak bridge, so the
  netlist never joins its nets and the engine never drives through it. It still claims
  its holes (occupancy) and counts as CONNECTED wherever a check asks whether a net has
  anything on it (`rcTrace.connected`, the floating-input sweeps in `engine.js` and
  `desk-review.js`). A reversed electrolytic changes nothing. The value is printed
  upright on the body (`capacitorLabel`, off-centre on the electrolytic, clear of the
  stripe). First placement from the tray raises a one-time toast (`desk.capacitorNote.*`,
  "Don't show again" → `settings.capacitorNoteDismissed`), through DeskController's
  `onPartPlaced` option.
- **The potentiometer** (`pot`, group Resistors, offsets [0,1,2]: pin 1 `1` · pin 2 `W`,
  role `wiper` · pin 3 `3`; a Bourns 3296W) has `ohms` (the whole track) and `position`
  (a whole percent, default 50 — the `"range"` field). `potentiometerSplit` is the ONE
  statement of its arithmetic: wiper↔pin 1 = position × ohms, wiper↔pin 3 = the rest. A
  side with track left is a `weakBridges` pair carrying its OWN ohms as a third element
  (`[2, 1, toPin1]` — `rc-trace.js` reads it in place of `params.ohms`; every other
  consumer destructures two and ignores it); a side with NONE left is an
  `internalBridges` pair — a WIRE — so at 0 % / 100 % the nets join and an LED fed through
  that side burns, with no special case anywhere (the LED rule reads `strongLevels`). The
  desk draws a blue block CENTRED over its three pins, as the real part is (the pins run
  under the middle of the body, hidden like a slide switch's; body-only hit rect),
  printed with its value, whose brass screw's slot turns through 270° with the position.
  Exports: KiCad `RV` on `Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical` (pads
  1·2·3 = ours, verified in KiCad's library), symbol `"potentiometer"` (the resistor body,
  the wiper's arrow from a TOP pin); Digital treats it as its sides, through the same
  `weakBridges`-driven pull/merge every resistive part now takes (no id checks), a dead
  side merged as a wire. Not offered to the AI builder (`hasKnob`).
- **The trace** (`sim/rc-trace.js`, `rcTrace(doc, netlist)`) is the ONE reader every timed
  part shares: capacitors and resistors indexed by net, PARALLEL parts between the same
  two nets combined (series is not followed — stated, not guessed), `toRail("+"/"-")`
  predicates, and `connected(net)`. `timingProbe(trace, pinNet)` adds `net(pin)` for one
  chip. Each part's `logic.timing(probe)` returns `{sections: [{mode, …}], problems:
  [{code, section?, from?, to?, pin?}]}` — a fact about the frozen topology, so the
  engine takes it ONCE per context.
- **The timed contract** (`sim/timing.js` + `chip-eval.js`'s `isTimed`/`stepChip`/
  `wakeAtOf`): `logic = {state0, step, outputs, timing, wakeAt}`, and `step(state, ins,
  prev, env)` gets `env = {now, timing}`. **The engine still keeps no time**: `tick`
  takes `now` (simulated seconds) and reports `wakeAt`, the earliest moment any powered
  timed part next changes on its own. A step's state is a pure function of `now` and the
  moment its cycle began (`t0`, `since`/`until`), so a repeated call at one `now` returns
  the same state — the tick's step fixpoint depends on it. **A value changed mid-run (a
  pot turned, a Properties edit) carries on at the new rate, never rewriting history**:
  the analysis is re-read every context, so a free-running part keeps the R·C (or
  period) it last ran at in its state, and on a change moves `t0` so `now` sits the same
  FRACTION of the way through the same segment (`rebase`, the 555 and 4047 astables) or
  at the same count (`rebaseCount`, the 4060 and 4541) — re-reading the whole elapsed
  run at the new rate jumped the output to wherever the new schedule said it "would
  have been".
- **SimController owns the sim clock**: seconds since Run × speed (`#simAnchor` +
  `#realAnchor`, `#freeze`/`#thaw` on pause, stall and speed change), handed to every
  `tick` as `now`, and `wakeAt` is an event in the same batch queue as the clock edges
  (see simulation.md "Batched ticks"), no sooner than `MIN_SHOWN_S` after the last tick.
  So a 555 ticks itself with no clock brick on the desk. Step moves the clock by the fastest
  running clock's half-period, or — with none — straight to `wakeAt`. Stop clears it all.
  `timing` (the per-chip analyses) rides `chiphippo:sim-state`; problems are a
  `{type:"timing"}` warning → a toast keyed `timing:<chip>`, the desk review's
  `TIMING_UNRECOGNISED`, and the chip's warning triangle (`part-chip--timing`, power
  faults outrank it).
- **The cap** — `TIMING_CAP_HZ` is DERIVED from the top of `CLOCK_HZ` (1 kHz since
  2026-10-07; it was 100): nothing on the desk runs faster than the fastest clock on offer. A faster oscillation is DRAWN at the cap with its duty kept
  (`capSchedule`) while its TRUE rate is reported (readout in amber, `part-chip--capped`,
  plus a Timing-row sentence); a pulse under `MIN_SHOWN_S` (0.5 ms) is stretched to it
  (`shownPulse`). The cap is in SIMULATED time, so the speed control scales it like
  everything else. The CD4060B shows true counts for every stage slow enough to see and
  the cap wave only for the stages too fast to.
- **The parts** (formulas from TI, cited at each def): the NE555 (`chips-555.js`,
  family-less, group `Timer` — the CD4000 RC timers' group, so it sits under CHIPS ▸
  Timer beside Interface/PROCESSOR in a 74LS or Combined tray and in ONE Timer group
  with the CD4000 timers in a CD4000 tray; `supply` 4.5–16 V, which
  `families.js`'s `supplyRange` honours) DETECTS astable (TRIG+THRES one net with C to
  GND, DISCH between RA→VCC and RB→that net; starts HIGH) vs monostable (THRES+DISCH one
  net with C to GND and RA to VCC, TRIG connected elsewhere; falling-edge, level-held,
  non-retriggerable) vs bistable (THRES on the GND rail, TRIG connected; the §6.4
  function table as a set/reset latch — TRIG LOW sets, RESET LOW clears and wins,
  otherwise it holds; powers up LOW; no readout, never wakes) and refuses anything else
  with a sentence (`ne555Unrecognised`), OUT LOW; RESET LOW wins; CONT ignored; DISCH is
  a timing terminal, not an output. **Bistable is asked FIRST**: the usual build grounds
  DISCH beside THRES (a monostable's tell) and a pressed SET button puts TRIG on that
  net too (an astable's), so asking either first misreads it.
  `chips-cd4000-timers.js`: CD4047B (4.40·RC astable; a 2.48·RC one-shot that is the
  internal oscillator run for WHOLE periods — §III/Fig. 34: another trigger does not
  restart it, and RETRIGGER risen during a period or HIGH at its end runs it on one more
  2.2·RC period, so one extra pulse gives the sheet's tRE = t1' + t1 + 2·t2; the rise
  that STARTS a pulse, with RETRIGGER tied to +TRIGGER, is not also a retrigger), CD4098B (½·R·C),
  CD4528B and CD4538B (R·C — sourced from TI's CD14538B sheet, SCHS093C, since
  `cd4538b.pdf` 404s) as `dualMonostableLogic` (+TR OR NOT −TR rising, retriggerable,
  RESET low; a section with nothing on it is "unused" and silent; `width(r, c, volts)`
  and `cxInside` per part), CD4060B (`ripple-oscillator.js`: Fig. 12 RC network →
  2.2·Rx·Cx, or external clock on φI when φO/φ̄O carry no network; no crystal), CD4541B
  (`programmable-timer.js`, SCHS085E: Fig. 2's network → 2.3·Rtc·Ctc with CTC driving the
  clock out and RTC its complement, or an external clock on RS counted on its FALLING
  edges — the clock is RS inverted; a 16-stage count whose stage N, picked by A/B, is
  the OUTPUT through Fig. 1's latch: MODE HIGH recycles, LOW makes one transition after
  2^(N−1) counts and holds it; Q/Q̄ SELECT is an XOR; MASTER RESET HIGH clears and stops
  it; AUTO RESET LOW starts it at Run, HIGH waits for an MR pulse). **The CD4528B has NO
  TI sheet** — it is from HGSEMI's (V1.4, a current second source with Fairchild's
  tables, fetched from LCSC's asset host): the 4098's functions on the 4098's pins
  under its own names, T1 NOT grounded inside (`cxInside: false` → `notGrounded` until
  T1 is wired to GND), and T = 0.2·Rx·Cx·ln(VDD − VSS), the one timing that reads the
  SUPPLY (`rcTrace().supplyVolts`). Makers disagree on that constant (another CD4528
  sheet falls from 0.42 to 0.30 as VDD rises); the HGSEMI/Fairchild formula is the
  one used. Groups `Timer` (new, CD4000) and `Counter` (the 4060).
- **New pin role `"timing"`** (`timing(n, name)` in `pin-builders.js`): an RC terminal —
  not an input (no floating warning, never tied by the compiler), not an output (drives
  nothing), KiCad PASSIVE, pinout tag `RC`.
- **Readouts**: `ChipView` draws `.part-chip-timing` under the part number (outside the
  flip group, so upright on a reversed chip) from `chiphippo:sim-state`'s `timing`
  (`model/timing-summary.js` owns every sentence: `timingReadout`, `timingDescription`,
  `timingProblemSentences`); the Properties card of a timed part gains a readonly
  **Timing** row computed from the CURRENT document, so it answers while stopped.
- **Exports & lists**: KiCad carries capacitor values (symbols in `chiphippo.kicad_sym`
  drawn to KiCad's `Device:C` / `Device:C_Polarized` shapes, footprints
  `Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P2.50mm` / `CP_Radial_D5.0mm_P2.50mm`, designator
  `C`, the Value `formatComponentValueAscii`'s — `4.7uF`, `4.7k`, plain ASCII, the
  card's figures); the BOM splits resistors and capacitors by value through the same
  formatter (`Resistor — 4.7kΩ`, dash not brackets, since several titles end in a bracket
  of their own); the schematic draws both plates and the value.

## The discretes — inductors, diodes, transistors

`catalog/discretes.js` (the capacitors moved in beside them) + `model/henry-format.js` +
`model/volt-format.js` + `sim/analog-switch.js` `transistorSwitch`. **Each does as much as
a digital engine can honestly represent, and exports to KiCad as the real part** — no
forward drop, breakdown, gain, threshold or kickback. Four flat COMPONENTS groups —
Capacitors, Inductors, Diodes, Transistors, after Resistors — each header carrying a red
(i) whose tooltip is `palette.limitedNote` (`LIMITED_GROUPS`, derived from
`countsAsConnection`; the (i) is `info-button.js`'s `buildInfoMark`, a span — a header is
already a button). Jason chose red-only on purpose; don't add a non-colour cue. There was
a red `*` beside it too, which he dropped as redundant (2026-10-04) — don't bring it back.

- **Data hooks, never ids**: `inductor: true`, `diode: {zener}`, `transistor: {type,
  holds, cases}`, and on all of them (capacitors too) **`countsAsConnection`** — a pin whose net
  holds one of their leads is WIRED, conducting or not (`rcTrace().connectedByPart`, which
  the engine's CMOS floating-input sweep and the desk review's TTL sweep ask in place of
  the old `hasCapacitor`). Every one has an optional **Part number** (`PART_NUMBER_FIELD`,
  `partNumberOf` — trimmed, ≤32, stored only when set; a TRANSISTOR's is the `"combo"`
  `transistorPartField`, its type's list, uppercased, letters/digits/`-`, ≤20): printed on
  the part, a BOM key, KiCad's Value for a semiconductor and an `MPN` field for all. Out of the AI builder
  (`BUILDABLE_DEFS` drops `countsAsConnection`).
- **Inductor = a wire**: `internalBridges` `[[1,2]]`, so the netlist joins its nets;
  `{bridges:false}` (schematic, exports) keeps them apart, which is what KiCad needs. The
  Inductance is OPTIONAL — `valueField({optional: true})` reads an empty box as a patch
  of `null`, which normalizeParams drops.
- **An inductor's look and size are params** (both `"segmented"`, always stored):
  `style` `"coil"` (default — a TOROID standing on edge, seen from ABOVE like everything
  on the desk: the top of its ring, centred on its leads, each turn drawn where it
  crosses the top so they bunch at the ends and open over the middle, dimmed by how
  squarely they face up — Jason rejected a face-on drawing as "sideways") or `"can"`
  (a radial drum from above, between its leads, its value printed on top — 3.2 across
  over three holes and two thirds of that over two, Jason's sizes);
  `bodyHoles` 2 (default, offsets `[0,3]`) or 3 (`[0,4]`, a bigger part). The size MOVES
  pin 2, so the footprint is params-aware: **`footprintOffsets(def, params)`**
  (`catalog/index.js`, reading a def's `offsetsFor`) is the one read — occupancy, the seat
  search, `ghostOrient`, the ghost — and `discreteBox(ref, rot, params)` /
  `inductorBox` size the ghost. The field carries `movesPins` (greyed while running) and
  `refused`: `DeskDoc.canSetComponentParams` asks `canPlacePart` only when the pins would
  move, and the Properties dialog's generic refusal (`onChange` → `false`) rebuilds that
  one row at the true value with `properties.refused.<key>` under it. Jason asked for the
  toroid and the drum from photos (2026-10-04); the earlier axial looks are gone.
- **A MOSFET's package is a param** (`case`: `"TO-220"` default, `"TO-92"`;
  `transistorCase(def, params)`; BJTs are `cases: ["TO-92"]` and store none). Same
  three holes either way — drawing (`buildTo220`, KiCad's TO-220-3_Vertical outline: it
  overhangs a pitch each side and the row behind, but only the moulding over its own
  holes is the hit target), BOM line (`— TO-220, IRLZ44N`) and export only.
- **Diode = ONE-WAY** (`oneWayBridges(params)` → `[[anode, cathode]]`; anode pin 1, no
  F-flip, so `polarity` is LED-only). In `resolveAll`: `diodeDrive` resolves the strong
  pass to a fixpoint WITHIN the pass, starting from no diode driving (monotone — a ring of
  diodes can't hold itself up; lagging a pass broke that), adding an output-strength H on
  the cathode for every strongly-H anode; a merely PULLED-high anode passes a PULL, as a
  link in the resistor relaxation. Never a LOW. An X anode is the "maybe" reading: the
  narrow pass reports `uncertain` and `solve` runs the wide pass (X passes H) and keeps
  what agrees, as for a maybe-on channel. A cathode on a supply net gets nothing
  (`feedsCathode`) — else the H rode a transistor joined to the rail as a phantom
  conflict. Diodes obey the LED's junction rule: forward across two strong nets they BURN
  (`sim-overlay #updateDiodes`, review `DIODE_UNLIMITED`). Zener = diode; `zenerVolts`
  (the `"combo"` `ZENER_VOLTS_FIELD`: a pick or a voltage on `ZENER_DIODES` brings its
  part number, a typed part number picks its entry, any other voltage drops a TABLE part
  number but keeps one the user typed) is export-only in the digital engine. The spec's
  key was `voltage`; `zenerVolts` was kept, since documents already store it. Under
  Spice Lite a diode is a JUNCTION of the voltage solve (`spice/diodes.js`: knee 0.6 V,
  a Zener backwards at `zenerVolts`), burning by its junction temperature.
- **Transistor = an analog-switch channel** (`logic.channels`, the CD4066B's mechanism —
  `channelGroups`). TO-92 `[0,1,2]`, pins E·B·C / S·G·D (control `input`, switched `io`),
  `reversible` (R turns it end-for-end). `floating: "unknown"` (families.js
  `floatsUnknown` honours a def's own) so a floating control reads X, never TTL's HIGH. A
  part with NO supply pins is `passive`: always OK, never in `chipStatus` (the desk
  review counts chips from it), skipped by the floating-input sweep. **BJT**: on iff the
  base reads its on-level, else off. **MOSFET** (`holds`): sequential `{gate}` state —
  the last DEFINED gate level, null (off) before any — and an undefined gate leaves the
  channel as that state says; `channelStates(def, levels, state)` reports `held`.
  `channels` (compId → `[{on, held}]`) rides the tick result and `chiphippo:sim-state`:
  the transistor's lamp lights (`part-discrete--on`), rings amber while held
  (`--held`), its `<title>` says so (`transistorHint`), and the Properties card warns
  `heldOn`/`heldOff`. Two rails joined through one: `short`, `via: "transistor"`
  (`ctx.transistorNets`). Supplies don't cross a channel or a diode at supply strength, so a
  chip fed through one is unpowered — in the DIGITAL engine. Under Spice Lite a transistor
  is a DEVICE of the voltage solve (BJT gain and saturation, MOSFET threshold and gate
  charge — spice-lite.md), its lamp lit from `transistors`, and a chip fed through one
  runs at what reaches it (`chipVolts`).
- **Exports**: KiCad symbols drawn to `Device:D`/`D_Zener`/`L`/`Q_*` shapes but numbered
  as OUR pins (KiCad 9's `Q_*` number by letter, which no TO-92 pad matches); footprints
  `Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal` (pad 1 = K, so our pin 2),
  inductors by style × pitch — a coil `L_Toroid_Vertical_L16.0mm_W8.0mm_P7.62mm` /
  `…_L26.7mm_W14.0mm_P10.16mm_Pulse_D` (exact), a can `L_Radial_D12.5mm_P7.00mm_Fastron_09HCP`
  / `L_Radial_D12.0mm_P10.00mm_Neosid_SD12_style1` (the NEAREST metric pitch, reported
  `nearestFootprint` via the spec's `nearest`) — and `Package_TO_SOT_THT:TO-92_Inline_Wide`
  or `TO-220-3_Vertical` by `case` (a KICAD_PARTS `footprint` may be a function of the
  component; identity pads, every transistor reported `transistorPinout` — the desk's
  order is no maker's); designators D, L, Q. Verified with
  `kicad-cli` (ERC clean, netlist identical). Digital leaves all three out with reasons
  (an inductor's nets come across APART).
