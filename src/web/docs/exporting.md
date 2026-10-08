# Exporting to Other Tools

A design that works on the desk is often only the beginning. You might want to
turn it into a real circuit board, or keep simulating it somewhere else.
**Desktop ▸ Export To** writes the desktop on screen in another program's
format. You can also right-click any desktop's tab and choose **Export To** to
export that desktop. There are two formats, one for each of those jobs:

- **KiCad Project…** writes a project for [KiCad](https://www.kicad.org), the
  free schematic and circuit-board program. Use it to go from breadboard to PCB.
- **Digital Circuit…** writes a circuit for
  [Digital](https://github.com/hneemann/Digital), a free logic simulator with
  its own 74xx library. Use it to keep simulating the design with the same
  chips.

Exporting only reads the desktop, so you can do it while the circuit is
running. It never changes your design, and the exported files keep no link to
it. Export again whenever the design changes.

## The export report

Some things on a breadboard have no exact equivalent in the other program. If
anything won't come across as it is, Chip Hippo tells you before writing a
single file:

- **Won't come across**: parts the other program has nothing for. Everything
  wired to them is still exported, and their nets keep their names.
- **Changes**: parts that are exported as something that behaves a little
  differently. For example, a push button becomes a toggle switch in Digital.
- **Footprints to check**: KiCad parts that got a stand-in footprint (see
  below). Choose the real one before laying out a board.

Parts are listed by the same names the exported file uses (`U7`, `R1–R3`).
Choose **Export…** to go ahead, or **Cancel** to write nothing. If nothing
changes in the export, the report is skipped and you go straight to choosing
where to save.

## Part names and net names

A schematic names every part with a letter and a number, so the export gives
each part one:

| Prefix | Parts |
|---|---|
| `U` | Chips |
| `R`, `RN` | Resistors, resistor networks |
| `D` | LEDs, diodes and Zener diodes |
| `L` | Inductors |
| `Q` | Transistors |
| `SW` | Switches, push buttons, DIP switch banks |
| `DS` | 7-segment digits, bar graphs, character LCDs |
| `X` | Oscillator cans |
| `J` | The power supply and clock source, which become connectors |

Parts are numbered in the order you placed them, so the same desktop always
exports with the same names. To choose a part's name yourself, set its **Name**
to a designator of the right kind (`U5`, `R12`) in **Properties…**, and the
export keeps it.

Nets are named the same way in both formats:

- a net you named yourself keeps its name (see
  [Probing & Net Names](probing.md));
- a wire in a bus is named after the bus and its bit, so bus `D[7:0]` gives
  `D0`…`D7`;
- the supply rails are `+5V` (or `+3V`, `+12V`) and `GND`;
- every other net is numbered `N1`, `N2`, … in reading order.

Characters the other programs can't use in a net name become `_`. A name
marked active-low with a leading `/`, `~` or `!` gets an `n` prefix instead,
so `/CLR` exports as `nCLR`.

## KiCad

**Export To ▸ KiCad Project…** asks for a **folder**, not a file name. A KiCad
project is several files that belong together, so choose (or create) a folder
for it. Chip Hippo writes four files there, named after the desktop:

- `<desktop>.kicad_pro`, the project itself. Open this one in KiCad.
- `<desktop>.kicad_sch`, the schematic.
- `chiphippo.kicad_sym`, the symbols for the parts on it.
- `sym-lib-table`, which tells KiCad where those symbols are, so the project
  opens anywhere without any setup.

The files are written in KiCad 8's format, so KiCad 8 and every later version
can open them.

### What the schematic looks like

Parts are laid out in the same arrangement as the
[Schematic View](schematic-view.md), including any symbols you moved there.
Each chip is **one** symbol with every pin in its physical numbering, the way
it sits on the breadboard. (KiCad's own library draws a 74xx chip as a set of
separate gates.) Inputs are on the left, outputs on the right, and power on
the top and bottom.

Pins are connected by **net labels** rather than drawn wires: each connected
pin has a short stub ending in its net's name, and KiCad joins every label with
the same name. The supply rails use power symbols, with one `PWR_FLAG` per rail
so KiCad's electrical rules check knows they are supplied. A pin that isn't
connected to anything gets a no-connect flag. The sheet passes KiCad's
electrical rules check with nothing to report.

### From schematic to circuit board

Every part is given a **footprint** from KiCad's standard libraries:

- Chips get `Package_DIP` footprints at their real width: 300 mil for logic,
  600 mil for the wide memory chips and processors.
- Resistors, LEDs, switches, DIP switch banks, resistor networks, oscillator
  cans and the 16×2 LCD each get their matching standard footprint.
- Capacitors come across **with their value** (`100nF`, `4.7uF`) as their
  KiCad Value, drawn the way KiCad draws them — the plain capacitor for a
  ceramic, the polarised one for an electrolytic, whose `+` is pin 1 — on a
  5 mm ceramic disc or a 5 mm radial electrolytic footprint. Resistors carry their value the
  same way (`4.7k`). Every value keeps the figures the part's **Properties…**
  card shows, written in plain ASCII — `u` for µ, and no `Ω` — as SPICE and
  BOM tools expect. On the breadboard a capacitor connects nothing; in KiCad it is
  wired where it sits, which is the point of exporting it.
- Diodes, inductors and transistors come across as KiCad's own shapes — the
  diode, the Zener (its bar bent), the inductor's coil, and the NPN, PNP and
  N- and P-channel MOSFET symbols. A diode or a transistor's **Value** is its
  part number (`1N4148`, `2N2222`), or the plain type (`D`, `NPN`) until it has
  one; a Zener adds its voltage (`1N4733A 5.1V`); an inductor's is its
  inductance (`10uH`). Any part number also rides along as an **MPN** field
  for KiCad's BOM tools. Diodes get a DO-35 footprint on 7.62 mm, its pad 1
  the cathode.
- An inductor's footprint is the part its **Style** says, on the pitch its
  **Holes between leads** says: a **Coil** is a standing toroid, on exactly
  7.62 or 10.16 mm; a **Can** is a radial drum, and KiCad's round radial
  inductors are on metric pitches, so it gets the nearest (7.00 or 10.00 mm)
  and the report lists it under **footprints to check**.
- Transistors get a **TO-92** footprint on 2.54 mm — or, for a MOSFET whose
  **Package** is TO-220, a standing **TO-220** — its pads numbered in the
  order the desk prints the pins (`E B C`, `S G D`). That is no one maker's
  pinout, so the report lists every transistor under **footprints to check**:
  make sure the pads match the real part's datasheet before laying out.
- The power supply and the clock source become pin headers labelled
  **POWER** (two pins) and **CLOCK IN** (three: the clock, its supply and its
  ground). That's where power and a clock come in on a real
  board. The clock needs an oscillator in its place, which the report points
  out.
- The 7-segment digits, the 8-segment bar graph, the 20×4 LCD and the latching
  push button get a **stand-in footprint** (a pin header or a tactile button
  of the right size). Chip Hippo's versions of these are idealized parts, with
  no single real part to match. Choose the real part's footprint before laying
  out the board.

With the project open in KiCad, **Tools ▸ Update PCB from Schematic** in the
PCB editor brings every footprint onto the board, connected.

### Exporting again

To update an exported project after changing the design, export into the
**same folder**. Chip Hippo rewrites the schematic and its symbol library, but
leaves your `.kicad_pro` and any board you've laid out alone. Every part keeps
the same identity from one export to the next, so **Update PCB from
Schematic** only adds, removes and rewires what actually changed, and the
parts you've already placed stay put.

Chip Hippo never overwrites a schematic that some other program wrote. If the
folder already holds a `.kicad_sch` of that name from somewhere else, the
export stops and changes nothing. Choose an empty folder instead.

### What isn't exported

Breadboards and jumper wires don't appear as parts: they become the
connections between the parts. External signals and Arduino Output and Input
elements are stimulus for the bench, not parts, so they are left out (the
report lists them). Notes and labels are left out too.

## Digital

**Export To ▸ Digital Circuit…** writes one `.dig` file. Open it in Digital
with **File ▸ Open**.

The chips are **Digital's own**: its library models most of the 74xx family as
DIL packages, pinned exactly like the real parts. It has no CD4000 folder, but
six CD4000 parts have a pin-for-pin twin there, and the export uses it:

| Chip Hippo part | Placed in Digital as |
|---|---|
| CD4002B dual 4-input NOR | 744002 |
| CD4017B decade counter | 744017 |
| CD4069UB hex inverter | 7404 |
| CD4075B triple 3-input OR | 744075 |
| CD4077B quad XNOR | 747266 |
| CD40106B Schmitt hex inverter | 7414 |

Chip Hippo places each chip
and connects its pins through **tunnels** named after their nets, which Digital
joins the way KiCad joins labels. Switches, LEDs, bar graphs, 7-segment
digits, clock sources, oscillator cans and the power supply each become the
matching Digital element. The switches start in the position they're in on the
desk. External signals become Digital buttons (momentary) or inputs (toggle),
labelled with their names.

These exports have been run in Digital itself and checked against Chip Hippo's
own simulation. For the example circuits, every chip output and every lamp
reads the same in both, at a range of switch settings.

### What changes

Digital is a logic simulator, so some parts have to be exported as what they
**mean** rather than what they are:

- **Resistors** are exported as what they do in the logic. A resistor to a
  supply rail becomes a pull-up or pull-down on the net at its other end, which
  is what a lamp's current-limiting resistor and a switch's pull-down amount
  to. A resistor between two signals becomes a plain wire (the report lists
  it). A resistor from rail to rail does nothing in logic and is left out.
- **Floating inputs**: an unconnected TTL input reads HIGH. Digital treats an
  undriven input as an error, so the export adds the pull-up that makes it
  HIGH in Digital too. It doesn't add one where a resistor already sets the
  level. An unconnected **CMOS** input gets the same pull-up, but there it
  changes the answer: Chip Hippo reads a floating CMOS input as unknown, and
  Digital has no unknown to give it. The report names each CD4000 chip this
  happens to.
- **Open-collector chips** (74LS01, 74LS03, 74LS05) get a pull-up on each
  output. Chip Hippo simulates their outputs driving both ways, but Digital
  simulates them as the real parts, which only pull low. The pull-up makes the
  two behave the same, as it would on a real board.
- **Push buttons** become toggle switches, because Digital has no momentary
  switch contact.
- **Unpowered chips** are powered, because Digital can't simulate a chip with
  its supply pins unconnected.

### What doesn't come across

- Seven 74xx parts that Digital's library doesn't include: 74LS73, 74LS75,
  74LS169, 74LS240, 74LS259, 74LS279 and 74LS533. Each one's place in the
  circuit is marked with a note, and everything wired to it is still exported.
- The other 37 CD4000 CMOS parts, which have no twin in Digital's library. The
  same note marks each one's place.
- The 555 timer, which Digital's library doesn't have either.
- Capacitors. A capacitor connects nothing in Chip Hippo, so leaving it out
  changes nothing about the circuit.
- Diodes and transistors: Digital has none that pass a level one way, or
  switch, the way Chip Hippo's do.
- Inductors. An inductor is a wire in Chip Hippo, so the two nets it joins
  come across **apart** — the report says so; join them in Digital if you
  need them joined.
- Memory chips, because their contents are stored in files the export doesn't
  carry.
- The processors and their peripheral chips (W65C02, Z80, W65C21, W65C22).
- The character LCD modules.
- Arduino Output and Input elements.

Digital needs its own library to find the chips. It comes in the `lib` folder
of the Digital download, which has to stay beside `Digital.jar`. If a chip
shows up as missing, check that folder and Digital's library settings.
