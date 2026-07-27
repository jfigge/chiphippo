# Projects & Desktops

A big build eventually needs a bench beside it. You want to work out a clock
module, an address decoder, or a memory map *without* doing it in the middle of
everything else — and then drop the finished thing into the main design.

That's what a **project** is for. A project is a workspace holding several
**desktops**, shown as tabs above the desk. Each desktop is a complete desk of
its own — its own boards, chips, wiring, camera position, and undo history —
and a design worked out on one can be copied straight onto another.

**Every desktop is the same.** There is no special "main" desk and no lesser
one: they are peers, all with the same menu, and which is the build and which
is the bench is entirely up to you. Any of them can be renamed or deleted —
the only rule is that a project always keeps at least one.

The tab strip is **always** above the desk, project or not. With no project
open it shows the single desk you're on, and the **+** beside it is how you
get another.

## Starting a project

**Just press +.** Adding a desktop never asks you anything: the desk you're on
becomes the project's first desktop (so nothing you were working on is
discarded), the desktop you asked for appears beside it, and you land on it.
After that, every + adds one more. A project starts life **Untitled** — the
window title says so.

The **Projects** button in the header toolbar has the rest:

- **New Project** — a blank slate: a fresh untitled project holding one new,
  empty desktop. No dialog. However many desktops you had, a new project
  always starts as a single one, numbered from `Desktop 1` again.
- **Load Project…** — lists the projects you've saved; pick one to open it.
- **Save Project…** — the one and only place a name is asked for. See below.
- **Add Desktop** — the same thing as the **+** at the end of the tab strip.

## Saving a project

**Projects ▸ Save Project…** asks for a name and keeps the project under it.
Every desktop is written to its file first, so "save the project" means all of
it, not just the tab list. Once a project is named, the item greys out: there
is nothing left to do, because a saved project's desktops and tab list are
already kept up to date.

Project names must be unique. If you type one you've already used, Chip Hippo
says so and asks for a different one — it never merges two projects into one,
and never offers to open the other (that would throw away the work you're
saving).

Saved projects are one folder per project, holding a small project file (the
tab list) plus one ordinary `.chiphippo` file per desktop. Because a desktop is
just a normal schematic file, anything you build on one can be opened outside
the project too.

## Changing projects

**New Project** and **Load Project…** both replace what's open, so nothing is
allowed to go with it unasked:

- An **untitled** project has to be dealt with whether or not its desktops are
  saved — it lives in Chip Hippo's one working slot and has no name to come
  back to it by. You're asked to **save it first** (which names it and writes
  every desktop), **discard** it, or **cancel** the whole thing.
- A **saved** project with desktops you've changed asks whether to **save
  all**, **discard**, or **cancel**.
- With no project open, the plain **desk** gets the same courtesy before a
  project takes the screen from it.

Choose to save and it goes through, then the action you asked for carries on —
you're never made to ask twice. Cancel, at that dialog or at the name dialog
behind it, and nothing happens at all.

Load Project… shows you the list of saved projects **first**; the question
above comes once you've picked one, so backing out of the list costs you
nothing.

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

A dot on a tab (`Desktop 2 •`) means that desktop has changes you haven't
saved yet. The window title shows the project — `Untitled` until you name it —
and the active desktop.

## Managing tabs

Right-click a tab for its menu:

- **Properties…** opens the same dialog every part, board, and wire has, with
  the same two fields: a **Name** — what the tab reads — and a **Description**,
  a note on what this bench is for. Hover the tab to see the description; both
  are saved with the project as you type them.
- **Delete Desktop** removes it, along with its file. Any desktop can go —
  there's nothing special about the first one — except the **last** one left,
  because a project with no desktops would have nothing to open. If the desktop
  has unsaved changes, you're asked whether to **save and delete**, **delete
  anyway**, or **cancel**.

Desktop numbers only ever count up: deleting `Desktop 2` doesn't make the next
one `Desktop 2` again, so a name you wrote in a note keeps meaning the same
bench. Rename them to whatever the benches actually are — `CPU`, `Clock`,
`Decoder` — through Properties…

## Copying a design from one desktop to another

This is the point of the whole thing.

1. On the desktop holding it, **shift-drag a marquee** around the design — the
   boards, the chips on them, and the wiring. A marquee takes in any board it
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

A project stays open between sessions — named or not: relaunch Chip Hippo and
it comes back on the desktop you were last on. Starting or opening another one
asks first about anything you'd lose (see *Changing projects* above).

**Closing the window or quitting asks the same question.** Desktops are only
written when you save them, so a tab still showing a dot would go with the
window — Chip Hippo stops and offers to save it (or to name an untitled
project) first. Cancel there and nothing closes at all.
