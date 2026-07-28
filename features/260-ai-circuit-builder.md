# Feature 260 — AI circuit builder (bring your own connection)

## Context

Every circuit on the desk today is placed hole by hole. That is the point of the app for
learning, and it is also the wall you hit when you know *what* you want — "an 8-bit adder
with a carry" — and simply want the boilerplate laid out so you can probe it, break it,
and understand it. This stage lets the user describe a circuit in words and get a real,
wired, **simulation-proven** desktop back.

Two facts about the tree shape the whole design.

**There is no network code anywhere, and no credential storage.** `src/package.json` has
no `dependencies` block at all; `main.js` imports no `net`; nothing calls `fetch`. The
renderer is sandboxed and its CSP is `default-src 'self'` with no `connect-src`, so a
renderer-side call to any API is refused outright. And `settings.json` is plaintext 0644
in `userData`, so an API key must not ride the ordinary `chiphippo:settings-changed` path
— anything emitted as a settings patch is written in the clear *and* re-seeded into the
Settings dialog on every open. The AI call therefore lives in **main**, exactly as
filesystem I/O does, and the key lives behind Electron's `safeStorage`.

**A language model cannot emit breadboard geometry, but it can emit a netlist.** Getting
~57 wire endpoints, `e<col>` anchor columns, and per-hole occupancy right in one shot is a
losing game. Naming two 74LS283s and saying which pins connect is not. So the model emits
a **coordinate-free netlist** and a deterministic, pure, tested compiler turns it into a
document. This is not speculative: `scripts/make-demos.mjs` already builds a 65xx computer
(CPU + ROM + VIA + inverter, ~60 wires) from code and validates it by running the real
engine, and this stage promotes that private `builder()` into a first-class module.

**Groundwork already landed** (ahead of this plan, and standing on its own):

- `web/scripts/tests/engine-adder.test.js` — the motivating circuit built from the catalog
  and proven by `settle` across ten operand vectors including `0+0` and `255+255`. 57
  wires, one Full-830 kit, settles in 3–4 iterations with no warnings. This is the
  acceptance target the compiler must reproduce.
- `normalizeDocument` now **requires a part to seat**. It previously checked only that the
  board existed and the anchor was a string, so a DIP anchored past the end of a strip
  loaded "clean" with its overhanging pins resolving to nothing — entity counts matched,
  so even an `assertClean`-style check passed while the chip sat electrically dead. A
  rotated part's *bent* lead stays exempt: floating over nothing is a state a document
  legally falls into when a rail moves away.
- `web/scripts/sim/junction.js` — the LED conduction/burn rule extracted from
  `sim-overlay.js` into the model, with tests. An LED whose cathode reaches a strongly
  driven rail **needs a series resistor**; the catalog blurbs and the user guide both
  claimed the opposite and have been corrected.

Prerequisites: 200 (undo/redo — the build rides that commit seam), 130 (buses, for
readability only), and the catalog. Independent of 250.

## Goal

A docked panel where the user describes a circuit and gets a design clip they can place —
built by the app, validated by the app, and proven by the engine before they ever see it.
The user supplies their own API key for Anthropic or any OpenAI-compatible endpoint
(Ollama, LM Studio, OpenRouter, OpenAI). No key, no feature; the app ships no credentials
and calls nothing on its own.

## Design decisions (settled)

**The model never sees a hole address.** Its entire output is `{title, parts, nets,
tests}`: `parts` are `{id, ref}` against catalog ids, `nets` are `{name, members}` where a
member is `<partId>.<pinNameOrNumber>` or a bare rail token. Placement, routing, board
selection, wire colours and hole allocation are all the compiler's, and none of them are
expressible in the DSL. This is the single decision the rest of the design hangs off.

**Power is a name, not a part.** `VCC` and `GND` are already in `desk-doc.js`'s
`RESERVED_NET_NAMES`; the DSL uses them as rail tokens. Every def declares `role:
"vcc"|"gnd"`, so the compiler derives power pins and wires them itself. The system prompt
states as a hard rule that the model must **never** enumerate a VCC or GND pin — which
also removes the largest source of net-member noise.

**Pin resolution is fail-closed.** A catalog audit finds **8 defs with duplicate pin
names**, two of them genuinely ambiguous: `74LS47` has `A`/`B`/`C`/`D` as both inputs and
segment outputs, and `seg8ca` has both a segment `A` and a common-anode `A`. `74LS83` and
`74LS283` share every pin *name* at different *numbers*. The resolver ladder is: integer →
exact name (two hits ⇒ `AMBIGUOUS_PIN` with candidates) → `role` for power → normalised
name (`R0(1)` → `R01`) → bus index via the def's existing `pinGroups` → **fail**. It never
guesses: silently mapping `S0`→`S1` yields a circuit that simulates happily and is wrong,
which is the worst outcome available.

**The catalog card is derived, never hand-written.** `buildCatalogCard()` projects
`PALETTE_DEFS` into `ref|package|n:name,…` lines at runtime — measured at ~8.4 KB
(~2,325 tokens), comfortably above Opus 5's 512-token cache minimum, so it caches and
costs ~0.1× on every repair turn. A hand-maintained prompt would drift the first time a
chip was added; this cannot. Note `JSON.stringify` silently drops `normalizeParams` /
`internalBridges` / `source` because they are **functions** — project fields explicitly.

**The output is a design clip, and `pasteDesign` is the transaction.** There is no
`applyBatch` and none is needed. `DeskDoc.pasteDesign` already snapshots, replays through
the ordinary `addBoard`/`addComponent`/`addWire` methods — each of which *throws* on an
illegal placement — and `restore`s wholesale on any failure. A generated design therefore
cannot land half-applied and cannot be silently pruned. The only missing piece is a public
door on the controller: extract `#commitDesignPaste`'s body into `#dropDesign(clip,
shift)`, then add `armGeneratedDesign(clip)` and `applyGeneratedDesign(clip, {at})`.
Arming is the better default — the user sees the whole circuit tracking the cursor,
mating magnetically with what is already on the desk and red-outlined where illegal,
before anything commits. That UX is free.

**Nothing reaches the user unproven.** A *repair*-class failure is the model's mistake and
goes back to it as structured errors; an *abort*-class failure is our bug and is never
shown as a circuit.

| # | Gate | Class |
|---|---|---|
| L0 | Schema (guaranteed by `output_config.format`, re-checked defensively) | reject |
| L1 | Spec semantics: refs exist · ids unique · nets ≥ 2 members · no pin in two nets · **no two `role:"output"` pins on one net** · every behavioural part has a resolvable VCC+GND | repair |
| L2 | Compile: column budget fits · allocator never double-books a node | repair |
| L3a | `normalizeDocument` drops nothing (entity-count comparison) | abort |
| L3b | Seating: `partPinAddresses` returns no `null`, `canPlacePart` true | abort |
| L4 | **Net partition**: every declared net's members share one netId, and distinct nets get distinct netIds | abort |
| L5 | `settle()`: every `chipStatus` `ok`, `warnings` empty, `settled` true | repair/abort |
| L6 | Liveness: no declared signal net resolves to `Z` or `X` | repair |
| L7 | **Functional**: the model's own `tests` block passes | repair |

L4 is the one that matters most. Two parts seated on the same column-half are electrically
joined, and *nothing* in the geometry layer complains — `canPlacePart` checks hole
occupancy, not node sharing. The design is silently wrong **and still simulates**. Only
comparing the declared partition against the derived one catches it.

**The model states its own acceptance test.** The DSL carries an optional `tests` block:
`{name, set: {SW1: "10110101"}, expect: {BAR1: "11000000", D1: "H"}}`. The runner writes
`set` into the switch banks' `params.states`, rebuilds the netlist (switch state is a
netlist *input*, not a settle input), settles, and reads each target back. This is the
highest-value gate — the only one checking *intent* rather than internal consistency — and
it costs the model ~100 output tokens.

**The compiler inserts series resistors.** Per the `junction.js` rule, an LED or display
segment whose cathode reaches a strongly driven rail burns rather than lights. This is a
physical requirement the board knows, not something the netlist should have to state, so
the compiler adds one resistor per common-cathode block. A design that asked for an LED
and got a burnt one would be a broken deliverable.

**Geometry the netlist cannot express is resolved by policy, not by asking.** The compiler
only ever emits canonical, geometry-free forms: `def.package` parts at `e<col>`,
`def.footprint` parts linear at `<row><col>` with `rot: 0`, `def.terminals` bricks at
integer `(x, y)`. **Rotated two-lead parts and `def.can` oscillators are out of scope** —
a bend is not expressible and `occupancy.js` refuses a lead over nothing. A spec asking
for one returns a warning rather than a broken document. Nothing is lost: a linear
resistor reaches the rails through wires just as well, which is what the adder does.

**Two providers, one adapter shape.** `{id, label, defaultBaseUrl, defaultModel,
buildRequest(...), parseStreamEvent(...)}` so the client never branches on provider inside
the request loop. Anthropic defaults to `claude-opus-5` with `thinking: {type:
"adaptive"}` and `output_config: {effort: "high", format: NETLIST_SCHEMA}`; `stop_reason
=== "refusal"` is checked **before** reading `content` (a policy decline is HTTP 200 with
empty or partial content, and indexing `content[0]` unguarded would crash the renderer).
The OpenAI-compatible adapter covers every other endpoint by base URL + model.

**Use Node's global `fetch` in main; add no runtime dependency.** Electron 42 ships Node
22. The official SDK would buy typed structured-output helpers and retries at the cost of
the project's first runtime dep, against a ROADMAP that says external packages only when
necessary. The module surface is identical either way, so this is revisitable without
churn.

## Implementation steps

**Steps 1–7 have landed** (`model/pin-resolve.js`, `model/column-allocator.js`,
`model/autobuild.js`, with `tests/pin-resolve.test.js`, `tests/column-allocator.test.js`,
`tests/autobuild.test.js`). Both fixtures now compile from coordinate-free specs into
circuits the real engine validates — the adder computes A+B with carry across six
operand pairs, and the counter counts while its bars **light** rather than burn.

Four deviations from this plan, each made against what the catalog actually contains:

- **`74LS47.A` / `seg8ca.A` are NOT ambiguous.** Pin names are case-distinguished —
  74LS47 has uppercase inputs `A,B,C,D` and lowercase segment outputs `a..g`; seg8ca has
  lowercase segments and an uppercase `A` common anode. Case-insensitive matching would
  *manufacture* an ambiguity the catalog does not have, so exact case is tried first. The
  only real duplicates are `NC` and `VSS`, which share a role and are electrically
  interchangeable — plural, not ambiguous.
- **`74LS148` is the genuine ambiguity, and it is a number.** Its inputs are *named* `0`–`7`
  and those names do not match the pin numbers: `74LS148.4` is either pin 4 (named `7`) or
  the input named `4` (pin 1). Both readings are reported; `#4` is the explicit
  pin-number escape. It is the only def in the catalog where this fires.
- **The LCD declares both 16 pins and 16 terminals** (terminal ids = pin names). It is a
  brick, so terminals win, and a datasheet pin number maps through (`lcd.4` → `RS`).
- **Companion stacking is deferred.** Seating an `rnet9` in a column-half a `sw-dip8`
  already owns is the exact failure the allocator exists to prevent by accident; making it
  a deliberate, net-equality-proven optimisation is a later change. Cost is wires, not
  correctness.

Two more consolidations: `netlist-dsl.js` and `autobuild-spec.js` folded into
`autobuild.js` (the spec's semantics and its compilation are one cohesive unit), and
`autobuild-layout.js`/`net-router.js` likewise. `compileNetlist` returns a **document**
rather than a clip, plus a `partMap` (spec id → component id) that every caller needs —
clip wrapping belongs with the paste path in step 9.

**Step 8 has landed** (`model/autobuild-verify.js`, `tests/autobuild-verify.test.js`).
`verifyBuild(compiled, spec)` runs L3a→L7 and returns faults tagged `abort` (our bug) or
`repair` (the spec's mistake), which is the split the panel's retry loop needs.
`runFunctionalTests` is exported separately.

Each abort-class rung has a negative fixture that breaks it in the way that is *invisible*
to everything else — the severed-carry case loads with matching counts, powers both chips,
and settles without a warning; only L4's declared-vs-derived comparison catches it.

Two shapes worth recording because they were not obvious:

- **L7's bit ordering is stated, not inferred.** `set`/`expect` take a number (bit `i` →
  position `i+1`) or an equivalent `0`/`1` string, and a test asserts the two agree. An
  off-by-one here is precisely the silent wrong-circuit failure the rest of the ladder
  guards against, so the convention is pinned rather than documented.
- **L5 settles with every clock idle-low.** A clock source only drives its `out` net when
  given a phase, so a bare `settle` leaves the clock line at `Z` and L6 reports an undriven
  net on a perfectly good circuit. Idle-low is what the SimController starts from.

### Remaining

9. **Transaction seam** — `#dropDesign` extraction, `armGeneratedDesign`,
   `applyGeneratedDesign`, plus document→clip wrapping.
10–14. **The AI half** — credential store, provider adapters, IPC, Settings tab, panel.
15. **`make demos` refactor** onto `model/autobuild.js`.
9. **Transaction seam** in `components/desk-controller.js` — `#dropDesign` extraction,
   `armGeneratedDesign`, `applyGeneratedDesign` (shift found via the existing
   `model/nearest-legal.js` `nearestLegalOffset`).
10. **`app/store/credential-store.js`** — `safeStorage.encryptString` into
    `userData/credentials.dat` over the existing atomic `store/io.js`. When
    `isEncryptionAvailable()` is false it **refuses to store and says so**; it never falls
    back to plaintext.
11. **`app/ai/client.js` + `app/ai/providers/{anthropic,openai-compat}.js`** — request
    loop, SSE streaming, an `AbortController` registry keyed by request id.
12. **IPC** — `ai:key:set` / `ai:key:clear` / `ai:key:status` / `ai:test` / `ai:start` /
    `ai:cancel` in `registerIpc()`, mirrored in `preload.js`. Streaming returns as one-way
    pushes re-dispatched as `chiphippo:ai-delta` / `-done` / `-error`, following the
    `memory:inbound` pattern. The key never crosses the bridge: `ai:key:status` answers
    `{configured, encryptionAvailable}` and nothing more.
13. **Settings ▸ AI tab** — provider segmented picker (reusing `buildSegmented`), base URL,
    model, an API-key `<input type="password">`, **Test connection**, Clear. The dialog has
    no text input today; follow `part-properties-dialog.js`'s commit-on-`change` behaviour
    so an API key is not written per keystroke. The key field is the one control that
    bypasses `SettingsDialog.#emit`.
14. **`components/ai-panel.js`** — docked and resizable, modelled on `scope-view.js`
    (`setVisible` / `onVisibilityChange` / `onHeightChange`). Its toolbar segment joins the
    desk-tool pill, because it toggles a desk panel exactly as Analyzer and BOM do, and its
    armed state comes from the panel's own `onVisibilityChange`.
15. **`make demos` refactor** — rewrite `scripts/make-demos.mjs` against
    `model/autobuild.js`; the two 65xx demos become netlist specs. This deletes ~120 lines
    of duplicated hole arithmetic and makes the compiler load-bearing for something already
    shipped, so it cannot rot. `demos.test.js` guards the output unchanged.

Steps 1–9 need no network and no API key. They are the risky half and they are fully
verifiable on their own; do them first.

## Acceptance criteria

- With no key configured, the panel explains what is needed and the app makes no outbound
  request of any kind.
- "Build a circuit that adds two 8-bit numbers with a carry" produces a design clip that
  passes every gate L0–L7 and, once placed, reproduces `engine-adder.test.js`'s result:
  both chips `ok`, no warnings, correct sum and carry across the vector sweep.
- The build is **one** undo step. ⌘Z removes the entire circuit; the desk is byte-identical
  to before.
- A spec naming an absent part, an ambiguous pin, or a two-output net is rejected with a
  structured error and repaired within 2 rounds, or surfaced readably — never shown as a
  circuit.
- An LED or display in a generated design lights rather than burns.
- The API key is absent from `settings.json` and unreadable in `credentials.dat`.
- `make demos` produces byte-identical demo files after step 15.

## Constraints

- No UI framework; `dom.js` `el()`, `theme.css` tokens, `ai-*` class naming.
- No runtime npm dependency (see the `fetch` decision above).
- **No CSP change.** `index.html` stays exactly as it is; the renderer still makes zero
  network calls.
- Every new pure module is DOM-free with a sibling `node --test` suite.
- `main.js` handlers and `preload.js` exports stay in lockstep (`ipc-parity.test.js`);
  channels follow `area:noun[:verb]`, lowercase, hyphens only between alphanumerics.
- Repair rounds capped at 2. Report what an ask cost — it is the user's key. In
  TOKENS, not dollars: a price table in the repo goes stale silently and the
  panel starts lying about money, whereas the four buckets a provider reports
  map one-to-one onto the console's price rows for anyone doing the sum.
- Apache-2.0 header on every new file (`make license-headers`).

## Verify

- `make fmt && make lint && make test` green.
- New suites: `pin-resolve.test.js`, `column-allocator.test.js`, `autobuild.test.js`
  (compile the adder spec and assert it reproduces the checked-in fixture),
  `autobuild-verify.test.js` with **negative** fixtures — a deliberately shorted design
  (two parts on one column-half), a floating pin, a two-output net — each of which must be
  caught by the gate that owns it.
- A jsdom test that a generated clip lands as exactly one undo step, and that a
  deliberately illegal clip leaves the desk byte-identical.
- `make demos` byte-identical after step 15.
- Live in `make debug` (isolated `--user-data-dir`, PID-scoped kill): Settings ▸ AI, paste a
  key, **Test connection**; open the panel, ask for the 8-bit adder, watch it stream, place
  the ghost, press **Run**, flip switches and confirm the sum counts; ⌘Z removes it whole.
- Pull the network mid-generation and confirm the failure is reported, cancellable, and
  leaves no partial desk.
