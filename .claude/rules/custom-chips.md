---
paths:
  - "src/web/scripts/hdl/**"
  - "src/web/chip-designer.html"
  - "src/web/scripts/chip-designer.js"
  - "src/web/scripts/components/chip-design*.js"
  - "src/web/scripts/components/chip-debug*.js"
  - "src/web/scripts/components/chip-package-*.js"
  - "src/web/scripts/components/chip-watch-panel.js"
  - "src/web/scripts/components/hdl-*.js"
  - "src/web/scripts/components/custom-pinout-sync.js"
  - "src/web/scripts/model/custom-chip.js"
  - "src/web/scripts/model/chip-debug.js"
  - "src/web/scripts/catalog/custom-chips.js"
  - "src/app/store/custom-chips.js"
  - "src/app/pinout-chip.js"
  - "src/web/docs/custom-chips.md"
  - "src/web/scripts/tests/chip-debug*.test.js"
  - "src/web/scripts/tests/chip-design*.test.js"
  - "src/web/scripts/tests/chip-package-form.test.js"
  - "src/web/scripts/tests/custom-*.test.js"
  - "src/web/scripts/tests/hdl.test.js"
  - "src/app/tests/custom-chips.test.js"
  - "src/app/tests/pinout-chip.test.js"
---

## Custom chips — the chip designer

**A chip the user designs: a DIP package they lay out, and behaviour written in a strict
subset of Verilog** (plan `features/done/custom-chip-designer.md`; guide page
`src/web/docs/custom-chips.md`). It places, seats, simulates, exports and lists like any
chip, and while the circuit runs it can be stepped through statement by statement.

- **The USER owns them; a project carries the ones it places** (Jason, 2026-10-05). A chip
  made or edited in the designer is saved in the machine's **chip library** —
  `app/store/custom-chips.js` `ChipLibraryStore`, `userData/custom-chips.json`, over the
  `chip-library:list`/`put`/`remove` IPC (app window only), its own file because a chip
  carries its Verilog and settings.json is rewritten on every camera move — so every
  project on the machine can place it. A project FILE carries exactly the chips its
  desktops PLACE (`meta.customChips`, derived by `project-doc.js` `withPlacedChips` in
  `#stash` and `#liveMeta`, so it is inside `projectSignature`: editing a placed chip is an
  unsaved change, editing an unplaced one is not; written only when non-empty). **A
  project opening with a chip the library lacks gives it to the library**
  (`chipsMissingFrom` → `#joinLibrary`, in `#adopt`; an imported desktop's too). A chip the
  library already holds is NOT replaced when the project's copy differs: while that
  project is open its own copy stands in (`chipRegistry(library, projectChips)` — the
  catalog's set, the tray's and the designer's), since it is what the design was built
  with. That copy is held for the whole session (`ProjectWorkspace#ownChips`), placed or
  not — the file carries only placed chips, but an instance removed and brought back
  (undo, a paste) must come back as the project's chip, never the library's different
  one under the same id. An edit writes BOTH the library and the project's copy, so the
  last edit wins in the library. A NEW design past `MAX_CUSTOM_CHIPS` is refused
  (`code: "full"`), since main's store would skip it and it would vanish at relaunch. Delete removes the chip from the library, refused only while the OPEN
  project places it — another project that places it keeps it in its file and gives it
  back when opened. The stored shape is `model/custom-chip.js`'s — `{id, name,
  description, family, pinsPerSide, wide, ports: [{name, dir, width}], units: [{<port>:
  [pin per bit]}], vcc, gnd, code}` — held to it by `normalizeCustomChip` in the renderer
  and, field by field with no knowledge of what it means, by `store/custom-chips.js`'s
  `sanitizeCustomChips` in main (project files and the library alike; ≤
  `MAX_CUSTOM_CHIPS` 256 per stored list, the catalog registry uncapped). A desktop Export
  carries the chips its design PLACES (`customChipsUsedBy`); Import and opening a
  snapshot merge them in (`mergeCustomChips`, which re-mints an id that clashes with a
  DIFFERENT chip and rewrites the incoming document's refs to match).
- **A placed chip's Name and Description ARE its design's** (Jason, 2026-10-06): its
  Properties card shows the part number and description, and an edit there is
  `putCustomChip` on the DESIGN (`DeskController#customChipCard` / `#setCustomChipMeta`,
  wired as the `putCustomChip` option) — the part number held to `isValidPartName`
  (refused with the designer's own sentence), a line break in the description flattened
  (the designer's box is one line), both greyed while running. The card FOLLOWS the
  designer while open (`PartPropertiesDialog`'s `follow: {event, values}` on
  `chiphippo:custom-chips-changed`; a box being typed in is left alone). A component's
  own `comp.name` is no longer shown for a custom chip.
- **Its Pin Assignment is the ordinary pinout window** (Jason, 2026-10-06), fed the chip
  by the app window since that window has no catalog of the user's chips:
  `customPinoutOf(chip)` (`{marking, description, package, pins}`) rides `pinout:open`'s
  `opts.chip`, held to shape by main's `app/pinout-chip.js` `sanitizePinoutChip` (pins
  exactly 1…N or refused whole) and kept per open window; the window asks for it
  (`pinout:chip`, its own window only) and is pushed it again (`pinout:chip`) whenever
  `components/custom-pinout-sync.js` sees a chip's PINOUT move (a code edit moves none;
  a deleted chip is sent null and main closes its window). `datasheetCrop` is null for a
  custom def; its header's one button, `chipDesignerButton` (the `</>` glyph), replaces
  the datasheet/example pair and asks `pinout:open-designer` → main relays
  `pinout:host-inbound` → `ChipDesignBridge.openForRef` (its first instance's debugger
  tab while running, else the design).
- **The ref is opaque and stable** — `custom-<8 hex>` (`CUSTOM_ID_RE`, `mintCustomId`) —
  because it is stamped into every placed component; the user's part number can change
  freely. So nothing displays a ref: **`chipMarking(def)`** (`catalog/index.js`) is what
  is printed on a chip, and every label site reads it (chip view, schematic symbol, 3D
  model, BOM/build guide, KiCad Value, desk review, the AI desk brief). A def's
  `custom: true` is the one test — never a ref pattern outside `isCustomRef`.
- **A catalog OVERLAY, registered before any document loads.** `setCustomChips(chips)`
  builds each chip's def (`catalog/custom-chips.js` `customCatalogDef`, cached by the
  chip's JSON, so one chip is always one def object) and `chipDef`/`partDef` fall back to
  them. `ProjectWorkspace` registers the library merged with the project's chips
  (`chipRegistry`) at boot (`ProjectWorkspace.boot` reads the library over
  `chip-library:list` first), on every adopt, and before an import is canonicalized — a
  document naming a chip the catalog cannot resolve would be DROPPED by
  `normalizeDocument` as an unknown part. `familiesUsed` skips them:
  a designed chip names its family for its inputs and supply, never to change the tray.
- **The package is real geometry**: `footprints.js` parses `DIP-<n>-<300|600>`
  (`packageName`, 4–40 pins), so seating, occupancy, the 600-mil row rule and the KiCad
  footprint all follow with no special case. **A placed chip's size and width are
  FIXED** (`ProjectWorkspace.putCustomChip` → `{ok: false, code: "placed"}`) — moving its
  pins would silently rewire every desk it is on — and **a placed chip cannot be
  deleted** (`deleteCustomChip` → `"placed"`, with the count). Nothing changes while the
  circuit runs (`"running"`).
- **Units** (≤ `MAX_UNITS` 6) are the SAME module repeated, each with its own state and
  its own pins. A port may share one pin across units (a common clock); an output may
  not (`outputShared`). `customPins` names each pin as the datasheets do — `1A`, `2A`, a
  shared pin bare, a pin shared by SOME units `12CLK`.
- **The behaviour is the standard sequential contract** (`{state0, step, outputs}`, the
  CPUs' arrangement with the code written by the user): `step` fires edge blocks and
  returns the state VERBATIM when nothing fired (the tick fixpoint depends on it),
  `outputs` evaluates the combinational blocks. A port bit with no pin reads as an open
  input of the chip's family (TTL 1, CMOS x). **A chip whose package or code has a
  problem is still a chip** — it seats and powers, and drives NOTHING (every output Z,
  `def.customRuntime` null); `customProblems` says why, and Run raises one toast naming
  every such chip on the desk (app.js `noteBrokenCustomChips`).

### The Verilog subset (`scripts/hdl/`)

**Real Verilog or a refusal — never an approximation.** Whatever is accepted means what
IEEE 1364 says it means; whatever is not is rejected by a NAMED diagnostic
(`{code, args, line, col, …}` → `hdl.diag.<code>`, every one translated). Pure and
DOM-free throughout, so `tests/hdl.test.js` exercises it under `node --test`.

- **Pipeline**: `lexer.js` → `parser.js` (an AST of items; one error per item, then it
  resyncs at the next item keyword so one typo does not hide the rest) → `analyze.js`
  (names, widths, drivers, ordering) → `program.js` (closures over 4-state values) →
  `compile.js` (`compileModule(source, ports, {name})`, LRU-cached by source + ports).
- **Values are 4-state, ≤ 32 bits** (`values.js`: `{w, v, x, z}` masks), sized by
  Verilog's context-determined rules. A `reg` starts `x` unless an initializer or
  `initial` block says otherwise. **Signedness is IEEE 1364's (§5.5)**: a plain decimal
  (the lexer's `based: false`), an `integer`, an array of integers and a parameter given
  a signed value are signed; an expression is signed only when every context-determined
  operand is (`selfSigned`, propagated down by `build`'s `signed`). It decides `<`/`/`/
  `%`/`>>>`/`**` and extension, nothing else; no signed leaf is narrower than 32 bits, so
  extension never actually widens. Round 2 (2026-10-06) found the old analyzer reading
  `(0 - 1) < 2` as unsigned — false, where Verilog says true.
- **Accepted**: `wire`/`reg` (constant range, initializer), `integer` (a general signed
  32-bit variable), `parameter`/`localparam` (+ `parameter integer`), `assign`,
  `always @(*)` / `@(a or b)` / `@(a, b)`, `always @(posedge … or negedge …)`, `initial`,
  `begin…end` — a NAMED block may declare its own `reg`/`integer` first (no initialiser;
  slot named `block.var`, resolved before compiling by `resolveScopes`, which stamps
  `_sym` on the AST ids) — `if`/`else`, `case`/`casez`/`casex` + `default`, `=` and `<=`,
  `for`/`repeat` (below), and the expression language incl. `**` (Table 5-6) and indexed
  part-selects `+:`/`-:` (the AST field is `from`: `start` is the span's offset).
- **`inout` ports** are two slots behind one name: the PIN's level (an input slot every
  read sees — so `assign D = oe ? q : 8'bz; assign y = D;` is no false comb loop) and
  the DRIVEN value (a hidden `drive` slot only `assign` may set — `inoutProcedural`).
  The package gives their pins role `io` (the CPUs'/RAMs' role, which the engine already
  reads and drives); an inout never shares a pin across units.
- **Arrays (memories)**: `reg [w] m [a:b]` (or integer), one dimension, ≤
  `MAX_MEMORY_DEPTH` 32K words, ≤ `MAX_MEMORY_WORDS` 64K per module, written only from
  edge and `initial` blocks (`memoryInComb`), `m[i]` only (`wholeArray`). The value is
  `hdl/memory.js`'s persistent 32-way trie (≤ 3 levels): a write copies one path, an
  untouched memory stays the SAME object (engine `sameState` stops at `===`), and a
  TRANSACTION (`newTx`, `ctx.tx`) lets one evaluation write nodes it made in place —
  never while a trace takes frames. Leaf numbers are compared within the word width (the
  shared all-x leaf holds 32 bits of x). A frame's `pending` is LAZY (a getter over the
  NBA queue and its length): a 32K-iteration loop takes a frame per statement.
- **Loops are proved to finish before anything runs**: a `for` sets ONE counter in its
  first and last parts (`loopCounterForm`), its start reads only constants and its
  condition/step only the counter (`loopNotStatic`), the body never sets it
  (`loopCounterAssigned`); `loopSequence` runs the counter at compile time. In
  `always @(*)` the loop is UNROLLED (each copy sees the counter as a constant through
  `loopEnv`, so the latch and per-bit loop checks see constant indices; a copy's index
  off the end reads x / writes nothing rather than refusing), cap `MAX_UNROLL` 1024; in
  edge/initial blocks it RUNS (`exec` "for", stopping at the proved count), cap
  `MAX_LOOP` 65,536 per loop statement, nesting multiplied (`ctx.cost`). The counter is
  really set at the `for` line, so the watch shows it and that line is a breakpoint. A
  module-level counter used by two blocks is `loopCounterShared`; `for (integer i…` is
  SystemVerilog (`loopHeaderDeclaration`).
- **Refused as unsupported**: `while`/`forever` (every evaluation must terminate — the
  spec's one hard rule), delays, functions/tasks, system tasks (`$display` included —
  Jason, 2026-10-06), `signed` declarations, multi-dimensional and wire arrays, gate
  primitives, instances, directives, `module`/port declarations in the body.
- **Refused as MISTAKES** (`analyze.js`): assigning an input, a parameter or a reg from
  `assign`; a bit or range a VARIABLE picks on an `assign` target
  (`assignVariableSelect`, §6.1.1); a wire set procedurally; two drivers, checked PER
  BIT (two assigns to different bits of one bus are fine); an `always @(*)` that leaves
  a signal unset on a path (a latch — `definiteFlow`, which tracks BLOCKING writes apart
  from all writes: a `<=` target read later in the same comb block is
  `nonblockingReadBack`, since it still holds its old value there); an incomplete
  sensitivity list; a combinational loop, found PER BIT between blocks (a shift register
  written as a bus is not a loop; within ONE block every bit written depends on every
  bit read). A case is FULL when its labels cover every value of the SUBJECT's own
  width (`caseIsFull`, ≤ 8 bits; casez/casex wildcards honoured) — plain decimal labels
  are 32 bits and must not make it look partial. A loop COUNTER is exempt from the latch
  rule (`counterLatches`) unless something reads it where the loop may not have run (its
  own block after the branch, or any other item). Undriven outputs, undriven wires and
  never-set regs are WARNINGS.
- **One clock per module**: every edge block shares one clock input; any other edge
  signal must be an asynchronous control tested in the block's LEADING `if` chain (the
  synthesis convention) — otherwise `clockAmbiguous` / `multipleClocks`.
- **The module header is GENERATED** (`header.js` `moduleHeader`), never typed: the user
  edits only the body, so the code's pins cannot drift from the package. An output an
  `always` block drives is declared `output reg`; an inout is always `inout wire`. The module name is the part number made
  an identifier (`moduleName`).

### The designer window

`web/chip-designer.html` → `scripts/chip-designer.js` → `components/chip-designer-view.js`
(+ `chip-package-diagram.js`, `chip-package-form.js`, `hdl-editor.js`, `chip-debug-bar.js`,
`chip-watch-panel.js`). ONE singleton OS window, its own sandboxed renderer: **the designer
while the circuit is stopped, the debugger while it runs.**

- **It owns nothing.** Main relays both ways (`chipdesign:open`/`to-window`/`to-host`,
  pushes `chipdesign:inbound`/`chipdesign:host-inbound` — only the main window may address
  it, only the designer may answer), and the main renderer's `ChipDesignBridge` answers:
  it keeps which designs are open as tabs and which has focus, and sends ONE `state`
  message (designs, uses, debugger view, mode) whenever any of it changes, coalesced per
  microtask. Edits go back as whole chips with a monotonic token, so a slow echo never
  overwrites newer typing (`#local` until the echo catches up); the code is debounced
  (`CODE_DEBOUNCE_MS`). The window compiles locally only to SHOW diagnostics — the
  catalog's compile is the one the engine runs.
- **A host that started over asks** (`{kind: "hello"}` at construction → the window
  re-sends `ready`), or a reloaded app window would never address it again.
- **The package form's notes sit behind an (i)** at the end of their row's controls
  (`chip-package-form.js` `#row` → `info-button.js`, Settings' control; Jason asked for it
  to save space, 2026-10-05): Logic family, Units, and — only while the chip is placed —
  why Body width and Pins per side are fixed. The card floats over the rows below (an
  absolutely placed grid child of `.cd-row`, its grid area under the controls), and an
  open note is re-opened after a redraw, since every echo of an edit redraws the form.
- **Each port's row carries its pin map** (Jason, 2026-10-06): name · direction · width ·
  one pin select per UNIT · ×, a bus's bits on rows of their own under it (`.cd-port-row--bit`,
  `D0`…), the column heading "Pin" for one unit and "Unit n" for several. There is no
  separate pin map. The pins scroll SIDEWAYS in `.cd-ports` when the pane is too narrow,
  the port cell and the × `position: sticky` over them; `ChipPackageForm.render` keeps
  that scroller's `scrollLeft` through its wholesale redraw.
- **Two dividers the user drags** (Jason, 2026-10-06), through `pointer-gesture.js`, each
  reset by a double-click and remembered in settings by the window itself
  (`chipDesignerLeftWidth` / `chipDesignerHeaderHeight`, px or null, written on release):
  `.cd-split` between the halves (a grid item sharing the right half's cell — both halves
  are placed explicitly — `--cd-left-width` clamped by `.cd-main`'s template to 300 px and
  the code's 360 px), and `.cd-code-split` under the module header, which is as tall as
  its text up to 40% of the code box and scrolls past it; a dragged height sets its
  `flex-basis` and lifts the cap. Either way the header is what gives way when the code
  is short of room (the editor's basis is 0 with its 8em floor).
- **The package drawing stays put; only the form scrolls** (Jason, 2026-10-05). The left
  half is `.cd-package` · `hr.cd-rule` · `.cd-form-pane`, and the rule is the one a
  Properties card draws after Name/Description — moved up to be the edge the form
  scrolls under, so Part number and Description lead the scrolled pane and the form
  draws no rule of its own. The pane's basis is 0 with a 12em floor: a package too tall
  to leave it that (40 pins in a short window) shrinks and scrolls itself. Debugging
  hides the rule and the pane, leaving the drawing with its live levels.
- **A redraw never moves a pane.** Every edit, echo and debugger tick rebuilds the
  drawing and the form (and the problems list, the tabs, the watch table) wholesale, and
  the browser's SCROLL ANCHORING re-anchored on whatever replaced its anchor node —
  throwing a scrolled pin map hundreds of pixels, usually to the top, on each change. So
  those panes are `overflow-anchor: none` (app.css), and `ChipDesignerView#render` also
  puts the drawing's, form pane's and problems list's offsets back itself while the same
  design (or debugged chip) stays on screen (`#viewKey`); a tab switch is left alone.
- **The editor** is a transparent `<textarea>` over a highlighted `<pre>`
  (`highlight.js` runs: pins, declared signals, keywords, numbers, bad tokens), monospace
  so a hover is offset arithmetic, not a DOM hit test. **Hover linking runs both ways**:
  a pin on the diagram lights its names in the code (`namesForPin`), a name in the code
  lights its pins (`pinsForName`, constant bit-selects honoured). Its GUTTER sets line
  breakpoints: a click on a number (or, while designing, F9 on the caret's line) sends `{kind:
  "breakpoint", ref, line, compId}` after flushing pending typing, so host and gutter
  number the same text; `setBreakpoints(lines, reachable)` draws a solid red circle
  where the number was, hollow where `program.executableLines` (from the window's own
  compile — empty while the package or code has an error) cannot stop.
- **Window moments the user never asks for**, each argued in `chip-design-bridge.js`: a
  breakpoint that fires OPENS/RAISES the window (once per pause, never per step); a
  click on a chip on the desk changes the TAB and never raises the window; Stop leaves
  the chips it was debugging open as DESIGNS; Run with a design on screen shows that
  chip's first instance. It is not closed by `closeAuxWindows` (it is not a document's)
  — a project change PRUNES its tabs to the incoming project's chips.
- **The custom look is not colour-only**: a slate body (`--color-chip-custom-*` tokens)
  plus a folded corner and a `</>` glyph (`chip-view.js` `buildCustomMarks`), the same
  glyph on every custom row in the tray (`CUSTOM_GLYPH`) and on the designer's diagram.
- **The tray**: a `CUSTOM` folder INSIDE CHIPS, a sibling of the family folders (Jason's
  call, 2026-10-05) — after `74LS`/`CD4000` in a Combined tray, after the groups in a
  single-family one (no family tier there), and never top-level, so the rail has no icon
  for it. Its header is a `palette-group` with its own `palette-custom-folder` class —
  NOT `palette-family`, which stays the mark of a real family. **New chip…** then one row
  per designed chip by its part number (filter-aware; the filter matches the marking, and
  a filter matching only custom chips still brings CHIPS up to hold them). A row's
  right-click is its own menu (Edit Design… / Duplicate Design / Delete Design), through
  app.js's `openCustomChipMenu`.

### The debugger

`components/chip-debugger.js` (`ChipDebugger`, the controller) + `model/chip-debug.js`
(pure) + one observer seam in `sim/engine.js` + one stall in `SimController`.

- **THE ENGINE IS NEVER PAUSED — a debug session is a REPLAY.** `tick` takes an optional
  `observer` (`recorder(watch)`): each solve pass reports its starting levels
  (`observer.round`), and each WATCHED chip's inputs and state as that pass evaluated it
  (`observer.chip`, from `driversFor` and the step loop). The tick runs to its end as it
  always does; then `debug.afterTick` turns the record into EVENTS (`collectEvents`:
  re-running each chip's program with a trace — `program.traceComb` / `traceStep` —
  wherever its pins or state changed since it was last seen) and, if any armed chip has
  one, returns a promise: **the SimController STALLS** exactly as the serial integration
  stalls (clock edges and input events wait), shows each pass's board levels as the
  replay reaches it (`show`), and publishes the final state only when the session lets
  go (`#endDebugStall`). Determinism is what makes revealing the record pass by pass the
  same thing as pausing it. Unlike the integration's millisecond stall, a person holds
  this one, so the transport Step, a manual clock and a signal press made meanwhile are
  QUEUED (`#hold`) and replayed one tick each when it lets go (`#replayHeld`, also after
  an integration stall that followed) — two Steps are two edges, a momentary press and
  release a pulse. A switch flip (doc-changed) or button press (part-state) is held
  the same way as the BOARD it made — the document snapshot and its netlist, taken at
  the event (`#holdBoard`) — so two flips are two ticks (2026-10-10; they used to merge). Resume during
  a stall leaves the sim clock frozen until the stall ends.
- **The spec's concurrency rule is the replay's structure** (`DebugSession`): every chip
  that changed in one pass pauses AT ONCE, each reading the inputs as the pass began; a
  change another chip makes to a paused chip's input is HELD (the next pass's input —
  the tab's "N held"), re-evaluated only if it differs; the board is settled only when
  every chip is idle and nothing is held. So the engine's PASSES are part of its
  contract: the incremental settle keeps them exactly, hands each pass's levels out as
  a map nothing changes afterwards, and evaluates every WATCHED chip on every pass
  (`heldOf` reads the next pass's record of it).
- **Two kinds of breakpoint, owned by different things** (Jason, 2026-10-06 — line
  breakpoints replaced a per-chip "Break on Pin Change"). A LINE breakpoint is the
  DESIGN's (`toggleBreakpoint(ref, line, compId)`, `breakpointsOf`, published as
  `state.breakpoints`): every placed instance stops where its reaction executes that line
  (`nextBreak` over the frames' `loc.line`), counted only on `executableLines`, kept for
  the session through Stop/Run and desk loads, and moved with their lines by a code edit
  (`shiftLines`: common head and tail of the two texts). SETTLED is one placed chip's
  (`setArmed`/`toggleArmed(id, "settled")`, mirrored as the context menu's one checked
  item and the bar's one toggle), surviving Stop/Run but not a document load
  (`chiphippo:desk-loaded`). `armedOf` is `{lines, settled}`; the engine records only the
  chips either could stop (`#watched`, cached), a chip newly watched mid-run taking its
  current values as baseline. A chip either could stop draws a red badge
  (`part-chip--armed`), a paused one pulses (`part-chip--paused`, motion off under
  reduced-motion) — both from the `chiphippo:chip-debug` broadcast.
- **Where a session stops**: `collectEvents` keeps every reaction of a watched chip and
  the session asks `linesOf` LIVE (a breakpoint set while paused counts at once). A
  reaction pauses at its first breakpoint frame, not its first statement; Continue moves
  each paused chip to its NEXT breakpoint frame (same reaction included) before moving
  on; Step and Step Out mark the chip as STEPPING, so its next reaction in the tick
  pauses at statement one breakpoint or not, until a Continue or To Settled.
- **Bar controls**: Continue (to the next breakpoint, on any chip), Step (one statement),
  Step Out (finish this chip's reaction), To Settled (ignore breakpoints, stop at
  quiescence), Detach (this chip ignores everything for the rest of the RUN and its
  Settled goes; setting a breakpoint from its tab, or Settled, brings it back), the
  Break-on-Settled toggle and the Settled lamp. No speed control (meaningless while
  paused) and nothing red (red is the global Stop's). **Function keys** (Jason,
  2026-10-10): F8 Continue · F6 Step · F7 Step Out · F9 To Settled · F10 Detach —
  `chip-debug-bar.js` `DEBUG_KEYS`, a window `keydown` in `ChipDesignerView` while
  `mode === "debug"`, no modifiers, each a `press()` of its button, so a disabled
  button's key does nothing. F9 is the editor's breakpoint key only while the code is
  EDITABLE (`hdl-editor.js` checks `readOnly`); debugging, it bubbles to To Settled and
  the gutter's tooltip drops its "(F9)" (`breakpointAddClick`).
- **Tabs** are ordered by arrival (`seq`), alphabetical within one pass, re-queued to the
  end when an idle tab gets a new change; a new pause never takes the focus from a tab
  being stepped; states Paused (+ held) · Idle · Settled · Detached — Detached is read off
  what could STOP it (no reachable breakpoint and no Settled, a never-armed chip
  included, or detached this run), not kept as history. An idle tab follows
  the live board (`LIVE_INTERVAL_MS`). The watch panel lists every pin and internal
  signal (`watchRows`), a pending non-blocking value after an arrow, an inout's driven
  value beside its pin level. An ARRAY is one row (its shape, its pending writes); its
  words NEVER ride the state message — **Show words** opens `hdl-memory-view.js`, a
  virtualized grid that asks for the rows on screen (`memory-range` window → bridge →
  `ChipDebugger.memoryRange` → `memoryWords`, answered to the window alone, stale
  replies dropped by `req`) and asks again on every redraw.
