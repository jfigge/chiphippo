# The Multimeter

The multimeter is a bench digital meter you put beside the board and touch
to the circuit with two probes. It is modelled on a real meter, the Brymen
BM235: the same dial, the same jacks, the same input resistance and fuses —
so it reads what a real one would, and goes wrong the way a real one does
when it is used wrongly. It reads under **Spice Lite** only (Settings ▸ Spice
Lite); with the logic engine the toolbar does not offer it and a meter already
on the desk stays dark.

The **Add Multimeter** button on the toolbar (beside the Analyzer) takes a
meter out onto the desk, at the right of the view, beside any already there.
You can have up to three; the button greys out at three. To put one away,
right-click it and choose **Put Away**. Taking one out and putting one away
are ordinary edits (**⌘Z** undoes them), and both work while the circuit
runs.
It is drawn at its real size — about as tall as a full breadboard is wide.

The meter is not part of the circuit: it lies ON the desk, over the boards
and everything on them. Drag it by its body anywhere — onto a board too,
and while the circuit runs. It is never selected or highlighted, and
whatever is under it cannot be reached until it is moved out of the way;
only its own probes and leads lie on top of it.

## The probes

Each probe trails a lead back to its jack: black from **COM**, red from
whichever jack its plug is in. Drag a probe by its body onto any hole —
an empty one, or one a chip's pin or a wire's end is already in (a probe
touches the lead there; it takes nothing). A probe snaps to the nearest
hole in reach, as a wire end does; dropped clear of every hole it lies on
the desk where you let it go, touching nothing. A probe can also rest on a
power supply's terminal.

A hole under a wide (600-mil) chip's body — the rows between its two rows
of pins — takes no probe: no tip reaches it there. And a probe is pushed out
of its hole by what is pressed into it: seat a wide chip over it, or push a
part's lead or a wire's end into the hole it is in, and the probe lies on
the desk where its tip was. (Put a probe on a hole a lead is already in and
it stays: it touches the lead.)

Probes, the dial and the buttons all work while the circuit runs — a meter
is used on a live circuit. Hold **Option/Alt** over a probe to reach the
lead in the hole under it. Moving a probe, turning the dial and moving the
plug are ordinary edits: **⌘Z** undoes them.

## The dial

Click a position's legend to turn the dial there. **SELECT** steps through
what that position offers:

| Position | SELECT | Measures |
|---|---|---|
| **AutoV LoZ** | — | DC or AC volts, whichever is larger, through a low 2.1 kΩ input |
| **OFF** | — | nothing |
| **V** | DC, AC | volts: 6 V, 60 V, 600 V and 1000 V ranges |
| **Ω** | ohms, continuity | resistance, 600 Ω to 60 MΩ; continuity beeps below 161 Ω |
| **mV** | DC, AC | millivolts: 60 mV and 600 mV |
| **→\|** | diode, capacitance | diode test: a junction's forward drop, up to 3 V; capacitance, 20 nF to 10 mF |
| **mA A** | DC, AC | current: 60 mA and 600 mA in the µA mA jack, 6 A and 10 A in the 10A jack |
| **µA** | DC, AC | current: 600 µA and 6000 µA, in the µA mA jack |

The display ranges itself (**AUTO**). **RANGE** holds the range it is on;
each press after that steps to the next; hold it for a second to go back to
auto-ranging. **OL** means the reading is past the range — or, on ohms, an
open circuit.

The buttons act when they are let go, and a button held for a second does
something else, as on the real meter:

| Button | Press | Hold a second |
|---|---|---|
| **SELECT** | the position's next function | the backlight on or off (it goes out by itself after 10 minutes) |
| **RANGE** | hold the range, then step it — in Hz, the trigger range | back to auto-ranging |
| **REC** | start recording; then show **MAX**, **MIN**, **AVG** and the present reading in turn | stop recording |
| **HOLD** | freeze the display, or let it go | **Δ** Relative Zero: show every reading less the one shown now; again to stop |
| **Hz** | the frequency of what the position measures, or back to it | — |

- **REC** keeps the largest, the smallest and the average of the readings
  the display has shown since it started, and beeps at each new MAX or MIN
  (with Sound on). The display still ranges itself.
- **Hz** works on V, mV and the current positions. It counts the signal's
  rising crossings through a trigger band about its average, so a logic
  signal reads whatever level it sits at; on V it triggers on the range the
  display was on, and RANGE steps the trigger range (6 V is the most
  sensitive, about 0.1 V RMS). Below 2 Hz it reads 0. A fast oscillator the
  simulation draws slowed (one past 1 kHz) reads its TRUE rate.
- REC, Relative Zero and Hz are not available on AutoV, and turning the dial
  ends them.

The display updates five times a second, and shows the AVERAGE over that
time, as a real meter does: a 50 % PWM on DC volts reads half its swing, and
an AC range reads the true RMS of the waveform. Once it has found a
signal's frequency, DC is averaged over whole periods of it, so a pure sine
reads 0.000 V DC.

## It is not an ideal meter

Whatever the dial selects is a real element between the probes, and the
circuit sees it:

- **Volts** puts 10 MΩ across what it measures. A divider of two 1 MΩ
  resistors off 5 V reads **2.381 V**, not 2.500 — exactly what a bench
  meter shows. A net nothing drives reads **0.000 V**: the meter's own
  10 MΩ ties it to the black probe. (A TTL input on that same floating net
  reads HIGH — the meter and the chip are asking different questions.)
- **AutoV** loads it with 2.1 kΩ, to drain the "ghost" voltages a high
  impedance meter shows. On a 10 kΩ divider that pulls the middle down to
  under a volt, and the display shows `----`.
- **Ohms, continuity, diode test and capacitance** push their own small
  test current through what they measure.
- **Current** ranges put a small resistance in series — 100 Ω on µA,
  1.9 Ω on mA, 0.04 Ω on 10A — and the circuit loses the voltage across it:
  on µA in series with 5 V and 1 kΩ the meter reads **4.545 mA**, not 5.000,
  and an LED behind it glows a little dimmer. A meter straight in a supply's
  lead is the same resistance in that lead: everything past it is fed
  through it, exactly as through a resistor of that value, and the rail
  past the meter runs short by the drop — on µA, a chip drawing a few
  milliamps runs a few tenths of a volt short — while the supply's own
  terminals, and anything wired straight to them, keep the full voltage.
  In the **−** lead the ground past the meter stands above the supply's by
  the drop instead, and the chips on it drive and read from that ground.
  A meter in each lead carries the one current, each dropping its own; one
  meter past another drops on top of it. A capacitor on the rail past the
  meter charges through it, so a big one is a current surge through the
  meter at Run. A chip the drop takes under its minimum supply but above
  its family's floor (74LS 4.5–4.75 V, CD4000 2.7–3 V) still works and
  switches, and is said to be running on its margin; below the floor it is
  underpowered — just as it would be fed through a resistor.

## Measuring current

A meter measures current by being IN the circuit: break the circuit, plug the
red lead into **µA mA** (or **10A** for more than 600 mA), turn the dial to
**µA** or **mA A**, and put the probes on the two sides of the break. The
meter closes the gap and reads what flows through it. Put both probes on one
connected net and it reads nothing — no current has any reason to go through
it.

On a current range the meter is very nearly a wire. Put it across a supply
and it shorts it: the **µA mA input's 0.4 A fuse blows** (F1), the display
reads nothing, and the circuit it was in is open. The 10A input has an 11 A
fuse (F2); a 1 A supply's current limit usually saves that one. A fuse heats
with the current through it, so an AC current past its rating blows it as
a DC one does — judged by its RMS: 0.41 A RMS blows F1, 0.399 A never does,
and the warning quotes the RMS current, not a peak. A blown fuse
is marked with the red (i) on the meter and a warning, and is replaced when
the circuit stops — like a part's smoke, it is a mistake on the bench, not
part of the design.

A red lead left in a current jack with the dial on anything else shows
**InEr** and beeps — the real meter's warning. The 10A jack's shunt is wired
to COM whatever the dial says, so "measuring volts" across a supply with the
lead still in 10A shorts it.

## When the circuit is stopped

Stopped, the bench is switched off: volts and current read nothing. Ohms,
continuity, the diode test and capacitance still read — the meter's test
source is the only thing driving the circuit, as on a real unpowered board.
And it drives it in time, from the moment the probes touch (or the desk last
changed where the probes reach — a supply put down, another meter or a part
on a strip it does not reach leaves the reading alone): across a capacitor
the ohms reading climbs as the test current
charges it, until it reads open; an LED on the diode test glows faintly,
lit by the meter's fraction of a milliamp.

On a live circuit these give false readings, as a real meter does — the
circuit's own voltages are added to the meter's test voltage. Measure
resistance and capacitance with the circuit stopped (running, capacitance
reads OL).

## Measuring capacitance

Turn the dial to **→|** and press **SELECT**: the display reads in nF, µF or
mF. The meter charges what is between its probes one way and then the
other, between two small voltages, and times the swing — so it shows
`----` for as long as that takes: a moment for nanofarads, a few seconds for
a thousand microfarads. A capacitor on its own reads its value exactly. A
resistor or another part across it changes the timing and so the reading,
as it does on a real meter — take one leg out to measure it. Past 10 mF it
reads OL.

## Look and size

**Properties ▸ Look** draws the meter as the orange **VoltHippo** — the app's
own — or as the **EEVBlog** edition of the BM235. It is the same meter whichever
look it wears. The look you pick is the one the next meter you take out wears
too.

**Properties ▸ Size** shows the meter **Full** — its dial, buttons and jacks —
or **Compact**: folded down to just its screen and the two jacks its leads are
in. Clicking the title at the top of the meter (its name, or the Volt
Hippo's logo) switches between the two as well. The screen stays where it is.
Folded, it has no dial or buttons, so the leads stay in the jacks they were
in — open it out to change them.

Where a meter lies and its size are not saved with the project: they are the
session's, so moving or folding one is no change to save. Open the project
again and each meter is laid out beside the circuit at full size, in its look,
its dial, leads and probes as you left them.

## Sound

The continuity beep, the InEr beep and REC's beeps are silent unless the
meter's **Properties ▸ Sound** is on; the display's backlight flashes for
continuity either way.

## In 3D

The 3D view shows the meter with its probes on the holes they touch and
their leads running round the meter to its jacks.

## What it does not do

The BM235's temperature, VFD, non-contact voltage and auto power-off are not
modelled. Its readings are exact: its accuracy figures are not added.
AutoV's input stays at 2.1 kΩ at every voltage (the real one rises above
50 V).

The meter is test equipment: it is left out of the schematic, the BOM, the
build steps and the AI builder, and the KiCad and Digital exports leave it out
— saying so when it was closing a gap on a current range, which the exported
circuit then has open.

## See also

- [Spice Lite](spice-lite.md) — the simulation the meter reads.
- [Probing & Net Names](probing.md) — the probe tool, which reads a net's
  voltage and the current through a lead without a meter.
- [Power & Clock Sources](power-and-clocks.md) — supplies and their current
  limits.
