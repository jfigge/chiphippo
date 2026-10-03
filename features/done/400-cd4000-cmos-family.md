# Feature 400 — CD4000-Series (CMOS) Chip Support

> **Landed 2026-10-03.** Numbered 400 because 390 is the KiCad/Digital export.
> Revised the same day after a review against the code: every section below names the
> existing mechanism it extends, and Jason's answers to the review's open questions are
> recorded in **Decisions** and applied inline.

## Summary

Add the CD4000 CMOS logic family to ChipHippo alongside the existing 74LS (TTL)
parts. A three-way logic-family mode controls which chips appear in the parts tray.
Each logic chip records which family it belongs to. Datasheets are linked by URL and
downloaded by the user, never bundled as PDFs.

This was requested by a user. The goal is to add the second family without making the
simulator harder to use for people who only want one family.

## Before you start

1. **Study the existing TTL implementation first**, and extend it rather than building
   beside it: a gate (`catalog/chips-gates.js`, `74LS00`), a sequential part
   (`catalog/chips-seq.js` + the builders in `sim/sequential.js`), the tray
   (`components/palette-panel.js`), power gating (`powerStatus` in `sim/engine.js`) and
   the datasheet table (`src/app/datasheets/sources.js`). Do not invent a parallel
   mechanism. Where the vocabulary can't express a part, extend the vocabulary
   (CLAUDE.md: "a new 74xx part is data").
2. **Never guess a pinout or truth table.** Every pin assignment, active level, and
   clock edge must come from the manufacturer datasheet for that part (Texas
   Instruments; see section 6). If a datasheet is not available for a part, leave the
   part out and list it in your summary. Do not fill it in from memory.
3. Keep ChipHippo's guiding principle in mind: **incorrect wiring should produce
   realistically incorrect behaviour**, because the tool is for teaching.

## Decisions (Jason, 2026-10-03)

| # | Question | Decision |
|---|---|---|
| D1 | Where does the family mode live? (§2) | App-wide in `settings.json`, switched from **Settings ▸ Data Sheets** |
| D2 | Datasheet images? (§6) | Every CD4000 part gets a PNG crop captured from its PDF, as the 74LS parts have. The PDFs themselves go into the download table, never into the app |
| D3 | Does the AI builder get CD4000 parts? (§9) | Yes. A request naming CD4000 or CMOS uses CD4000 parts; one naming TTL or 74LS uses the 74LS parts |
| D4 | Demo group projects? (§9) | Separate per family, one folder each: `demos/74LS/` and `demos/CD4000/` |
| D5 | How does `website/chips.html` show the family? (§9) | Same seven sections, 74LS rows first then CD4000 in each band. The part number already says the family |
| D6 | Does the floating-CMOS-input warning cover spare gates? (§5) | Yes. The datasheets say to tie every unused input. Reported once per chip |
| D7 | Is the 74LS → CD4000 boundary a warning or an X? (§5) | A warning; the level stays H |
| D8 | Add CD4093B and CD40106B to Phase 1a? (§7) | Yes |
| D9 | Datasheet URLs and the live check (§6) | The URLs are the ones in §7. The live check over them is an opt-in script, outside `make test` |

## 1. Chip family as a per-chip property

- Add a `family` property to every **logic** chip definition, with values `74LS` and
  `CD4000`. Mark all existing logic chips (`chips-gates.js`, `chips-seq.js`,
  `chips-74ls.js`) as `74LS`.
- **Leave the rest family-less**: the PROCESSOR group (W65C02, Z80A), the Interface group
  (W65C21, W65C22) and every Memory part. They are not 74LS, several are CMOS, and
  tagging them would hide the CPUs in CD4000 mode. A family-less part shows in every
  mode.
- The family lives in the **catalog only** and is never written into a document, so an
  existing project needs no migration and loads byte-for-byte as before. One board can
  hold chips from both families.
- Rules elsewhere in this spec key off `family === "CD4000"`, **never** off "is CMOS".
  The CPUs and memories must keep the floating-reads-HIGH rule; `z80.test.js` depends
  on a floating bus reading `$FF`.

## 2. Logic-family mode (three-way switch)

- Add a mode setting with three values: **74LS**, **CD4000**, **Combined**.
- Default to **74LS**, so existing users see no change.
- The mode controls which chips appear in the parts tray (section 3). It filters the
  tray only and never removes or alters parts on a desk; a loaded project's chips load
  and simulate normally whatever the mode.
- **Storage (D1): app-wide**, a `settings.json` key (`logicFamily`: `"74LS"` |
  `"CD4000"` | `"combined"`, default `"74LS"`) with its default in
  `app/store/settings-store.js`, applied live through `applySettings`. Main stores it
  unvalidated (as it does `paletteAutoClose`); the renderer coerces an unknown value to
  `"74LS"` (`catalog/families.js`'s `normalizeFamilyMode`).
  - It is deliberately not per project. A project flag is an ordinary unsaved change
    (the padlock's `wheelLocked` is the precedent), so toggling a view filter would put
    a • on the project.
- **Where the switch lives (D1): Settings ▸ Data Sheets**, as a segmented row
  (`components/segmented-picker.js`, the same control as Theme) with its explanation
  behind an (i) (`rowWithNote`). The panel is live-apply like the others: picking a
  family `#emit`s the patch, and the tray rebuilds while Settings is still open.
  - Check that the Data Sheets tab still fits the card without scrolling at the largest
    font size in every shipped language. The card's height is set by Appearance
    (`max(520px, 34 lines)`).
- **A hidden family that the open project uses.** Opening a CD4000 project in 74LS mode
  must not leave the user unable to add more of the parts already on the desk. While
  the open project contains chips of a hidden family, the tray shows that family too, as
  if in Combined mode. This is derived from the project and never stored. It lasts until
  the project is closed, so deleting the last CD4000 part mid-session doesn't make the
  folder vanish under the user.
- **Point the way from the tray.** The switch is in Settings, not the tray, so a user
  typing "4011" in 74LS mode would otherwise get a bare "No matches". When the filter
  matches nothing visible but does match parts of a hidden family, the empty-list line
  says so and names where to switch (e.g. "CD4011B is a CD4000 part. Show CD4000 chips
  in Settings ▸ Data Sheets.").

## 3. Parts tray tree

The CHIPS folder expands directly into catalog groups, in catalog order: NAND, NOR,
Inverter, AND, OR, XOR, Buffer, Flip-flop, Latch, Counter, Shift register, Decoder,
Register, Multiplexer, Display driver, Comparator, Encoder, Arithmetic, Interface,
PROCESSOR. Memory is its own top-level section.

**Single-family mode (74LS or CD4000):** keep the tree exactly as it is today. The
function folders sit directly under CHIPS and contain only the selected family's chips
plus the family-less groups. There is no family folder, because there would only be
one.

```
CHIPS
├─ NAND
├─ NOR
├─ INVERTER
└─ ...
```

**Combined mode:** insert one family tier under CHIPS, with sibling folders `74LS` and
`CD4000`. Each contains the same function folders, holding only that family's chips.
The family-less groups (Interface, PROCESSOR) stay directly under CHIPS, after the two
family folders.

```
CHIPS
├─ 74LS
│  ├─ NAND
│  ├─ NOR
│  └─ ...
├─ CD4000
│  ├─ NAND
│  ├─ NOR
│  └─ ...
├─ Interface
└─ PROCESSOR
```

Rules:
- **Hide empty function folders in every mode.** This already happens: `#render` builds
  groups from the parts that pass the filter.
- **The filter keeps today's behaviour in every mode.** While filtering, `#render`
  (`palette-panel.js`) already forces every section open, so nobody walks the tree. In
  Combined mode a match for "nand" therefore shows under both 74LS ▸ NAND and CD4000 ▸
  NAND. Each row already shows its part number (`palette-item-id`: `74LS00`,
  `CD4011B`), which is the family label, so add no second one.
  - In a single-family mode the filter searches the visible family plus the family-less
    parts.
- **Collapse state must not collide.** Collapse state is keyed by section NAME
  (`#collapsed`, `allSections()`). In Combined mode "NAND" appears under both families,
  so key the inner tier as `74LS/NAND` and `CD4000/NAND`. The bare `NAND` key keeps
  serving single-family mode, and the two family folders get keys of their own.
- **Three more places learn the extra tier:**
  - `folderOf` and `#openOnly`, so auto-close (Settings ▸ Appearance) keeps open the path
    to the opened section;
  - the rail's `#openSection`.
- Switching modes rebuilds the tree immediately and keeps each section's remembered
  open/closed state.

## 4. Supply voltage

There is no per-board voltage in ChipHippo, and this feature does not add one. A
"board" is a strip with no electrical identity. Supply comes from **PSU bricks**
(`PSU_VOLTS = [3, 5, 12]`, `catalog/parts.js`) wired to the rails, and power is gated
**per chip** by `powerStatus` (`sim/engine.js`), from the PSU volts on that chip's own
VCC net. Build on that:

- **A supply envelope per family, as catalog data.** Replace the hard-coded 3 / 5 / 12
  in `powerStatus` with an envelope looked up by family:
  - **74LS:** 5 V ok, 3 V underpowered (inert), anything above 5 V damaged.
  - **CD4000:** the B-series recommended operating range from the TI sheets (3–18 V);
    every voltage on offer inside it is ok.
  - **Family-less parts:** keep exactly today's 3 / 5 / 12 behaviour.
- **More PSU voltages:** `PSU_VOLTS = [3, 5, 9, 12, 15]`. The Properties dialog's select
  picks them up from the list. 15 V is the top TI parametric rating; 18 V is left off
  because it sits at the very edge of the recommended range.
- **A mixed board needs no rule of its own.** On a 9 V rail a 74LS chip smokes when Run
  starts, while a CD4000 chip beside it runs. That is the realistic version of "any 74LS
  part caps the board at 5 V", with no clamp, no new document field and no migration.
- **The failure happens at Run, not at placement.** Placement cannot know a net's
  voltage, because nets only exist once the wiring is resolved. That is also how a
  real chip behaves.
- **The visible failure is the existing one:** the chip's status badge plus the
  underpowered/damaged notification. Its strings hard-code the voltage (`en.json`:
  `underpoweredMessage` "is at 3 V", `damagedMessage` "damaged by 12 V", and the badge
  tooltips). Give each a `{volts}` placeholder and say what the part needs, e.g.
  "{chip} needs 5 V and was damaged by {volts} V". Do this in all 7 locales.
- **Fix a stale string while you're there:** `damagedMessage` still says "Delete it and
  place a fresh one to continue", but Stop restores every damaged chip (the badge
  tooltip already says so).
- Keep the first version simple. The voltage drives only the power gating above.
  Analog modelling (propagation delay or drive strength by voltage) is out of scope.

## 5. CMOS-specific behaviour

The teaching points here are the reason the family is worth adding, so the floating-input
rule is **not** optional for any part in the list, sequential parts included.

### Floating inputs read unknown

An unconnected CMOS input is undefined: it must read `X`, not HIGH as a TTL input does.

- **Combinational parts.** Apply the rule at the two places inputs are read:
  `evaluate` and `inputLevels` in `sim/chip-eval.js`, both currently through `asInput`
  (Z → H). Add a per-family variant there; `levels.js` keeps `asInput` as the TTL rule.
  The ternary primitives already give the realistic answer: a CD4001 NOR with one input
  floating and the other HIGH still outputs LOW.
- **Sequential parts must be X-aware.** Every existing builder in `sim/sequential.js`
  reads X as a clean L: `asBit` and `high` do, and `edgeRose`/`edgeFell` need an exact
  L↔H. With only the input change above:
  - a 4017 with RESET floating would count perfectly, hiding the classic beginner
    mistake;
  - a 4013 with D floating would capture a clean LOW.

  The CD4000 sequential units are new builders anyway (section 7), so write them
  X-aware from the start:
  - **Async inputs:** an X on set/reset/clear makes the state unknown.
  - **Clock:** an X on the clock makes the state unknown, since it might have clocked.
  - **Data:** an X on a data input sampled at an edge makes that bit unknown.
  - **Outputs:** an unknown state drives `X` on every output it governs.
  - **Recovery:** a clean async reset or set makes the state known again.
  - **Power-up:** stays deterministic, as on the 74LS parts. An unknown power-up would
    leave an un-reset 4017 LED chaser dark forever, which is harsher than a real 4017,
    which just starts somewhere.
- **Make it visible.** On its own an X is quiet: an LED on an X net is simply dark
  (`sim/junction.js`), and an X from a single driver raises no warning
  (`sim/resolve.js`). Add a `floating-input` engine warning for CD4000 inputs on a net
  nothing drives.
  - **D6:** spare gates are included, because the datasheets say to tie every unused
    input.
  - Report it once per chip, naming the pins, through the existing warning path that
    already carries underpowered/damaged.

### Mixed-family boundaries

The engine has no net voltages: levels are H/L/Z/X with drive strengths, and voltage
exists only at the power check. Model the boundaries **structurally**, from the
netlist, as warnings that name the pins and the fix. Below are typical datasheet
figures; confirm them against the sheets.

- **74LS output → CD4000 input (D7: a warning, level stays H).** A 74LS VOH is 2.7 V
  minimum and about 3.4 V typical, while a CD4000B input at VDD = 5 V needs VIH of at
  least 3.5 V. That is marginal; it usually works on a bench but is out of spec.
  - **When to warn:** a net driven by a 74LS output that feeds a CD4000 input and has no
    pull-up resistor to a supply `+`. Suggest the pull-up.
  - **Detecting the pull-up:** resistors are already modelled as weak pulls (catalog
    `weakBridges`, collected in `buildContext`).
  - **Why not X:** it would kill most mixed circuits, which overstates reality.
- **CD4000 output → 74LS inputs (missing from the first draft).** A standard B-series
  output sinks only about 0.5 mA at 0.4 V on 5 V, roughly one LS input load (0.4 mA).
  Warn when one non-buffer CD4000 output drives more than one 74LS input, and point at
  the CD4049UB/CD4050B, which exist for exactly this.
- **Mixed supply voltages** (e.g. CMOS at 12 V driving LS at 5 V, or a 4049/4050
  shifting levels down) cannot be told apart without a voltage on each driven H. For
  v1, warn when one net joins chips powered from different supply voltages. The real
  model is a follow-up (section 10).

## 6. Datasheets

Datasheet PDFs are copyrighted and **must not be bundled** with the application. What
ships is the same as for the 74LS parts: a hand-cut PNG crop of each part's diagram
(D2, below). The PDFs are downloaded by the user.

- **The URL lives in main, not in the chip definition.** The existing mechanism is the
  hand-written table in `src/app/datasheets/sources.js`, kept in main on purpose so the
  renderer can never name a URL. It already has a **Texas Instruments** library block
  (`base: https://www.ti.com/lit/ds/symlink/`). Each CD4000 part is one line in it,
  with the URL from section 7 written as a path relative to that base (`cd4001b.pdf`).
  Reuse the existing Data Sheets tab and download flow.
- **URLs use TI's stable link format,** `https://www.ti.com/lit/ds/symlink/<part>.pdf`,
  and are listed in section 7. If a URL fails, report it rather than substituting a
  different link.
- **Shared sheets: fetch once, save a copy per part.** Several parts share one TI
  datasheet, so their rows point to the same URL.
  - The table already allows that (see the 74LS138/'139 entry), and each part still gets
    its own `<ref>.pdf`, since the pinout window's PDF button looks a part up by its own
    id.
  - `downloadAll` currently fetches once per part, so shared URLs are fetched repeatedly.
    Change it to fetch each **unique URL** once and write a copy for every part that
    names it.
  - Progress still counts parts. A failed URL fails every part that shares it, and each
    of those parts is reported by name.
- **Dead links are already handled. Keep that behaviour, don't reimplement it.**
  `downloadAll` (`download.js`):
  - fetches one URL at a time;
  - checks every body for the `%PDF` magic bytes, which turns a redirect to an HTML page
    into an honest failure;
  - records each failure against its part and keeps going;
  - and the download dialog names the parts that failed.

  What's missing is a test (section 8).
- **Live URL check (D9).** The URLs are the ones listed in section 7. Add a script that
  requests every unique URL in `sources.js` (all libraries, not just TI) and checks
  that each returns a PDF.
  - Model it on `scripts/check-datasheets.mjs`: it reports, with `--strict` to fail.
  - Give it its own Make target. Keep it out of `make test`, which makes no network calls
    and must not go red because a vendor's server is slow.
- **Many of these datasheets are scanned Harris originals.** Text extraction only
  returns the cover note and packaging pages, while the pinouts and function tables are
  images. To read pinouts and truth tables, render the pages as images and read them
  visually. Do not assume the text layer is complete.
- **TI's CD4049UB/CD4050B datasheet has a known error.** Its CD4050B pin table copies
  the 4049's wording ("Inverting output"). The CD4050B is non-inverting, as the
  datasheet's own function table shows. Trust the function table.
- **Crops (D2).** Every CD4000 part gets a PNG crop captured from its PDF,
  `src/web/datasheets/<id>.png`, exactly as the 74LS parts have. The pin-assignments
  window shows it, and main widens the window when one exists.
  - **Crops are cut by hand, not generated.** A generator was tried for the 74LS parts and
    never cropped well enough to ship. Jason is working on the images; the
    implementation adds none.
  - **One crop per part, named by its id** (`datasheetCrop(def)`: a DIP part's crop IS
    its id), cut from that part's own diagram even where the PDF is shared. The
    CD4001B, CD4002B and CD4025B are three crops from one sheet.
  - **Until a crop lands, `make datasheets` lists that part as missing**, which is
    the to-do list working as intended. Do **not** add CD4000 parts to `NO_DATASHEET`:
    that list is only for parts that have no sheet to crop at all. With no crop yet, the
    window shows the pin map (the `<figure>` removes itself when the image fails to
    load).
  - **For the scanned Harris sheets**, the diagram is already an image, so the crop
    comes from a rendered page.

## 7. Chip list

**Part ids are permanent.** An id is stamped into every saved document that uses the
part, so renaming one later is a migration (the AS6C1024 lesson). Use the TI part
numbers exactly as below; the tray filter still finds "4001". Name pins as the
datasheet prints them, including VDD/VSS for power. Power gating goes by pin
**role**, not name, so that is safe.

### Phase 1a: Combinational gates

These reuse the existing gate machinery: pins + a `logic.units` block + `family:
"CD4000"`. Take the exact pinout of each part from its datasheet.

| Part | Description | Group | Datasheet URL |
|---|---|---|---|
| CD4001B | Quad 2-input NOR | NOR | https://www.ti.com/lit/ds/symlink/cd4001b.pdf |
| CD4002B | Dual 4-input NOR | NOR | https://www.ti.com/lit/ds/symlink/cd4001b.pdf |
| CD4025B | Triple 3-input NOR | NOR | https://www.ti.com/lit/ds/symlink/cd4001b.pdf |
| CD4078B | 8-input NOR/OR | NOR | https://www.ti.com/lit/ds/symlink/cd4078b.pdf |
| CD4011B | Quad 2-input NAND | NAND | https://www.ti.com/lit/ds/symlink/cd4011b.pdf |
| CD4012B | Dual 4-input NAND | NAND | https://www.ti.com/lit/ds/symlink/cd4011b.pdf |
| CD4023B | Triple 3-input NAND | NAND | https://www.ti.com/lit/ds/symlink/cd4011b.pdf |
| CD4068B | 8-input NAND/AND | NAND | https://www.ti.com/lit/ds/symlink/cd4068b.pdf |
| CD4093B | Quad 2-input NAND Schmitt trigger *(D8)* | NAND | https://www.ti.com/lit/ds/symlink/cd4093b.pdf |
| CD4081B | Quad 2-input AND | AND | https://www.ti.com/lit/ds/symlink/cd4073b.pdf |
| CD4082B | Dual 4-input AND | AND | https://www.ti.com/lit/ds/symlink/cd4073b.pdf |
| CD4073B | Triple 3-input AND | AND | https://www.ti.com/lit/ds/symlink/cd4073b.pdf |
| CD4071B | Quad 2-input OR | OR | https://www.ti.com/lit/ds/symlink/cd4071b.pdf |
| CD4072B | Dual 4-input OR | OR | https://www.ti.com/lit/ds/symlink/cd4071b.pdf |
| CD4075B | Triple 3-input OR | OR | https://www.ti.com/lit/ds/symlink/cd4071b.pdf |
| CD4030B | Quad XOR | XOR | https://www.ti.com/lit/ds/symlink/cd4030b.pdf |
| CD4070B | Quad XOR | XOR | https://www.ti.com/lit/ds/symlink/cd4070b.pdf |
| CD4077B | Quad XNOR | XOR | https://www.ti.com/lit/ds/symlink/cd4070b.pdf |
| CD4069UB | Hex inverter | Inverter | https://www.ti.com/lit/ds/symlink/cd4069ub.pdf |
| CD40106B | Hex Schmitt-trigger inverter *(D8)* | Inverter | https://www.ti.com/lit/ds/symlink/cd40106b.pdf |
| CD4049UB | Hex inverting buffer (higher drive, level shifting) | Inverter | https://www.ti.com/lit/ds/symlink/cd4049ub.pdf |
| CD4050B | Hex non-inverting buffer | Buffer | https://www.ti.com/lit/ds/symlink/cd4049ub.pdf |

The CD4093B and CD40106B URLs were checked on 2026-10-03, and both return a PDF:
- the CD4093B sheet is a scanned Harris original, SCHS115D, which lists the 14-lead
  plastic DIP (E suffix);
- the CD40106B sheet is SCHS097F, "CD40106B CMOS Hex Schmitt-Trigger Inverters", which
  lists PDIP (14).

Things to watch for:
- **The 4049 and 4050 have unusual power pins.** Check the datasheet. Do not assume the
  corner VDD/VSS layout, and don't assume the unused pins carry signals (use `nc()`).
  Off-corner power is already supported: the 74LS83, '76 and '90 have it.
- **The 4068 and 4078 have both inverting and non-inverting outputs.** Model both, as
  two units over the same eight inputs. The catalog integrity test allows inputs to fan
  out (`chips-catalog.test.js`).
- **The 4030 and 4070 are both quad XORs.** Include both, because users will search for
  both numbers. Use each part's own datasheet; don't assume they are interchangeable.
- **The Schmitt parts (4093, 40106) are logic only**, like the existing 74LS14: no
  hysteresis model. Their signature use, the RC oscillator, cannot be built here
  because there are no capacitors. Say so in their blurbs.
- If you find another basic gate in the TI CD4000 range that this list misses, list it
  in your summary rather than adding it.

### Phase 1b: Sequential parts

These need internal state and edge handling, so most of the engineering effort is here.
Build them from `sim/sequential.js` builders, extending the vocabulary where it can't
express a part, and make every builder X-aware (section 5).

| Part | Description | Group | Datasheet URL |
|---|---|---|---|
| CD4013B | Dual D-type flip-flop with set/reset | Flip-flop | https://www.ti.com/lit/ds/symlink/cd4013b.pdf |
| CD4017B | Decade counter/divider with 10 decoded outputs | Counter | https://www.ti.com/lit/ds/symlink/cd4017b.pdf |
| CD4040B | 12-stage binary ripple counter | Counter | https://www.ti.com/lit/ds/symlink/cd4040b.pdf |

The CD4040B datasheet also covers the CD4020B and CD4024B, and the CD4017B datasheet
also covers the CD4022B. Those are easy later additions, and the builders below should
make each of them data rather than code.

**Vocabulary the current builders lack.** Confirm every level and edge against the
sheet.
- `asyncOverride` (used by `dffUnit`/`jkUnit`) handles **active-LOW** preset/clear only.
  The 4013's SET/RESET are active HIGH, so give the override an active-level option
  rather than a CMOS copy of the D-FF. Include the both-asserted case.
- There is **no decoded Johnson-counter builder** for the 4017. Its datasheet behaviour
  includes the clock / clock-inhibit pair (which edge advances the count, and when), the
  async reset, and the carry-out. Parameterize the count length, so the 4022's ÷8
  becomes data.
- There is **no N-stage binary counter builder** for the 4040. Give it a stage count, so
  the 4020, 4024 and 4060 become data.

Take every behaviour from the datasheet and write a test for each one, including:
- Which clock edge triggers each part. These differ between parts, so check each one.
- The active level of every reset, set and enable input, and whether it is synchronous
  or asynchronous.
- The CD4017's clock-inhibit/enable input and its carry-out.
- The CD4040's full 12-bit count and its async reset. The engine has zero delay, and
  Feature 220 deliberately completes a ripple within one tick, so the intermediate
  stage-by-stage codes of a real ripple counter cannot appear. Don't try to model them
  (section 10).

## 8. Testing

- **Per-part datasheet proof:** a demo spec for every new chip in
  `scripts/demo-specs.mjs`, which `make demos` runs through the real engine against the
  datasheet truth table or state sequence. This is required anyway (section 9). The
  existing `truth-table.test.js` harness also picks up every new gate unit
  automatically, but it only proves that a unit computes its gate function, not that
  the pinout matches the datasheet.
- **Sequential fixtures** for the 4013/4017/4040 in the style of `engine-seq.test.js`:
  - every edge and active-level rule from section 7;
  - every X rule from section 5 (floating reset, floating clock, floating D, and
    recovery on a clean reset).
- **Floating inputs:** a CD4000 input left floating reads X, and a dominant input still
  forces the output. The 74LS parts, CPUs and memories still read HIGH.
- **Warnings:**
  - the floating-input warning, spare gates included (D6);
  - the 74LS → CD4000 warning, present without a pull-up and absent with one;
  - the CD4000 → multiple-74LS fan-out warning;
  - the mixed-supply warning.
- **Power:** `powerStatus` per family across every `PSU_VOLTS` value. A 74LS chip at 9 V
  is damaged and a CD4000 chip beside it is ok. The notifications carry the voltage.
- **Tray**, in all three modes:
  - folder structure, hidden empty folders, and the family-less groups in every mode;
  - the filter, including the hint when it only matches a hidden family;
  - no collapse-key collision in Combined mode;
  - auto-close and the rail's section jump;
  - a hidden family shown because the open project uses it.
- **Settings:**
  - the Data Sheets row emits `logicFamily` and the tray follows live
    (`settings-dialog.test.js`);
  - an unknown stored value reads as `"74LS"` (`normalizeFamilyMode`).
- **AI builder** (section 9), with no network:
  - the catalog card carries each part's family;
  - the prompt states the family rule;
  - the compiler ties a CD4000 part's spare-gate inputs and reports it;
  - the verifier refuses a build that leaves a CD4000 input floating;
  - `autobuild-corpus.test.js` compiles and verifies the CD4000 demo specs alongside the
    74LS ones.
- **Datasheet downloader** (`downloadAll` has no unit test today), with `fetch` stubbed
  and no network:
  - One bad URL among good ones (a 404, an HTML body with status 200, a network error)
    is reported by part, and the rest are saved.
  - A URL shared by several parts is fetched once and saved under every part's name.
  - When a shared URL fails, every part that shares it is reported.
- **`sources.js` table:** every CD4000 key is a real catalog id and every path stays
  inside the TI block. `datasheet-sources.test.js` already enforces both and picks up
  the new entries for free.
- **Old projects:** load a pre-feature project and confirm it behaves exactly as
  before. Every logic chip is 74LS, the mode is 74LS, and the tray is unchanged.
  Because the family is catalog-only, no document changes.

## 9. Also affected (the test suite will force these)

- **Demos.** Every chip in a benchable group must have a demo spec and a bundled
  example:
  - `assertComplete` in `scripts/demo-build.mjs` enforces it, and so does
    `gate-demos.test.js` ("exactly one example per benchable chip").
  - Regenerate with `make demos`. CMOS benches must tie every spare-gate input, or
    those outputs go X and trip the floating-input warning.
  - **Group projects are separate per family (D4): `demos/<family>/<Group>.chiphippo`.**
    - The folder is the family value: `demos/74LS/NAND.chiphippo`,
      `demos/CD4000/NAND.chiphippo`.
    - The existing 74LS group projects **move** from `demos/` into `demos/74LS/`. Use
      `git mv` so their history follows them.
    - The 65xx and eater demos (`65xx-*`, `eater-*`) are not group projects and stay at
      the `demos/` root.
    - The group machinery is keyed by family as well as group:
      - `catalogGroups()`, `assertComplete` and `fileNameOf` in `scripts/demo-build.mjs`;
      - the writer in `make-gate-demos.mjs`;
      - `gate-demos.test.js`, including its "no Memory project" check, which looks at a
        path that moves.
    - Add a guard that no group project is left at the `demos/` root, since nothing
      sweeps that folder today.
    - The per-chip bundled examples (`src/web/demos/<ref>.json`) are already one per
      chip, so they need nothing.
    - Update the docs that name the old path: `demos/README.md` (its intro and the
      `make demos` section) and CLAUDE.md's "Example circuits" section.
- **AI builder (D3): CD4000 parts are buildable.** They enter `BUILDABLE_DEFS`
  (`ai/catalog-brief.js`) like any new part. The prompt, catalog card and compiler learn
  the family:
  - **The family is in the catalog card.** Each part's line states its family, so the
    model never has to infer it from the id.
  - **A family rule in the system prompt.**
    - A request that names CD4000, 4000-series or CMOS uses only CD4000 parts.
    - One that names TTL or 74LS uses only the 74LS parts.
    - One that names neither uses 74LS, today's behaviour.
    - Never mix the families unless the request asks for it. A mixed build gets the
      section 5 boundary warnings, so the prompt also says to put a pull-up on every
      74LS output that feeds a CD4000 input.
    - The opening line, "You design 74xx TTL logic circuits", becomes family-neutral.
  - **The input rule splits by family.** The prompt currently says that a floating TTL
    input reads HIGH, and that inputs of a gate whose output is unused (the spare gates
    of a 74LS00) may be left out. For CD4000 parts:
    - a floating input reads unknown;
    - every input of a used gate must be in a net;
    - spare gates are the compiler's job (next point).
  - **The compiler ties spare CD4000 inputs.** This is the same move as the series
    resistors and pulls it already inserts: it fills in what a netlist shouldn't have to
    mention.
    - Every input of a CD4000 gate or section whose outputs are all unused goes into
      the GND net, and the router reaches the rail on the pin's own side of the trench.
      Either level is correct for a gate nobody reads; one level keeps it one net.
    - It is reported to the repair round beside `RESISTOR_INSERTED`/`PULL_INSERTED`
      (e.g. `SPARE_INPUTS_TIED`).
  - **Verify is family-aware.**
    - `spec-lint`'s `floatingInputs` and the L6 `INPUT_FLOATING` message state the CMOS
      rule for a CD4000 part (reads unknown; tie it HIGH on a NAND/AND, LOW on a
      NOR/OR).
    - L5 does NOT repeat the engine's `floating-input` warning: every declared net that
      floats is already L6's (`NET_NOT_DRIVEN` / `OUTPUTS_DISABLED`), and an input on no
      net is `INPUT_FLOATING` — both name the pin in the spec's terms, which the engine
      warning cannot.
    - The section 5 boundary and mixed-supply warnings reach the panel like any other
      engine warning.
  - **The PSU stays 5 V.** The compiler plants one PSU, and 5 V is valid for both
    families.
  - **The Review prompt** ("You are helping someone debug a 74xx TTL circuit") becomes
    family-neutral too. The new engine warnings (floating CMOS input, the boundary, the
    fan-out and the mixed supply) join the findings it explains.
  - The catalog card grows by about 25 parts. It stays well over the prompt-cache minimum
    and is still read once per repair round.
  - **Update `ai-builder.md`** in the user guide.
- **i18n.** Every new part needs `parts.<id>.title` in all 7 locales
  (`i18n-catalogs.test.js`). New keys are also needed for:
  - the Data Sheets row's label, options and (i) note (`settings.datasheets.*`);
  - the tray's hidden-family hint;
  - the reworded power messages (section 4);
  - the new warnings.

  `make test-i18n` checks all of it.
- **Exports.**
  - The Digital export test requires every palette part to be either mapped or listed in
    `DIGITAL_UNSUPPORTED` (`export-digital.test.js`). Map each part only where Digital's
    library has a pin-verified model; otherwise list it with a reason.
  - `digital.js` adds a PullUp to a floating chip input as "the same answer our engine
    gives". That is no longer true for a CD4000 input, so don't add one there, and
    report it.
    - *As built:* the PullUp IS added, and reported (`cmosFloating`). Without it
      Digital refuses to run the file at all ("No output connected to a wire … The
      state of the wire is undefined", checked against v0.31), so leaving it out
      would trade a reported difference for an export that cannot be simulated.
    - *As built:* six CD4000 parts are mapped to pin-for-pin twins in Digital v0.31's
      library (744002, 744017, 7404, 744075, 747266, 7414); the other 19 are listed
      as `noDigitalModel`.
  - KiCad maps chips by package and needs nothing.
- **Website.** `website/chips.html` is generated from catalog groups
  (`scripts/build-chips-page.mjs`, `SECTIONS`). Present the family per D5 and regenerate
  (`website-chips.test.js` holds the committed page to the generator).
- **User guide.** `simulation.md`, `power-and-clocks.md` and `chip-library.md` state the
  floating-reads-HIGH rule and the 3 / 5 / 12 V behaviour, and `settings.md` describes
  the Data Sheets tab. Update them, add the mode switch and the new warnings, then
  `make docs` and `make pdf`.

## 10. Out of scope (for now)

- The rest of the CD4000 range beyond the parts above, such as the 4511 display driver,
  the 4094 shift register, the 4051 multiplexer, and other counters (the 4020, 4022,
  4024 and 4060 become data once the counter builders exist). Add these in later batches
  using the same pattern.
- **Voltage-carrying levels.** Tagging each driven H with its chip's supply voltage
  would allow:
  - over-voltage damage on a 74LS input driven from a 12 V CMOS output;
  - the 4049UB/4050B's real job, shifting a higher-voltage signal down.

  v1 only warns (section 5).
- Analog effects of supply voltage, such as speed and output current; propagation delay,
  including a ripple counter's intermediate codes; Schmitt hysteresis and RC
  oscillators.
- Analog/transistor-level parts such as the CD4007.
- Bundling datasheet PDFs in any form.

## 11. Deliverables

When you finish, report:
1. Which chips were implemented, and any that were skipped or added, with the reason.
2. Where the family property, the mode setting and the per-family supply envelope are
   stored, and anywhere the implementation had to depart from a decision (D1–D9).
3. Which CD4000 parts still have no datasheet crop (the `make datasheets` report).
4. How you modelled floating inputs (combinational and sequential) and the mixed-family
   boundaries.
5. Any follow-ups or open questions for Jason.
