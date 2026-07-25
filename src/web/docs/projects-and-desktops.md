# Projects & Sub-Desktops

A big build eventually needs a bench beside it. You want to work out a clock
module, an address decoder, or a memory map *without* doing it in the middle of
everything else — and then drop the finished thing into the main design.

That's what a **project** is for. A project is a named workspace holding
several **desktops**, shown as tabs above the desk: `Main` for the build, and
as many `Sub-Desktop #N` benches as you want beside it. Each desktop is a
complete desk of its own — its own boards, chips, wiring, camera position, and
undo history — and a design worked out on one can be copied straight onto
another.

## Creating a project

The **Projects** button in the header toolbar opens the menu:

- **New Project…** — asks for a name, then creates the project.
- **Load Project…** — lists the projects you've saved; pick one to open it.
- **Add tab** — adds another sub-desktop. With no project open yet, this asks
  for a project name first (there has to be a project for the tab to live in).

Creating a project **adopts the desk you're already on** as its `Main` tab, so
nothing you were working on is discarded, and adds `Sub-Desktop #1` alongside
it. Every project after that starts the same way.

Project names must be unique. If you type one you've already used, Chip Hippo
offers to open that saved project instead, or to let you pick a different name
— it never merges two projects into one.

Projects are stored in Chip Hippo's own working folder, one folder per project,
holding a small project file (the tab list) plus one ordinary `.chiphippo` file
per desktop. Because a desktop is just a normal schematic file, anything you
build on one can be opened outside the project too.

## Working across tabs

Click a tab to put that desktop on the desk. Everything follows the active tab:

- The **toolbar's New, Load and Save** act on that desktop. Save writes the
  desktop's own file inside the project — no dialog, because a tab already
  knows where it lives. New empties that desktop; Load reads a `.chiphippo`
  into it.
- **Undo/redo** is per desktop. Switch away and back, and `Cmd/Ctrl+Z` still
  undoes that desk's last edit, not the other one's.
- Each desktop remembers **where you were** — its camera position comes back
  with it.
- The **simulation stops** when you switch. A running circuit belongs to the
  desk it's running on, so the transport resets rather than following you to
  another desktop. Any open pin-assignment or memory-inspector windows close
  for the same reason: they were pointing at chips on the desk you just left.

A dot on a tab (`Sub-Desktop #1 •`) means that desktop has changes you haven't
saved yet. The window title shows the project and the active desktop.

## Managing tabs

Right-click a tab for its menu:

- **Properties…** opens the same dialog every part, board, and wire has, with
  the same two fields: a **Name** — what the tab reads — and a **Description**,
  a note on what this bench is for. Hover the tab to see the description; both
  are saved with the project as you type them.
- **Delete Sub-Desktop** removes it, along with its file. `Main` can't be
  deleted — it is the project. If the desktop has unsaved changes, you're asked
  whether to **save and delete**, **delete anyway**, or **cancel**.

Sub-desktop numbers only ever count up: deleting `Sub-Desktop #2` doesn't make
the next one #2 again, so a name you wrote in a note keeps meaning the same
bench.

## Copying a design from one desktop to another

This is the point of the whole thing.

1. On the sub-desktop, **shift-drag a marquee** around the design — the boards,
   the chips on them, and the wiring. A marquee now takes in any board it
   encloses *completely*, and the selected set is outlined as one block.
2. Press `Cmd/Ctrl+C`. The whole sub-assembly is copied: the boards, everything
   seated on them (whether or not the box touched it), every wire with **both**
   ends inside the set, and the buses, net names, and anchored labels riding
   them. A wire with one end outside is left behind — it would have to be cut.
3. Click the tab you want it on and press `Cmd/Ctrl+V`.

The design appears **under the cursor as a translucent ghost**, following it
with no button held — the same way a fresh breadboard does when you pick one
from the palette. Move it where you want it:

- Boards outline **green** where the design will land and **red** where it
  overlaps something already on that desk.
- Bring it near a board that's already there and it **snaps flush**, dovetailing
  exactly as a board you dragged into place would.
- **Click** to drop it. **Esc** throws it away and leaves the desk untouched.

The drop is all-or-nothing: if any board would land on top of something, the
click is refused rather than pasting half a design and silently cutting its
wiring. The whole paste is a single undo step, and the pasted design is brand
new hardware — fresh boards, fresh parts, and (for a ROM) its own fresh backing
file, so editing the copy never touches the original.

The clipboard survives switching tabs, so you can paste the same design onto
several desktops, or stamp it more than once on the same one.

## Leaving a project

A project stays open between sessions: relaunch Chip Hippo and it comes back on
the desktop you were last on. Opening a different project (or creating one)
asks what to do about any desktops with unsaved changes first — **save all**,
**discard**, or **cancel**.
