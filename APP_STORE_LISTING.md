# Chip Hippo — App Store listing copy

Draft content for the App Store Connect fields, kept here so a re-submission
starts from the last thing that was approved rather than from a blank box.
The number beside each heading is Apple's limit. Counts as drafted:
name 10/30 · subtitle 23/30 · promotional text 156/170 · keywords 98/100 ·
description 3107/4000 — so there is room to edit, but check again if you add a
paragraph, because the store TRUNCATES rather than refusing.

Wording is deliberately close to `website/index.html` and the in-app About
panel: the store page, the site and the app should not describe the product
three different ways.

---

## Version

**`1.0.0`** — must match `CFBundleShortVersionString` (i.e. `version` in
`src/package.json`) EXACTLY. App Store Connect was created as `1.0`, which is a
different string; edit it there rather than editing the repo, since `1.0.0` is
already the published GitHub release.

## Name (30)

```
Chip Hippo
```

## Subtitle (30)

```
TTL breadboard designer
```

## Category

Primary: **Developer Tools**. Secondary: **Education** (optional — the app is
as much a teaching tool as a bench tool, and it is how most people will look
for it).

## Promotional text (170)

Editable without a new build, so this is the line to change for a release note.

```
Build 74xx logic circuits on virtual breadboards, then run them — real
electrical nets, real clock edges, and real magic smoke if you get the voltage
wrong.
```

## Keywords (100)

Comma-separated, no spaces (a space costs a character). The app NAME is already
indexed, so "chip" and "hippo" are deliberately absent.

```
74xx,TTL,breadboard,logic,simulator,electronics,digital,circuit,7400,74LS,schematic,6502,Z80,retro
```

## Description (4000)

```
Chip Hippo is a workbench for 74xx-family TTL logic. Place solderless
breadboards on an endless desk, populate them with DIP chips, wires, switches,
LEDs and power supplies, then run the circuit and watch electricity settle
through every net.

It is a real bench, without the wire mess.

THE DESK
An infinitely pannable, zoomable workspace. Drop Full 830, Half 400 and Tiny
170 boards — power rails and pin-boards dovetail together exactly like the real
thing, and snap as you drag them. Every tie point is where it should be: the
board geometry is derived from millimetre measurements, not approximated.

THE PARTS
Gates, flip-flops, counters, decoders, multiplexers, shift registers,
comparators, bus drivers, memory, and even complete CPUs — the W65C02 and the
Z80, each running a real instruction set against a real bus protocol. Every
part carries its datasheet-exact pinout, including the ones with power pins in
unexpected places.

THE SIMULATION
Power is traced from the supplies, every electrical net is resolved, each
chip's outputs are computed, and changes ripple until the circuit settles.
Floating inputs read high, opposing drivers conflict, and a chip fed 12 V
releases its magic smoke — recoverable, because burning a chip is a wiring
mistake and not a permanent property of your design. Edge-triggered parts step
correctly on every clock, with Run, Pause, Single-step and speed control.

FINDING OUT WHY
Hover any hole to highlight its entire electrical net across every board and
wire, with a live readout of what is connected and the level it is carrying.
Flip to a derived schematic view of the same circuit. Open the logic analyzer
to watch signals over time. Every one of these reads the same document — there
is no second source of truth to fall out of step.

WIRING, FASTER
Wire a whole address or data bus in one gesture instead of one lead at a time.
Drag a part and its wiring goes with it. Route a wire by hand where the tidy
path matters. Name a net once and see it everywhere.

TAKING IT TO A REAL BENCH
The build guide turns your design into an ordered bill of materials and a
step-by-step assembly sequence, with a numbered cutting list for every jumper —
by colour and by length, so you can work through a drawer instead of guessing.

MEMORY
Program ROMs from .bin or Intel HEX files, inspect and edit them in a hex/ASCII
window, and export them again. A project carries its ROM images inside it, so a
design travels complete.

PROJECTS
One file holds every desktop in your project and every programmed ROM. One
save, one dirty marker, nothing written until you ask. Autosave keeps a
recovery copy so a crash costs you at most thirty seconds.

BUILT TO BE HONEST
Chip Hippo works entirely offline. It collects nothing, has no analytics, and
makes no network call you did not ask for. The optional AI circuit builder
talks to your own provider account with your own API key — nothing is sent to
us, because there is no "us" to send it to. It is free and open source under
the Apache 2.0 licence.

Available in English, German, Spanish, French, Italian, Japanese and Chinese.
```

## Support URL

```
https://github.com/jfigge/chiphippo/issues
```

## Marketing URL

```
https://chiphippo.com
```

Falls back to the `*.github.io` Pages URL until the domain is configured — do
not list a URL that does not resolve, it is a review rejection.

## Copyright

```
2026 Jason Figge
```

---

## Screenshots

**Captured — `.docs-build/appstore/`, all exactly 2560×1600.** Regenerate with
`node .docs-build/appstore.mjs [id …]`; it verifies every written PNG's
dimensions and fails rather than emit a size Apple would reject.

macOS accepts 1280×800, 1440×900, 2560×1600 or 2880×1800 and ONLY those, to
the pixel — the user guide's own images are 2560×**1544** and cannot be reused.

1. **`01-desk-running`** — a 74LS161 counter mid-simulation, three lamps lit,
   transport showing Stop/Pause/Step, chip library open down the side. Answers
   *what is this?* The palette is deliberately expanded: a tray of five
   collapsed headings advertises a parts library without showing a part.
2. **`02-schematic`** — the 65xx blink computer as a logical diagram: CPU, ROM,
   VIA, inverter, named nets. Answers *does it understand my circuit?* A
   MULTI-CHIP circuit on purpose — a one-chip counter derives a tall thin
   column that fits a 16:10 frame as a hairline, whatever the framing does.
3. **`03-build-guide`** — the bill of materials with the numbered jumper
   cutting list, by colour and length. Answers *what do I get out of it?*
4. **`04-ai-design`** / **`04b-ai-design-whole`** — the same AI-generated
   circuit framed two ways: circuit-first (caption cropped) and everything-in
   (caption whole, circuit small). **Pick one.** Both are re-shot offline from
   `.docs-build/generated.chiphippo`, so neither costs an API call.

5. **`05-logic-analyzer`** — CLK, QA, QB, QC, QD captured live, each lane half
   the frequency of the one above. Answers *can I see what it is doing over
   time?*
6. **`06-pinout-74LS151`** — the pin-assignments window floating over the desk:
   the DIP-16 map, then the manufacturer's own connection diagram and truth
   table. Answers *how do I know which pin is which?* It is a COMPOSITE — the
   pinout is a separate OS window and cannot appear in a capture of the main
   one, so it is photographed separately and overlaid, which is also what it
   looks like in use.

A live shot of the AI PANEL — the prompt, the verification ladder, the verdict —
would sell the feature harder than either 04, and needs one real API call:
`node .docs-build/capture.mjs ai-builder`.

## App previews (video)

Both **1920×1080 H.264 `.mov`**, inside Apple's 15–30 s window — checked with
`ffprobe` by the scripts that build them, which throw rather than emit a file
that would be rejected.

- **`wire-fade.mov`** (16.5 s) — `node .docs-build/wire-fade-gif.mjs`. The
  Fade-wires toggle on the 142-wire `eater-io` bench, cross-faded and looped.
  Faded, the chip labels buried under the bundle (W65C02, AT28C256, HM62256)
  become readable, which is the whole argument for the feature. The same run
  writes `wire-fade.gif` (1000 px) from the same frames.
- **`lcd-65xx.mov`** (17.1 s) — `node .docs-build/lcd-mov.mjs`. A real
  recording of the 65xx LCD bench: press Run, and the display comes up blank →
  `H` → `HI` as the CPU writes it. Played at the speed it was captured and
  looped three times, so the motion is honest.

  **CAPTION IT ACCURATELY.** This circuit is a **W65C02 with an 8 K ROM and a
  74LS04 / 74LS08 doing address decode, driving an HD44780 16×2 module that is
  memory-mapped directly.** There is **no W65C22** in it — the VIA is in the
  `65xx-blink` bench, and no shipped demo pairs the two — and the program
  prints `HI`, not "Hello, World!". Something like: *"A W65C02 running from ROM,
  printing to a memory-mapped 16×2 character LCD."* Do not describe it as
  driving the display through a VIA.

Optional further shot: the **memory inspector** over a programmed ROM.

## Review notes

Paste into *App Review Information ▸ Notes*.

```
Chip Hippo is a digital-logic breadboard simulator. No account, no login, and
no server: everything works offline and out of the box.

Three things a reviewer may notice, all deliberate:

1. NO IN-APP UPDATER. Help has no "Check for Updates" item and Settings > About
   explains why. The App Store delivers updates for this build. The same
   codebase ships a direct download that does self-update; it is switched off
   at runtime here (process.mas), not branched at build time.

2. THE AI CIRCUIT BUILDER IS OPTIONAL AND BRING-YOUR-OWN-KEY. The toolbar's AI
   button is disabled until the user enters their own Anthropic or OpenAI API
   key in Settings > AI. It then calls THAT provider directly with THAT key.
   No data reaches the developer at any point, and the app makes no network
   call at all until the user configures it. To review it without a key, every
   other feature is fully functional.

3. A ONE-TIME "CONFIRM ACCESS" PROMPT. Opening a project from the recent list
   may ask you to confirm the file in an open panel. This is the sandbox: a
   bookmark minted by the save panel does not survive a relaunch, so the app
   re-requests access rather than failing. Confirming once is permanent for
   that file.

Suggested walkthrough: open Help > Chip Hippo User Guide, or use the parts
palette to place a breadboard and a 74LS00, then press Run. Every chip's
pin-assignments window also has an "Example Circuit" button that opens a
working demonstration bench for that part.
```

## Privacy

**Data collection: none.** Answer *No* to "Does this app collect data?" — there
is no analytics, no telemetry, no crash reporting and no account.

The AI builder is the only thing worth a second thought, and it still collects
nothing: the user's prompt goes to the user's OWN provider account over the
user's OWN API key, which they entered themselves. The developer neither
receives it nor could. The key is held in the OS keychain via `safeStorage` and
never crosses into the renderer.

## Export compliance

Standard TLS only (HTTPS to the AI provider and the datasheet hosts) plus the
OS keychain — **exempt**. `ITSAppUsesNonExemptEncryption: false` is already in
the build, so the per-submission prompt should not appear at all. If it does,
the answers are: uses encryption **yes** → exempt (standard/HTTPS only)
**yes**.
