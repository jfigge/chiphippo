---
paths:
  - "src/app/ai/**"
  - "src/web/scripts/ai/**"
  - "src/web/scripts/model/autobuild*.js"
  - "src/web/scripts/model/pin-resolve.js"
  - "src/web/scripts/model/spec-lint.js"
  - "src/web/scripts/model/column-allocator.js"
  - "src/web/scripts/model/wire-crossing.js"
  - "src/web/scripts/components/ai-panel.js"
  - "src/app/store/credential-store.js"
  - "src/web/scripts/tests/ai-*.test.js"
  - "src/web/scripts/tests/autobuild*.test.js"
  - "src/web/scripts/tests/pin-resolve.test.js"
  - "src/web/scripts/tests/spec-lint.test.js"
  - "src/web/scripts/tests/column-allocator.test.js"
  - "src/web/scripts/tests/wire-crossing.test.js"
  - "src/web/scripts/tests/generated-design.test.js"
---

## AI circuit builder

`app/store/credential-store.js` + `app/ai/{providers,client}.js` +
`model/{pin-resolve,spec-lint,column-allocator,autobuild,autobuild-verify,wire-crossing}.js` +
`web/scripts/ai/{catalog-brief,generate,connection,usage}.js` + `components/ai-panel.js`.

**An LLM cannot emit geometry, so it is never asked to.** The model answers exactly one
question — which parts, and which of their pins share a net — as a coordinate-free
`{parts, nets, tests}` spec, and a pure, DOM-free compiler decides every hole, column,
anchor and wire.

- **The compiler interposes what a netlist must not have to mention.** `sim/junction.js`
  (the LED burn rule, moved out of the view because it is PHYSICS) is why a series
  resistor is added automatically — in EVERY lamp leg the spec puts straight on a rail
  (`lampLegs`: a display's common leg, an isolated segment, a bare LED's cathode on GND
  or its anode on VCC over an active-low output). Legs are limited per NODE: the lamp legs
  one rail net holds are already joined, so they are one common leg and take one
  resistor, as a common-cathode bar does; legs on different nets pack eight to an `rnet9`
  with COM on the rail. A **bare LED** is the exception to both groupings: it gets a
  `resistor` of its OWN, plugged in (`seatPlug`, below) — one per LED even when the spec
  puts several cathodes in one GND net, since a resistor can plug into only one lamp's
  column. The legs are moved OUT of the rail net, never the rail off it —
  a named `GND` net holds everything else tied low, and detaching its rail once hung all
  of it off the lamp's side of the resistor. The **pull rule** is the same fact one step over: a
  switch is a CONTACT, not a source, so an input fed from one floats when the switch is
  open — and a floating TTL input reads HIGH, i.e. a switch that appears to do nothing. A
  signal net with no rail, no output driver and no resistor of its own, whose only path
  to a supply runs through a contact, gets a pull to the OPPOSITE rail (`contactPairs`
  probes each def's own `internalBridges` at both extremes of its parameter domain,
  rather than adding a second catalog field that could drift). Which rail is READ off the
  far side of the contact, never assumed (a GND-side switch gets a pull-UP); a net whose
  contacts disagree, or reach no rail, is left as declared for L6 to report. Pulls to one
  rail pack eight to an `rnet9`; a lone one is a bare `resistor`.
- **Compile** (`autobuild.js`): `compileNetlist(spec)` → `{document, warnings, partMap,
  nets}`. Power is DERIVED — every def declares `role:"vcc"|"gnd"`, so a spec never lists
  a power pin; the compiler wires them, plants a PSU, and bridges the kit's two rail
  strips. `column-allocator.js` hands out EXCLUSIVE column runs, which makes the worst
  machine-generation bug — two parts sharing a column-half, hence silently shorted —
  unrepresentable rather than merely unlikely. Routing is per-net star-from-hub over
  `freeAt` (you never wire TO a pin, you wire to a free hole on the pin's NODE), the hub
  being the highest-capacity port (a rail is ∞), and a port is keyed by its NODE so two
  pins already sharing one are never wired to each other.
- **Boards snap together and a stacked pair shares the rail between them** — rule 1 of
  "Power layout" below, which the compiler shares with every other generator here
  (`railSpineOrder` is rule 2, `railLink` rule 3). The compiler emits one RUN of strips,
  `rail · pins · rail · pins · rail`; the shared strip sits in BOTH kits' `rails`, the
  bridge loop CHAINS (R0–R1 across the first board, R1–R2 across the second), and
  `railStripIds` is read off `boards` rather than off `kits`, whose lists now overlap
  (walking the kits would offer the shared strip's holes twice). The run carries ONE
  `group`, as `DeskDoc.addKit` gives a palette-placed kit (`pasteDesign` re-mints the id
  on the way in).
- **Placement is a step, not an accident.** Three rules decide the layout; together they
  took the 8-bit adder from two breadboards and 74 wires to one board and 58, and across
  all 51 demo benches −18% wire and 104 fewer wires.
  - `orderByConnectivity` — greedy cluster growth from the busiest part, then whichever
    unplaced part shares the most nets with what is down. Since the seating loop fills
    one board before starting the next, an order where neighbours are adjacent also keeps
    a net's parts on ONE board, and the cross-board wires that remain fall on the
    genuinely least-connected seam. RAIL nets are deliberately not adjacency (every part
    touches power, and a rail net routes to the nearest rail hole). Ties break by spec
    order, so a spec always lays out the same way.
  - `seatCompanion` — a pull pack seats IN the columns of the switch bank it pulls (an
    `rnet9` under a `sw-dip8` buys eight pull-downs for zero wires and zero columns).
    Sharing a column-half is otherwise the exact disaster `column-allocator.js` prevents,
    so NOTHING is inferred: the net equality is given (the pull rule CREATED one net per
    pack pin), the geometry is proved pin by pin with `nodeOf`, and every column touched
    must be free or the host's (hence `columnOwner`, and hence a column recording WHO
    owns it). Any check failing returns null and the part seats the ordinary way, so this
    can only cost columns, never correctness; L4 checks the result regardless. One host
    per pack only.
  - `seatPlug` — a bare LED's resistor PLUGS IN, as on a bench: the lamp seats in row b,
    the resistor stands (rot 90) with its top lead in row a of the lamp's RAIL-LEG column
    and its other lead bent straight down into the matching line of the rail strip below
    (`-` for a cathode on GND, `+` for an anode on VCC). Lamp → resistor → rail is then
    joined by the board, with no wire between them; only the output's wire to the lamp
    remains (it was three: output → lamp → resistor → rail). The rail is drilled in
    groups of five, so where the column has no hole straight across the lead leans up to
    `PLUG_LEAN` (2) columns, away from the lamp's other leg; rail holes under its body are
    claimed and left empty. Same proof discipline as `seatCompanion` (the resistor rule
    CREATED the LIMITED net, the landing is proved through `partPinAddresses`), same
    fallback (null → seated the ordinary way, wired). It costs no columns, so the kit
    budget counts it at 0; to the router its rail lead IS the rail (`seat.rails` →
    `railPort`), and a bare LED's routing box is widened to its dome (`LAMP_DOME`).
  - `freeRail(…, {fromEnd})` — the PSU brick stands off the RIGHT of the boards, and a
    rail is one node end to end, so reaching for hole 1 bought nothing but two wires the
    width of the desk.
- **Seating is two passes, and a second breadboard is a LAST RESORT.** Pass 1 fills each
  board before starting the next — the only way to learn how many boards a design
  actually needs, which the column budget cannot know.
  - **The blank column goes before the board does.** `GAP` is a courtesy (so neighbours
    do not read as one block), but insisting on it fetched a whole breadboard for a
    1-column shortfall, so a spilled design is re-seated with `gap = 0` and that is kept
    ONLY when it saves a board. This alone took the demo corpus from 9 multi-board
    circuits to 1.
  - **The split is CHOSEN, not fallen into** (`splitAcrossBoards`, pure): a design that
    genuinely needs two boards is cut where it severs the FEWEST NETS, not at the halfway
    column (a naive even split turned 8 cross-board wires into 22). Every position
    leaving the board reasonably filled (`FLOOR`) is a candidate, ties go to the evenest;
    RAIL nets are excluded (every part touches power, so they sever nothing); a companion
    costs 0, since it rides its host's columns. The assignment is a **preference, never a
    refusal** (assigned board first, then every board), and a re-seat needing MORE boards
    is discarded for the one that came before it. Corpus-wide: −13% strips, −8% wire
    length, −11% crossings. A serpentine fill was tried and REJECTED — it only helps when
    the first board is full to its last column, and with a properly chosen split it
    rarely is (with a half-filled first board it made the 8-bit bus port 43% longer).
  - **Kits are PRUNED, not predicted.** The column budget must assume a pull pack costs
    its nine columns and companion seating then costs none, so a design that fits on one
    board was handed two and the spare shipped EMPTY with bridges stitched across it.
    Nothing tries to estimate better (guessing low costs a `NO_ROOM` refusal, which is
    not recoverable; guessing high costs a board that is simply given back). Seat first,
    then keep only the kits something landed on — which is also why the power wiring and
    routing moved AFTER seating. A design with no seated parts keeps the first kit (the
    PSU still needs a rail to reach).
- **Routing minimises length AND crossings** (`model/wire-crossing.js`, pure). A DIP
  straddles the trench with pins in rows e/f and everything else the compiler seats lies
  along row `a`, and a wire attaches to a free hole on the pin's NODE — which offers five
  ROWS. Taking "the first free hole" took row `a` every time, the one row every discrete
  occupies. So a port OFFERS its free holes and `bestPair` picks by
  `distance + 20 × crossingCount`, `segmentHitsBox` being Liang–Barsky (sampling steps
  over a corner clip, and near-misses read as crossing). The same chooser does the POWER
  wiring, so nearest-that-flies-over-nothing picks the rail on the pin's own side of the
  trench with nothing told to it — and the bridges and PSU leads are wired AFTER seating,
  since before it there is nothing to avoid and a bridge always went down column 1,
  exactly where the first part goes. Residual crossings are REPORTED
  (`WIRES_CROSS_PARTS`), never hidden: a net joining a pin below the trench to one above
  has to get across. Corpus-wide: wire length −38%, crossings −44% (932 → 518).
  - **The router tests the wire as DRAWN** (`drawnCrossings` over `drawnWire`, the same
    sagging quadratic `desk/wire-path.js` draws), and excuses a part only while an END
    of the wire is inside it — not for being the part the wire leaves from. A chord test
    missed that a long run hangs a pitch or two below its chord, and the owner excuse let
    a lead leave beside its part and run back across it. The residual REPORT keeps the
    owner excuse (a count of wires over somebody else's part), as `wireCrossings` does.
  - **A part you OPERATE seats in row h** (`seatRowOf`: anything with `contact` pins —
    slide switch, push buttons; a DIP bank straddles anyway), with a routing box widened
    to `OPERATED_MARGIN` (0.95 — knob ±0.45 plus half a wire's hit stroke). Wires draw
    above parts, so a wire over a knob swallows the click: in row a, all 219 switches the
    corpus compiles were covered (supply lead up across the knob, every run above sagging
    onto it). Row h is the demo bench's row for the same reason — rail lead from i/j
    above, signal from f/g below. Row e was measured and is worse (where every
    trench-crossing wire passes). Together: knobs covered 219 → 3, drawn crossings over
    any part 1840 → 167, wire length +0.5%, same wires and strips.
- `pin-resolve.js` is FAIL-CLOSED and case-FIRST: pin names are case-distinguished in the
  catalog (74LS47's `A`–`D` inputs vs its `a`–`g` outputs), so folding case would
  MANUFACTURE ambiguity. The one real ambiguity is `74LS148` (inputs *named* `0`–`7` that
  do not match their pin numbers), reported with both readings, with `#N` as the escape.
  - **Punctuation that means something is kept** (`canonical`). An overbar, a leading
    `/`/`~` or a trailing `'` all say "complement / active-low", so `1Q'`, `/1Q`, `~1Q`
    and `1Q̅` are `1Q̄` and never `1Q`; `>`/`<`/`=` name different '85 pins. Stripping it
    all once made 26 same-role pairs across 10 chips identical, and the lowest pin won —
    `1Q'` silently wired the TRUE output. A loose match landing on two DIFFERENT names is
    reported (`oneName`), never collapsed; only identical names (`NC`, `VSS`) are
    interchangeable.
  - A marked token may name a bare INPUT (`/CLR` → the '161's `CLR`; a chip never has
    both) and a bare token a marked pin (`INT` → the Z80's `/INT`), but a marked token is
    REFUSED on a bare OUTPUT: `1Q'` on the '174 asks for a complement the part does not
    have.
- **The spec is linted before it is built** (`model/spec-lint.js`, pure) for what the
  engine rightly lets through. `OUTPUT_ON_RAIL`: supply beats chip output
  (`sim/resolve.js`), so an output in a VCC/GND net settles, verifies and drives nothing.
  `MULTIPLE_DRIVERS`: two `output` pins may share a net only when EVERY one can be
  switched off — a BUS — which `switchableOutputs` PROBES from the evaluator (every enable
  at its OFF level → whatever reads Z) rather than assuming from the enable, since the
  '595's OE leaves `QH'` driving. `io` pins are left to the engine. Output enables come
  from **`outputEnablePins(def)`** (`catalog/index.js`) as `{n, on}` — the declared
  `outputEnable` (active LOW) and `outputEnableHigh` (active HIGH: the CD4094B's, the only
  one), or a memory's own `ceN`/`oeN` read off `logic.memory` — never declared twice —
  which is what gives memory CE/OE their `!` and lets two ROMs share a data bus.
  `outputEnables(def)` is the same list as bare pin numbers. Every consumer reads the
  polarity: the verifier's `OUTPUTS_DISABLED` says "active-HIGH … tie it to VCC" for the
  4094, and the desk review has its own two sentences for it.
- **Verify** (`autobuild-verify.js`): the L3a–L7 ladder, faults tagged `abort` (OUR bug)
  or `repair` (the SPEC's mistake) — the split the panel's retry loop needs. **Faults name
  parts and nets in the SPEC's terms** (`partNamer`, `electricalNamer`): `U2 (74LS244)`,
  `"BUS"` — never the document's `c7` or a net's smallest member address, which the model
  never wrote and cannot act on.
  - **L4** compares the DECLARED net partition against the one `buildNetlist` DERIVES —
    the only thing that catches an accidental short (counts match, it loads clean, it
    settles, and it computes something else). It derives that partition from **wiring
    alone** (`{bridges: false}`, every switch treated as an open contact), because a
    switch thrown to a rail genuinely does make its signal net that rail, and holding
    THAT against the declared topology condemned the most ordinary input stage there is
    (every slide-switch design aborted as `NET_SHORTED_TO_RAIL`, a fault the model could
    neither cause nor repair). A severed net and two parts sharing a column-half are
    facts about wiring, which no switch position can hide or invent; a real electrical
    short is L5's to report, from the conducting netlist it keeps.
  - **L5** settles with every clock idle-low — a bare `settle` leaves a clock line at `Z`
    and L6 would report a good circuit as undriven. It also asks `burntLamps` (`LED_BURNS`):
    a burnt junction is physics, not an engine warning, so nothing else reports a lamp
    wired between two outputs.
  - **L6** uses the tri-state data: a net that floats with a tri-state driver on it
    reports `OUTPUTS_DISABLED`, naming the chip, the pin and "tie it to GND" (or, on a BUS,
    "exactly one enable LOW" — tying two low starts a fight), instead of `NET_NOT_DRIVEN`
    sending a repair round hunting for a wire that was never missing. An `X` net is
    `NET_UNRESOLVED`, not "undriven". A net on an analog switch's OPEN channel
    (`openChannelNets`) floats by design and is exempt — seven of a 4051's eight are —
    while one on a CLOSED channel with nothing on either side is still undriven. And
    `INPUT_FLOATING` (`floatingInputs`) names every
    input a part USES that no net connects — an input on no net is invisible to a net
    sweep and reads HIGH. "Uses": a unit whose output is wired needs all its inputs (the
    spare gates of a 7400 may float; a switch CHANNEL with a terminal wired needs its
    controls, so a 4066's spare controls are the compiler's to tie); a part without units
    is read by the datasheet's
    `1…`/`2…` section numbering, and an unnumbered input (a shared CLK, an address line,
    a counter's load data) is needed once any output is.
  - **L7** is the highest-value one: the spec states its own acceptance tests and the app
    RUNS them, so a perfectly-built adder with its bit order reversed is caught. Bit
    ordering in `set`/`expect` is PINNED by a test, not inferred. A pattern must give
    EVERY position (a short one once left the rest open silently), `edges` needs a clock
    (it once settled instead and compared against power-on), a test must expect
    something, and an `expect` pin goes through `resolvePin` like a net member. Each test
    starts from the switches AS BUILT, and each test STATE is checked for shorts, fights,
    oscillation and burning lamps no expectation mentions. A test that cannot be run as
    written is `TEST_INVALID`, a different repair from `TEST_FAILED`.
  - **The SUITE is the AI builder's rule, not the verifier's** (`ai/generate.js`
    `testSuiteFaults`, which other callers never run): at least `MIN_TESTS` (the prompt
    quotes the constant), and no two applying the same inputs (`DUPLICATE_TEST`) —
    reported beside whatever else failed, so one round fixes both.
- **Every generated circuit explains itself.** The spec carries a `notes` paragraph and
  `assemble` stamps it above the boards as a caption, in the line pitch and muted body a
  demo bench uses — a generated circuit and a shipped demo should read the same way on
  the desk. It is **anchored to the leftmost seated part** — load-bearing, since
  `captureDesign` carries ONLY anchored labels, so an unanchored note would be silently
  dropped on the way to the ghost. `wrapText` breaks to 64 characters because a label is
  `white-space: nowrap` (a word longer than that overflows rather than being cut, and
  `.annotation--label` clears the shared `max-width`). The 30-line cap is a GUARD, not a
  budget (~1900 characters), and a trim marks its last line with an ellipsis, because a
  caption that simply stops reads as one written badly. The prompt states the length it
  wants (four to eight sentences). The same paragraph is handed back on the build result
  so the panel can say it while the user is still deciding whether to place the design. A
  `title` with no notes still captions the circuit with one line.
- **Place**: the output is a **design clip** (`designClipOf` = `captureDesign` with
  everything selected, never a second converter) handed to
  `DeskController.armGeneratedDesign` — a ghost the user positions, NOT a circuit that
  appears. `applyGeneratedDesign(clip, {at})` drops it outright (shift from
  `nearestLegalOffset`). Both go through the one `#dropDesign`, so a generated circuit is
  ONE undo step on the same atomic `pasteDesign` transaction as a paste — there is
  deliberately no `applyBatch`. A build that finishes while the circuit RUNS is HELD
  (`app.js` `heldDesign`; the panel says `ai.placeAfterStop`) and armed at Stop. A Stop
  that is a desktop or project SWAP's (`ProjectWorkspace#stopForSwap` says
  `chiphippo:desk-leaving` first) keeps it held, and the desk that arrives is armed with
  it on `chiphippo:desk-loaded` — arming it at the Stop put the ghost on the desk the
  swap then replaced, and the paid build was gone (2026-10-10).
- **The prompt is DERIVED, never hand-written** (`ai/catalog-brief.js`):
  `buildCatalogCard()` projects `BUILDABLE_DEFS` for the builder (`PALETTE_DEFS` minus the
  `can` oscillators the compiler refuses, the capacitors, every `isTimed` part and every
  part with a KNOB — a `"range"` property, the potentiometer's wiper — since a netlist spec
  has nowhere to state a VALUE or a setting, a timer is nothing without its R and C, and a
  pot at the end of its track is a wire; the review keeps them all) — ids, packages,
  exact `n:name` pin lists, and a part's `buses` for the `A[3]` member form —
  `JSON.stringify` would silently drop the FUNCTION fields), so a new 74xx part reaches
  the model the moment it lands in `catalog/`. ~4.4 K tokens, over the prompt-cache
  minimum, so a repair round re-reads rather than re-pays. Each pin carries a
  one-character MARK (`pinMark`): `>` output, `<>` bidirectional, `!` **active-low output
  enable**, `^` the active-HIGH one (the CD4094B's — "tie every enable LOW" would disable
  it), `~` an analog switch terminal (it CONNECTS and drives nothing, so the model must
  never count on one as a source). The first exists because "two outputs must not share a net" is a rule the
  compiler ENFORCES; the `!` is the one fact nothing else reveals (the pins are called
  `1G`, `OE`, `M`, `N`) and getting it wrong is silent — the part floats every output it
  gates, an unwired enable reads HIGH, and a datasheet-correct netlist comes up dead. A
  repair round is also told what the compiler CHANGED (`RESISTOR_INSERTED`,
  `PULL_INSERTED` — `buildRepairMessage`'s notes), since a level the model did not expect
  is often a pull it never asked for; a ROM warns the USER it arrives unprogrammed
  (`ROM_UNPROGRAMMED`) — a netlist has nowhere to carry memory contents.
- **Tri-state is DECLARED, then PROVED** — `outputEnable: [pins]` on the nine 74LS parts
  that have one and `outputEnableHigh` on the CD4094B, plus `tests/chips-tristate.test.js`
  (which also proves a memory's DERIVED enables against `memUnit`). Not derived, because the catalog
  expresses tri-state four ways and only one is introspectable (a `BUF3` unit '125/'244;
  a `COMB` returning `Z` '240/'245/'257; a sequential `outputs()` returning `Z`
  '173/'533/'573/'595/4094; a memory image). So the test probes the REAL evaluator: every
  declared pin, taken to its OFF level, must float an output that drives at its ON level
  (pinning each enable's polarity), and a behavioural sweep requires any part that floats an output to declare
  one — which is what found the '595, whose title never says "tri-state". `74LS245`'s
  `DIR` is deliberately NOT an enable (it picks which side drives; only `OE` stops both),
  and the Memory/Interface/PROCESSOR groups are out of the sweep — a CPU or PIA floats
  its bus on a PROTOCOL and its ports on a direction register, neither of which is a pin
  anyone can tie.
- **The compiler's corpus is the DEMO BENCHES** (`tests/autobuild-corpus.test.js`).
  `scripts/demo-specs.mjs` describes 52 circuits — one per 74xx part, each proved through
  the real engine by `make demos` against a datasheet truth table — and is ALREADY
  coordinate-free (`inputs`, `ties`, `links`, `clock`, `leds`), so a forward mapping
  turns each into a netlist spec. Every one is compiled and verified on `make test`, with
  no API key and no network. Deliberately a forward map from the SPECS, never a
  reverse-compile of the committed documents: a document's derived netlist includes
  whatever its switches are currently conducting, which would promote a transient switch
  position into declared topology. Two exception lists carry what the DSL cannot say,
  each named and argued: the `route` demo (a switch that STEERS a signal) and the seven
  tri-state parts whose demo hangs an enable on a switch (a spec cannot state a switch's
  RESTING position; the answer is to tie the enable, which the prompt says and the corpus
  proves builds clean).
- **The renderer makes NO network call** — its CSP is `default-src 'self'` with no
  `connect-src`. `ai/client.js` uses Node's global `fetch` (no runtime dependency of its
  own; `electron-updater` is the only entry in `src/package.json`'s `dependencies`) with
  an `AbortController` registry keyed by request id and an SSE reader that carries the
  tail across chunk boundaries. `app/ai/providers.js` holds BOTH adapters in one file
  behind `buildRequest`/`readEvent`/`buildPing`; nothing else branches on provider. **A
  refusal is a failure** — Anthropic returns HTTP 200 on a policy decline, so
  `stop_reason:"refusal"` is checked before the text is used. `ai:test` pings with
  `buildPing` (unstreamed, unschema'd): Test connection asks "can I reach you", so it
  must not fail because a model declined to fill a netlist.
- **The key never crosses the bridge.** `credential-store.js` writes it through
  `safeStorage` into `userData/credentials.json` and REFUSES rather than falling back to
  plaintext when the OS has no store; `ai:key:status` answers
  `{configured, encryptionAvailable}` and nothing more. That is why it does not ride
  `settings:set` — settings.json is plaintext and is handed back whole on every read.
  Only the NON-secret half (`ai: {provider, baseUrl, model}`) lives there. The provider
  LIST is itself IPC (`ai:providers`), so the Settings picker cannot drift from the
  adapters.
- **The panel** (`components/ai-panel.js`) shares the analyzer's docked shell and the
  toolbar-pill segment discipline. `ai/generate.js` is the DOM-free seam (`parseNetlist`
  → compile → verify → clip), so a whole generation is testable with no window and no
  network; the clip is taken from the VERIFIED (loaded) document, since what the desk
  places must be what the loader would keep. Repair rounds cap at **2** and only
  `repair`-class faults are sent back — the model cannot fix our compiler.
  `ai:delta`/`:done` are a SEPARATE message stream from the `ai:start` invoke result, so
  pushes that beat the reply back are held and replayed rather than dropped.
- **No connection, no segment.** The toolbar's AI segment is **disabled** until there is
  something to ask: `ai/connection.js` (pure) reads the settings' `ai` config, the
  `ai:providers` list and `ai:key:status` for the provider the Settings picker would show
  — one `effectiveProvider` rule, so the button can never be gated on a key for a
  provider the panel isn't showing. Validity is decided WITHOUT asking the provider
  (nothing is sent anywhere until the user asks for a build): a key is stored, the
  provider has an adapter, and a typed base URL parses as http(s). Whether the server
  would ACCEPT the key is Settings ▸ AI's Test connection. Every refusal carries the
  sentence the disabled button shows as its tooltip. The two ways the answer changes are
  a settings patch carrying `ai` and the key itself (which bypasses settings entirely —
  hence the dialog's `chiphippo:ai-key-changed` broadcast, saying only THAT it changed).
  The remembered `aiOpen` is restored only once the answer is known, and a key cleared
  while the panel is open closes it.
