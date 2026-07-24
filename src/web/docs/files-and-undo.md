# Files, Autosave & Undo

Chip Hippo separates two things most apps blur together: the circuit you're
currently poking at, which is saved for you continuously, and a named
schematic file you deliberately save to organize or share a specific design.
This page covers both, plus the discard-changes prompt, the title bar's dirty
indicator, and undo/redo.

## The autosaved working document

Whatever is on the desk right now — every board, chip, wire, and part — lives
in a **working document** that Chip Hippo saves automatically as you go.
There's nothing to save manually for day-to-day tinkering: place a chip, lay
a wire, quit the app, relaunch, and the desk comes back exactly as you left
it. This is the same document that opens by default every time you launch
Chip Hippo.

## Named files

A **named file** (extension `.chiphippo`) is a snapshot of a schematic you've
explicitly saved somewhere on disk — useful for organizing a design under a
project name, keeping several circuits side by side, or sharing one with
someone else. Once you've opened or saved a named file, it becomes the
working document: further edits keep autosaving into it, and the title bar
shows its filename.

## New, Open, Save, Save As

Four commands on the **File** menu cover the whole file lifecycle:

- **New Schematic** (`Cmd/Ctrl+N`) — clears the desk back to an empty working
  document, no file attached.
- **Open Schematic…** (`Cmd/Ctrl+O`) — shows a native file picker; choose a
  `.chiphippo` file and it becomes the working document.
- **Save** (`Cmd/Ctrl+S`) — writes the current desk to the file it's already
  associated with. If there isn't one yet, this falls back to **Save As…**.
- **Save As…** (`Shift+Cmd/Ctrl+S`) — shows a native save dialog; writes the
  current desk to the chosen path and adopts it as the working file from then
  on.

The same four actions are also available as buttons in the header toolbar's
schematic menu, alongside their keyboard shortcuts.

**New** and **Open** replace the whole desk, so the window refreshes to load
it — a brief flash as everything rebuilds from the new document. Note that
this resets any run-volatile simulation state (see below); it doesn't affect
what's saved.

## Unsaved changes

The title bar shows the current file's name (or "Untitled" for a fresh
document) with a leading dot — `• MyCircuit — Chip Hippo` — whenever the desk
has changes that haven't been written to that file yet. Save clears the dot.

Because **New Schematic** and **Open Schematic…** both replace the working
document outright, Chip Hippo won't silently throw away unsaved work: if the
desk is dirty, it shows a **Discard unsaved changes?** prompt naming the
current file and asking you to confirm before proceeding. Choose **Discard**
to continue (losing those changes) or **Cancel** to back out and save first.

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
back to before it happened. The only way to clear a damaged chip is the
right-click **Replace chip** action (see
[Power & Clock Sources](power-and-clocks.md)) — which, taken while stopped,
is a normal edit and undoes/redoes like any other. What undo/redo restores is
always the circuit you built, never a moment in its simulated behavior.

## Example circuits

Chip Hippo's project repository ships a handful of ready-to-load example
circuits as ordinary `.chiphippo` files — currently small W65C02-based
breadboard computers built from 74xx glue logic, each paired with a `.hex`
ROM image. Open one the same way as any saved file: **File ▸ Open
Schematic…**, then load its matching `.hex` into the ROM chip via the memory
inspector or the external programmer before pressing **Run**.

---

See [Getting Started](getting-started.md) for building your first circuit
from scratch, and [Settings](settings.md) for what else persists between
sessions.
