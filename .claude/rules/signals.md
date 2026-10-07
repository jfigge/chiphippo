---
paths:
  - "src/web/scripts/model/signals.js"
  - "src/web/scripts/model/signal-keys.js"
  - "src/web/scripts/components/signal-*.js"
  - "src/web/scripts/tests/signal*.test.js"
  - "src/web/scripts/tests/engine-signals.test.js"
---

## External signals

**Bench stimulus that lives OFF the boards** (Feature 370): a **signal button** pinned to
the desk viewport's right edge plus a **signal flag** whose apex plugs into one breadboard
hole. Pressing the button injects a level there. `model/signals.js` (pure) +
`model/signal-keys.js` (pure) + `components/signal-rail.js` (the buttons) +
`components/signal-layer.js` (the flags) + `doc.signals` / `nextSignalId`.

- **A signal is the first desk item that is neither a component nor decoration.** An
  annotation is invisible to occupancy, the netlist and the engine; a wire is visible to
  occupancy and the netlist; a flag is visible to **occupancy and the ENGINE**, and is
  neither. Exactly three modules assume "everything electrical is a component" —
  `buildOccupancy`, `sim/engine.js`'s `buildContext`, and `schematic-layout.js`'s
  `layout()`. Each gained ONE loop, and each must stay the only one. Making it a fake
  component kind would drag in footprints, a catalog def, `normalizeParams`,
  `partPinAddresses`, the part menu's fixed three-item shape, the BOM and the build guide,
  none of which has anything to say about a bench button.
- **The record** is `{ id: "sig<n>", color, type: "momentary"|"toggle", rest: "low"|"high",
  name?, description?, flag?: { anchor, rot } }`. The three scalars are stored ALWAYS,
  departing from omit-when-default deliberately: that convention exists to keep an existing
  serialized form byte-identical, and a signal has none. `flag.rot` is a DESK rotation, and
  the anchor is an address, so a rotated rail carries its flags with no code at all.
- **The signal palette is the jumper palette MINUS BLACK** (`SIGNAL_COLORS`), derived by
  subtraction so a new jumper colour reaches signals for free. Black is the bench's ground
  colour: a black flag reads as a ground tie and its button's dot vanishes against the dark
  rail. Excluded rather than discouraged — the picker cannot offer it, `addSignal` cannot
  mint it, and a stored one is repaired on load.
- **The cap is the DIGIT ROW** — `SIGNAL_KEYS` is `1`…`9`, `0` (digit-row order, so `0`
  is the TENTH), and `MAX_SIGNALS = SIGNAL_KEYS.length`, so it is **10**, never a typed
  number. Every signal has a key, which is the whole rule: there is no eleventh because
  there is no eleventh key. It used to be the colour palette's length (7) while a colour was
  a signal's identity; that coupling is GONE.
- **Colours CYCLE and may repeat** (`nextSignalColor`): a new signal takes the LEAST-USED
  signal colour, ties by `SIGNAL_COLORS` order — the first colour nobody holds, then a
  second lap from the beginning once all seven are used, and a deleted signal's colour is
  the next one handed out. So the colour is presentation, not identity: the Properties
  picker offers all seven, `updateSignal` accepts one another signal holds, and a loaded
  duplicate is legal. **The identity tying a flag to its button is its KEY** (`signalKey`,
  derived from rail position — never stored), printed on both.
- **A colour repair moves as little as it can.** Only a colour that is not a signal colour
  (black, junk) is repaired, and `normalizeDocument` gives it `nextSignalColor` over every
  colour already KEPT on the rail (later signals' included), each repair joining the pool
  before the next — so it lands in a gap rather than shoving the rest along.
- **THE RULE for a homeless flag, stated once and reused verbatim**: *a flag with nowhere
  to go stops existing; the SIGNAL never does.* `normalizeDocument` owns the sentence;
  `removeBoard`'s `#detachSignalFlags` and `pasteDesign` reuse it. A bad colour is
  REPAIRED rather than dropped — a colour is presentation, and losing a stimulus source to
  a cosmetic fault is the wrong trade. Past `MAX_SIGNALS` a signal is dropped
  (`addSignal` throws `SIGNALS_FULL`).
- **Occupancy claims the flag's hole — one hole, one lead — and the loop runs FIRST.**
  `buildOccupancy` is last-writer-wins while `normalizeDocument` is first-wins (pins →
  wires → flags), so appending it last would invert the precedence. A normalized document
  never collides, but `buildOccupancy` also runs against live mid-mutation documents, and
  of the two ways a collision could read, a flag masking a WIRE END is the harmful one —
  `canReendWire` would then refuse to move that wire's own end, wedging it for good.
  `canPlaceFlag` is `canReendWire`'s argument one item over: free, ignoring the moving
  signal's OWN claim, which is what lets one method serve planting AND moving.
- **The rail is pinned BETWEEN the padlock and the zoom cluster**, and it is the first
  piece of desk chrome with a variable height. The desk's corner chrome is kept apart
  by POSITION — each piece measured out of the others' way — not stacked by `z-index`,
  so the existing convention was extended rather than broken: `--desk-zoom-height` joins
  `--desk-lock-size` on `.app-stage`, and **`.desk-zoom` itself consumes it**, so the two
  cannot drift. A doc change REBUILDS the rail (≤10 rows); a `chiphippo:sim-state` toggles
  CLASSES ONLY, because that event fires on every tick. While STOPPED a button shows its
  `rest`, so a toggle that did not survive a Run never looks like a bug.
- **The menu's two exits are worded apart**: **Remove Signal** is the UNPLUG
  (`DeskController.unplugSignal` — the flag goes back to its button, anchor AND rotation
  dropped, the signal stays; the bare-desk drop calls the same method) and **Delete
  Signal** is `removeSignal`, the whole signal, as the Delete key. Remove stays present but
  DISABLED for an unplaced signal (the Add-to-analyzer precedent), so the menu's shape
  never changes; unplugging drops the flag's selection, or its rail button stays lit.
- **ONE `drag-signal-flag`, two entry points** — the rail's unplaced chip and the planted
  polygon — because "drag it onto a board" and "move it to another hole" are the same act.
  `worldFromEvent` reads client coordinates off any event, so the rail chip is not a
  coordinate-space problem. Drop on (or within a hole's reach of) a free hole plants
  there; **clear of every hole unplugs**; aimed at a board with nothing free in reach
  reverts. `inReach` is that difference, and it is deliberately NOT red with nothing in
  reach (the unplug is a real action) and red with every hole in reach taken: a mis-aim
  is not an intent to unplug. The Output/Input tag drag is the same rule.
  - **The preview redraws ONE polygon IN PLACE** (`SignalLayer.setPreview`), and
    `setSelected` is a class toggle — both for the same load-bearing reason: the press
    calls `selectSignal` BEFORE beginning the gesture, so a re-render there destroys the
    very `<polygon>` that press is about to capture, and a re-render per pointermove would
    destroy it again every frame.
  - **The flag carries ONE CHARACTER — its key**, on the rail button's dot drawn on the
    flag. At rot 90/270 the body is barely over a pitch wide with nowhere for a horizontal
    NAME (that lives on the button), but a single UPRIGHT glyph fits the body at every
    angle (`flagKeyPoint`, the body's centre, rotated with the flag while the glyph is
    not; `FLAG_KEY_R` sized to clear the point). It is a pointer-inert `<g
    class="signal-flag-key">` (disc + digit, ONE translate) BESIDE the polygon, which stays
    the one hit target and the one node carrying `data-signal-id`; `setPreview` moves both
    in place. **The flag IS an Output/Input tag's glyph** — `integration.js`'s `TAG_W` /
    `TAG_LEN` / `TAG_KEY_R` / `tagPolygon` / `tagLabelPoint` are `signals.js`'s flag
    constants and functions under their own names, and the digit is the tag label's type —
    so both are wider than a pitch and neighbours overlap; each layer draws every body in
    one group and every key/label in a second above it. The disc is TRANSLUCENT and DERIVED: `--signal-flag-alpha` (0.4375) is the one
    body opacity (the Output/Input tags and their waiting chips share it), and the disc
    takes `a / (1 − a)` so disc-over-body composites to exactly 2a. The digit's size is world px (a `type-scale.test.js` exemption); a digit is not a
    word, so there is still nothing for i18n to reach.
  - **Selecting a flag lights its button.** `SignalLayer.setSelected` is already the ONE
    seam every highlight goes through (`#applySelection` and `forgetAll`), so it reports to
    an `onSelect` callback → DeskController's `onSignalSelect` option → app.js →
    `SignalRail.setSelected` (a class toggle, remembered across a rebuild).
- **The engine treats it exactly as a clock source**: `ctx.signals` in `buildContext`, one
  `add(sig.net, signalLevels.get(sig.id) ?? Z)` in `driversFor`, and `signalLevels` threaded
  through **all THREE `solve` call sites** (`settle`, `tick`'s pre-settle, and `tick`'s
  inner-loop re-settle — miss the third and a ripple tick drops every signal).
  `sim/resolve.js` changes NOT AT ALL: being a `chipLevels` contributor is what makes two
  signals fighting, or a signal against a chip output, report a conflict with no new code.
  A fourth strength tier would have had to re-define what beats what.
- **`SimController.pressSignal(id, on)` is the ONLY public entry point**, and the only
  place momentary/toggle is decided. The rail and the keyboard both report down → true, up
  → false and know nothing about the difference — if they did, a key and a click could come
  to disagree about what a press means. `#signalLevel` is run-volatile like `#clockPhase`:
  seeded from `rest` on Run, cleared on Stop, republished on `chiphippo:sim-state` so the
  rail lights up from the ONE broadcast. A toggle deliberately does not survive a Run —
  `rest` is the single durable answer to "what is this signal holding".
- **Bare digits (`1`–`9`, then `0`), and only while RUNNING** (`model/signal-keys.js`).
  Conflict-free by construction: `handleKeyDown` claims `1`–`9` only while the wire or bus
  tool is armed, Run disarms both, and bare `0` has no other claim. The signal block sits
  AFTER `controller.handleKeyDown` in app.js, which makes that precedence a fact of the
  code rather than a claim about tool state. The held set is a **Map, key → the signal id
  it PRESSED**, so a release always reaches the
  signal that was pressed even if the rail changed underneath. **Release is gated on
  nothing** — not the run state, not the popup guard, not the typing guard — and has three
  legs (keyup, window blur, the transport stopping), because a stuck signal is far worse
  than a missed press.
- **Design clips are the one place all-or-nothing bends.** A signal travels only when its
  flag is planted on a captured board (the wire rule); an unplaced one stays behind.
  `color` is deliberately NOT captured — colours are handed out per desk, so the next in
  the destination's cycle is issued on arrival. Paste is BEST-EFFORT: at the cap → dropped
  (and REPORTED in the notification `#dropDesign` already raises); hole taken → arrives
  unplaced. Boards, parts and wires stay
  all-or-nothing because that rule exists to stop half a design cutting the wires that
  crossed to the board left behind — and *a signal cuts nothing*.
- **The schematic follows the POWER STUB precedent, not the node one** — a signal can never
  be a `layout()` node, which walks `doc.components` through `symbolFor`. One `signalStubs`
  entry per planted flag at the first port of its net in sorted order (deterministic), drawn
  by `buildSignalSymbol` from **the same `flagPolygon` the desk uses**. A signal on a net
  with no symbol port draws nothing, which is honest: there is nothing there to stimulate.
- **The analyzer needed almost nothing**: `doc.scopeChannels` already binds `kind:"net"` to
  a member ADDRESS, and a planted flag's anchor is one. The flag's menu calls the
  `onAddNetToAnalyzer` callback the probe already uses; `ScopeView.addNetChannel` was only
  widened to forward the `{color, label}` `DeskDoc.addScopeChannel` had always accepted.
- **`WIRE_COLORS` moved to `model/wire-colors.js`** (whose header already called itself the
  tokens' file) and is re-exported from `desk-doc.js`, so no call site changed. Necessary,
  not tidying: `desk-doc.js` imports `signals.js`, so `signals.js` reaching back for the
  palette would be an import cycle whose top-level `WIRE_COLORS.length` reads a TDZ binding
  and throws.
- Out of scope, deliberately: the **build guide and BOM** (a signal is bench stimulus, not
  a part you buy or solder) and **user-positionable rails** (`railOrder(signals)` exists so
  a reorder has exactly one place to land).
