# Feature Request — Bench-Completeness Parts

**Project:** Chip Hippo
**Baseline:** v1.3.0 + Spice Lite (`main`, HEAD `fa92175`)
**Theme:** Fill the last obvious gaps in the "jelly bean" parts drawer — the parts most engineers keep on the bench.

---

## 0. Note for the implementer — read first

- **Existing code wins. All changes are additive.** Do not rename, re-value or remove any existing part, grade, folder or figure.
- Every new part follows the existing patterns. These are: a catalog entry, the standard Properties dialog (Name, Description, divider, part-specific fields, part number, Warnings), the pin-assignments window, a datasheet URL for **Data Sheets ▸ Download…**, and an **example bench circuit**.
- Behaviour has to be defined for **both engines**. The logic engine gets a simple, honest digital approximation. Spice Lite gets the electrical model.
- Part grades and names use **real jelly-bean part numbers**, the same convention as the existing transistor Grades.
- Each part should be its own small commit, in the order of Section 9, so they can be reviewed one at a time.
- In your completion summary, list what you added, anything you found already present and skipped, and any open question you had to decide.

---

## 1. Summary

| # | Addition | Where in the tray | Type |
|---|---|---|---|
| 1 | Darlington BJT grade | existing Transistors | grade (verify — may already exist) |
| 2 | Op-amps: LM741, LM358 | CHIPS ▸ OP-AMPS (family-less) | chip |
| 3 | Linear regulators: 78xx fixed, LM317 adjustable | CHIPS ▸ REGULATORS (family-less) | chip |
| 4 | Optocouplers: 4N35, PC817 | CHIPS ▸ INTERFACE (family-less, beside PIA/VIA) | chip |
| 5 | ULN2003A Darlington array | CHIPS ▸ INTERFACE | chip |
| 6 | Relay (5 V SPDT) | COMPONENTS ▸ RELAYS | component |
| 7 | Electronic load (CC / CR) | COMPONENTS ▸ Power (desk brick, beside PSU and Clock) | brick |

---

## 2. Darlington BJT grade

**Request:** Make a Darlington available as a selectable BJT Grade.

**Check first.** The existing grades already include **TIP120 (NPN)** and **TIP125 (PNP)**. Both are Darlington pairs. If the model treats them as Darlingtons (high hFE, VBE(on) about 1.4 V, VCE(sat) about 1 V), **nothing needs to be done**. Say so in the summary.

**Optional addition,** only if there is no small-signal Darlington yet: **MPSA14 (NPN)** and **MPSA64 (PNP)** in TO-92, the small-signal counterparts to the TIP pair.

---

## 3. Op-amps — CHIPS ▸ OP-AMPS

### Parts

| Part | Package | Notes |
|---|---|---|
| **LM741** | DIP-8, single | Teaching classic. Needs split or wide supply. Output does **not** reach the rails (about 1–2 V headroom). |
| **LM358** | DIP-8, dual | What people actually have. Runs single-supply, input range includes ground, output swings to near ground but about 1.5 V below V+. Two units in one package. |

### Pinouts

- **LM741:** 1 Offset N1 · 2 IN− · 3 IN+ · 4 V− · 5 Offset N2 · 6 OUT · 7 V+ · 8 NC
- **LM358:** 1 OUT A · 2 IN− A · 3 IN+ A · 4 GND/V− · 5 IN+ B · 6 IN− B · 7 OUT B · 8 V+

Offset-null pins may be left unmodelled (no connection electrically).

### Spice Lite model

**Do not model the raw open-loop gain directly.** The gain is effectively a vertical cliff, and stepping up it naively makes convergence overshoot or oscillate. Instead:

1. **Detect the configuration** for each op-amp unit by tracing nets from OUT back to IN− (the same net-tracing used by the timers):
   - **No feedback → comparator.** Output goes to the high or low output limit depending on whether IN+ > IN−.
   - **Negative feedback → virtual short.** Assume V(IN+) = V(IN−) and solve directly for the output that makes that true. Classic closed forms:
     - Voltage follower: Vout = Vin
     - Non-inverting: Vout = Vin × (1 + Rf / Rg)
     - Inverting: Vout = −Vin × (Rf / Rin) (relative to the reference on IN+)
2. **Clamp** the solved output to the part's output swing limits, which depend on its supply (see the notes above). When it clamps, the virtual short no longer holds. Raise a **"saturated"** warning on the part.
3. **Fallback.** Any feedback network that can't be classified uses a **heavily damped, clamped iterative solve** inside the existing analog convergence loop. Slower, but safe.
4. Enforce output current limits (about 20–40 mA short-circuit) through the existing output-current and power limit mechanism.

**Out of scope for v1:** slew rate, gain-bandwidth limits, offset voltage, input bias current, frequency compensation. These can be added later as Advanced figures.

### Logic engine

Treat each unit as a **comparator** on resolved levels: IN+ = H and IN− = L gives OUT H. The reverse gives L. Equal or undefined inputs give **X**. Add a drag-time / Properties note: *"Analog part — full behaviour under Spice Lite."* This follows the existing "a wire digitally; real under Spice Lite" convention used for inductors.

---

## 4. Linear regulators — CHIPS ▸ REGULATORS

### Parts

| Part | Output | Notes |
|---|---|---|
| **LM7805** | +5 V | |
| **LM7809** | +9 V | |
| **LM7812** | +12 V | |
| **LM7815** | +15 V | |
| **LM317** | 1.25–37 V, adjustable | Vout = 1.25 V × (1 + R2 / R1), set by two resistors on the board |

Note: there is no standard 78xx part for 3.3 V. A 3.3 V rail comes from an **LM317** with resistors, or later from a dedicated 3.3 V LDO (e.g. LM1117-3.3) if wanted.

### Pinouts (TO-220, front view, leads down)

- **78xx:** 1 IN · 2 GND · 3 OUT
- **LM317:** 1 ADJ · 2 OUT · 3 IN

### Spice Lite model

- **In regulation** (Vin ≥ Vout + dropout): OUT is a voltage source at the nominal Vout. Dropout is about **2 V** for 78xx and about **1.5–2 V** for LM317.
- **In dropout:** Vout ≈ Vin − dropout. Raise a **"dropout"** warning.
- **Current limit** about 1.5 A. Past it, the output droops, using the same droop behaviour as the PSU brick.
- **Heat:** dissipation = (Vin − Vout) × Iout + quiescent current. This is the teaching point — linear regulators burn the difference as heat. Show the dissipation in the probe and Properties. Warn above about **1 W** (hot without a heatsink). Above about **2 W** without a heatsink, go into **thermal shutdown**: output collapses until the load drops, using the existing smoke/fault visuals as appropriate.
- **LM317:** reads its two resistors from the board, the same way the 555 reads R and C. Show the computed Vout under the part, like timer readouts.

### Logic engine

If IN is powered at or above Vout + dropout, OUT is a **supply** at nominal Vout. Downstream chips see a real supply, and the existing family voltage rules apply. Otherwise OUT is unpowered. LM317: use the resistor-computed Vout.

---

## 5. Optocouplers — CHIPS ▸ INTERFACE

### Parts

| Part | Package | Pinout |
|---|---|---|
| **4N35** | DIP-6 | 1 Anode · 2 Cathode · 3 NC · 4 Emitter · 5 Collector · 6 Base |
| **PC817** | DIP-4 | 1 Anode · 2 Cathode · 3 Emitter · 4 Collector |

### Spice Lite model

- **Input side:** reuse the existing infrared LED model (forward-voltage curve, current, burn-out). An input LED with no series resistor burns, same as any LED.
- **Output side:** a phototransistor with collector current = **CTR × IF**, limited by the external circuit and VCE(sat). Use CTR about 100 % for 4N35 and about 50–600 % (default about 100 %) for PC817, editable under Advanced. 4N35 base pin may be left unconnected or modelled as the base.
- **Isolation:** input and output sides share **no** electrical path. The two sides may sit on different supplies, which is the whole point. Do not raise the "two supplies meeting" warning across an optocoupler.

### Logic engine

LED forward-biased (anode H, cathode L, through a resistor) → collector and emitter **join**, like the existing transistor join. Otherwise open.

---

## 6. ULN2003A — CHIPS ▸ INTERFACE

Seven open-collector Darlington drivers with built-in flyback diodes. This is the standard way to drive relays, motors and solenoids from logic.

**Pinout (DIP-16):** 1–7 IN1–IN7 · 8 GND · 9 COM · 10–16 OUT7–OUT1 (OUT1 = pin 16, opposite IN1).

### Spice Lite model

- Each channel is a Darlington (about 2.7 kΩ base resistor, VCE(sat) about 1 V, up to about 500 mA per channel). Reuse the Darlington grade figures.
- Each output has a **flyback diode to COM**. When COM is tied to the load supply, the existing **inductive-kick warning** must **not** fire for coils driven from that channel. This is a deliberate teaching contrast with a bare transistor.
- Enforce total package dissipation through the existing power-limit mechanism.

### Logic engine

INn = H → OUTn sinks to GND (L). INn = L or floating → OUTn = **Z** (open-collector, like the existing OC parts).

---

## 7. Relay — COMPONENTS ▸ RELAYS

**Part:** 5 V SPDT relay, the ubiquitous blue cube (e.g. Songle SRD-05VDC-SL-C). Pins: **Coil+, Coil−, COM, NO, NC**.

**Properties:** coil voltage (5 V default; 12 V option), coil resistance (default about 70 Ω for the 5 V part), contact rating (display only for v1).

### Spice Lite model

- **Coil:** the existing **inductor** model with winding resistance, so it ramps on its time constant.
- **Pull-in / drop-out:** contacts switch when coil voltage crosses about 75 % of rated (pull-in). They release below about 10 % (drop-out). The hysteresis is intentional.
- **Operate time:** about 10 ms from pull-in to contacts moving, so it's visible on the analyzer.
- **Contacts:** COM joins NO when energised and NC when not, using the existing analog-switch join.
- **Inductive kick:** switching the coil off with no flyback diode (and not via a ULN2003) fires the existing **inductive-kick warning**. This is a key lesson.
- **Coil current** is checked against the driver's output-current limit. Driving a relay straight from a 74LS or CD4000 output should raise the existing over-current / brown-smoke behaviour, which teaches why a transistor or ULN2003 is needed.

### Logic engine

Coil+ = H and Coil− = L (or the reverse — coils are non-polar unless a diode is fitted) → contacts switch to NO. Otherwise NC. The 'on' lamp follows the transistor-lamp convention.

---

## 8. Electronic load — COMPONENTS ▸ Power

A desk-level brick, like the PSU and Clock bricks, used to deliberately load a supply. It turns the power modelling from something that happens to the user into something they can test on purpose: prove a regulator holds, watch a PSU droop, trip a brown-out on purpose.

**Connection:** two leads, **+** and **−**, wired across any rail or net.

### Properties

- **Mode:** **Constant Current (CC)** or **Constant Resistance (CR)**.
- **Value:** one field whose unit follows the mode — **mA** in CC, **Ω** in CR. Parsed by the existing value parser (`50m`, `250mA`, `4k7`…).
- **Live readout** on the brick while running: **V**, **I**, **P**.

### Spice Lite model

- **CC:** sinks the set current regardless of voltage. When the source can't keep it up (voltage collapses toward 0 V), it drops out of regulation and the readout shows **"UNREG"**. It never sources current.
- **CR:** behaves as the set resistance (I = V / R).
- Contrast for teaching: as a rail sags, CC holds current flat while CR draw falls with voltage.
- Power rating about 25 W for display purposes. Warn if exceeded.

### Logic engine

Electrically inert, like the capacitor convention. Show a drag-time note: *"Electronic load — active under Spice Lite."* The brick still places, saves and exports.

---

## 9. Suggested build order

1. Darlington grade check (likely a no-op)
2. Linear regulators: simplest model, and they immediately make the electronic load useful
3. Electronic load
4. Optocouplers: reuse the LED and transistor models
5. ULN2003A
6. Relay: depends on the inductor and benefits from the ULN2003A for the example circuit
7. Op-amps: the most model work, so it goes last

---

## 10. Cross-cutting requirements

- **Datasheets:** add a manufacturer-hosted URL for each new part to the Download… list (TI for LM741, LM358, 78xx, LM317, ULN2003A; Vishay for 4N35; Sharp for PC817). Verify each URL resolves. Don't guess.
- **Example bench circuits,** one per part, opened from the pin-assignments window:
  - LM358: non-inverting ×2 amp, plus a comparator lighting an LED
  - LM741: inverting amp on ±9 V
  - 7805: 9 V PSU → 5 V rail feeding a 74LS00
  - LM317: two-resistor 3.3 V rail
  - Optocoupler: 5 V logic switching an isolated 12 V LED
  - ULN2003A: driving the relay
  - Relay: switching a lamp, with and without a flyback diode
  - Electronic load: a 7805 under a CC sweep
- **Schematic view:** standard symbols (op-amp triangle, regulator box, opto with arrows, relay coil and contacts, load symbol).
- **3D view:** a model for each new package (DIP-4/6/8/16, TO-220, relay cube, load brick).
- **BOM and KiCad export:** standard KiCad library symbols and footprints. The electronic load is a bench instrument and should be **excluded from the BOM and KiCad export**, with a line in the export report.
- **AI builder:** keep these parts **excluded** for now, consistent with how it currently excludes transistors, diodes and inductors.
- **User guide:** a short entry per part, and note which behaviours need Spice Lite.
- **Spice Lite fidelity:** where practical, add ngspice golden cases (`make spice-golden`) for the regulator, the op-amp configurations and the optocoupler CTR.

---

## 11. Open questions

1. **Tray placement:** the op-amps and regulators are proposed under **CHIPS** (family-less, beside the NE555), since they seat like chips. Confirm, or move them to COMPONENTS.
2. **79xx negative regulators** (7905, 7912): add now for the LM741's split supply, or leave for later?
3. **Relay coil voltages:** 5 V only, or 5 V and 12 V variants?

---

## 12. Completion summary (2026-10-09)

Built in one pass, uncommitted, for review (the request asked for one commit per part;
the parts share their plumbing — the device kinds in the solve, the catalog module, the
tests — so splitting is left to whoever commits).

### Added

| Part | Catalog | Logic engine | Spice Lite |
|---|---|---|---|
| **LM358** | CHIPS ▸ Op-amps, DIP-8 | a comparator of levels per unit (X when its inputs agree) | an op-amp device: gain 10⁵ about mid-swing, swing GND+5 mV … VCC−1.5 V behind 20 Ω, 30 mA source / 20 mA sink, inputs draw nothing |
| **ULN2003A** | CHIPS ▸ Interface, DIP-16, no supply pin | seven switches, output to E while the input is HIGH | seven Darlingtons fitted to TI's VCE(sat) (0.9/1.0/1.2 V at 100/200/350 mA, within 3 %), 2.7 kΩ inputs, clamp diodes to COM, 500 mA warning |
| **4N35**, **PC817** | CHIPS ▸ Interface, DIP-6 / DIP-4, no supply pin | C–E joined while A is HIGH and K LOW | an IR LED (fitted to both sheets' VF) and a phototransistor carrying CTR × IF, CTR 50–600 % in Properties (Spice Lite only); 60 mA LED / 50 mA output warnings |
| **LM7805/7809/7812/7815, LM317** | COMPONENTS ▸ Regulators, TO-220 | OUT is a supply while IN ≥ Vout + dropout; chained; LM317 Vout read off R1/R2 | holds OUT; dropout (2 V / 1.7 V), 1.5 A limit, quiescent current; warnings for dropout, current limit, > 1 W hot; > 2 W thermal shutdown cycling (1 s cool) |
| **Relay** (SPDT, 5 V / 12 V coil) | COMPONENTS ▸ Relays, five legs COIL+ · COIL− · COM · NO · NC | COM–NO while one coil leg is HIGH and the other LOW, COM–NC otherwise | the coil is an inductor (0.14 H / 70 Ω, 0.8 H / 400 Ω); contacts follow the coil's CURRENT: pull-in 75 %, drop-out 10 %; 0.1 Ω contacts, 10 A warning; kicks without a diode |
| **Electronic load** | COMPONENTS ▸ Power, a desk brick (`load1`) | inert | CC (sinks its set current, UNREG when it can't) or CR; never sources; V · A · W readout on the brick; 25 W warning |

Everywhere else: Properties fields, pin-assignment windows (generic), 2D drawings
(TO-220, the blue relay cube with its lamp, the load brick), 3D models, schematic
symbols (the load a sink box; the rest generic boxes), KiCad (TO-220 footprints for the
regulators, a 5-pin header for the relay — generic, flagged; the load LEFT OUT with a
report line), Digital export (each left out with its reason), BOM (as parts; the load left
out, an instrument), designators (K for the relay, J for the load), i18n in all seven languages, AI
builder exclusion, datasheet sources (TI LM358, ULN2003A, LM317, LM340 for the
7805/7812/7815; Vishay 4N35; Sharp PC817 — each opened and checked), the user guide
(components, chip library, power & clocks, Spice Lite), and hand-built example desks for
the LM358 (comparator, ×2 amplifier), ULN2003A (relay driver), 4N35 and PC817
(isolated 12 V switch), LM7805 (9 V → 5 V; under load), LM317 (3.3 V), the relay (with and
without a flyback diode) and the load (a 500 mA supply under load).

### Found already present, skipped

- **§2 Darlington grade** — `npn`/`pnp` already have a Darlington grade (TIP120/TIP125).

### Dropped (before building, by agreement)

- **LM741** and the **79xx** negative regulators: the desk has no negative rail (every
  PSU's − is ground), so a split supply cannot be built.

### Open questions decided

1. **Tray placement** — the op-amp under **CHIPS ▸ Op-amps** (shelved beside Timer);
   the regulators under **COMPONENTS ▸ Regulators**, not CHIPS: they are three-lead TO-220s
   that seat and draw like a TO-220 transistor, not DIPs.
2. **79xx** — left out (see above).
3. **Relay coil voltages** — both, 5 V (default) and 12 V, as a Properties choice.

### Decided along the way (differences from the request)

- **Relay pull-in is by coil CURRENT, not voltage** (75 % / 10 % of the rated current):
  with an inductive coil the voltage jumps at once while the current builds, and with a
  flyback diode the voltage collapses while the current carries on — by voltage the relay
  would release at once with a diode fitted, and without one it read the kick as being
  energised. The operate time is the coil's own (about 3 ms to 75 %), not a separate 10 ms.
- **No coil-resistance or contact-rating fields**: the coil voltage sets both.
- **The load's value is two fields** (Current in CC, Resistance in CR, the other greyed)
  rather than one whose unit follows the mode: the Properties dialog does not redraw a
  combo box when another field changes.
- **ULN2003A** "total package dissipation" is not enforced — each output's 500 mA is.
- **LM317's computed Vout is not printed under the part**; the regulator's hover shows what
  it delivers under Spice Lite, and the logic engine uses the computed Vout.
- **Regulator heat** is shown in its hover and its warnings, not with the smoke visuals.
- **Golden ngspice cases** were not added: these models are DC algebra the solve meets
  exactly, a `same` deck would only re-check the solver, and ngspice has no vendor-neutral
  `device` models for them without importing vendor macro-models.
- **LM7809** has no datasheet download (TI makes none; ST and onsemi refuse a program).

### Solver fixes the parts forced (Spice Lite)

- A Newton solve that cannot gain now falls back to a Gauss–Seidel sweep, and sweeps once
  more if it ends unbalanced: the ULN2003A stayed ON with its input at 0 V (a Darlington's
  coupled step mispredicts the collector by amps). The same fix took a relay's inductive
  kick through a Darlington from 69 s to under 0.1 s, and through a 2N3904 from 0.65 s to
  3 ms.
- `solveRising` (the transistor model's inner solves) is Brent's method.
- The stuck-corner run-on recognises a group sliding among recent pieces, is capped at the
  slowest time constant, and never carries a coil's current through zero.
- A coil's cluster balances to 1e-14 A, and a coil that turned round is re-linearized the
  way it goes.

### Known limits

- Under Spice Lite a regulated rail with no logic input on it shows its digital level
  (often LOW) in the probe's tint, though its voltage is right.
- The ULN2003A's channels and the LM358 run differently in the two engines by design, so
  their examples (and the regulators' and the relay's) are exempt from engine parity, each
  with its reason.
