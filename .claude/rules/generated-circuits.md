---
paths:
  - "src/web/scripts/model/autobuild.js"
  - "src/web/scripts/model/example-desktops.js"
  - "scripts/make-demos.mjs"
  - "scripts/demo-*.mjs"
  - "scripts/make-gate-demos.mjs"
  - "src/web/demos/**"
  - "demos/**"
  - "src/web/scripts/tests/demos.test.js"
  - "src/web/scripts/tests/gate-demos.test.js"
  - "src/web/scripts/tests/autobuild.test.js"
---

## Power layout — the three rules every GENERATED circuit follows

These bind everything this repo GENERATES — `model/autobuild.js`,
`scripts/make-demos.mjs` and `scripts/demo-bench.mjs`. They do **not** constrain what a
user builds by hand. They exist because a generator has no eye: it will happily emit a
circuit that simulates perfectly and looks like nothing anyone would build.

1. **Boards are spanned, and the rail between two of them is SHARED.** A bench dovetails
   two 830s and the strip in the middle serves the board above and the board below — you
   do not fit a second one against it. So a stack is ONE flush run,
   `rail · pins · rail · pins · rail`, never N self-contained kits with a gap. Everything
   else falls out: rail-to-rail links CHAIN instead of leaping the height of a whole
   breadboard; the run carries ONE group, so it drags as a unit and the outline traces
   the assembly; and every row of every board has a rail 2.76 pitch away, which is what
   makes rule 3 possible. ONE rail strip serving four pin-boards is not a shape a
   breadboard can be in — the heights are fractional, so a typed y leaves a gap, nothing
   mates, and a chip four boards down has nowhere near to reach for power. The one
   sanctioned exception is an **open bottom**: a run may end on a pin-board where a
   bottom-mounted module (an HD44780 panel) plugs into row `a` and its body hangs down
   off the bench.
2. **The supply is a vertical spine down the END of the run — RIGHT for preference, then
   LEFT, then the middle.** Two rail strips share no node, so something has to tie them,
   and a rail-to-rail wire crosses the pin-board and cannot be routed around (both ends
   are fixed to a hole and the chips are in between). The ends are where the boards are
   EMPTY. Right first because that is where the PSU brick stands; left next as the only
   other edge; the middle only when both ends are blocked, and then in from the right.
   "The end" means the line's last GROUP of holes (`railGroup`), not its last hole — that
   is the unit the part is drilled in, and it is what makes a blocked hole 50 step to 49
   rather than across the desk to hole 1. Two consequences of *one hole, one lead*: a
   middle rail is the bottom end of the segment above AND the top end of the one below,
   so its leads sit in ADJACENT holes and the spine steps one column per board, leaning
   the same way all the way down; and the two POLARITIES take different columns, or the
   supply and ground wires would lie a single pitch apart over their whole length and
   read as ONE line.
3. **A power lead takes the shortest route — the rail on its own side of the trench,
   nearest its own column.** Rows f–j face the rail above, a–e the rail below; once rule
   2 has tied them the two are the same net, so reaching for the far one costs a lead
   straight over the chip it is powering. "Nearest column" is the other half: a rail is
   one node end to end, so its leftmost free hole is exactly as correct as the nearest
   one and just as much a wire dragged the width of the board. Neither half is a special
   case — `autobuild.js` picks a supply hole with the SAME `bestPair` chooser the signal
   router uses, and nearest-that-flies-over-nothing arrives there on its own. The FACING
   rail loses only when there is none (an open-bottom run's last board).

**Where they are enforced.** `model/autobuild.js` — `assemble`'s strip run (1),
`railSpineOrder` + `bridge` (2), `railLink` → `bestPair(pinPort, railPort)` (3).
`scripts/make-demos.mjs` — `stack`/`extend` (1), `spine` (2), `tie` (3); `stack` is the
ONLY way to put a board on the desk there (`board` is not exported from `builder()`), so
rule 1 holds by construction. `scripts/demo-bench.mjs` — `BOARDS`, `#railFor`/`railNear`/
`wireToRail` (a single kit, so rules 1–2 have nothing to decide), and `free(hole, board,
toward)`, which leaves a node from the row NEAREST the wire's other end — the first
free row sent every input switch's supply lead from row f across its own knob. Held by
`autobuild.test.js`, by each generator's own `assertClean` (a non-flush board is DROPPED
by `normalizeDocument` as an overlap, so the arithmetic cannot drift silently), and by
`demos.test.js`, which runs the shipped files through the real engine.

## Example circuits

Every benchable 74xx part's demonstration bench, shipped INSIDE the app as
`src/web/demos/<ref>.json` and offered as a button on that part's pin-assignments window.

- **One build, two outputs**: `make-gate-demos.mjs` writes each desktop into its group
  project (`demos/<family>/<Group>.chiphippo` — `demos/74LS/`, `demos/CD4000/`; the
  families never share a project, keyed by `groupKey`) AND on its own into
  `src/web/demos/`, from the SAME
  `buildDemo(spec)` call, and `gate-demos.test.js` holds them to byte-for-byte agreement.
  Minified (nobody reads that one) and pre-**CENTRED** on the origin by `demo-build.mjs`'s
  `centreDocument` — which is load-bearing, not tidy: `fitToScreen` RECENTRES as well as
  frames, so an uncentred example would put a "recentre desk" undo step at the top of a
  brand-new desk's history and the user's first ⌘Z would slide the circuit off-centre.
  Centred, the fit finds a zero delta, returns before `#emitDocChanged`, and is pure
  camera. The directory is **SWEPT** every run: a chip dropped from the catalog must not
  leave a document behind that still puts a button on a pinout window. Per-chip rather than
  per-group because it makes "does this part have an example?" an `fs.existsSync` — main
  answers with no catalog knowledge and no JSON parse.
- **Two channels, because there are two windows and only one can use the bytes**: a PINOUT
  window has a ref and nothing else, so it asks (`demo:open`) and main RELAYS
  `demo:host-inbound` to the app window after raising it (the pinout is `alwaysOnTop`, so
  an unraised desk would land behind the click); the APP window then READS the document
  (`demo:read`) itself, so the bytes cross the bridge once, into the window that will hold
  them.
- `ProjectWorkspace.openExample(ref)` is `importTab` with the file picker swapped for that
  read: an ADDITION, reseated through `desktop.duplicate` (no shipped example carries a ROM
  today, but "two chips can never share a guid" must not have a door in it), landing as
  `<ref> example`. Asking twice **switches** to the desktop already holding it — the tab
  NAME is the whole identity test, which is also its cost (rename it and the next ask brings
  a fresh one, the honest answer since the v4 schema keeps no per-tab marker a rename could
  not erase). An in-flight map keyed by ref makes a double-click ONE desktop (the name check
  and the insert are separated by awaits). The answer is three-valued
  (`"added"`/`"switched"`/null) because a NEW example desktop is centred, framed and left
  CLEAN while one already open is none of those — its camera and whatever the user has made
  of it are theirs. Clean is the deliberate half: looking an example up is not work to keep
  or throw away, and it must not put a save-or-discard question in front of the next New or
  Open. Editing it is an unsaved change like any other.
- Memory/Interface/PROCESSOR chips get no example and therefore no button: a RAM or a CPU
  cannot be demonstrated by flipping switches at it, and the 65xx demos are excluded for a
  sharper reason — their program lives in a separate `.hex`, so the document alone would
  arrive not working. The **Timer** group is `TIMED_GROUPS`
  (`demo-build.mjs`) and get no BENCH: the bench DSL has no resistor/capacitor values
  and its truth-table proof has no notion of time. The CD4060B (group Counter) DOES have
  one, built on its external-clock mode (a clock brick on φI) so the bench proves the
  divider without the oscillator.
- **A part can ship a HAND-BUILT example instead** (`HAND_BUILT` in `demo-build.mjs`: the
  NE555 → `demos/ne555.chiphippo`, drawn on the desk with ONE DESKTOP PER MODE —
  Monostable, Bistable, Astable). `make-gate-demos.mjs` ships it as
  `src/web/demos/<ref>.json` in a second payload shape, `{ref, title, desktops: [{name,
  description?, doc}]}` beside the benches' `{ref, title, doc}`, and keeps it out of the
  sweep. `buildHandBuilt` holds each desktop to the bench's bars (current `DOC_VERSION`
  — a bundled doc skips main's migrations — nothing dropped, every part `canPlacePart`,
  centred, no ROM images) and `validateHandBuilt` proves it in the engine (every chip
  `ok`, NO warning, every timed part reading its wiring with no problem); `gate-demos.test.js`
  holds the shipped file to a fresh build and the 555's desktops to the mode each is NAMED
  for. **`model/example-desktops.js` is the ONE reader of both shapes** (the workspace and
  `export-fixtures.js`'s `demoDocs`, which labels them `NE555-Astable`), and owns the tab
  names: `<ref> example`, or `<ref> <desktop> example` — English, being identity. For
  several desktops the identity test is PER DESKTOP: only those not open are added (a
  deleted one comes back alone), with all open the first is selected (`"switched"`); every
  copy is reseated before the project changes, so a failure adds none; the first NEW one
  is landed on and framed. Re-run `make demos` after editing the project in `demos/`, or
  the guard fails as stale.
- **Landing clean never HIDES unsaved work**: `#addExample` re-baselines (`#markClean`)
  only when the project was clean before the example arrived. It used to do so
  unconditionally, which cleared the • over edits on another desktop — and a close then
  discarded them without asking.
