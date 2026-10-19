# Veroboard

A **veroboard** (stripboard) is the board a circuit moves to once it works: a
sheet of holes on the 0.1 in (2.54 mm) pitch with **copper strips** running
underneath. Every hole on a strip is joined to every other — until you
**cut** the strip. Chip Hippo models it the way you build on one: place the
board, seat the parts across the strips, cut the copper where two things
must not meet, and add wire links where they must.

## Placing a veroboard

Open **BOARDS ▸ Veroboard** in the parts tray. The sizes are listed by their
millimetres (and inches, where a supplier quotes them), in three groups:

| Group | Sizes (mm) |
| --- | --- |
| Compact / pedal | 92 × 54, 93 × 55, 25 × 64 |
| Medium | 65 × 144, 122 × 102, 121 × 102, 70 × 90, 100 × 150 |
| Large / Eurocard | 100 × 160, 38.1 × 214.6, 304.8 × 431.8 (a 12 × 17 in sheet) |

**Custom size…** asks for any width and height from 10 to 500 mm.

Click a size and move the ghost onto the desk. **The copper strips always run
down the desk** (top to bottom); press **`R`** while the ghost is in hand to
turn the board a quarter — 92 × 54 becomes 54 × 92, with short strips or long
ones as you need. A placed veroboard does not turn.

The number of holes comes from the size: as many as fit on the 2.54 mm pitch
inside a 1.27 mm edge, centred, so a 92 × 54 board is 36 strips of 21 holes.
Where a maker states the layout — the 65 × 144 board is sold as 24 strips of
56 holes — that is used instead. A veroboard does not dovetail onto anything:
two side by side are two boards.

## Holes and strips

Strips are lettered **A, B, C …** from the left (after **Z** come **AA, AB**
…) and holes are numbered **1, 2, 3 …** from the top, so `C14` is hole 14 of
strip C. The letters and numbers are printed along the board's edges where
there is room, and the hover readout names every hole.

## Seating parts

Parts seat on a veroboard as they do on a breadboard, except that there is no
channel down the middle:

- A **chip** sits with every pin on a strip of its own. Pin 1 and the pin
  opposite it (pin 14 on a DIP-14) are on the SAME strip — exactly as on a
  real board — so **cut that strip between the two rows** for every pin pair
  you need apart. A wide (600-mil) chip stands six holes across, a narrow one
  three.
- A **resistor**, **LED**, **diode** and the other two-legged parts lie across
  the strips, one leg per strip, or stand up to any hole when turned.
- A **wire** lands in any hole: a link to join two strips, or across a cut to
  bridge it.

Strips joined by nothing but copper are one net — the probe, the schematic,
the build guide and both simulation engines all read the same copper.

## Cutting tracks

Press **`K`**, or click the **Cut track** button in the toolbar (the cutter,
beside **Bus**), to arm the **Cut Track** tool. The button is shown only while
the desktop holds a veroboard. Then:

- **Click a hole** to cut the strip there. The cutter drills the copper away
  round that hole, as a spot-face cutter does, so the hole is isolated and the
  strip above and below it become two separate runs. The copper drawn
  through the board shows the gap.
- **Click a cut** to put the copper back. With the tool armed, the ring over a
  cut hole is dashed to show that a click there restores it.
- A hole under a chip can be cut — that is where most cuts go.
- **`Escape`** or **`M`** puts the tool away; arming another tool does too.

Every cut and every restore is one step for **Undo** and **Redo**. Cuts are
saved with the project, copied with a board, and listed in the
[Build Guide](build-guide.md) as a step straight after the board is placed —
before anything is seated over them.

The tool is put away while the circuit runs: a cut changes the circuit, so it
is made with the simulation stopped, like any other edit.

## Looking underneath

In the [3D View](3d-view.md), orbit the camera down past the edge of the desk
to see the board from below: the copper strips, a real gap in the copper at
every cut, and the solder where a part's leg or a wire goes through.

## What it does not do (yet)

- The pitch is 2.54 mm only: every part's legs are drawn on it.
- A cut is made at a hole; a cut between two holes with a knife is not modelled.
- Moving a part on a veroboard does not carry its wires with it the way it
  does on a breadboard: a strip is too long to tell which wires belong to it.
- The AI circuit builder and the example circuits build on breadboards only.

## See also

- [The Desk & Breadboards](the-desk.md)
- [Wiring, Nets & Buses](wiring.md)
- [3D View](3d-view.md)
