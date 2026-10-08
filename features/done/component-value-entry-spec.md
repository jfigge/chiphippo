# ChipHippo — Component Value Entry Spec

Status: landed 2026-10-08 — the existing transistor GRADES were kept as the preset range (§0); the §7 fallback presets were not added
Scope: properties dialogues for passive and discrete components (resistors, capacitors, inductors/chokes, diodes, transistors)

---

## 0. Note for the implementer — read first

This spec describes the target behaviour, but some of it may already exist in the codebase. **Existing data wins over this document; changes must be additive.**

In particular, for **transistors (BJT and MOSFET)**:

- The codebase may already offer a range of transistor variants (e.g. logic-level, medium, power). **If any such range already exists, leave it exactly as it is — do not add the Section 7 presets, and do not change any existing names or values.**
- Only use the Section 7 transistor presets if the code has **no** variant range at all for that transistor type.
- Either way, the Tier 2 behaviour (Section 5 — `Custom…` sentinel, advanced fields, reopen logic) is still to be built around whatever presets end up in place.

For the value lists in Section 7 generally (resistors, capacitors, inductors, Zeners): extend existing lists, never shrink or rewrite them.

---

## 1. Goal

Give every component a consistent way to set its electrical values:

- The common case is one click (pick a standard value or preset).
- Unusual values are always possible (type them or go Custom).
- Complexity only appears when the user asks for it.
- One pattern, reused everywhere, built on the standard properties dialogue.

---

## 2. Where it lives

All of this sits in the **element-specific region** of the existing standard properties dialogue:

```
┌───────────────────────────────┐
│ Name         [ R1           ] │
│ Description  [              ] │
│ ───────────────────────────── │   ← divider
│ Resistance   [ 3 kΩ       ▾ ] (i)
│                               │
│ (advanced fields, if any)     │
└───────────────────────────────┘
```

Do not create a bespoke dialogue. Extend the standard one so every component looks the same.

---

## 3. The rule: which pattern does a component get?

Ask one question per component: **how many values does the user's choice control?**

| Choice controls…                     | Pattern                                  | Components                                  |
|--------------------------------------|------------------------------------------|---------------------------------------------|
| A single value                       | **Tier 1 — Value field**                 | Resistor, capacitor, inductor/choke, Zener  |
| A cluster of related parameters      | **Tier 2 — Preset list + Custom…**       | BJT (NPN/PNP), MOSFET (N/P-channel)         |

If a future component only needs one number, it is Tier 1. Only reach for Tier 2 when picking a variant genuinely sets several parameters together.

---

## 4. Tier 1 — Value field (single-value components)

An **editable combo box**: a dropdown of standard values, and the user can also type directly into it.

Behaviour:

1. Dropdown lists the component's preferred-value series (Section 7).
2. User may type any value instead of picking one.
3. Typed values go through the **existing parse-and-validate path** already used by resistors and capacitors (SI prefixes, optional unit). Reuse it — do not write a second parser.
4. Invalid input uses the existing field-level validation styling; the last valid value is kept.
5. Valid input is accepted **as typed**. No snapping, no rounding.
6. If the typed value is not a standard value, show the nearest-value hint (Section 6).

Resistors and capacitors already behave this way. Their one addition is the nearest-value hint.

No "Custom…" entry and no advanced fields for Tier 1.

---

## 5. Tier 2 — Preset list + Custom… (multi-parameter components)

A **non-editable** dropdown of named presets, ending with a sentinel entry **`Custom…`**.

```
Variant  [ Logic-level           ▾ ]
          ├ Small-signal
          ├ Logic-level
          ├ Power
          └ Custom…
```

Behaviour:

1. **Selecting a preset** populates all of that preset's underlying parameters. Advanced fields stay hidden.
2. **Selecting `Custom…`** reveals the advanced fields **below the dropdown**, pre-filled with the values of the preset that was selected just before. Custom starts from the nearest known-good part, never from blank.
3. Each advanced field is a Tier 1–style typed field: parsed and validated with the existing parser.
4. **Switching from Custom back to a preset** overwrites the custom values with the preset's and hides the advanced fields.
5. **Reopening the dialogue:**
   - If the stored parameters exactly match a preset, select that preset.
   - Otherwise select `Custom…` and show the advanced fields expanded.
   This keeps the dialogue honest — it never displays a preset name over values that don't match it.
6. **Persistence:** always save the full parameter set, plus the preset id (or `custom`). Parameter values are the source of truth; the preset id is a convenience.

### Engine visibility

The transistor Variant dropdown and its advanced fields are **only shown when the SPICE engine is active**. With the digital engine, transistors are pure switches and the fields are hidden (current behaviour — keep it).

Tier 1 value fields remain visible in both engines, since they also feed the KiCad export.

---

## 6. Nearest-value hint (circled-i popup)

Applies to **every Tier 1 component** — resistors, capacitors, inductors/chokes and Zeners — whenever a typed value falls between two entries in that component's preferred-value series.

This matters for resistors and capacitors as much as anything: E12 is sparse, so a natural value like **3 kΩ** has no exact match (neighbours 2.7 kΩ and 3.3 kΩ), and the user usually doesn't realise it. The hint surfaces that quietly and offers both neighbours as one-click fixes.

### When it shows

- The typed value is valid **and** is not a series value (allow a small tolerance, e.g. 0.5%, so `4.7u` and `4.70 µH` count as equal).
- The value lies within the series range.
- Outside the range (below the smallest / above the largest), show the single closest end value instead of two.
- A standard value → no icon.

### Icon

- Reuse the existing **circled-i information icon** and its CSS style used elsewhere in the app.
- Yellow / advisory styling. This is information, not a warning — never red.
- Placed immediately to the right of the value field.

### Popup

The existing info icon only drives a floating hover tooltip. This needs its own small popup, because it contains clickable links (a hover tooltip would vanish as the pointer moves to them).

- Visual style should match the existing info tooltip (small dialogue-like panel). **Investigate the existing CSS class first and reuse it.**
- Opens when the icon is clicked (hover may also open it).
- Content, kept short:

  ```
  Standard values close to this:
  [2.7 kΩ]   [3.3 kΩ]
  ```

- Each value is a link. Clicking one sets the combo box to that standard value, closes the popup, and removes the icon.
- **Dismissal: clicking anywhere outside the popup closes it.** No X button. Escape should also close it.

### Computing the bracket

Preferred-value series are logarithmic, so search on the series sorted ascending:

- `lower` = largest series value ≤ typed value
- `upper` = smallest series value ≥ typed value
- Show both (lower first).

---

## 7. Default value lists

Reminder: per Section 0, these extend what exists — they never replace it.

### Resistors — E12 (already implemented)
10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82 — repeated per decade across the existing range.

### Capacitors — E12-style (already implemented)
Keep existing list.

### Inductors / chokes — new

**µH:** 1, 1.5, 2.2, 3.3, 4.7, 6.8, 10, 15, 22, 33, 47, 68, 100, 150, 220, 330, 470, 680
**mH:** 1, 1.5, 2.2, 3.3, 4.7, 6.8, 10, 22, 33, 47, 100

(~29 entries — E6-style steps, matching common through-hole choke/inductor stock.)

### Zener diode voltage — new
2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1, 10, 12, 15, 18, 24 V
(Common 1N47xx / BZX55 values.)

### Transistor presets — fallback only (see Section 0)

Use these only if the code has no existing variant range. If a range already exists, ignore this subsection entirely.

Values are generic typical figures for simulation, not datasheet guarantees. Presets use **generic names**; the "≈" part number appears in a tooltip only, not as the preset name — a preset is a behaviour class, not a specific part.

**MOSFET (N-channel; P-channel uses the same magnitudes with negative V<sub>GS(th)</sub>)**

| Preset        | ≈ Part   | V<sub>GS(th)</sub> | R<sub>DS(on)</sub> | V<sub>DS</sub> max | I<sub>D</sub> max |
|---------------|----------|--------------------|--------------------|--------------------|-------------------|
| Small-signal  | 2N7000   | 2.1 V              | 5 Ω                | 60 V               | 0.2 A             |
| Logic-level   | IRLZ44N  | 1.5 V              | 0.05 Ω             | 55 V               | 10 A              |
| Power         | IRF540N  | 3.0 V              | 0.08 Ω*            | 100 V              | 20 A              |

\* Power preset needs ~10 V gate drive for full enhancement. Driven from a 5 V logic output it should only partially turn on — a deliberate teaching case.

**BJT (NPN; PNP uses the same magnitudes with reversed polarity)**

| Preset          | ≈ Part        | h<sub>FE</sub> | V<sub>BE(on)</sub> | V<sub>CE(sat)</sub> | I<sub>C</sub> max | V<sub>CEO</sub> |
|-----------------|---------------|----------------|--------------------|---------------------|-------------------|-----------------|
| Small-signal    | 2N3904 / 3906 | 100            | 0.65 V             | 0.2 V               | 0.2 A             | 40 V            |
| Medium power    | BD139 / 140   | 60             | 0.7 V              | 0.5 V               | 1.5 A             | 80 V            |
| Power           | TIP31 / 32    | 25             | 0.8 V              | 1.0 V               | 3 A               | 40 V            |
| Darlington      | TIP120 / 125  | 1000           | 1.4 V              | 1.0 V               | 5 A               | 60 V            |

Default selection on drop (fallback presets only): **Small-signal** for both BJT and MOSFET.

---

## 8. Implementation notes

- Build one reusable control for each tier (e.g. `ValueField` and `PresetField`) and configure per component with: series/presets, unit, parser, and (Tier 2) the parameter field definitions.
- Store series and presets as data tables, not code branches, so adding a component is a data change.
- The nearest-value hint belongs to the shared `ValueField` and is driven by whether a series is configured — so it is automatically available to resistors, capacitors, inductors and Zeners alike.
- KiCad export is unaffected: it continues to use the component's stored real values.
- In your completion summary, state whether an existing transistor variant range was found (and kept as-is), or whether the Section 7 fallback presets were added.

---

## 9. Open questions

1. Should switching from Custom back to a preset ask for confirmation, since custom values are lost?
2. Should the inductor list display switch units automatically (µH ↔ mH), or show everything in one unit?
