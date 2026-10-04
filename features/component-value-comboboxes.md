# ChipHippo: Default-value combo boxes for discrete components

## Goal

Add an **editable combo box** to the properties dialogue for resistors, capacitors, inductors, Zener diodes and transistors. Each one offers a dropdown of the most common values or part numbers, and also lets the user type any value directly. Typed values are validated and normalised into a clean, canonical display string (e.g. typing `100 kilo ohms` shows as `100kΩ`).

These fields replace (or wrap) the existing free-text value fields. They must not change how any component behaves in the simulation; resistors still draw colour bands from a valid value, capacitors still just carry a farad value for the smart parts (555, RC-timing CD4000 parts) to read.

## Before you start

- Read the existing properties dialogue (name, description, dividing line, then element-specific fields) and build on it so the new control looks consistent with everything else.
- Find the existing resistance and farad parsing used by the resistor and capacitor fields. **Replace it with the single shared parser described below**, so there is one parse-and-validate path for every value field, whether the value was picked or typed.
- Build the combo box as one reusable control used by every component type, configured with: the unit, the default list, the allowed range, and whether the field is a numeric value or a part number.

## The combo box control

- A dropdown of defaults, plus free typing in the same field.
- Validate on blur and on Enter (not on every keystroke, so partial input like `4.` isn't flagged mid-typing).
- **Valid input:** replace the field text with the canonical display string, store the parsed numeric value in base SI units.
- **Invalid input:** keep the user's text, show the field in the existing red field-level validation style with a short message (e.g. "Not a resistance value", "Out of range: 0.1Ω to 100MΩ"). Do not save an invalid value; the component keeps its last valid value.
- Typing into the box should filter the dropdown to matching entries (e.g. typing `4` shows 4.7k, 47k etc.).
- Custom (non-default) values are allowed silently. No nagging about non-standard values.

## Shared value parser

One function, e.g. `parseComponentValue(text, expectedUnit) → { value, display } | error`.

### Accepted input forms

| Form | Examples | Result |
|---|---|---|
| Plain number | `470`, `0.1`, `1e3` | value in base units |
| Number + prefix letter | `4.7k`, `100n`, `10u`, `2.2M` | |
| Number + prefix + unit | `4.7kΩ`, `100nF`, `10uH`, `5.1V` | |
| Spelled-out words | `100 kilo ohms`, `100 kiloohm`, `10 microfarads`, `1 millihenry` | |
| RKM / "4k7" notation | `4k7` → 4.7k, `2R2` → 2.2Ω, `4n7` → 4.7nF, `5V1` → 5.1V | |
| Spaces anywhere sensible | `4.7 k`, `100 nF`, `100 k ohm` | |

### Prefixes

| Prefix | Symbols / words accepted |
|---|---|
| pico 1e-12 | `p`, `pico` |
| nano 1e-9 | `n`, `nano` |
| micro 1e-6 | `u`, `µ`, `μ`, `micro` |
| milli 1e-3 | `m`, `milli` |
| kilo 1e3 | `k`, `K`, `kilo` |
| mega 1e6 | `M`, `meg`, `mega` (note: `meg` is common in SPICE) |
| giga 1e9 | `G`, `giga` |

- **Single letters are case-sensitive for `m` vs `M`** (milli vs mega). Everything else and all spelled-out words are case-insensitive.
- Special case for resistors only: since milliohm resistors aren't realistic in this tool, treat a lowercase `m` on a resistance as mega? **No.** Keep it strict: `1m` on a resistor is 1 milliohm, which then fails the range check with "Out of range", prompting the user. Don't guess.

### Units

| Unit | Accepted |
|---|---|
| Ohms | `Ω`, `ohm`, `ohms`, `R` (as a suffix or RKM decimal point) |
| Farads | `F`, `farad`, `farads` |
| Henries | `H`, `henry`, `henries`, `henrys` |
| Volts | `V`, `v`, `volt`, `volts` |

- The unit is optional; if omitted, the field's expected unit is assumed.
- A **wrong unit is an error** (e.g. `10uF` typed into a resistor → "That's a capacitance, not a resistance").
- Reject anything with leftover characters, multiple numbers, negative values, zero, NaN or infinity.

### Canonical display

- Engineering notation with the largest prefix that keeps the number ≥ 1: `4700` → `4.7kΩ`, `0.0000001 F` → `100nF`.
- Up to 3 significant figures, trailing zeros stripped (`4.70k` → `4.7k`, `100.0` → `100`).
- No space between number, prefix and unit symbol: `100kΩ`, `4.7µF`, `10mH`, `5.1V`.
- Always use `µ` (micro sign) in display, regardless of how it was typed.
- Values that need more than 3 significant figures (e.g. `4.753k`) are kept to their typed precision rather than rounded, so nothing is silently changed.

### Allowed ranges

| Component | Min | Max |
|---|---|---|
| Resistor | 0.1Ω | 100MΩ |
| Capacitor (ceramic) | 1pF | 100µF |
| Capacitor (electrolytic) | 100nF | 100mF |
| Inductor | 1nH | 10H |
| Zener voltage | 1.8V | 200V |

If a capacitor's type is switched and its current value falls outside the new type's range, show the field red with the range message rather than altering the value.

## Default lists

### Resistors: full E12 series

Base values `10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82` repeated across decades from **10Ω up to 1MΩ**, plus `1MΩ` itself:

10Ω, 12Ω, 15Ω … 82Ω, 100Ω, 120Ω … 820Ω, 1kΩ, 1.2kΩ … 8.2kΩ, 10kΩ … 82kΩ, 100kΩ … 820kΩ, 1MΩ

Generate this list programmatically from the 12 base values rather than hard-coding every entry.

### Capacitors: depends on capacitor type

- **Ceramic:** 10pF, 22pF, 100pF, 1nF, 10nF, 100nF, 1µF
- **Electrolytic:** 1µF, 10µF, 22µF, 47µF, 100µF, 220µF, 470µF, 1000µF

The dropdown contents switch when the capacitor type (ceramic / electrolytic) changes.

### Inductors

1µH, 10µH, 22µH, 47µH, 100µH, 220µH, 1mH, 10mH, 100mH

### Zener diodes: voltage paired with part number

Each entry shows both, e.g. `5.1V (1N4733A)`. Picking an entry stores the voltage **and** the part number. Typing a bare voltage (`5.1`, `5.1V`, `5V1`) that matches an entry attaches that part number; any other valid voltage is stored with no part number. Typing a known part number (`1N4733`, `1n4733a`) selects its entry.

| Voltage | Part number |
|---|---|
| 2.4V | BZX55C2V4 |
| 2.7V | BZX55C2V7 |
| 3.3V | 1N4728A |
| 4.7V | 1N4732A |
| 5.1V | 1N4733A |
| 5.6V | 1N4734A |
| 6.2V | 1N4735A |
| 7.5V | 1N4737A |
| 8.2V | 1N4738A |
| 9.1V | 1N4739A |
| 12V | 1N4742A |
| 15V | 1N4744A |
| 18V | 1N4746A |
| 24V | 1N4749A |
| 30V | 1N4751A |

(1N47xxA is the common 1W series; it doesn't go below 3.3V, so the two lowest use the 500mW BZX55 parts.)

Standard (non-Zener) diodes are out of scope for this change.

### Transistors: part numbers, filtered by transistor type

Part numbers are metadata only (used for the KiCad export and labelling); they **do not change simulation behaviour**, which stays the simple digital-switch model.

| Type | Defaults |
|---|---|
| NPN | 2N2222A, 2N3904, BC547 |
| PNP | 2N2907A, 2N3906, BC557 |
| N-channel MOSFET | 2N7000, BS170, IRF540N |
| P-channel MOSFET | BS250, IRF9540N |

- The dropdown shows only the parts for the currently selected transistor type, and switches when the type changes. If the current part number belongs to a different type after switching, clear it.
- Free-typed part numbers are allowed. Validation is light: trim whitespace, uppercase, allow only letters, digits and `-`, max 20 characters, non-empty. Otherwise accept as-is (we can't know every part).
- Typing a part number from another type's list (e.g. `2N3906` on an NPN) shows a red warning: "2N3906 is a PNP transistor". Don't block it, just warn.

## Data model / persistence

- Numeric values are stored as base-SI numbers (ohms, farads, henries, volts), not as display strings.
- Zener: store `voltage` and optional `partNumber`.
- Transistor: store optional `partNumber`.
- Existing saved projects must still load. Values saved by the old resistor/capacitor fields should be run through the new parser on load; if one fails to parse, keep the raw string and show the field red when the dialogue is opened, rather than discarding it.
- KiCad export should use the canonical display value (and part number where present) for the component's value field.

## Tests

Add unit tests for the parser covering at least:

| Input | Field | Expected |
|---|---|---|
| `100 kilo ohms` | resistor | `100kΩ` |
| `100k` | resistor | `100kΩ` |
| `4k7` | resistor | `4.7kΩ` |
| `2R2` | resistor | `2.2Ω` |
| `4700` | resistor | `4.7kΩ` |
| `1meg` | resistor | `1MΩ` |
| `1M` | resistor | `1MΩ` |
| `1m` | resistor | error: out of range |
| `10uF` | resistor | error: wrong unit |
| `100n` | capacitor | `100nF` |
| `0.1uF` | capacitor | `100nF` |
| `10 microfarads` | capacitor | `10µF` |
| `4n7` | capacitor | `4.7nF` |
| `1 millihenry` | inductor | `1mH` |
| `5V1` | Zener | `5.1V`, part `1N4733A` |
| `1n4742` | Zener | `12V`, part `1N4742A` |
| `11` | Zener | `11V`, no part number |
| `-5k` | resistor | error |
| `abc` | resistor | error |
| `4.7kk` | resistor | error |

Plus UI checks: picking a default, typing a custom value, red state on bad input, dropdown filtering, capacitor-type and transistor-type switching, and loading an older project.
