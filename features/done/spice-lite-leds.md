# Spice Lite — real LEDs

**Status:** built 2026-10-07; Jason's answers folded in (end).
Asked for by Jason: "simulate real LEDs with real burn outs based on actual voltage and
current as per the generic specs for the different colors".

## What it does

With Spice Lite on, every LED and every display segment / bar carries the current its
circuit pushes through it, and what that current does to it follows its colour's
datasheet. The digital engine's junction rule (`sim/junction.js`) is untouched and still
decides with Spice Lite off.

## The numbers (all verified from the sheets, 2026-10-07)

One ordinary 5 mm part per colour — Kingbright WP7113 series, typical at 25 °C:

| Colour | Part        | VF typ         | rd (fig.) | IF DC | IFP    | Tj max | RthJA    | Burns at |
| ------ | ----------- | -------------- | --------- | ----- | ------ | ------ | -------- | -------- |
| red    | WP7113ID    | 1.9 V @ 10 mA  | 10 Ω      | 30 mA | 160 mA | 125 °C | 560 °C/W | 71.1 mA  |
| yellow | WP7113YD    | 1.95 V @ 10 mA | 12 Ω      | 30 mA | 140 mA | 110 °C | 560 °C/W | 59.6 mA  |
| green  | WP7113GD    | 2.0 V @ 10 mA  | 14 Ω      | 25 mA | 140 mA | 110 °C | 600 °C/W | 54.1 mA  |
| blue   | WP7113QBC/D | 3.3 V @ 20 mA  | 25 Ω      | 30 mA | 150 mA | 115 °C | 610 °C/W | 39.1 mA  |
| white  | WP7113QWC/D | 3.3 V @ 20 mA  | 25 Ω      | 30 mA | 150 mA | 115 °C | 570 °C/W | 41.2 mA  |

Chip outputs (`sim/spice/output-stage.js`): 74LS HIGH = VCC − 1.4 V behind 120 Ω
(SDLS025B schematic; checks against VOH 3.4 V typ and IOS 20–100 mA), LOW = 0.15 V
behind 25 Ω (VOL 0.25/0.35 V at 4/8 mA). CD4000 = a MOSFET saturating at 4.2 / 16 / 28 mA
at 5 / 10 / 15 V (CD4029B SCHS034C Figs. 1 and 3) behind 400 / 190 / 200 Ω. NE555
(SLFS022K Figs. 5-1, 5-4 and §5.5), CD4511B (SCHS072B Output Drive Voltage table) and
CD4049UB/CD4050B (SCHS046L Figs. 5-3/5-5) state their own.

## Decisions (each is a constant or one function)

1. **Burn rule = steady-state junction temperature past Tj max** (Ta + RthJA·VF·IF,
   Ta 25 °C), at once. Alternatives: burn at the peak-pulse rating IFP (much later: red
   160 mA), or a thermal time constant (the sheets give none). `leds.js` `ledVerdict`.
2. **Overdriven past the DC rating = a warning**, not damage (the sheets' own note).
3. **Brightness = cube root of I over the sheet's normalising current**, capped 1.4;
   dark below 50 µA. Presentation, not data. `LIT_MIN_A`, `MAX_LEVEL`.
4. **Reverse voltage past 5 V = a warning only** (no breakdown model).
5. **The burnt set is run-volatile in `analog`**, not a document param like `damaged`.
6. **Segments and bars use their colour's 5 mm LED.**
7. **Booking at SET volts, verdicts at delivered volts** (two solves), so the supply's
   droop arithmetic stays what `supply.js` was built on and a drooping supply dims LEDs.

## Jason's answers (2026-10-07)

- Q1 (burn point): **keep the instant burn-out** at Tj max.
- Q2 (editable LED numbers): **no**.
- Q3 (an LED overloading the chip driving it): **no**.
- Q4 (where an LED's current shows): **no component shows a current unless told to
  (the PSU's draw); the PROBE shows current** — built: the solve's `currents` by hole,
  `SimOverlay.currentAt`, the probe readout's `currentText`.

## Answered since

- Q5 (diodes and Zeners into the same solve): **yes** — built by the Spice Lite audit's
  phase C (`done/spice-lite-audit.md`): `sim/spice/diodes.js`, one common silicon
  junction (0.6 V knee), a Zener also conducting backwards at its `zenerVolts`, both
  burning by the same junction rule as an LED (`diode-burnt`).
