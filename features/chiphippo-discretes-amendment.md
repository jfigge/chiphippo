# Amendment to chiphippo-discretes.md: Panel Layout and Markers

This is an **amendment** to the discrete-components spec (`chiphippo-discretes.md`) you were just given. It changes only two things: how these parts are arranged in the parts panel, and how their folders are marked.

**All behaviour in the original spec stays exactly as written:**
- the inductor conducts like a wire
- the diode is a one-way connection
- the transistors are switches, using the MOSFET-holds / BJT-off rule
- board validation
- the KiCad export
- testing

This amendment also resolves both open questions at the end of the original spec.

## 1. No group folder

**Drop the DISCRETES group entirely.** Don't create an umbrella folder for these parts.

## 2. Each component type gets its own folder

Under **COMPONENTS**, add these as flat folders, alongside the existing SWITCHES, RESISTORS, LEDS, DISPLAYS, OSCILLATORS and POWER:

- **CAPACITORS**: the existing folder, with the existing ceramic and electrolytic parts. Don't move them.
- **INDUCTORS**: the inductor.
- **DIODES**: the standard diode and the Zener diode.
- **TRANSISTORS**: four separate entries for NPN, PNP, N-channel MOSFET and P-channel MOSFET, the same way RESISTORS holds the resistor, the resistor array and the potentiometer.

Follow the panel's existing conventions for folder entries and ordering.

## 3. Markers on these four folders

Next to the names of CAPACITORS, INDUCTORS, DIODES and TRANSISTORS, show two markers:

- a **red asterisk**
- a **red information icon**: the existing circle-with-an-eye icon used elsewhere in the app, coloured red. Reuse the existing icon component and change only its colour.

### Hover pop-up

Hovering over the red information icon shows a pop-up with exactly this text:

> These components have limited functionality but exist for the purpose of export and design completeness.

Use the app's existing tooltip/pop-up pattern.

### Colour

Using red alone to carry meaning is an accessibility concern. Jason knows this and has chosen to keep it. **Implement it as specified. Don't add a non-colour cue or change the colour.**

## 4. Interaction with existing notes

The capacitor's drag-time note from the capacitor/555 feature stays as it is. Don't add drag-time notes for the new parts; the folder markers do that job.

## Deliverables

Report:

1. Where each folder ended up in the panel.
2. That the asterisk, the red information icon and the hover pop-up appear correctly on all four folders.
3. Anything you had to change from this amendment, with the reason.
