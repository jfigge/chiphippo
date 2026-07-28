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

**There is always a project open.** From the first launch, the desk you are
looking at is a desktop of one — a brand-new project with no name, no home of
its own, and a single desktop called `Desktop 1`. Nothing has to be created
before you can start building, and nothing has to be named before you can add
a second desktop.

## Adding desktops

**Just press +** at the end of the tab strip. It asks you nothing: the new
desktop appears beside the others, named `Desktop 2`, `Desktop 3`, and so on,
and you land on it. Chip Hippo keeps a file for it in its own saves folder
until you give it one of your own with **Save As** — see
[Files, Saving & Undo](files-and-undo.md).

The **Project** menu — the first menu in the menu bar, just before **File** —
has the rest:

- **New Project** — a blank slate: a fresh unnamed project holding one new,
  empty desktop. However many desktops you had, a new project always starts as
  a single one, numbered from `Desktop 1` again.
- **Load Project…** — pick a `.project.chiphippo` file to open.
- **Open Recent Project** — the last ten projects you saved or opened, most
  recent first.
- **Save Project** — save all of it, naming the project the first time. See
  below.
- **Save Project As…** — the same save, but always to a new file. The project
  keeps its name; only where it lives changes.
- **Project Properties…** — the project's **Name**, **Description**, and the
  read-only **Location** of its file (blank until it has been saved).
- **Add Desktop** — the same thing as the **+** at the end of the tab strip.

Everything about a project lives on that menu, and nowhere else: the toolbar
carries the tools you reach for while building, not the paperwork.

## Saving a project

**Project ▸ Save Project** saves all of it: every desktop is written to its
own file first, then the project file itself — so "save the project" never
means just the tab list.

A project that has never been saved is asked for two things, in order:

1. a **name**, if it doesn't have one yet (you can also set it any time in
   Project Properties…);
2. **where to keep it** — a native save dialog, whose suggested file name comes
   from the name you just gave it. If a file is already there, that dialog asks
   about replacing it in your system's usual way.

Cancel either question and nothing is saved. Once the project has a home, Save
Project just writes it — no dialogs — and moves it to the top of the recent
list. **Save Project As…** asks the location question every time, so it is how
a project moves to a file of your choosing (or gets a copy kept somewhere
else); it never asks for the name again.

A saved project is two kinds of file: one small `.project.chiphippo` listing
its desktops, and one `.desktop.chiphippo` per desktop, wherever each of them
was saved. Because a desktop file is an ordinary Chip Hippo design, anything
you build on one can be opened outside the project too.

The **tab list itself** — which desktops there are and what they are called —
is part of what Save Project saves. Add a desktop or rename one and the project
has unsaved changes, exactly as a desk you have wired does; the window title
shows a • for either.

**Discard those changes and they are gone**, which includes any desktop you
added since the last save: it isn't in the file the project reloads from, so
Chip Hippo also deletes the file it was keeping for that desktop rather than
leaving one behind that nothing points at. A desktop you saved somewhere of
your own keeps its file, as always.

Two things are written for you the moment they happen, because the alternative
is a project file that lies: a desktop's file **moving** (Save As, or Open) and
a desktop being **deleted**. Either would otherwise leave the project pointing
at a file that no longer exists.

## Changing projects

**New Project** and **Load Project…** both replace what's open, so nothing is
allowed to go with it unasked:

- A project that has **never been saved** has to be dealt with whether or not
  its desktops are saved — it lives in Chip Hippo's one working slot, and the
  project taking its place is about to claim it. You're asked to **save** it
  (which names it, gives it a home, and writes every desktop), **discard** it,
  or **cancel** the whole thing.
- A **saved** project with desktops you've changed asks whether to **save**,
  **discard**, or **cancel**.

Choose to save and it goes through, then the action you asked for carries on —
you're never made to ask twice. Cancel, at that dialog or at a dialog behind
it, and nothing happens at all.

## Working across tabs

Click a tab to put that desktop on the desk. Everything follows the active tab:

- The **toolbar's New, Open, Save and Save As** act on that desktop and its own
  file (see [Files, Saving & Undo](files-and-undo.md)).
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
  the same two fields — a **Name**, which is what the tab reads, and a
  **Description**, a note on what this bench is for — plus the read-only
  **Location** of the file this desktop is saved in. Hover the tab to see the
  description; the name and description are saved with the project as you type
  them.
- **Delete Desktop** removes it from the project. Any desktop can go — there's
  nothing special about the first one — except the **last** one left, because a
  project with no desktops would have nothing to open. **Where its file is
  decides what happens to it**: a file inside Chip Hippo's own saves folder is
  deleted along with the desktop (the one the app minted for it, or one you
  saved into that folder yourself), and a file you keep anywhere else is left
  exactly where it is. If the desktop has unsaved changes, you're asked whether
  to **save and delete**, **delete anyway**, or **cancel** — and if its file is
  one of the app's, saving it means choosing where it goes, since the delete
  would take that file with it.

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

A project stays open between sessions — named or not. Relaunch Chip Hippo and
it comes back on the desktop you were last on: the unsaved project from its
saves folder if there is one, and otherwise the project you used most recently.
Starting or opening another one asks first about anything you'd lose (see
*Changing projects* above).

**Closing the window or quitting asks the same question**, about the desktops
you have changed and about the project itself. Because you didn't ask for a
save, it doesn't ask you where anything goes: each desktop goes to the file it
already has, and the project to its own (or, having none yet, to the app's
default project file, where the next launch will find it). Discard instead and
any desktop you had added is dropped along with the file Chip Hippo was keeping
for it. Cancel and nothing closes at all.
