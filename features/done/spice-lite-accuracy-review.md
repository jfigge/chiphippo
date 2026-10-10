# Spice Lite against ngspice — second accuracy review

_Review, 2026-10-09. Second pass after the fidelity plan's own review
(`features/done/spice-lite-3-plan.md`, "Results", 2026-10-08). Measured on
the working tree as of today — bench parts, clock waves and the wave
performance fixes included, all uncommitted — against **ngspice 44.2**._

This review answers three questions:

1. **Does the scorecard still hold?** Every golden case re-run on today's
   engine, and every ngspice reference re-generated to check it is still the
   right answer for today's models.
2. **What has been added since, and how accurate is it?** The clock waves and
   the bench parts (ULN2003A, optocouplers, LM358, LM78xx/LM317) were built
   after the last review and have no golden cases. Each is compared here,
   against ngspice where a fair comparison exists.
3. **What is still not checked against anything independent?** The gaps,
   and what to add to close them.

---

## 1. Summary

| Question                                          | Answer                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Golden scorecard (13 areas, 62 cases, 133 values) | **A in every area**, every case independent of tick spacing. Worst value 1.34 % (CMOS stage at 10 V, a known effect — §3)                                                                                                                                          |
| Are the committed references still right?         | **Yes.** Re-generated on ngspice 44.2 from today's models: 11 of 13 areas identical to the last bit, the inductors within 3·10⁻⁹ relative; the NE555 area moves by up to 0.30 %, the documented ngspice 42 → 44.2 shift. Spice Lite is A against **both** versions |
| Changes since the last review                     | Every area unchanged within rounding; inductors' worst now 0.054 %                                                                                                                                                                                                 |
| Clock waves (new)                                 | **A** — 47 values over triangle, sine and both sawtooths, low-pass and high-pass: worst **0.04 mV**                                                                                                                                                                |
| ULN2003A (new)                                    | **A** — against ngspice running its Darlington as Gummel–Poon cards: worst **1.7 mV** (0.26 %)                                                                                                                                                                     |
| 4N35/PC817, LM358, LM7805, LM317 (new)            | **Exact** against ngspice running the same behavioural law (opto, op-amp) or the regulator's own formula (≤ 0.004 %). These grade the _solver_, not the _part_ — §5.3                                                                                              |
| Not compared with ngspice                         | CD4000 timers (graded against their datasheet formulas: 0.5–3 %), 74LS stages (B by hand), analog switches, supply droop and sag, the relay's pull-in, mixed circuits — §6                                                                                         |

**Bottom line:** everything Spice Lite solves, it solves to within 1.4 % of
ngspice (most values well under 0.5 %), and the references it is graded against are current.
The weak spots are not numerical: they are the parts whose _model_ is a
simplification (the LM358 has no bandwidth or slew rate, the regulators no
line/load regulation curve beyond 0.01 Ω, the optocoupler a fixed CTR) and the
areas that have only ever been checked against a formula or by hand.

---

## 2. How Spice Lite is graded

The machinery is the one the fidelity plan built (Phase 0):

- **Cases** — `tests/spice-golden-cases.js`: each circuit is built once with
  the test fixtures (`bench()`), and the **same document** is both run by
  Spice Lite and written out as an ngspice deck (`scripts/spice-deck.mjs`).
- **Reference flavours** — what the ngspice deck models each part as:
  - **same**: Spice Lite's _own_ models as behavioural sources — grades the
    **engine** (time stepping, corners, crossings, the network solve);
  - **device**: the parts' real models — vendor cards (1N4148, 2N3904,
    2N2222A, 2N3906, 2N2907A) or the grade's own fit written as a card, a
    CD4000 output as a level-1 MOSFET pair — grades the **models**;
  - **ideal**: the same models less the comparators' bias currents — what a
    555's datasheet formula assumes.
- **Rubric** — **A** within 2 % (or 20 mV for a value under 1 V), **B** 10 %
  / 50 mV, **C** 50 %. An area's grade is its worst case's.
- **Tick-spacing invariance** — every transient case is run again ticked on
  extra grids beside its own wake times; an answer that moves by more than
  1e-4 is held to C.
- **References** are committed JSON (`tests/spice-golden/<area>.json`) with
  the ngspice version that wrote them; `make test` needs no ngspice;
  `make spice-golden` regenerates them.

| Area                                    | Cases | Reference |
| --------------------------------------- | ----: | --------- |
| Resistive DC                            |     1 | same      |
| Single-capacitor RC, Schmitt relaxation |     3 | same      |
| Multi-capacitor RC networks             |     2 | same      |
| Capacitor-coupled gate oscillators      |     4 | same      |
| NE555 timing                            |     4 | ideal     |
| LEDs                                    |    12 | device    |
| Silicon diodes                          |     1 | device    |
| CMOS output stage dynamics              |     2 | device    |
| BJT as a saturated switch               |     7 | device    |
| BJT in its active region                |     7 | device    |
| MOSFET fully on                         |     9 | device    |
| MOSFET near threshold                   |     6 | device    |
| Inductors                               |     4 | same      |

---

## 3. The scorecard, re-run

`SPICE_GOLDEN_REPORT=… node --test tests/spice-golden.test.js` on today's tree:

| Area                                    | Grade | Worst value today                     | Worst at the last review (2026-10-08)           |
| --------------------------------------- | :---: | ------------------------------------- | ----------------------------------------------- |
| Resistive DC                            | **A** | exact                                 | exact                                           |
| Single-capacitor RC, Schmitt relaxation | **A** | 0.020 % (CD40106B 10k/10µ, HIGH time) | 0.03 %                                          |
| Multi-capacitor RC networks             | **A** | 0.003 % (high-pass at 2 ms)           | 0.01 %                                          |
| Capacitor-coupled gate oscillators      | **A** | 0.71 % (CD4069UB pair, HIGH time)     | 0.7 %                                           |
| NE555 timing                            | **A** | 0.39 % (1 MΩ/1 MΩ, LOW time)          | 0.39 %                                          |
| LEDs                                    | **A** | 0.25 % (white, 330 Ω)                 | 0.24 %                                          |
| Silicon diodes                          | **A** | 0.17 %                                | 0.17 %                                          |
| CMOS output stage dynamics              | **A** | 1.34 % (10 V into 1 µF at 0.4 ms)     | 1.3 %                                           |
| BJT as a saturated switch               | **A** | 1.28 % (power NPN, collector)         | 1.3 %                                           |
| BJT in its active region                | **A** | 0.46 %                                | 0.46 %                                          |
| MOSFET fully on                         | **A** | 0.065 %                               | 0.06 %                                          |
| MOSFET near threshold                   | **A** | 0.050 %                               | 0.05 %                                          |
| Inductors                               | **A** | 0.054 % (relay kick, coil current)    | 0.29 % (results table) / 0.06 % (scorecard row) |

Every case passed the tick-spacing check. The full per-value tables are in
Appendix A.

**The two largest errors, explained** (both known, neither a solver fault):

- **CMOS stage at 10 V, 1.34 %.** Every corner of the square-law curve is
  within 0.07 % of the exact law; the rest is a reading taken a few
  microseconds late — a tick re-linearizes every corner within
  `FAST_WINDOW_S` (10 µs) of the last one past its own moment, and on a curve
  with closely spaced corners that chain moves the reading forward.
- **Power NPN switch, 1.28 %.** A collector voltage around 0.12 V — 1.5 mV
  off, well inside the 20 mV absolute bar for a value under 1 V; as a
  percentage it looks larger than it is.

**Inductors:** the last review's results table lists a worst case of
0.29 % (its scorecard row says 0.06 %); today's worst is 0.054 %. The likely
cause is the bench-parts solver work (a coil's cluster balanced to 1e-14 A,
`COIL_TOLERANCE_A`; the stuck-corner run-on reworked), but this was not
bisected.

---

## 4. Are the references still right?

A reference can go stale two ways: the ngspice version changes, or Spice
Lite's own models change (a "same" deck is generated from them). Since the
last review the transistor, inductor and network code changed (uncommitted),
so every area was **regenerated** in a scratch copy with ngspice 44.2 and
compared with what is committed:

| Area                                                                       | Committed with | Max change on regeneration         |
| -------------------------------------------------------------------------- | -------------- | ---------------------------------- |
| bjt-active, bjt-switch, diode, led, mosfet-on, mosfet-threshold, resistive | ngspice 42     | **0** (identical)                  |
| cmos-stage, coupled-osc, multi-rc, single-rc                               | ngspice 44.2   | **0**                              |
| inductors                                                                  | ngspice 42     | 3·10⁻⁹ relative                    |
| ne555                                                                      | ngspice 42     | **0.30 %** (10k/10k/10µ HIGH time) |

The NE555 shift is the one the rules already record: "42 → 44.2 moved
nothing but the NE555's `ideal` periods (+0.3 %)". Graded against the 44.2
numbers, Spice Lite is still A (worst −0.32 %):

| Case              | Quantity | Spice Lite | ngspice 42 |    Error | ngspice 44.2 |    Error |
| ----------------- | -------- | ---------: | ---------: | -------: | -----------: | -------: |
| ne555-10k-10k-10u | period   |   0.208357 |   0.208204 | +0.074 % |     0.208828 | −0.225 % |
| ne555-10k-10k-10u | high     |   0.138628 |   0.138552 | +0.055 % |     0.138968 | −0.245 % |
| ne555-10k-10k-10u | low      |  0.0697291 |  0.0696517 | +0.111 % |    0.0698598 | −0.187 % |
| ne555-10k-1k-10u  | period   |  0.0833360 |  0.0831985 | +0.165 % |    0.0834272 | −0.109 % |
| ne555-10k-1k-10u  | high     |  0.0762461 |  0.0761322 | +0.150 % |    0.0763401 | −0.123 % |
| ne555-10k-1k-10u  | low      | 0.00708998 | 0.00706627 | +0.335 % |   0.00708710 | +0.041 % |
| ne555-1k-100k-1u  | period   |   0.142237 |   0.142179 | +0.041 % |     0.142492 | −0.179 % |
| ne555-1k-100k-1u  | high     |  0.0700048 |  0.0700160 | −0.016 % |    0.0701553 | −0.214 % |
| ne555-1k-100k-1u  | low      |  0.0722325 |  0.0721627 | +0.097 % |    0.0723369 | −0.144 % |
| ne555-1M-1M-1u    | period   |    2.08085 |    2.07892 | +0.093 % |      2.08412 | −0.157 % |
| ne555-1M-1M-1u    | high     |    1.38528 |    1.38603 | −0.054 % |      1.38966 | −0.315 % |
| ne555-1M-1M-1u    | low      |   0.695574 |   0.692895 | +0.387 % |     0.694457 | +0.161 % |

(For scale, the datasheet formula 0.693·(RA + 2RB)·C gives 0.2079 s for the
first case: all three sit within 0.5 % of it.)

**Nothing was rewritten.** The committed JSON is untouched; regenerating
`ne555` on 44.2 is a decision for you (recommendation in §7).

---

## 5. What has been added since — new comparisons

### 5.1 Clock waves

A clock brick's triangle, sine and sawtooths (`spice/waves.js`) drive their
net as an **ideal source**, so the fair ngspice reference is an ideal source
of the same shape: `PWL(…) r=0` for the triangle and sawtooths, `SIN(2.5 2.5
f 0 0 −90)` for the sine (Spice Lite's sine is ½·V·(1 − cos 2πφ), starting at
its low point). Each drove an RC (10 kΩ, 1 µF unless stated) as a low-pass,
or a high-pass for the rising sawtooth's drop; ngspice at `reltol=1e-6`,
step = stop/20 000.

| Case                                   | Values | Worst difference | Grade |
| -------------------------------------- | -----: | ---------------: | :---: |
| Triangle 10 Hz, low-pass               |      9 |       < 0.005 mV |   A   |
| Sine 50 Hz, low-pass                   |      9 |          0.01 mV |   A   |
| Sine 16 Hz, low-pass                   |      7 |       < 0.005 mV |   A   |
| Sawtooth up 20 Hz, high-pass           |      8 |          0.01 mV |   A   |
| Sawtooth down 20 Hz, low-pass          |      7 |       < 0.005 mV |   A   |
| Triangle 250 Hz, low-pass (1 kΩ, 1 µF) |      7 |          0.04 mV |   A   |

Two things had to be matched before the comparison was fair (neither is a
Spice Lite error):

- **Initial conditions.** ngspice starts a transient from its DC operating
  point — a capacitor already charged to the source's value at t = 0. Spice
  Lite starts every capacitor empty, as a bench does at power-on. For the
  falling sawtooth (which starts at 5 V) that put the two 1.8 V apart in the
  first period; with `uic` (capacitors start empty) they agree to < 0.005 mV.
- **Reading at an edge.** The sawtooth's drop is a step at the edge; a value
  read exactly _at_ that instant is whichever side each tool interpolates.
  Read 0.1 ms after, they agree.

Full table: Appendix B.

### 5.2 ULN2003A

Each channel is a Darlington behind a 2.7 kΩ input resistor, 7.2 kΩ and
3 kΩ across the two base–emitter junctions and 1.1 Ω in the collector
(`ARRAY_MODELS.uln2003a`, `catalog/chips-drivers.js`). The ngspice deck
draws that same circuit with the two transistors as **Gummel–Poon cards**
of the model's own figures (IS, BF, IKF, VAF, BR, RB) — the "device"
flavour the transistor areas use, so this grades Spice Lite's junction
tables and its nested Darlington solve against SPICE's exponential devices.

| Supply | Load   | Input  | V(out) Spice Lite | V(out) ngspice |       Δ | V(in) Spice Lite / ngspice |
| ------ | ------ | ------ | ----------------: | -------------: | ------: | -------------------------- |
| 5 V    | 1000 Ω | direct |            0.6461 |         0.6478 | -1.7 mV | —                          |
| 5 V    | 100 Ω  | direct |            0.7518 |         0.7530 | -1.3 mV | —                          |
| 12 V   | 100 Ω  | direct |            0.8574 |         0.8581 | -0.7 mV | —                          |
| 12 V   | 24 Ω   | direct |            1.3122 |         1.3122 | -0.0 mV | —                          |
| 5 V    | 100 Ω  | 10 kΩ  |            0.7766 |         0.7778 | -1.2 mV | 2.1189 / 2.1211            |
| 5 V    | 100 Ω  | 100 kΩ |            5.0000 |         5.0000 | -0.0 mV | 0.5713 / 0.5713            |
| 12 V   | 100 Ω  | 47 kΩ  |            0.9146 |         0.9154 | -0.8 mV | 1.9656 / 1.9675            |

**A** throughout, worst 1.7 mV (0.26 %). Against TI's typical VCE(sat)
(0.9 V at 100 mA, 1.1 V at 200 mA, 1.3 V at 350 mA): 0.86 V at 112 mA and
1.31 V at 450 mA — inside the sheet's typical-to-maximum band.

### 5.3 Optocoupler, LM358, regulators

These are **behavioural** parts in Spice Lite (`spice/analog-devices.js`):
an optocoupler is its IR LED junction plus a collector current of
CTR × IF limited by a 0.1 V knee and 10 Ω; an LM358 unit is a gain of 10⁵
about the middle of its swing, clamped 5 mV above ground and 1.5 V under
its supply, behind 20 Ω, with 30/20 mA current limits; a regulator holds
its reference above REF behind 0.01 Ω, never above IN less its dropout.

No vendor model of these parts is available offline, so the fair ngspice
comparison is the **same law** written as ngspice behavioural sources (a
diode card for the IR LED, a `B` source for the rest) — which grades the
_solver_ on these devices. The regulators are compared with their own
formula.

#### Optocoupler 4N35 (CTR 100 %), 12 V, LED via Rin, collector via Rc

| Rin     | Rc      | V(collector) Spice Lite | ngspice same-model | Δ       |
| ------- | ------- | ----------------------- | ------------------ | ------- |
| 470 Ω   | 1000 Ω  | 0.2178 V                | 0.2178 V           | -0.0 mV |
| 4700 Ω  | 1000 Ω  | 9.6750 V                | 9.6753 V           | -0.3 mV |
| 47000 Ω | 1000 Ω  | 11.7653 V               | 11.7653 V          | -0.0 mV |
| 4700 Ω  | 10000 Ω | 0.1119 V                | 0.1119 V           | 0.0 mV  |
| 2200 Ω  | 4700 Ω  | 0.1253 V                | 0.1253 V           | -0.0 mV |

#### LM358 non-inverting ×2 (10k/10k), 9 V supply, IN+ from a divider

| Divider (top/bottom)  | V(out) Spice Lite | ngspice same-model | ideal 2·Vin (clamped 7.5 V) | Δ vs ngspice |
| --------------------- | ----------------- | ------------------ | --------------------------- | ------------ |
| 8000/1000 Ω (1.000 V) | 2.00004 V         | 2.00004 V          | 2.00000 V                   | 0.00 mV      |
| 2000/1000 Ω (3.000 V) | 5.99995 V         | 5.99995 V          | 6.00000 V                   | -0.00 mV     |
| 1000/1000 Ω (4.500 V) | 7.49251 V         | 7.49251 V          | 7.50000 V                   | 0.00 mV      |

#### LM317 (R1 = 240 Ω, IN 15 V) against Vout = 1.25·(1 + R2/R1) + 50 µA·R2

| R2     | Spice Lite | formula   | Δ        |
| ------ | ---------- | --------- | -------- |
| 240 Ω  | 2.5119 V   | 2.5120 V  | -0.004 % |
| 390 Ω  | 3.3006 V   | 3.3007 V  | -0.004 % |
| 1000 Ω | 6.5081 V   | 6.5083 V  | -0.004 % |
| 2000 Ω | 11.7662 V  | 11.7667 V | -0.004 % |

#### LM7805 against its model's own law: min(5 V, IN − 2 V) − I·0.01 Ω, limit 1.5 A

| IN   | Load   | Spice Lite | expected | Δ        |
| ---- | ------ | ---------- | -------- | -------- |
| 9 V  | 1000 Ω | 5.0000 V   | 5.0000 V | -0.000 % |
| 9 V  | 100 Ω  | 4.9995 V   | 4.9995 V | -0.000 % |
| 9 V  | 10 Ω   | 4.9950 V   | 4.9950 V | -0.000 % |
| 6 V  | 100 Ω  | 3.9996 V   | 3.9996 V | -0.000 % |
| 12 V | 5 Ω    | 4.9900 V   | 4.9900 V | 0.000 %  |

All exact to the printed digits (the LM317's −0.004 % is its 0.01 Ω output
resistance carrying the 5 mA through R1 and R2; the clamped LM358 case sits
7.5 mV under the clamp because its 20 Ω output resistance feeds the 20 kΩ
feedback divider).

**What this does not show:** how close the _law_ is to the real part. That
is held by `tests/bench-parts.test.js` against datasheet figures (gain 2
from two 10 kΩ, the 1.5 V headroom, CTR ×3 at 300 %, 7805 dropout and limit,
LM317's formula) and is a model question, not a solver one — see §6.

---

## 6. What is not compared with anything independent

| Area                                                            | How it is checked today                                                                                                                                                                                                                                                                                              | Gap                                                                                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CD4000 timers** (4047, 4060, 4098/4528/4538, 4541) as silicon | `spice-silicon.test.js` holds each to its **datasheet formula**: the 4047's halves to 0.5 % of 2.2·RC (its first HIGH to 1 % of 2.48·RC), the monostables to 1.5 % of K·Rx·Cx at 5/10/15 V; the 4060 and 4541 share one network that runs at 2.23·RxCx — 1.5 % over the 4060 sheet's 2.2, 2.9 % under the 4541's 2.3 | No ngspice case. The 4541 sits at B against its formula, though the formula itself is an approximation (both parts share one network, 2.23·RxCx) |
| **74LS input / output stages**                                  | By hand against SDLS025: **B** (VOH +4 % at −0.4 mA)                                                                                                                                                                                                                                                                 | Not in the golden suite; every 74LS-driven LED, divider or RC inherits this B                                                                    |
| **Analog switches** (CD4066B, CD405x)                           | A switch channel is a resistor of its on-resistance                                                                                                                                                                                                                                                                  | Exact as a resistor; the real rON's variation with signal voltage is not modelled                                                                |
| **Supply droop and wire sag**                                   | `spice-current.test.js`, `spice-sag.test.js` (analytic)                                                                                                                                                                                                                                                              | Pure resistive arithmetic; low risk                                                                                                              |
| **Relay pull-in / drop-out**                                    | Coil = inductor (graded A in the inductors area); contacts at a fraction of rated current                                                                                                                                                                                                                            | The thresholds are parameters, not a model to compare                                                                                            |
| **LM358 dynamics**                                              | —                                                                                                                                                                                                                                                                                                                    | **No gain-bandwidth, no slew rate**: a ×2 amplifier follows a 100 kHz signal as well as DC. A real LM358 (1 MHz GBW, 0.3 V/µs) would not         |
| **Regulator dynamics**                                          | —                                                                                                                                                                                                                                                                                                                    | No line/load regulation curve beyond 0.01 Ω, no transient response, no ripple rejection                                                          |
| **Optocoupler CTR**                                             | One CTR per part (a choice of 20–300 %)                                                                                                                                                                                                                                                                              | Real CTR falls with temperature and with IF; not modelled                                                                                        |
| **Mixed circuits**                                              | Each golden area is graded alone                                                                                                                                                                                                                                                                                     | No case combines areas (a 74LS output into an RC into a CMOS Schmitt, a ULN driving a relay with a flyback diode); errors could stack            |
| **Clock waves into nonlinear loads**                            | `spice-waves.test.js`: a 40106 switching at VT± (analytic)                                                                                                                                                                                                                                                           | Not in the golden suite                                                                                                                          |

---

## 7. Recommendations

1. **Add the new comparisons to the golden suite**, so they are graded on
   every `make test` rather than once, here:
   - a **`waves`** area — teach `spice-deck.mjs` to write a wave clock as
     `PWL`/`SIN` (and pass `uic`, since Spice Lite starts capacitors empty);
     the six cases in §5.1 are ready to lift;
   - a **`bench-parts`** area — the ULN2003A as Darlington cards (the deck
     already writes a TIP120 that way), and same-model `B`-source blocks for
     the optocoupler, op-amp and regulator (§5.3's decks).
2. **Regenerate `ne555.json` on ngspice 44.2** (`make spice-golden
GOLDEN=ne555`), so every area is pinned to one version. Spice Lite stays
   A (§4). Record it in the area's JSON as the rules ask.
3. **Add a 74LS stage area** with a behavioural deck of SDLS025's output
   schematic, so the B grade is mechanical and ratcheted like the others.
4. **Add one mixed-circuit area** (e.g. 74LS04 → 10 k → 1 µF → CD40106 →
   ULN2003A → relay with a flyback diode), graded on its period and the coil
   current — the place compounding errors would show.
5. **Model fidelity, if wanted** (a decision, not a defect): a single-pole
   gain-bandwidth and a slew limit for the LM358 would make it behave like
   the part above a few kHz; a CTR(IF) curve for the optocouplers. Each
   would get a "device" case against a vendor macromodel.
6. **CD4000 timers against ngspice**: behavioural blocks for the 4047's and
   the monostables' comparators (the deck already has the 555's), so their
   periods are graded against SPICE and not only against their sheets'
   formulas.

---

## Appendix A — every golden value, today

Spice Lite (working tree) against the committed references (ngspice 42 for
the areas so marked in §4, 44.2 for the rest). Errors are relative; the
grade is the case's, on the rubric (a value under 1 V is also allowed 20 mV
for an A, which is why a small voltage can show a larger percentage and
still grade A).

#### Resistive DC

| Case          | Quantity | Spice Lite | ngspice | Error    | Grade |
| ------------- | -------- | ---------- | ------- | -------- | ----- |
| divider-chain | a/V      | 2.0414     | 2.0414  | +0.000 % | A     |
| divider-chain | b/V      | 0.65089    | 0.65089 | -0.000 % | A     |

#### Single-capacitor RC, Schmitt relaxation

| Case                     | Quantity    | Spice Lite | ngspice  | Error    | Grade |
| ------------------------ | ----------- | ---------- | -------- | -------- | ----- |
| cmos-rc-ramp             | cap@0.002/V | 0.87375    | 0.87378  | -0.004 % | A     |
| cmos-rc-ramp             | cap@0.005/V | 1.9069     | 1.907    | -0.001 % | A     |
| cmos-rc-ramp             | cap@0.01/V  | 3.087      | 3.087    | -0.000 % | A     |
| cmos-rc-ramp             | cap@0.02/V  | 4.2686     | 4.2686   | -0.000 % | A     |
| cmos-rc-ramp             | cap@0.05/V  | 4.9591     | 4.9591   | -0.000 % | A     |
| schmitt-cd40106b-100k-1u | period/s    | 0.081558   | 0.081559 | -0.002 % | A     |
| schmitt-cd40106b-100k-1u | high/s      | 0.039103   | 0.039107 | -0.011 % | A     |
| schmitt-cd40106b-100k-1u | low/s       | 0.042455   | 0.042452 | +0.007 % | A     |
| schmitt-cd40106b-10k-10u | period/s    | 0.084533   | 0.084542 | -0.011 % | A     |
| schmitt-cd40106b-10k-10u | high/s      | 0.040531   | 0.040539 | -0.020 % | A     |
| schmitt-cd40106b-10k-10u | low/s       | 0.044003   | 0.044003 | -0.002 % | A     |

#### Multi-capacitor RC networks

| Case      | Quantity    | Spice Lite | ngspice | Error    | Grade |
| --------- | ----------- | ---------- | ------- | -------- | ----- |
| rc-ladder | out@0.01/V  | 1.0354     | 1.0354  | -0.001 % | A     |
| rc-ladder | out@0.02/V  | 2.2258     | 2.2258  | -0.000 % | A     |
| rc-ladder | out@0.05/V  | 4.0874     | 4.0874  | -0.000 % | A     |
| rc-ladder | out@0.08/V  | 4.7003     | 4.7003  | +0.000 % | A     |
| high-pass | out@0.002/V | 0.72016    | 0.72018 | -0.003 % | A     |
| high-pass | out@0.005/V | 1.2053     | 1.2053  | -0.001 % | A     |
| high-pass | out@0.01/V  | 1.3316     | 1.3316  | +0.000 % | A     |
| high-pass | out@0.02/V  | 1.019      | 1.019   | +0.000 % | A     |
| high-pass | out@0.04/V  | 0.49097    | 0.49097 | +0.000 % | A     |

#### Capacitor-coupled gate oscillators

| Case                 | Quantity | Spice Lite | ngspice  | Error    | Grade |
| -------------------- | -------- | ---------- | -------- | -------- | ----- |
| two-gate-cd4069ub    | period/s | 0.16407    | 0.1652   | -0.687 % | A     |
| two-gate-cd4069ub    | high/s   | 0.082035   | 0.082623 | -0.712 % | A     |
| two-gate-cd4069ub    | low/s    | 0.082035   | 0.082582 | -0.662 % | A     |
| two-gate-cd4069ub-rs | period/s | 0.21685    | 0.21709  | -0.107 % | A     |
| two-gate-cd4069ub-rs | high/s   | 0.10843    | 0.10857  | -0.132 % | A     |
| two-gate-cd4069ub-rs | low/s    | 0.10843    | 0.10852  | -0.082 % | A     |
| two-gate-cd40106b    | period/s | 0.20963    | 0.20958  | +0.026 % | A     |
| two-gate-cd40106b    | high/s   | 0.10983    | 0.10981  | +0.020 % | A     |
| two-gate-cd40106b    | low/s    | 0.099802   | 0.099769 | +0.033 % | A     |
| two-gate-cd40106b-rs | period/s | 0.27365    | 0.27365  | -0.000 % | A     |
| two-gate-cd40106b-rs | high/s   | 0.14076    | 0.14075  | +0.009 % | A     |
| two-gate-cd40106b-rs | low/s    | 0.13289    | 0.13291  | -0.011 % | A     |

#### NE555 timing

| Case              | Quantity | Spice Lite | ngspice   | Error    | Grade |
| ----------------- | -------- | ---------- | --------- | -------- | ----- |
| ne555-10k-10k-10u | period/s | 0.20836    | 0.2082    | +0.074 % | A     |
| ne555-10k-10k-10u | high/s   | 0.13863    | 0.13855   | +0.055 % | A     |
| ne555-10k-10k-10u | low/s    | 0.069729   | 0.069652  | +0.111 % | A     |
| ne555-10k-1k-10u  | period/s | 0.083336   | 0.083198  | +0.165 % | A     |
| ne555-10k-1k-10u  | high/s   | 0.076246   | 0.076132  | +0.150 % | A     |
| ne555-10k-1k-10u  | low/s    | 0.00709    | 0.0070663 | +0.335 % | A     |
| ne555-1k-100k-1u  | period/s | 0.14224    | 0.14218   | +0.041 % | A     |
| ne555-1k-100k-1u  | high/s   | 0.070005   | 0.070016  | -0.016 % | A     |
| ne555-1k-100k-1u  | low/s    | 0.072232   | 0.072163  | +0.097 % | A     |
| ne555-1M-1M-1u    | period/s | 2.0809     | 2.0789    | +0.093 % | A     |
| ne555-1M-1M-1u    | high/s   | 1.3853     | 1.386     | -0.054 % | A     |
| ne555-1M-1M-1u    | low/s    | 0.69557    | 0.6929    | +0.387 % | A     |

#### LEDs

| Case           | Quantity | Spice Lite | ngspice    | Error    | Grade |
| -------------- | -------- | ---------- | ---------- | -------- | ----- |
| led-red-10k    | d1/A     | 0.00034172 | 0.00034132 | +0.117 % | A     |
| led-red-1k     | d1/A     | 0.0032338  | 0.00323    | +0.121 % | A     |
| led-red-330    | d1/A     | 0.0094276  | 0.0094201  | +0.080 % | A     |
| led-red-100    | d1/A     | 0.028921   | 0.028896   | +0.086 % | A     |
| led-yellow-330 | d1/A     | 0.0092721  | 0.0092684  | +0.039 % | A     |
| led-yellow-10k | d1/A     | 0.00032631 | 0.00032611 | +0.061 % | A     |
| led-green-330  | d1/A     | 0.0090475  | 0.0090445  | +0.033 % | A     |
| led-green-10k  | d1/A     | 0.00032164 | 0.00032145 | +0.060 % | A     |
| led-blue-330   | d1/A     | 0.0063841  | 0.0063689  | +0.238 % | A     |
| led-blue-10k   | d1/A     | 0.00025479 | 0.00025478 | +0.006 % | A     |
| led-white-330  | d1/A     | 0.0063826  | 0.006367   | +0.245 % | A     |
| led-white-10k  | d1/A     | 0.00025536 | 0.00025535 | +0.002 % | A     |

#### Silicon diodes

| Case          | Quantity | Spice Lite | ngspice   | Error    | Grade |
| ------------- | -------- | ---------- | --------- | -------- | ----- |
| diode-led-330 | d1/A     | 0.0073295  | 0.0073173 | +0.166 % | A     |

#### CMOS output stage dynamics

| Case                  | Quantity     | Spice Lite | ngspice | Error    | Grade |
| --------------------- | ------------ | ---------- | ------- | -------- | ----- |
| cmos-high-into-1u     | out@0.0002/V | 0.83895    | 0.83856 | +0.046 % | A     |
| cmos-high-into-1u     | out@0.0005/V | 2.0954     | 2.0957  | -0.016 % | A     |
| cmos-high-into-1u     | out@0.0008/V | 3.2207     | 3.2229  | -0.068 % | A     |
| cmos-high-into-1u     | out@0.001/V  | 3.7941     | 3.7969  | -0.073 % | A     |
| cmos-high-into-1u     | out@0.0015/V | 4.6014     | 4.6048  | -0.075 % | A     |
| cmos-high-into-1u     | out@0.002/V  | 4.8804     | 4.8818  | -0.030 % | A     |
| cmos-high-into-1u     | out@0.003/V  | 4.9901     | 4.9901  | -0.001 % | A     |
| cmos-high-into-1u-10v | out@0.0001/V | 1.5981     | 1.5972  | +0.053 % | A     |
| cmos-high-into-1u-10v | out@0.0003/V | 4.7906     | 4.7912  | -0.012 % | A     |
| cmos-high-into-1u-10v | out@0.0004/V | 6.3528     | 6.2687  | +1.342 % | A     |
| cmos-high-into-1u-10v | out@0.0005/V | 7.5686     | 7.479   | +1.198 % | A     |
| cmos-high-into-1u-10v | out@0.0007/V | 8.9773     | 8.9829  | -0.062 % | A     |
| cmos-high-into-1u-10v | out@0.001/V  | 9.7726     | 9.7754  | -0.028 % | A     |
| cmos-high-into-1u-10v | out@0.0015/V | 9.9834     | 9.9836  | -0.001 % | A     |

#### BJT as a saturated switch

| Case                   | Quantity    | Spice Lite | ngspice  | Error    | Grade |
| ---------------------- | ----------- | ---------- | -------- | -------- | ----- |
| npn-switch-10k         | collector/V | 0.083079   | 0.083739 | -0.788 % | A     |
| npn-general-switch-10k | collector/V | 0.036573   | 0.036334 | +0.658 % | A     |
| npn-power-switch       | collector/V | 0.11895    | 0.12049  | -1.281 % | A     |
| npn-darlington-switch  | collector/V | 0.75512    | 0.75559  | -0.062 % | A     |
| pnp-switch-10k         | collector/V | 4.9501     | 4.952    | -0.038 % | A     |
| pnp-general-switch-10k | collector/V | 4.9554     | 4.9555   | -0.002 % | A     |
| pnp-power-switch       | collector/V | 4.8811     | 4.8795   | +0.032 % | A     |

#### BJT in its active region

| Case                  | Quantity    | Spice Lite | ngspice | Error    | Grade |
| --------------------- | ----------- | ---------- | ------- | -------- | ----- |
| npn-active-1M         | collector/V | 4.4409     | 4.4414  | -0.012 % | A     |
| npn-active-100k       | collector/V | 0.17012    | 0.17091 | -0.464 % | A     |
| npn-general-active-1M | collector/V | 4.3517     | 4.3543  | -0.060 % | A     |
| npn-power-active      | collector/V | 4.9258     | 4.9258  | +0.000 % | A     |
| npn-darlington-active | collector/V | 0.67437    | 0.67613 | -0.261 % | A     |
| pnp-active-1M         | collector/V | 0.90868    | 0.90924 | -0.061 % | A     |
| pnp-general-active-1M | collector/V | 0.96096    | 0.96035 | +0.064 % | A     |

#### MOSFET fully on

| Case                   | Quantity | Spice Lite | ngspice   | Error    | Grade |
| ---------------------- | -------- | ---------- | --------- | -------- | ----- |
| nmos-on-4v             | drain/V  | 0.10335    | 0.10335   | +0.000 % | A     |
| nmos-on-5v             | drain/V  | 0.079444   | 0.079444  | +0.000 % | A     |
| nmos-logic-power-on-3v | drain/V  | 0.0028147  | 0.0028142 | +0.019 % | A     |
| nmos-logic-power-on-5v | drain/V  | 0.0013487  | 0.0013487 | -0.000 % | A     |
| nmos-power-on-4.5v     | drain/V  | 0.0033536  | 0.0033536 | +0.000 % | A     |
| nmos-power-on-5v       | drain/V  | 0.0026764  | 0.0026755 | +0.034 % | A     |
| pmos-on-5v             | drain/V  | 4.3246     | 4.3246    | -0.000 % | A     |
| pmos-power-on-4v       | drain/V  | 4.9779     | 4.9811    | -0.065 % | A     |
| pmos-power-on-5v       | drain/V  | 4.9876     | 4.9876    | -0.000 % | A     |

#### MOSFET near threshold

| Case                       | Quantity | Spice Lite | ngspice | Error    | Grade |
| -------------------------- | -------- | ---------- | ------- | -------- | ----- |
| nmos-threshold-2.5v        | drain/V  | 1.96       | 1.96    | -0.000 % | A     |
| nmos-threshold-3v          | drain/V  | 0.18755    | 0.18746 | +0.050 % | A     |
| nmos-threshold-3.5v        | drain/V  | 0.12887    | 0.12886 | +0.003 % | A     |
| nmos-power-threshold-3.65v | drain/V  | 4.38       | 4.38    | +0.000 % | A     |
| pmos-threshold-3v          | drain/V  | 1.248      | 1.248   | +0.000 % | A     |
| pmos-power-threshold-3v    | drain/V  | 0.57085    | 0.57085 | +0.000 % | A     |

#### Inductors

| Case          | Quantity            | Spice Lite | ngspice   | Error    | Grade |
| ------------- | ------------------- | ---------- | --------- | -------- | ----- |
| rl-step       | mid@0.0003/V        | 3.7903     | 3.7902    | +0.001 % | A     |
| rl-step       | mid@0.0007/V        | 2.8262     | 2.8261    | +0.001 % | A     |
| rl-step       | mid@0.0014/V        | 2.0595     | 2.0595    | +0.000 % | A     |
| rl-step       | mid@0.0035/V        | 1.6602     | 1.6602    | +0.000 % | A     |
| rl-step       | l1@0.0003/A         | 0.012097   | 0.012098  | -0.003 % | A     |
| rl-step       | l1@0.0007/A         | 0.021738   | 0.021739  | -0.001 % | A     |
| rl-step       | l1@0.0014/A         | 0.029405   | 0.029405  | -0.000 % | A     |
| rl-step       | l1@0.0035/A         | 0.033398   | 0.033398  | -0.000 % | A     |
| relay-flyback | collector@0.0195/V  | 0.14505    | 0.14505   | +0.000 % | A     |
| relay-flyback | collector@0.0203/V  | 5.8393     | 5.8393    | +0.000 % | A     |
| relay-flyback | collector@0.0206/V  | 5.8068     | 5.8068    | +0.000 % | A     |
| relay-flyback | collector@0.021/V   | 5.7675     | 5.7675    | +0.000 % | A     |
| relay-flyback | collector@0.0215/V  | 5.7105     | 5.7105    | +0.000 % | A     |
| relay-flyback | l1@0.0195/A         | 0.05062    | 0.05062   | +0.000 % | A     |
| relay-flyback | l1@0.0203/A         | 0.035741   | 0.03574   | +0.002 % | A     |
| relay-flyback | l1@0.0206/A         | 0.02466    | 0.024659  | +0.003 % | A     |
| relay-flyback | l1@0.021/A          | 0.014189   | 0.014188  | +0.003 % | A     |
| relay-flyback | l1@0.0215/A         | 0.0058515  | 0.0058513 | +0.004 % | A     |
| relay-kick    | collector@0.02002/V | 40.043     | 40.043    | +0.000 % | A     |
| relay-kick    | collector@0.02005/V | 40.031     | 40.031    | +0.000 % | A     |
| relay-kick    | collector@0.0201/V  | 40.013     | 40.013    | +0.000 % | A     |
| relay-kick    | l1@0.02002/A        | 0.042724   | 0.042716  | +0.017 % | A     |
| relay-kick    | l1@0.02005/A        | 0.031151   | 0.031144  | +0.023 % | A     |
| relay-kick    | l1@0.0201/A         | 0.012595   | 0.012588  | +0.054 % | A     |
| rlc-series    | cap@0.0005/V        | 4.3462     | 4.3463    | -0.003 % | A     |
| rlc-series    | cap@0.001/V         | 8.0402     | 8.0402    | -0.000 % | A     |
| rlc-series    | cap@0.0015/V        | 5.442      | 5.4419    | +0.001 % | A     |
| rlc-series    | cap@0.002/V         | 3.1521     | 3.1521    | +0.000 % | A     |
| rlc-series    | cap@0.003/V         | 6.1229     | 6.1229    | -0.000 % | A     |
| rlc-series    | cap@0.005/V         | 5.4141     | 5.4141    | -0.000 % | A     |
| rlc-series    | cap@0.008/V         | 4.9075     | 4.9075    | +0.000 % | A     |

## Appendix B — clock waves, every value

V(x) in volts; ngspice interpolated from its output at the same instant.

| Case                   | t        | Spice Lite | ngspice |        Δ | Grade |
| ---------------------- | -------- | ---------: | ------: | -------: | :---: |
| triangle-10Hz-lowpass  | 10.0 ms  |     0.3679 |  0.3679 |  0.00 mV |   A   |
| triangle-10Hz-lowpass  | 25.0 ms  |     1.5821 |  1.5821 |  0.00 mV |   A   |
| triangle-10Hz-lowpass  | 50.0 ms  |     4.0067 |  4.0067 |  0.00 mV |   A   |
| triangle-10Hz-lowpass  | 75.0 ms  |     3.3364 |  3.3364 | -0.00 mV |   A   |
| triangle-10Hz-lowpass  | 100.0 ms |     0.9866 |  0.9866 | -0.00 mV |   A   |
| triangle-10Hz-lowpass  | 200.0 ms |     0.9866 |  0.9866 | -0.00 mV |   A   |
| triangle-10Hz-lowpass  | 425.0 ms |     1.6631 |  1.6631 |  0.00 mV |   A   |
| triangle-10Hz-lowpass  | 450.0 ms |     4.0134 |  4.0134 |  0.00 mV |   A   |
| triangle-10Hz-lowpass  | 500.0 ms |     0.9866 |  0.9866 | -0.00 mV |   A   |
| sine-50Hz-lowpass      | 2.0 ms   |     0.0307 |  0.0307 |  0.00 mV |   A   |
| sine-50Hz-lowpass      | 5.0 ms   |     0.4006 |  0.4006 |  0.00 mV |   A   |
| sine-50Hz-lowpass      | 10.0 ms  |     1.8949 |  1.8949 |  0.00 mV |   A   |
| sine-50Hz-lowpass      | 15.0 ms  |     2.7161 |  2.7161 | -0.00 mV |   A   |
| sine-50Hz-lowpass      | 20.0 ms  |     1.9628 |  1.9628 | -0.00 mV |   A   |
| sine-50Hz-lowpass      | 100.0 ms |     2.2699 |  2.2699 | -0.01 mV |   A   |
| sine-50Hz-lowpass      | 105.0 ms |     1.7774 |  1.7774 |  0.00 mV |   A   |
| sine-50Hz-lowpass      | 110.0 ms |     2.7300 |  2.7300 |  0.01 mV |   A   |
| sine-50Hz-lowpass      | 115.0 ms |     3.2225 |  3.2225 | -0.00 mV |   A   |
| sine-16Hz-lowpass      | 10.0 ms  |     0.3161 |  0.3161 |  0.00 mV |   A   |
| sine-16Hz-lowpass      | 30.0 ms  |     3.5143 |  3.5143 |  0.00 mV |   A   |
| sine-16Hz-lowpass      | 50.0 ms  |     3.2961 |  3.2961 | -0.00 mV |   A   |
| sine-16Hz-lowpass      | 250.0 ms |     1.2566 |  1.2566 | -0.00 mV |   A   |
| sine-16Hz-lowpass      | 270.0 ms |     1.8984 |  1.8984 |  0.00 mV |   A   |
| sine-16Hz-lowpass      | 290.0 ms |     4.2557 |  4.2557 |  0.00 mV |   A   |
| sine-16Hz-lowpass      | 300.0 ms |     3.3046 |  3.3046 | -0.00 mV |   A   |
| ramp-up-20Hz-highpass  | 10.0 ms  |     0.6321 |  0.6321 |  0.00 mV |   A   |
| ramp-up-20Hz-highpass  | 25.0 ms  |     0.9179 |  0.9179 |  0.00 mV |   A   |
| ramp-up-20Hz-highpass  | 49.9 ms  |     0.9932 |  0.9932 | -0.00 mV |   A   |
| ramp-up-20Hz-highpass  | 50.1 ms  |    -3.9569 | -3.9569 |  0.01 mV |   A   |
| ramp-up-20Hz-highpass  | 60.0 ms  |    -0.8419 | -0.8419 |  0.00 mV |   A   |
| ramp-up-20Hz-highpass  | 200.1 ms |    -3.9838 | -3.9838 | -0.01 mV |   A   |
| ramp-up-20Hz-highpass  | 225.1 ms |     0.5909 |  0.5909 | -0.00 mV |   A   |
| ramp-up-20Hz-highpass  | 249.0 ms |     0.9625 |  0.9625 | -0.00 mV |   A   |
| ramp-down-20Hz-lowpass | 10.0 ms  |     2.7927 |  2.7927 | -0.00 mV |   A   |
| ramp-down-20Hz-lowpass | 25.0 ms  |     3.0075 |  3.0075 | -0.00 mV |   A   |
| ramp-down-20Hz-lowpass | 49.0 ms  |     1.0553 |  1.0553 | -0.00 mV |   A   |
| ramp-down-20Hz-lowpass | 60.0 ms  |     3.1457 |  3.1457 |  0.00 mV |   A   |
| ramp-down-20Hz-lowpass | 200.0 ms |     0.9661 |  0.9661 |  0.00 mV |   A   |
| ramp-down-20Hz-lowpass | 225.0 ms |     3.0868 |  3.0868 | -0.00 mV |   A   |
| ramp-down-20Hz-lowpass | 249.0 ms |     1.0625 |  1.0625 | -0.00 mV |   A   |
| triangle-250Hz-lowpass | 0.5 ms   |     0.2663 |  0.2663 |  0.01 mV |   A   |
| triangle-250Hz-lowpass | 1.0 ms   |     0.9197 |  0.9197 |  0.03 mV |   A   |
| triangle-250Hz-lowpass | 2.0 ms   |     2.8384 |  2.8383 |  0.04 mV |   A   |
| triangle-250Hz-lowpass | 3.0 ms   |     3.2850 |  3.2851 | -0.02 mV |   A   |
| triangle-250Hz-lowpass | 20.0 ms  |     1.9039 |  1.9040 | -0.04 mV |   A   |
| triangle-250Hz-lowpass | 21.0 ms  |     1.6202 |  1.6201 |  0.03 mV |   A   |
| triangle-250Hz-lowpass | 22.0 ms  |     3.0961 |  3.0960 |  0.04 mV |   A   |

## Appendix C — how this was run

- **Golden scorecard:** `SPICE_GOLDEN_REPORT=/tmp/golden-report.json node
--test --test-reporter=tap web/scripts/tests/spice-golden.test.js` from
  `src/`.
- **Reference regeneration:** `node scripts/spice-golden.mjs` in a scratch
  copy of `scripts/` and `src/web/scripts/` (so the committed JSON was not
  touched), ngspice 44.2 (`/opt/homebrew/bin/ngspice`), then a value-by-value
  diff against the committed files.
- **New comparisons:** throwaway Node scripts (not committed) that build each
  circuit with `tests/timing-fixtures.js`, run Spice Lite exactly as
  SimController does (each tick handed the clock's level and `clockTimes`,
  the next tick at the earlier of the next edge, the engine's `wakeAt` and
  the next reading time), and write the matching ngspice deck by hand.
