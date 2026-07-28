# Files, Saving & Undo

Chip Hippo keeps your work in ordinary files you can see, move, and share —
one for each **desktop** you build on, and one for the **project** that lists
them. This page covers where those files live, the four commands that manage a
desktop's file, the dirty marker, and undo/redo.

## There is always a project

The desk in front of you is always a **desktop of an open project**, from the
very first launch. A brand-new project has no name, no home of its own, and
exactly one desktop called `Desktop 1` — which is simply a desk to build on.
See [Projects & Desktops](projects-and-desktops.md) for what a project is for
and how to keep several desktops side by side.

Two kinds of file follow from that:

- a **desktop file** (`.desktop.chiphippo`) — one complete desk: its boards,
  chips, wiring, and parts. It is an ordinary Chip Hippo design file, so it
  opens on any desktop, in any project.
- a **project file** (`.project.chiphippo`) — the small list of which desktops
  the project has, what they are called, and where each one's file is.

## Before you choose where things go

Chip Hippo never stops you mid-thought to ask for a file name. Until you save
something under a name of your own, it keeps the file for you in its own
**saves folder** inside the app's data directory:

- every new desktop gets a file there straight away, under a generated name
  you are not meant to read — its Location, but a temporary one;
- a project with no name lives in the one **default project file** there. It
  is the work in progress, and it is what Chip Hippo opens when you launch it.

Give either one a home of your own (**Save As** for a desktop, **Project ▸
Save Project** for a project) and the file left behind in the saves folder is
cleaned up — nothing but that one object ever pointed at it.

That folder is Chip Hippo's to tidy, so **anything of yours kept in it is
treated the same way**: a desktop whose file is in there — the generated one,
or one you saved into the folder yourself — has that file deleted when you
delete the desktop. Save a desktop anywhere else and the file is yours; Chip
Hippo will never remove it, even when the desktop is gone.

When you launch, Chip Hippo opens the unsaved project from its saves folder if
there is one; otherwise it reopens the **project you used most recently**.

## New, Open, Save, Save As

Four commands — on the **File** menu, in the header toolbar's File pill, and
under the usual shortcuts — manage the **active desktop's** file:

- **New Desktop** (`Cmd/Ctrl+N`) — empties the desk you're on. Its file keeps
  whatever was last saved to it, so this is "start over here", not "delete".
- **Open…** (`Cmd/Ctrl+O`) — shows a native file picker; the design you choose
  is loaded onto the active desktop, and that file becomes the desktop's
  Location. From then on, Save writes there.
- **Save** (`Cmd/Ctrl+S`) — writes the desk back to the file its Location
  names. No dialog: a desktop always has one.
- **Save As…** (`Shift+Cmd/Ctrl+S`) — asks where to keep it and writes it
  there, and that file becomes the desktop's Location. If the desktop was
  still in the file Chip Hippo minted for it, the suggested name comes from
  the **desktop's own name** ("Clock module.desktop.chiphippo"), and the
  minted file is deleted once the design has a real home.

If the file you pick already exists, your system's own save dialog asks
whether to replace it, exactly as it does in any other app — Chip Hippo adds
no second question of its own. Decline there and nothing is written.

Right-click a tab and choose **Properties…** to see a desktop's Location —
alongside its Name and Description — without opening any dialog that writes.

## Unsaved changes

A desktop's tab shows a dot when it has changes that aren't in its file yet,
and the window title shows the same for the desk you're on:
`• 6502 SBC — Clock module — Chip Hippo`. Save clears it. The title's dot also
covers the **project's** own unsaved changes — a desktop added, something
renamed — which **Project ▸ Save Project** writes.

Nothing that would lose those changes happens silently. Emptying a desktop or
loading another design into it asks first; so does deleting a desktop, opening
or starting another project, and quitting. Every one of those questions offers
to **save** first — and choosing that carries the action through, so you are
never made to ask twice.

When the save is the app's idea rather than yours — quitting with a dot on a
tab — nothing is asked about *where*: each desktop goes to the file it already
has, and the project to its own (or, having none yet, to the app's default
project file, where the next launch will find it).

## Undo & redo

`Cmd/Ctrl+Z` undoes the last edit; `Shift+Cmd/Ctrl+Z` redoes it. Undo/redo
covers the full editing history of the circuit — placing and moving boards,
chips, and discretes; wiring and unwiring; deleting anything; net names — as
far back as your session's history allows, and both menu items disable
themselves automatically when there's nothing left to undo or redo.

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
it onto the desktop you're on. Then load its matching `.hex` into the ROM chip
via the memory inspector or the external programmer before pressing **Run**.

---

See [Getting Started](getting-started.md) for building your first circuit
from scratch, and [Settings](settings.md) for what else persists between
sessions.
