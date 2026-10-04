# ChipHippo Feature: Discrete Components (Diodes, Inductors, Transistors)

## Summary

This feature adds a new group of discrete components to the parts panel: diodes, inductors, BJTs and MOSFETs.

These parts have one thing in common. Each does as much as a digital simulator can honestly represent, and each exports correctly to KiCad. Some act on the circuit and some only carry a value for export:

| Part | In the simulator |
|---|---|
| Capacitor | Non-connect. Timing chips can trace through it. *(Already implemented.)* |
| Inductor | Conducts like a wire. |
| Diode | One-way. Conducts forward, blocks reverse. |
| Transistor | Switch. The control pin opens or closes the path between the other two pins. |

ChipHippo stays a digital, event-driven simulator. **Do not add analog modelling**: no forward-voltage drops, gain, saturation curves, gate thresholds or Zener breakdown.

## Before you start

- Study how the existing components, the capacitor and resistor value fields, the properties dialogue, the parts panel and the KiCad export are implemented. Follow the same patterns.
- If the bidirectional-switch approach used for the CD4066B / CD405x analog switches is in place, reuse it for the transistors. Don't build a second mechanism.
- Keep ChipHippo's teaching philosophy: wrong wiring should misbehave visibly and realistically, never silently.

## 1. The group

Add a new folder under **COMPONENTS** named **DISCRETES** *(placeholder name; Jason may change it)*. It holds:

- Diodes
- Inductors
- Transistors (NPN, PNP, N-channel MOSFET, P-channel MOSFET)
- Capacitors. Move the existing CAPACITORS parts into this group, unless Jason says to leave them where they are.

Inside DISCRETES, use subfolders the way the rest of COMPONENTS does (for example DIODES, INDUCTORS, TRANSISTORS, CAPACITORS). Follow whatever convention the panel already uses.

Every part in this group has an optional **Part number** field (for example `1N4148`, `1N4733A`, `2N2222`, `2N3906`, `2N7000`). It is shown on the part and carried into the KiCad export. It does not change how the part behaves.

## 2. Inductor

- Optional **Inductance** field, in henries. Accept the usual forms: `10µH`, `10uH`, `4.7u`, `4u7`, `100mH`, `1H`. Use the same parsing approach as the capacitance field.
- Blank is valid. The part places as a bare inductor.
- If the value doesn't parse, show a field-level error and keep the previous value.
- **Electrically it conducts like a wire.** It joins the nets on its two pins, exactly as a wire would. The inductance value has no effect in the simulator.
- Exports with the standard KiCad inductor symbol and its value.

## 3. Diodes

Two types:

- **Diode** (standard)
- **Zener diode**, with an optional **Zener voltage** field (for example `5.1V`, `5V1`, `3.3`). The voltage is export-only.

Electrical behaviour (both types):

- **One-way connect.** A logic level on the anode passes through to the cathode. Nothing passes from cathode to anode.
- A diode never pulls a net. With its anode low or undriven, it does not drive the cathode net. If that leaves the cathode floating, that net's normal floating rules apply.
- A Zener behaves exactly like a standard diode in the simulator. Don't model reverse breakdown.
- If the engine can't express a one-way connection, stop and propose an approach before implementing.

Draw the cathode band. Export a standard diode as KiCad's diode symbol and a Zener as the Zener symbol, with part number and voltage.

## 4. Transistors

Four parts, each a three-pin controlled switch. Use the correct pin names and symbols for each:

| Part | Control pin | Switched path | Turns on when control is |
|---|---|---|---|
| NPN BJT | Base (B) | Collector (C) to Emitter (E) | High |
| PNP BJT | Base (B) | Emitter (E) to Collector (C) | Low |
| N-channel MOSFET | Gate (G) | Drain (D) to Source (S) | High |
| P-channel MOSFET | Gate (G) | Source (S) to Drain (D) | Low |

Read the control pin as a plain logic level. Don't model threshold voltages, base current, gain or on-resistance. When the transistor is on, the switched path joins its two nets. When it's off, they are disconnected.

### Undriven and undefined control pins

The two kinds of transistor behave differently here, matching the real physics:

- **BJT: follows its base.** Off by default. Off whenever the base is undriven, floating or undefined. It has no memory.
- **MOSFET: holds its last state.** Off until the gate is first driven to a defined level. After that, if the gate becomes undriven, floating or undefined (for example, a floating CMOS output), the MOSFET **stays in its last defined state**. The gate stores charge, so the undefined state stops at the gate instead of spreading through the switched path.

This is a deliberate teaching point. Make sure the MOSFET's held state is visible to the user (for example in its hover or properties information), following existing patterns.

### Export

Use KiCad's generic NPN, PNP, N-MOSFET and P-MOSFET symbols, with the part number. Don't invent package-specific pin orders (EBC, CBE, GDS and so on). If the existing export needs footprints, report what you did instead of guessing.

## 5. Board validation

A pin connected only through a part in this group counts as connected, whether or not the part is conducting at that moment. A reversed diode or an off transistor is a valid board, not an unconnected pin.

## Testing

- Inductor: passes high and low both ways, joins nets, value parsing (valid, invalid, blank).
- Diode: anode high gives a high cathode. A reversed diode passes nothing. A diode never drives its cathode low. Two-diode OR / steering circuits behave correctly.
- Zener: identical simulator behaviour to a diode; voltage parsing; correct export symbol.
- NPN / N-MOSFET: on when the control is high, off when low.
- PNP / P-MOSFET: on when the control is low, off when high.
- BJT with a floating or undefined base: off.
- MOSFET: off before first drive. Drive the gate high, float it, and it stays on. Drive it low, float it, and it stays off.
- MOSFET gate driven by a floating CMOS output: holds its last state.
- An LED driven through an NPN and through an N-MOSFET from a 74LS output and from a CD4000 output.
- Board validation with reversed diodes and off transistors.
- KiCad export of every part in the group, with values and part numbers.
- Capacitors still work as before after moving into the group.

## Out of scope

Analog behaviour of any kind (diode drop, Zener regulation, transistor gain or saturation, inductive kickback); LEDs as part of this group; Schottky, photo or other specialist diodes; JFETs, IGBTs, Darlingtons; package-specific transistor pinouts.

## Deliverables

When you finish, report:

1. What was implemented, and anything skipped or changed, with reasons.
2. How the one-way diode connection and the transistor switch fit into the engine, and whether you reused the analog-switch mechanism.
3. Where the parts landed in the panel, and whether capacitors moved.
4. Any follow-ups or open questions.

## Open questions for Jason

1. Final name for the group (placeholder: DISCRETES).
2. Move capacitors into the group, or leave them in their own folder? Default: move them.
