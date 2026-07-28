# Files, Saving & Undo

Chip Hippo keeps your work in **one ordinary file** you can see, move, and
share. This page covers what's in it, the four commands that manage it, the
dirty marker, and undo/redo.

## One file is the whole design

The desk in front of you is always a **desktop of an open project**, from the
very first launch. A brand-new project has no name, no home of its own, and
exactly one desktop called `Desktop 1` — which is simply a desk to build on.
See [Projects & Desktops](projects-and-desktops.md) for keeping several
desktops side by side.

**The project is the document.** A single `.chiphippo` file holds all of it:

- every desktop — its boards, chips, wiring, parts, and net names;
- what those desktops are called, and which one you were on;
- the contents of every ROM you programmed.

Nothing else is needed to open a design. Copy that one file to another machine
and it opens whole, ROM contents included — which is what makes a Chip Hippo
design something you can actually send to someone.

## Before you choose where it goes

Chip Hippo never stops you mid-thought to ask for a file name. A project that
hasn't been given a home lives in a **working slot** inside the app's own data
directory, and `Cmd/Ctrl+S` writes it there with no dialog at all. Design
something, save, quit — it's there when you come back.

**Save As…** is what gives the project a real file, when you want one. From
then on Save just writes that file. When you launch, Chip Hippo opens the
unsaved project from its working slot if there is one; otherwise it reopens the
**project you used most recently**.

## New, Open, Save, Save As

Four commands — on the **File** menu, in the header toolbar's File pill, and
under the usual shortcuts — manage the project's file:

- **New Project** (`Cmd/Ctrl+N`) — a fresh unnamed project with one empty
  desktop. What's open now is asked about first.
- **Open…** (`Cmd/Ctrl+O`) — shows a native file picker. A `.chiphippo` project
  opens as itself; a loose design or an exported desktop opens as a new project
  of one desktop.
- **Save** (`Cmd/Ctrl+S`) — writes the project to its file, or to the working
  slot when it hasn't got one yet. No dialog either way.
- **Save As…** (`Shift+Cmd/Ctrl+S`) — asks where to keep it and writes it
  there. An unnamed project takes its **name from the file you pick**, so
  there's no separate naming step.

If the file you pick already exists, your system's own save dialog asks whether
to replace it, exactly as it does in any other app — Chip Hippo adds no second
question of its own. Decline there and nothing is written.

**File ▸ Project Properties…** shows the project's Location alongside its Name
and Description, without opening any dialog that writes.

## Unsaved changes

The window title shows a • when the project has changes that aren't in its file
yet: `• 6502 SBC — Clock module — Chip Hippo`. Save clears it. There is one
marker because there is one document — it covers every desktop's design *and*
the desktops themselves, so adding one, renaming one, or deleting one shows up
there exactly as wiring a board does.

**Nothing is written until you save.** Add a desktop, rename it, delete another
— none of it touches the disk, and closing the project without saving takes all
of it back. Tabs carry no marker of their own for the same reason: a desktop
can't be saved on its own, so a dot on one would have nothing to clear it.

Nothing that would lose your changes happens silently. Starting or opening
another project asks first, and so does quitting. Both offer to **save** — and
choosing that carries the action through, so you are never made to ask twice.

A project still in the **working slot** is asked about every time, even when
nothing is unsaved: the incoming project is about to claim that slot, so
there's nowhere for this one to stay. **Save** there means Save As — a file of
its own.

When the save is the app's idea rather than yours — quitting with a • in the
title — nothing is asked about *where*: the project goes to the file it already
has, or to the working slot, where the next launch will find it.

Two things that are deliberately **not** counted as changes: which desktop is on
the desk, and where the camera is. Moving between tabs and panning around never
mark a design dirty.

## Undo & redo

`Cmd/Ctrl+Z` undoes the last edit; `Shift+Cmd/Ctrl+Z` redoes it. Undo/redo
covers the full editing history of the circuit — placing and moving boards,
chips, and discretes; wiring and unwiring; deleting anything; net names — as
far back as your session's history allows, and both menu items disable
themselves automatically when there's nothing left to undo or redo.

Undo/redo is **per desktop**: switch away and back, and `Cmd/Ctrl+Z` still
undoes that desk's last edit, not the other one's. Adding, deleting, renaming
and importing a desktop are not on any undo stack — they're changes to the
project's own structure, and what takes them back is closing the project
without saving.

Undo/redo does **not** cover simulation state. While the circuit is running,
editing — and with it, recording new undo steps — is locked, so nothing that
happens mid-run (sequential chip state, clock phase, a chip taking 12 V
damage) ever becomes an undo step of its own. Sequential state and clock
phase vanish outright the next time you press **Run**. 12 V damage is the one
exception that outlives the run: it's written into the document, so stopping
— or even quitting and reopening — doesn't clear it, and there's no `Cmd+Z`
back to before it happened. The only way to clear a damaged chip is to delete
it and place a fresh one (see [Power & Clock Sources](power-and-clocks.md))
— which, taken while stopped, is a normal edit and undoes/redoes like any
other. What undo/redo restores is always the circuit you built, never a
moment in its simulated behavior.

## Example circuits

Chip Hippo's project repository ships a handful of ready-to-load example
circuits as ordinary `.chiphippo` files — currently small W65C02-based
breadboard computers built from 74xx glue logic, each paired with a `.hex`
ROM image. Open one the same way as any saved design: **File ▸ Open…** loads
it as a project of its own. Then load its matching `.hex` into the ROM chip
via the memory inspector or the external programmer before pressing **Run**.

---

See [Getting Started](getting-started.md) for building your first circuit
from scratch, and [Settings](settings.md) for what else persists between
sessions.
