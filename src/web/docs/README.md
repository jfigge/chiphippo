# Chip Hippo User Guide

Chip Hippo is a desktop app for designing and simulating **74xx TTL logic
circuits** on virtual solderless breadboards. Place a breadboard on the
infinite desk, populate it with 74xx DIP chips, wires, switches, LEDs, and
power sources, then press **Run** — a simulation engine traces electricity
from every power source, resolves each electrical net, and ripples changes
through the circuit exactly like a real breadboard would.

![The Chip Hippo desk](images/overview.png)

## What you can build

Anything a 74xx TTL breadboard bench can hold: combinational logic (gates,
decoders, multiplexers), sequential logic (flip-flops, counters, shift
registers), a free-running or manually stepped clock, and small memory
circuits backed by ROM/RAM chips — all wired across Full/Half/Tiny
breadboards, powered at 3 V / 5 V / 12 V, and watched settle live. Beyond
the 74xx shelf there is a **PROCESSOR group** — a W65C02 and a Zilog Z80A,
each a full instruction-set simulation — and an **Interface group** of 65xx
peripherals (a PIA and a VIA), for building a small single-board computer out
of the same glue logic.

## Highlights

- **Breadboard-accurate placement** — chips, wires, and discretes snap to the
  real 0.1 in hole grid, with the same row-half/trench/rail tie-point rules
  as a physical board.
- **Live simulation** — Run the circuit and watch LEDs light, chip health
  badges report power/damage state, and switches drive the circuit live.
- **Deep inspection tools** — a connectivity **probe**, **net names/labels**,
  and a **logic analyzer** for capturing waveforms.
- **Memory chips with a hex inspector** — file-backed ROM/EEPROM images you
  program with an in-app programmer, plus a live hex/ASCII viewer.
- **A derived schematic view** — press `Tab` to flip between the physical
  breadboard and a logical diagram of chip symbols, routed named nets, and
  bus lines, kept in sync with the desk.
- **Build guide & BOM export** — including a numbered cutting list of every
  jumper — and **undo/redo** across every edit, per desktop of the open
  project.
- **Seven languages** — English, German, Spanish, French, Italian, Japanese
  and Chinese, chosen in Settings ▸ Appearance (this guide is English only).
- **An AI circuit builder** — describe a circuit in words, using your own AI
  connection, and get a wired design that has already been built and run
  before you're offered it.

## Table of contents

### Getting started

- [Getting Started](getting-started.md) — install the app, place your first
  board and chip, and run your first circuit.

### Building a circuit

- [The Desk & Breadboards](the-desk.md) — pan/zoom, breadboard kits, strips
  and rails, snapping and grouping.
- [Chips & Components](components.md) — the parts palette, DIP chips,
  discretes, placement and rotation.
- [Wiring, Nets & Buses](wiring.md) — the wire tool, colors, cross-board
  wires, and multi-bit buses.
- [Power & Clock Sources](power-and-clocks.md) — PSU bricks, voltage and the
  12 V damage rule, and clock sources.
- [The Chip Library](chip-library.md) — the catalog: 74xx logic, memory, the
  65xx interface parts and the CPUs, and the pin-assignments/datasheet window.

### Simulating & inspecting

- [Running a Simulation](simulation.md) — Run/Stop/Pause/Step, the settle
  model, and live views.
- [Probing & Net Names](probing.md) — the connectivity probe and naming nets.
- [Memory Chips & the Inspector](memory.md) — ROM/RAM, the programmer, and
  the hex/ASCII inspector.
- [Logic Analyzer & Timing](logic-analyzer.md) — capturing and reading
  waveforms.
- [Schematic View](schematic-view.md) — the derived logical diagram.
- [AI Circuit Builder](ai-builder.md) — describe a circuit in words and get a
  simulation-proven design, using your own AI connection.

### Files & reference

- [Build Guide & BOM](build-guide.md) — deriving a bill of materials, a
  jumper cutting list, and an ordered assembly checklist.
- [Files, Saving & Undo](files-and-undo.md) — where a desktop and a project
  are kept, saving them, and undo/redo.
- [Projects & Desktops](projects-and-desktops.md) — tabbed desktops, saving a
  project, and copying a design from one desktop onto another.
- [Settings](settings.md) — the settings dialog and its options.
- [Keyboard Shortcuts](keyboard-shortcuts.md) — every shortcut in one place.
