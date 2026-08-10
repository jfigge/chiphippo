# Chip Hippo — A free, offline, open-source TTL breadboard designer & simulator

[![CI](https://github.com/jfigge/chiphippo/actions/workflows/ci.yml/badge.svg)](https://github.com/jfigge/chiphippo/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
[![GitHub stars](https://img.shields.io/github/stars/jfigge/chiphippo?style=social)](https://github.com/jfigge/chiphippo/stargazers)

Design and simulate **74xx TTL logic circuits on virtual solderless breadboards**,
laid out on an infinitely pannable, zoomable desk. Place breadboards, seat DIP
chips across the trench, run jumper wires hole to hole, then press **Run** and
watch electricity trace out from the power supply, resolve every net, and ripple
through the circuit until it settles — LEDs light, switches drive the logic live,
and a 12 V rail lets the smoke out of a chip exactly as it would on a real bench.

Built with **Electron** and **Vanilla JavaScript** — no UI framework — with the
breadboards, the netlist, and the entire simulation engine as first-party code.
It shares its engineering foundation with its siblings
[Rest Hippo](https://github.com/jfigge/resthippo) and Port Hippo.

> **Why Chip Hippo?** Free forever · Open source (Apache 2.0) · 100% offline · No
> sign-in · No tracking · Your designs stay in local files.

<p align="center"><img src="src/web/docs/images/overview.png" alt="Chip Hippo — a circuit on the desk" width="820"></p>

📦 **[Download for macOS, Windows &amp; Linux](https://chiphippo.com/#downloads)** &nbsp;·&nbsp;
🌐 **[chiphippo.com](https://chiphippo.com)** &nbsp;·&nbsp;
📖 **[User guide](https://chiphippo.com/docs/)** ([PDF](docs/chip-hippo-user-guide.pdf))

## Features

- **The desk** — an infinite pannable/zoomable workspace. Breadboards come as
  kits (Full 830 / Half 400 / Tiny 170 tie points) or as loose pin-boards and
  power rails that **dovetail together** into snap groups and drag as one unit;
  a rail stood on end becomes a signal bus. Every tie point, rail hole, and
  component terminal is individually addressable (`bb1.f12`, `psu1.+`), so chip
  pins and wire ends bind to real holes.
- **63 chips** — the 74LS logic family (gates, buffers and transceivers,
  flip-flops, latches, counters, shift registers, decoders, encoders,
  multiplexers, a comparator, adders and the '181 ALU), memory (SRAM, ROM,
  EPROM, EEPROM), the 65xx peripherals (W65C21 PIA, W65C22 VIA), and two real
  **CPUs** — the **W65C02** and the **Z80A**, the latter running a genuine
  M-cycle / T-state machine so `/M1`, `/RFSH` and `/WAIT` mean something.
- **20 discrete parts** — slide switches, momentary and toggle push buttons,
  1/2/4/8-position DIP switch banks, LEDs, 7-segment digits and bar graphs,
  resistors and bussed resistor arrays, power supplies (3 V / 5 V / 12 V),
  clock sources and oscillator cans, and HD44780 character LCD modules.
- **Wiring** — click-click jumper wires in eight colours, laid **direct** (a
  sagging hole-to-hole curve) or **routed** by hand through waypoints. Buses lay
  a whole `D[7:0]` run in one click and draw as a ribbon. Nets can be named and
  the desk annotated. **Option-drag** a seated part and its wiring rides along —
  the wire ends, and the legs of the resistors and LEDs plugged into it — so a
  re-seat can never silently rewire the circuit; marquee or ⌘-click a group and
  the whole cluster drags as one rigid unit, in one undo step.
- **Simulation** — a pure, DOM-free engine: a union-find **netlist** partitions
  every point into nets, each net's level is resolved by driver strength, and an
  iterative **settle loop** with warm start runs to a fixpoint (which is why
  cross-coupled NAND latches hold their state). Chips are power-gated off their
  real VCC/GND nets — 5 V computes, 3 V is inert, 12 V is fatal. Driver
  conflicts, shorts, and oscillation are detected and surfaced. Sequential parts
  advance on a two-phase clock tick, driven by the **Run / Pause / Step / speed**
  transport at 1–100 Hz or stepped by hand.
- **Instrumentation** — a connectivity **probe** that lights up an entire net
  across boards, a **logic analyzer** recording waveforms and hex bus lanes with
  cursors and a Δ readout, per-part **pin-assignment windows** carrying
  hand-cut datasheet crops (and a button through to the manufacturer PDF), and a
  **build guide** with a bill of materials, a numbered wire cutting list, and
  ordered assembly steps you can follow at a real bench.
- **Schematic view** — `Tab` flips the desk over to a derived logical diagram:
  chip symbols, routed named nets, and bus lines laid out automatically from the
  same document, sharing the desk's camera, probe, and live simulation tint.
- **Memory** — ROM/EPROM/EEPROM chips backed by real bytes, with a virtualized
  hex/ASCII **inspector** (editable when stopped, a live viewer while running),
  Intel HEX and `.bin` import/export, and an in-app programmer. Programmed images
  travel **inside the project file**, content-addressed so identical bytes are
  stored once however many chips hold them.
- **AI assistant** _(optional — your own API key, encrypted at rest by the OS
  keystore)_ — two modes, and in both the app does the electrical reasoning.
  **Build**: describe a circuit in words and get a wired design; the model only
  ever emits a **coordinate-free netlist**, and a pure compiler places, routes,
  and interposes the resistors, then **proves the result through the real
  simulation engine** before offering it as a ghost for you to place. **Review**:
  Chip Hippo runs its own engine-backed checks over the desk you already have —
  floating inputs, a tri-state part switched off, two outputs on one net, shorts,
  an unlimited LED — and the model explains what they mean. It finds the faults;
  the model explains them, never the other way round.
- **Projects** — one `.chiphippo` file holds every desktop **tab** and every
  programmed ROM image: one dirty marker, one Save, one File menu. Nothing is
  written to your file until you save it, and a 30-second recovery stash in the
  app's own working folder means a crash costs at most half a minute.
- **Examples** — every benchable part ships a working demonstration bench inside
  the app, one click away from its pinout window, each one engine-validated
  against its datasheet truth table at build time.
- **Extras** — undo/redo throughout, light/dark/system theming, a scalable UI
  font, auto-update (opt-in — a check is an outbound call), and a UI localized
  into **seven languages** (English, German, Spanish, French, Italian, Japanese,
  Simplified Chinese).

Chip Hippo makes **no network call at all** unless you ask it to: the AI builder,
the datasheet downloader, and the update check are the only three, and every one
is opt-in.

## Architecture

```
Electron main process (src/app/main.js)     ← owns all filesystem I/O + native dialogs
  ├── store/        settings.json + ONE project file (atomic writes, schema migrations)
  ├── ai/           the only outbound HTTP (renderer CSP forbids it)
  └── IPC bridge (src/app/preload.js)  →  window.chiphippo.*
        └── Renderer / UI (src/web/scripts/app.js)   ← sandboxed; talks to main via IPC only
              ├── DeskView            ← desk/desk-geometry.js  (pure camera transform)
              ├── ProjectWorkspace    ← the open project; which desktop is on the desk
              └── DeskController      ← DeskDoc (model/, pure) + the surface layers
                    boards → parts → wires → overlay
```

Two rules shape the whole codebase:

- **Process split.** The main process owns every filesystem and native call. The
  renderer is fully sandboxed (`contextIsolation`, no `nodeIntegration`) and
  reaches main only over the `window.chiphippo.*` bridge — kept in lockstep with
  `main.js`'s handlers by an IPC-parity test.
- **Pure-logic / DOM split.** All geometry, addressing, occupancy, netlist, and
  simulation logic lives in **DOM-free ES modules** with sibling tests; view
  components stay thin. The simulation engine is pure computation, not I/O — it
  runs under plain `node --test` with no display and no Electron.

## Prerequisites

- [Node.js](https://nodejs.org/) (includes `npm`) — Electron 42 bundles Node 22;
  matching that locally keeps CI parity.

There is one runtime dependency (`electron-updater`). Everything else — the
breadboards, the netlist, the chip models, the compiler — is first-party.

## Project Structure

```
Chip Hippo/
├── Makefile               # Build orchestration (authoritative command list)
├── features/              # Numbered implementation plans; finished ones in done/
├── demos/                 # Generated + engine-validated demo projects
├── website/               # The chiphippo.com static site (GitHub Pages)
├── docs/                  # Generated user-guide PDF
├── scripts/               # Build tooling (docs, PDF, icons, demos, license guard)
└── src/
    ├── package.json       # Node / Electron dependencies + electron-builder config
    ├── packaging/         # Mac App Store entitlements + provisioning profiles
    ├── app/               # Electron main process (Node.js, CommonJS)
    │   ├── main.js        #   window lifecycle + IPC registration + app menu
    │   ├── preload.js     #   IPC bridge exposed as window.chiphippo
    │   ├── store/         #   projects, settings, memory images, credentials (+ tests)
    │   ├── ai/            #   provider adapters + streaming client
    │   └── datasheets/    #   the datasheet source table + downloader
    └── web/               # Renderer (Vanilla JS ES modules + CSS)
        ├── index.html     #   plus pinout / memory / docs auxiliary windows
        ├── scripts/
        │   ├── model/     #     breadboards, documents, occupancy, move rules (pure)
        │   ├── sim/       #     netlist, levels, chip eval, resolve, engine (pure)
        │   ├── catalog/   #     the parts catalog — data, never per-part code paths
        │   ├── desk/      #     camera + wire-path geometry (pure)
        │   ├── ai/        #     catalog brief + generate pipeline (pure)
        │   └── components/#     thin view components
        ├── demos/         #   bundled example circuits (one per benchable part)
        ├── docs/          #   the user guide's Markdown source + screenshots
        ├── datasheets/    #   committed datasheet crops for the pinout window
        ├── locales/       #   i18n catalogs (7 languages)
        ├── styles/        #   CSS + design tokens (theme.css)
        └── fonts/         #   Bundled Inter variable font
```

## Getting Started

### Install dependencies

```bash
make install        # npm ci in src/
```

### Run in development

```bash
make debug          # Electron with hot-reload (primary dev workflow)
```

This launches the app with a local `--user-data-dir` (`data/`, git-ignored) so
development projects stay out of your real profile.

## Building

For day-to-day local builds, `make` with no arguments produces an **unsigned,
un-notarized** macOS `.dmg` — fast, and it needs no signing credentials. Output
lands in `build/src/dist/`.

```bash
make                # Unsigned macOS .dmg (default; fast local testing)
make dmg            # Unsigned macOS .dmg (same as bare `make`)
```

`build-*` targets produce an **unpackaged** app directory (fastest, for smoke
tests — always unsigned). `dist-*` targets produce **installers** (signed when
credentials are present).

```bash
make build          # Build the app directory for macOS (dir only)
make build-mac      # macOS app directory
make build-linux    # Linux app directory
make build-win      # Windows app directory

make dist           # Installers for all platforms (host can only build its own)
make dist-mac       # macOS (.dmg, .zip)
make dist-linux     # Linux (.AppImage, .deb)
make dist-win       # Windows (NSIS .exe, portable)
```

> A given host can only build its own platform's installer (a macOS `.dmg` needs
> macOS, etc.). CI runs `dist-mac` / `dist-linux` / `dist-win` on native runners.

### Code signing

`dist-mac` / `dist-win` sign their installers when signing credentials are
present and produce **unsigned** artifacts (no failure) when they are absent — so
unsigned `--dir` dev builds and credential-less CI keep working unchanged. macOS
reads `CSC_LINK` / `CSC_KEY_PASSWORD`; in CI both come from repository secrets,
and the [Release workflow](.github/workflows/release.yml) names them and signs
only on tag builds.

### Mac App Store

The store package is the **same code** down a different channel — a runtime gate
(`src/app/store-build.js`) turns the auto-updater off in a store build rather
than the build being branched.

```bash
make mas            # Universal signed .pkg for App Store Connect
make mas-dev        # Locally-runnable sandboxed build, to try before submitting
```

Both **skip with a message and exit 0** when their git-ignored provisioning
profile is absent, so a fresh clone still builds everything else. The submission
process itself lives in [STORE-PUBLISHING.md](STORE-PUBLISHING.md).

## Code Quality & Tests

```bash
make fmt            # Format JS/CSS/HTML (Prettier)
make fmt-check      # Verify formatting without writing
make lint           # Lint JS (ESLint)
make test           # License-header guard + the full unit suite (node --test)
make test-i18n      # Just the language guards — the fast loop while translating
```

`make test` is hermetic — pure `node --test` across ~145 suites with no display,
Electron process, or network — and is the gate CI enforces. It covers the pure
model and engine modules directly (including an exhaustive truth-table harness
over every gate and circuit fixtures for the sequential parts), the renderer
components under jsdom, and five **i18n guards** that make an untranslated
string fail the suite rather than ship.

Every first-party source file must carry the Apache 2.0 header; `make test`
enforces it and `make license-headers` stamps any file missing one.

## Releasing

Run from `main` with a clean, up-to-date working tree:

```bash
make release VERSION=1.2.3
```

It validates the version, confirms you're on `main` and in sync with origin, and
gates on the full test suite. On approval it bumps `src/package.json`,
fast-forwards the long-lived `release` branch to `main`, tags `v1.2.3`, and
pushes all three atomically. The tag triggers the **Release** workflow, which
builds and publishes signed installers for macOS, Windows, and Linux — along with
the `latest*.yml` feed that in-app auto-update reads.

`release` stays a strict fast-forward of `main`, so it always points at exactly
what was last shipped.

## Generated Assets

Several committed artifacts are build outputs; regenerate them with `make` rather
than by hand.

```bash
make demos          # Rebuild + engine-validate demos/ and the bundled examples
make docs           # Build the hosted user guide into website/docs/
make pdf            # Build the user-guide PDF (docs/chip-hippo-user-guide.pdf)
make icons          # Regenerate app-icon rasters from the SVG sources
make datasheets     # Report which pinout-window datasheet crops are missing
make vendor-markdown  # Rebuild the bundled marked + DOMPurify renderer
make site           # Regenerate website/versions.json from GitHub Releases
```

The user guide has **one Markdown source** (`src/web/docs/*.md`) driving three
outputs that therefore cannot diverge: the in-app viewer (Help ▸ User Guide,
`⌘/`), the hosted site, and the PDF.

## Build Information

```bash
make version        # Print the current version string
make info           # Print full build info (version, branch, commit, build time)
make help           # List all available targets
make clean          # Remove build/ and dist/ directories
```

## Roadmap

Chip Hippo is **released and in active development** — v1.0.0 ships for macOS,
Windows, and Linux. Development is plan-driven: every stage is written up in
[`features/`](features/ROADMAP.md) before it is built, and finished plans move to
[`features/done/`](features/done). What is queued next, and the backlog behind it,
lives in that roadmap.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
