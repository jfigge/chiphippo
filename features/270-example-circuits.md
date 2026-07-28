# Feature 270 — Example circuits from the pin-assignments window

## Context

`make demos` already builds a complete, engine-proven bench for **every benchable
74xx part in the catalog** — 52 circuits over 18 group projects in `demos/`, each one
a desktop with switched inputs, LED read-outs and a caption, validated against its
truth table (or clocked edge by edge) before the file is written. A part added to the
catalog *fails the run* until it has one, so the coverage question has exactly one
answer.

None of that was reachable from inside the app. Nothing under `src/app/` or
`src/web/scripts/` referenced `demos/` at all; the only way in was **File ▸ Open…** on
a file in the repo, which a packaged build does not ship. A user who has just placed a
74LS138 and opened its **Pin Assignment** window has the pin map in front of them —
which says where the pins are, and nothing about the part working.

Prerequisites: 100 (the pinout window), 240/250 (a project of desktops, and the
document swap that makes adding one cheap). Independent of 260.

## Goal

Right-click a chip ▸ **Pin Assignment** ▸ click the circuit button → that part's
bench arrives as a new desktop called `<ref> example`, centred and ready to Run.

## Design decisions (settled)

**One build, two outputs.** `make-gate-demos.mjs` writes each desktop into its group
project *and* on its own to `src/web/demos/<ref>.json`, from the SAME `buildDemo(spec)`
call. Two copies of the same bytes is a real cost; a second build would have been a
worse one, and `gate-demos.test.js` holds the pair to byte-for-byte agreement so drift
is not merely unlikely but unrepresentable.

**Generated straight into `src/web/`.** This is what `make datasheets` already does
with its PNG crops: the existing `web/**/*` glob in `build.files` bundles it, `make
build-setup`'s rsync of `src/` carries it, and main resolves it as `path.join(__dirname,
"..", "web", "demos", …)` — identical under `make debug` and inside `app.asar`, because
Electron patches `fs`. No `extraResources`, no `process.resourcesPath`, no copy step;
the repo deliberately uses none of those.

**Per chip, not per group, because it makes "does this part have an example?" an
`fs.existsSync`.** Main answers the availability question with no catalog knowledge and
no JSON parse, so its document knowledge stays the two narrow places it already was
(`migrations.js`, `project-images.js`).

**The document is CENTRED at generation time** (`demo-build.mjs`'s `centreDocument`).
This is load-bearing, not tidiness. `fitToScreen` recentres the document as well as
framing it — deliberately, per the ⌘F note — so an uncentred example would put a
"recentre desk" entry at the top of a brand-new desk's history, and the user's first
⌘Z would slide the circuit off-centre. Centred, the fit finds a zero delta, returns
before `#emitDocChanged`, and is pure camera. The move is rigid, so it can neither drop
an entity nor illegalise a placement: `assertClean`/`assertPlaceable` stay as
meaningful over the centred document, and `validateDemo` re-proves every circuit on the
same run.

**The directory is SWEPT every run.** A chip dropped from the catalog, or a group moved
into `PROGRAM_ONLY`, must not leave a document behind that still puts a button on a
pinout window and still opens a circuit for a part that has gone.

**Two channels, because there are two windows and only one can use the bytes.** A
pinout window has a ref and nothing else — no project, no desk, no handshake — so it
asks (`demo:open`) and main relays `demo:host-inbound` to the app window, which is the
memory inspector's host pipe one step simpler. The app window then reads (`demo:read`)
the document itself, so it crosses the bridge once, into the window that will hold it.
Main raises the app window before relaying: the pinout is `alwaysOnTop`, so the new
desktop would otherwise land behind the button just clicked.

**Asking twice switches rather than copies.** The tab NAME is the whole identity test.
That is also its cost — rename the tab and the next ask brings a fresh one — and it is
the honest answer, since the v4 project schema keeps no per-tab marker a rename could
not erase. An in-flight promise map keyed by ref makes a double-click one desktop: the
name check and the insert are separated by two awaits, which is exactly where a
duplicate gets in.

**No example, no button** — matching `datasheetButton`, which simply is not built when
main did not flag `?pdf=1`. Memory and Interface chips have no bench (a RAM or a CPU
cannot be demonstrated by flipping switches at it), and the 65xx demos are excluded for
a sharper reason still: their program lives in a separate `.hex`, so the document alone
would arrive not working.

**It arrives like an import, reseated.** `openExample` is `importTab` with the file
picker swapped for the bundled read, still routed through `desktop.duplicate` so the
ROM guids are re-minted. No shipped example carries a memory chip today, but "two chips
can never share a guid" is a rule that must not have a door in it.

## Implementation steps

1. `demo-build.mjs` — `centreDocument(doc)` over `deskBounds` + `DeskDoc.translateAll`,
   applied in `buildDemo` before the assertions.
2. `make-gate-demos.mjs` — write `src/web/demos/<ref>.json` (`{ref, title, doc}`,
   minified) from the same `built.doc`; sweep anything the run did not write.
3. `main.js` — `DEMOS_DIR`, `demoDocPath` (ref pattern + `path.relative` containment),
   `readDemoDoc`, `requestDemoImport`; `query.demo = "1"` in `openPinoutWindow`;
   `demo:open` / `demo:read` handlers.
4. `preload.js` — `demo: { open, read }` and `["demo:host-inbound",
   "chiphippo:demo-host-inbound"]` in the payload-carrying push loop.
5. `chip-pinout.js` — `exampleButton` + `EXAMPLE_SVG`; both header buttons share
   `.pinout-header-btn` (one CSS rule, `app.css`).
6. `pinout.js` — `?demo=1` → `addExampleButton`, appended LEFT of the datasheet one so
   the incumbent keeps its place and the button with a consequence is not where a hand
   already goes.
7. `project-workspace.js` — `openExample(ref)` → `"added"` | `"switched"` | null.
8. `app.js` — the `chiphippo:demo-host-inbound` listener; frames with `fitActiveView`
   only on `"added"`.

## Acceptance criteria

- A chip with a bench shows the circuit button; a RAM, a CPU, a discrete, a brick and a
  wire show none.
- Clicking it adds `<ref> example`, active and framed, and the circuit runs correctly.
- Clicking it again lands on the same desktop; the strip does not grow.
- A double-click makes one desktop.
- The project is dirty and nothing is written until the user saves.
- Every `src/web/demos/<ref>.json` equals its group project's tab byte for byte, is at
  the renderer's `DOC_VERSION`, and is centred on the origin.

## Constraints

- No new packaging config, no `extraResources`, no Makefile copy step.
- Main gains no document knowledge: it reads a file and hands it over verbatim.
- `ipc-parity.test.js` covers `demo:open` and `demo:read`; the push channel is not
  scanned and needs only the preload `.on` entry.

## Verify

```bash
make demos          # 52 bundled examples; demos/ shifts by one rigid translate
make fmt && make lint && make test
make debug
```

Place a 74LS00 ▸ right-click ▸ **Pin Assignment** ▸ click the circuit button: a
`74LS00 example` desktop appears, centred. **Space** to run, flip a switch. Click the
button again — same desktop, no duplicate. Right-click a `ram-8k` ▸ Pin Assignment:
no button.
