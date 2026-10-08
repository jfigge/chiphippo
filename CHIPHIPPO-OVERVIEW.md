# Chip Hippo — Architecture & Feature Overview

*Snapshot of the working tree on 2026-10-07 (version 1.3.0 plus uncommitted work on the `spice` branch). Written as context for an AI assistant: what the app is, what it can do, and how it is built.*

---

## 1. What it is

**Chip Hippo** is a cross-platform desktop app (macOS, Windows, Linux, Mac App Store) for **designing and simulating 74LS TTL and CD4000 CMOS logic circuits on virtual solderless breadboards**.

- The main window is an infinite, pannable, zoomable **desk**. The user places breadboards, seats DIP chips and discrete parts, runs jumper wires, adds power supplies and clocks, and presses **Run**.
- A **simulation engine** resolves every electrical net and ripples changes through the circuit until it settles. LEDs light, displays count, and chips smoke if mistreated.
- A second, more electrical engine, **Spice Lite**, gives every net a voltage. It models currents, RC timing, fan-out, supply droop and LED brightness and burnout.
- Around that core are:
  - a schematic view, a 3D view, a logic analyzer, a build guide and bill of materials, and memory chips with a hex inspector;
  - an AI circuit builder and AI desk review;
  - a **custom chip designer** (behaviour written in a Verilog subset, with a debugger);
  - **Arduino serial integration**, so real hardware can talk to the simulated circuit;
  - KiCad and Digital exports, and a bundled user guide in 7 languages.
- **Tech:** Electron 42+ with **vanilla JavaScript** and Node.js. There is **no UI framework and no bundler** for app code, as a hard, permanent constraint. Plain CSS uses design tokens. Tests use Node's built-in `node --test` plus jsdom.
- **Scale:** about 126k lines of source (72 main-process files, about 480 renderer files) and about 93k lines of tests in 244 test files.
- **License:** GPL-3.0-or-later. Code the app generates for microcontrollers is exempt under a section-7 additional permission.
- **Ecosystem:** a website at chiphippo.com (GitHub Pages). Sibling apps by the same author are Rest Hippo and Port Hippo.

---

## 2. Process architecture

```
Electron main (src/app/, CommonJS) — owns ALL filesystem, native and network I/O
  ├── Stores (src/app/store/)   settings.json, ONE .chiphippo project file, custom-chips.json,
  │                             credentials (safeStorage), bookmarks (MAS), ROM sidecars
  ├── Window state, close guard (pure state machine), native menu, i18n locale resolution
  ├── IPC handlers (area:noun[:verb]) — held in lockstep with preload by a parity test
  ├── ai/ (LLM client), datasheets/ (downloader), updater.js — the ONLY 3 network paths
  └── serial/ (Arduino link, Mock device, port I/O via `serialport`)
        │
        └── preload.js → window.chiphippo.*  (the only bridge)
              └── Renderer (src/web/, ES modules, sandboxed)
                    ├── DeskView (camera/DOM shell) ← desk/desk-geometry.js (pure)
                    ├── ProjectWorkspace — the open project + which desktop is shown
                    ├── DeskController — owns DeskDoc, surface layers, the input state machine
                    ├── SimController — transport, sim clock, engine choice, run-volatile state
                    └── panels: palette, analyzer, AI, build guide, schematic, 3D, settings
```

**Windows.** There is the main window plus these sandboxed auxiliary windows:
- pin-assignments (one per part type)
- memory inspector
- chip designer
- user-guide viewer
- serial connection log (one per connection)

Auxiliary windows relay through main.

### Security posture
- **Renderer isolation.** Every renderer has `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`.
  - CSP is `default-src 'self'` with no `connect-src`, so the renderer cannot touch the network.
  - The Inter font is bundled and fonts never load from a CDN.
  - Links open in the system browser.
- **Path gating.** Every path crossing the bridge is gated by main's `knownPath`. A path is allowed if it is inside the app's saves folder, or was established by a dialog or an opened project this session. The recent-projects list is its own allowlist.
  - ROM sidecars are GUID-keyed, and their paths are resolved only in main.
  - Serial ports are named by connection id. The renderer never names a device path.
- **Network.** There are exactly three outbound network paths, all in main and all **opt-in**: the AI builder, the datasheet downloader and the auto-updater. An unconfigured install never touches the network. Each path sits beside a hard-coded statement of where it may connect.
- **API key.** The key is encrypted with Electron `safeStorage` (Keychain, DPAPI or libsecret). The store refuses to save it in plaintext, and the key never crosses IPC.
- **Settings ownership.** The renderer writes only its own settings. Main-owned keys, such as the recent-projects allowlist and window bounds, are stripped from renderer writes.

### IPC areas
| Area | Purpose |
|---|---|
| `app:*` | version and info, close handshake |
| `settings:*` | read and write settings |
| `project:*` | boot, new, open, save, recent, recovery |
| `desktop:*` | export, import, duplicate, export-to KiCad/Digital |
| `mem:*` / `memory:*` | ROM sidecars and the memory inspector |
| `pinout:*` | pin-assignments window |
| `chipdesign:*` / `chip-library:*` | custom chip designer and library |
| `datasheet:*` | datasheet open and download |
| `demo:*` | example circuits |
| `docs:*` | user guide |
| `ai:*` | AI requests and key management |
| `updater:*` | auto-update |
| `serial:*` / `integration:*` | Arduino link and generated files |
| `menu:*` | menu state |
| `i18n:load` | locale catalogs |

Main→renderer pushes are re-dispatched by preload as global `chiphippo:*` CustomEvents.

### Renderer code layout (`src/web/scripts/`)
- **`desk/`**: pure geometry (camera, wire sag and polylines, ribbons, union outlines).
- **`model/`**: pure document logic.
  - board lattice, occupancy, footprints, mating and snapping
  - part and cluster moves, design clips and paste, schematic layout, build plan
  - value parsing, autobuild (AI compiler), desk review, export, serial integration and codegen
- **`sim/`**: the DOM-free, timer-free logic engine. **`sim/spice/`** holds Spice Lite.
- **`hdl/`**: the Verilog-subset toolchain (lexer, parser, analyzer, 4-state interpreter).
- **`catalog/`**: every part as **pure data plus pure functions**. There are no part-specific code paths anywhere else.
- **`scene3d/`**: the pure 3D scene builder. **`ai/`**: prompt, catalog card, usage, connection logic.
- **`components/`**: thin class-based views and controllers.
- **`bench/`**: performance fixtures (`make bench`, `make profile`).

### Core engineering rules
- **Pure logic, thin views.** All geometry, addressing, occupancy, netlist and simulation logic is DOM-free with sibling tests.
- **Sim state reaches views only by broadcast.** All visible sim state renders from the `chiphippo:sim-state` broadcast; views never query the engine.
- **Messaging.** Use constructor callbacks for parent-owned widgets and global `chiphippo:*` CustomEvents for app-wide changes. There is no event bus library.
- **Drag discipline.**
  - Every drag uses pointer events with `setPointerCapture` and a ~4 px threshold. Native HTML5 drag-and-drop is never used.
  - The drop resolves from the **release** event's position.
  - Preview and drop share one resolver.
  - A drag that spans pressing Run is reverted.
- **Hit-testing is math, not DOM.** Holes carry no ids or listeners; everything goes through `holeAt()` from pointer coordinates.
- **Addresses are the currency.** `bb1.a12` is a grid hole, `bb2.+7` a rail hole, `psu1.+` a brick terminal. Wires store addresses, never pixels. Pin positions are always derived from footprint and anchor, never stored.
- **Occupancy is the single collision authority.** Each hole holds one lead.
- **Loading enforces placement rules.** `normalizeDocument` applies them to anything loaded from a file: it drops overlapping boards, double-booked holes and invalid wires.

---

## 3. The desk and breadboards

### Camera
- **Pan** by dragging empty desk or with a two-finger scroll. **Zoom** with the wheel or a pinch, centred on the pointer.
- **Zoom cluster** (− / % / +) sits bottom-right.
- **Keys:**
  - `⌥⌘=` / `⌥⌘−` / `⌥⌘0` zoom the desk.
  - `⌘=` / `⌘−` / `⌘0` resize the interface text.
- **Fit** (`⌘F`) frames everything and recentres the design around the origin as one undoable edit. `⇧⌘F` zooms out fully.
- **Dot grid** marks the 0.1 in pitch and coarsens with zoom.
- **Wheel lock** (`⌘L`, the padlock) stops Magic Mouse phantom scrolls. It is saved per project.

### Units
One world unit equals one breadboard pitch, 0.1 in (2.54 mm).
- **Horizontal** is a strict integer lattice.
- **Vertical** has no lattice. Real strip heights are stated in mm and quantized to 0.01: rails are 3.50 pitch and pin-boards 14.02, so a Full kit stacks at 0 · 3.50 · 17.52.

### Boards are strips
A "breadboard" is a **kit** of strips placed in one action.

| Strip | Size |
|---|---|
| Full pin-board | 63 columns, 630 points |
| Half pin-board | 30 columns |
| Tiny pin-board | 17 columns, 170 points |
| Full power rail | 2 × 50 holes |
| Half power rail | 2 × 25 holes |

- **Kits:**
  - Full 830 = rail + pins + rail.
  - Half 400 is the same at half length.
  - Tiny 170 is a bare pin-board.
  - Loose single strips are offered too.
- **Rows** run `j i h g f`, then the **trench**, then `e d c b a`. Each 5-hole column-half is one node. Each rail line (`+`, `−`) is one continuous node.
- **Magnetic snap.** A strip within 2 pitch of a compatible edge is pulled flush, but only if the snapped spot is legal. Flush strips **mate** into a group that drags as one rigid unit; a kit arrives pre-grouped.
- **Breaking a snap.** `⌥`-drag tears off the run forward; `⌥⇧`-drag tears it off backward. Both halves are regrouped automatically.
- **Group outline.** The selection outline traces the union of the group with no seams, and turns red when the drop is illegal.
- **Rotation is for power rails only**, in 90° steps, pressing `R` while placing. A rail turned on end works as a signal bus. Hole ids stay in the strip's own frame, so the netlist is rotation-blind.
- **Deleting a strip** removes only what is seated on it. A neighbour's lead that reached onto it is left floating, which is legal.
- **Tabs.** Projects hold multiple **desktops** in a tab strip over the desk (see §12).

---

## 4. Parts and placement

### Parts palette (left tray)
- **Sections:**
  - BOARDS
  - CHIPS, in function folders, plus Timer · Interface · PROCESSOR · CUSTOM
  - COMPONENTS: Switches, Resistors, Capacitors, Inductors, Diodes, Transistors, LEDs, Displays, Oscillators, Power
  - Memory
  - ANNOTATIONS
  - SIGNALS
- **Filter box** searches parts. A **chip family filter** (74LS / CD4000 / Both) hides the other family, but a family the open project uses is always shown.
- **Layout.** The tray collapses to an icon rail (`⌘P`) and is resizable.
- **Placing.** Click an entry to arm a placement ghost; it turns red where illegal, and `Esc` cancels.

### Seating rules
- **300-mil DIPs** (up to DIP-20) straddle the trench in rows e/f. Pin 1 sits at the anchor and the notch faces left.
- **600-mil DIPs** (DIP-24 to DIP-40: memories, 65xx, Z80, 74LS181) seat in rows d/h. Their body covers rows e–g, and those holes are blocked. Older narrow seats remain valid.
- **Linear parts** seat along one row: switches, LEDs, digits, bar graphs, LCD headers, transistors, the pot, the resistor network.
- **Two-lead parts** (resistor, capacitors, inductor, diodes, LED) start inline.
  - `R` while placing switches to **free-ends** mode: pin 1 anchors anywhere, including a rail, and pin 2 is a bent lead that lands on any hole on any strip.
  - A lead over nothing **floats**, which is legal.
- **Rotate and flip.** `R` flips chips 180° in place, turns two-lead parts about pin 1, and reverses transistors and resistor networks. `F` flips LED polarity while placing.

### Non-chip parts
Every part has Name and Description fields. Discretes also take an optional part number, which is exported to the BOM and KiCad.

- **Switches**
  - Slide switch (SPDT).
  - Momentary push button.
  - Latching push button.
  - DIP switch banks of 1, 2, 4 and 8 positions. These straddle the trench and are clickable while running.
- **Resistors**
  - Resistor: E12 picks from 10 Ω to 1 MΩ, or any typed value from 0.1 Ω to 100 MΩ, drawn with real colour bands.
  - 9-pin bussed SIP network (`rnet9`).
  - Potentiometer (Bourns 3296W): a live position slider while running, with a rotating screw.
- **Capacitors**
  - Ceramic, default 100 nF.
  - Electrolytic, polarized, default 10 µF.
  - Digitally a capacitor is open; timing chips read it, and Spice Lite charges it.
- **Inductors.** Coil or can style, 2- or 3-hole spacing. Electrically a wire.
- **Diodes**
  - Diode: one-way.
  - Zener: a 2.4–30 V list paired with real part numbers. It clamps under Spice Lite.
- **Transistors**
  - NPN and PNP BJTs in TO-92.
  - N- and P-channel MOSFETs in TO-220 or TO-92. The MOSFET gate holds its last level, shown with an amber ring.
  - Each has an "on" lamp.
- **LEDs**
  - LED in red, green, blue, yellow or white.
  - 8-segment digit, common cathode or common anode.
  - 8-segment bar graph: common-cathode SIP, or isolated DIP-16.
- **Displays.** HD44780 character LCDs, 16×2 and 20×4, at true size. They are a full controller model (8- and 4-bit modes, CGRAM) with a backlight colour. Under Spice Lite the backlight and contrast are electrical.
- **Oscillator cans.** Full and half size, 1 Hz–1 kHz, chip-powered.
- **Power bricks** (desk-level, not seated)
  - **PSU:** 3, 5, 9, 12 or 15 V. Above 5 V damages 74LS chips. The current limit (100 mA–5 A) matters under Spice Lite.
  - **Clock:** 1, 2, 5, 10, 20, 50, 100, 250 Hz, 1 kHz, or Manual (click to toggle). It must itself be powered.
- **Annotations:** Label (one line) and Note (multi-line). They can anchor to a part and ride with it, and they are invisible to the electrical model.
- **Signals** (§10) and **Arduino Output/Input tags** (§11).

### Values
A single value parser handles every value field.
- **Accepted forms:** `470`, `4k7`, `2M2`, `100n`, `0.1uF`, `5V1`, and spelled-out prefixes. Lowercase `m` is always milli and uppercase `M` always mega.
- **Validation.** A wrong unit is refused by name, and an out-of-range value is shown in red with the reason.

---

## 5. Wiring, buses, names

### Wire tool (`W`)
- **Drawing.** Click-click with a rubber band, and the tool stays armed between wires.
- **Colours.** There are 8: red, black, blue, green, yellow, orange, white, purple. Keys `1`–`8` pick one while the tool is armed.
- **Editing.** Drag an end cap to re-end it; it snaps within about 1.2 pitch or reverts. Drag the body of a direct wire to move it whole.
- **Layout per wire:**
  - **Direct:** a sagging curve, the default.
  - **Routed:** a straight polyline through up to 20 waypoints. Press along the run to add a bend; drop a bend on a neighbour to merge it away.
- **Board drags.** Dragging a board carries the waypoints drawn over it.
- **Fade wires** (`H`) draws each wire as end stubs only.
- **Wire Properties** draws a **wire gauge** picture showing the real cut length in cm, including the stripped ends.
- **Auto-route** (toolbar) rewrites every wire as a board-aligned routed run around the parts, as one undo step. Its plan is still formally open, but the feature works.

### Bus tool (`B`)
- **Widths.** Lays a 2–8- or 16-bit run in one click-click, drawn as a ribbon cable (`D[n-1:0]`).
- **Fit check.** Every hole at both ends is ringed green or red.
- **Fanning.** Landing on a chip's pin group fans the bus onto those pins in bit order.
- **Menu:** rename, un-bundle, delete, recolour.

### Net names
- **Naming.** With the probe armed, right-click to name a net. Quick picks are VCC, GND and CLK.
- **Binding.** The name belongs to the hole and resolves to whatever net that hole is on. A merge conflict raises a toast.
- **Where names appear:** the probe, the schematic, the build guide and the exports.

---

## 6. Selection, moving, clipboard, undo

### Selecting
- **Click** to select one item.
- **Shift-drag** draws a marquee that selects enclosed items.
- **⌘-click** toggles an item. **⌘A** selects all. **Delete** removes the selection; **Esc** clears it.
- Nothing is selectable while the circuit runs.

### Moving
- **Plain part drag** re-seats the part alone.
- **⌥-drag carries the wiring.** Every wire end sharing a column-half with one of the part's pins rides along, as do bent resistor or LED legs. The move is one hop, crosses boards, and is all-or-nothing. Holding ⌥ previews which ends will ride.
- **Cluster drag.** Dragging a multi-selection moves every selected part, PSU and clock by one delta, as one undo step.

### Copy and paste
- `⌘C` / `⌘V` copies a part, a cluster, or a whole **design** (boards plus everything on them). Designs paste **across desktops** as a ghost that magnetically snaps.

### Undo and redo
- `⌘Z` / `⇧⌘Z`.
- History is whole-snapshot (no inverse code), up to 100 steps, with gestures coalesced within 400 ms.
- Each desktop has its own history. Simulation state is never undoable.

### Context menus
- **Part:** Pin Assignment · Properties… · Delete Component. Custom chips add Open in Chip Designer and Break on Settled.
- **Board:** Properties · Remove.
- **Bus:** rename · un-bundle · delete · colour.
- **Annotation:** edit · remove.
- **Signal:** Properties · Add to analyzer · Remove · Delete.

### Properties dialog
- **Shape.** One shared modal driven entirely by the part's catalog `properties` list. It holds Name and Description, then the part's own fields: colour, select, segmented, range slider, value combobox, readonly, action, and wire gauge.
- **Live editing.** Changes apply live and coalesce into one undo step each. A **Warnings** section lists the part's current faults every tick.
- **Extra rows.** Timed parts show a Timing row. Memory chips show Inspect memory… and Load image….

---

## 7. Simulation — the classic logic engine

### Purity
The engine is DOM-free and timer-free.
- **Inputs:** document, netlist, warm-start levels, chip state, clock phases, memory images, signal levels, and `now`.
- **Outputs:** levels, state, chip status, warnings, `wakeAt` and memory writes.

### Netlist
A union-find partition of every hole, terminal and pin into nets. Net ids are the smallest member address, so they stay stable for warm starts. There are two partitions:
- **Conducting:** switches as currently set, an inductor as a wire. This is the live circuit.
- **Wiring:** every switch open. This is what was physically built; the schematic, build guide and net naming use it.

### Levels
Every net is H, L, Z (floating) or X (unknown or conflict).
- **Readers.** A floating input reads **HIGH for 74LS** and **X for CD4000**.
- **Strength:** supply > chip output > resistor pull.
- **Faults.** Opposing supplies raise a **short**; disagreeing outputs raise a **conflict**.
- **Diodes** are one-way bridges that never pass a LOW.

### Chips are data
- **Combinational parts** declare units (gates, tri-state buffers, compute blocks) walked by one generic evaluator.
- **Sequential parts** declare `{state0, step, outputs}`, built from family builders: D/JK flip-flops, latches, sync and up/down counters, shift registers, Johnson counters, BCD decoders and others.
- **Per-part code** behind the same contract exists only for the CPUs, PIA/VIA, HD44780 and timers.

### Settle and tick
- **Settle** loops resolve → evaluate → re-drive to a fixpoint. At the 200-pass cap, still-changing nets become X and an **oscillation** warning is raised.
- **Incremental settle** is the default. It re-evaluates only chips whose inputs changed and is proven bit-identical to the full loop: 3.8–4.4× faster, about 1.4× under Spice Lite.
- **Tick** runs pre-settle, then samples clock edges and steps sequential chips, then post-settles. Ripple chains (74LS90, 74LS107) cascade within one tick.

### Power and chip health
Each chip is gated on its VCC and every ground pin.
- **Supply ranges:** 74LS 4.75–5.25 V; CD4000 3–18 V; NE555 4.5–16 V.
- **Statuses:** ok, unpowered, underpowered, reversed, **damaged** (over-voltage, with magic smoke), and overloaded (brown smoke, Spice Lite only). Damage clears on Stop.

### Other electrical behaviour
- **Open-collector parts** (74LS01/03/05/47, the 74LS181's A=B output) output Z instead of HIGH, so wired-AND with a pull-up works.
- **Analog switches** (CD4066B, CD4051B/52B/53B) and transistors join nets rather than driving them. A rail through a switch fights an output on the far side. The CD4007UB is six bare MOSFET channels.
- **LED rule.** An LED lights when its anode is H and its cathode L. It **burns** when both ends are strongly driven, meaning no series resistor. A CD4000 output at ≤5 V cannot burn an LED, except the high-current 4049, 4050 and 4511.

### Family rules (74LS vs CD4000)
- **Floating CMOS inputs** read X and propagate; CMOS sequential state can be unknown.
- **CD405x parts** need VEE tied to VSS, or they are unpowered.
- **Structural warnings:**
  - `floating-input`: a CMOS input, spares included.
  - `marginal-high`: a 74LS output driving CMOS with no pull-up.
  - `ls-fanout`: a CMOS output driving more than one 74LS input.
  - `mixed-supply`.

### Clocking and transport
- **Clock bricks** run at 1 Hz–1 kHz or Manual, and each can be paused while running. Oscillator cans free-run.
- **Transport controls:**
  - Run/Stop: `Space` or `⌘R`.
  - Pause/Resume.
  - Step: one half-period of the fastest clock, or the next timer wake.
  - Speed: ×¼, ×1 or ×4.
- **Batched ticks** (newest work):
  - Clock edges and timer wakes share one queue in **simulated** time.
  - Every due event is its own exact tick, but the screen is updated once per frame (at most every 8 ms, with a 6 ms work budget).
  - If the desk can't keep up, time re-anchors rather than bunching. The speed button shows the achieved speed in amber.
  - Above 25 Hz effective, lamps stop flickering and draw flat.
  - User inputs catch the schedule up first.

### What the user sees while running
- **LEDs** glow, or show burnt with a red cross and smoke.
- **Chip badges** show amber for underpowered and smoke for damaged.
- **Timers** show readouts and warning triangles. **Clock lamps** follow the clock.
- **Warnings** appear as toasts: short, conflict, oscillation, floating input, timing and others.
- **Interaction.** Switches, buttons, DIP banks, signals and manual clocks stay live while running, but topology editing is locked.

---

## 8. Spice Lite — the second engine

Settings ▸ Spice Lite turns it on, effective from the next Run.
- **What it is not.** It is not SPICE: there is no circuit-wide matrix and no manufacturer models.
- **What it uses:** Ohm's law, small per-cluster Newton solves, closed-form exponentials, and one **common** figure set per family. The figures come from TI datasheets and are user-editable.
- **How it drives the digital engine.** It works through a hooks seam and never re-implements the settle. Only `SimController` chooses the engine.
- **Parity.** The AI verifier, desk review, demos and exports always use the digital engine. A parity test runs every example in both engines.

### What it models
- **Every net a voltage.**
  - **Output stages:** a 74LS HIGH is VCC − 1.4 V behind 120 Ω, and a LOW is 0.15 V behind 25 Ω. CD4000 outputs are saturating MOSFETs that scale with VDD.
  - **Input stages:** 74LS bias currents and CMOS clamp diodes.
  - **Readings.** Every input reads its **own pin's voltage** against the family's VIL/VIH thresholds, with an undefined band. Schmitt parts keep hysteresis.
  - Dividers, diode-AND drops, weak pull-downs into the undefined band, and output fights all behave realistically.
- **Devices.**
  - BJTs: VBE 0.65 V, β 100, VCE(sat) 0.2 V.
  - MOSFETs: Vth 2 V; a floating gate keeps its voltage.
  - Diodes: 0.6 V knee. Zeners conduct backwards.
- **Chips powered off the rails** (through a diode, resistor or transistor) run at whatever voltage the solve gives them.
- **Time.** One pass equals the shortest gate delay: 74LS 10 ns; CD4000 125 ns at 5 V, faster at higher VDD.
- **RC nodes.**
  - Every capacitor net follows a closed-form exponential, or a ramp where an output saturates. The cost is the same for 1 µs or 10 s.
  - Inputs are read by exact **crossing times**.
  - Charge is carried tick to tick; power-up is real.
  - **Coupling:** steps across a capacitor shift the far node; cap pairs share one τ.
  - **Fast oscillations** are recognised as cycles and drawn at the 1 kHz cap, while counters still count the true cycles.
- **Fan-out.** Input loads are summed against the drivers' source and sink ratings. Over 1× is a brown-out warning; 2× or more gives **brown smoke**.
- **Output limits.** 74LS warns over 20 mA and smokes over 100 mA. CD4000 warns over 50 mW and smokes over 100 mW. A 74LS input over 7 V smokes, and CMOS clamp current over 10 mA smokes.
- **Supplies.** Each PSU has a current limit; past it, the voltage droops proportionally. The PSU brick shows the current drawn.
- **Wire resistance.** Jumpers are 24 AWG at their real cut length, and the drop is fed into chip power checks.
- **Switching spikes and decoupling.** Each switching output charges its load capacitance from its supply. Peaks over the limit warn, and a capacitor from a chip's VCC to ground decouples it.
- **LEDs by datasheet** (Kingbright 5 mm, per colour).
  - Model: a knee voltage plus resistance; brightness is the cube root of current.
  - Faults: overdriven, **burnt** (by junction temperature), and reverse-voltage.
  - Segments and bars are LEDs too.
- **LCD.** The backlight is an LED, and V0 sets the contrast.
- **The probe** shows net voltage and lead current under Spice Lite.
- **The analyzer** draws voltage traces under Spice Lite.

### Timers as silicon
The NE555, CD4047B, CD4098B, CD4528B, CD4538B, CD4060B and CD4541B are each modelled as their datasheet internals: comparators, reference dividers, discharge transistors and clamps on their real pins. **Nothing computes a period**; the readout is **measured** from the waveform.
- The first 555 astable high is about 1.6× longer, because the capacitor starts empty.
- CONT moves the 555's trip points.

### Not modelled
Inductor current, contact resistance, heat beyond LED and diode junctions, two unrelated fast oscillators at once, and smoothly moving coupling.

---

## 9. Timed parts, memory, CPUs, analyzer

### Timed parts in the digital engine
- **Timed contract.** Each timed part reads its R and C from the board through a single RC tracer, which combines parallel parts. The part reports a `wakeAt`, and the controller schedules it.
- **Display cap.** Oscillations above 1 kHz are drawn at 1 kHz with the duty cycle kept, and the true rate is shown in amber. Pulses shorter than 0.5 ms are stretched.
- **NE555.** It auto-detects its configuration:
  - **Bistable** is checked first.
  - **Astable:** 0.693(RA+RB)C high, 0.693·RB·C low.
  - **Monostable:** 1.1·RA·C.
  - Unrecognised wiring is refused with an explanation.
- **CMOS timers:**
  - CD4047B: astable or monostable.
  - CD4098B, CD4538B, CD4528B: dual retriggerable one-shots.
  - CD4060B: 14-stage counter with an RC oscillator, or an external clock; no crystal.
  - CD4541B: programmable timer with selectable 2^8, 2^10, 2^13 or 2^16 division, recycle or single mode.
- **Readouts.** Timing appears under the chip and in its Properties dialog, even while stopped.

### Memory
| Part | Description | Volatility |
|---|---|---|
| rom-8k | 8K×8 generic ROM | non-volatile |
| 28C16 | 2K×8 EEPROM | non-volatile |
| AT28C256 | 32K×8 EEPROM | non-volatile |
| AM27C1024 | 64K×16 EPROM | non-volatile |
| ram-8k | 8K×8 generic SRAM | volatile |
| HM62256 | 32K×8 SRAM | volatile |
| AS6C1024 | 128K×8 SRAM | volatile |

- **SRAM** is filled with random noise at each Run and is never saved.
- **ROMs** are programmed only through the in-app "external programmer" (Load image…: `.bin` or Intel HEX) or the inspector. The circuit can never write a ROM.
- **Storage.** ROM bytes are saved inside the project file and deduplicated by SHA-256. Desktops sharing an image store it once.
- **Memory inspector.** A floating window per chip with a virtualized hex/ASCII grid, Go to, Fill, Save, and import/export of `.bin`/HEX.
  - A stopped ROM is editable.
  - A running chip shows a live mirror with changed bytes tinted.

### CPUs and peripherals
All four parts are DIP-40 and run real programs from ROM.
- **W65C02:** one bus access per PHI2 cycle; reset vector at $FFFC.
- **Z80A:** a real M-cycle/T-state machine with a separate I/O space, starting at $0000.
- **W65C21 PIA:** two 8-bit ports with data-direction registers, plus handshake and IRQ lines.
- **W65C22 VIA:** ports, T1/T2 timers, shift register, interrupt registers.

The bundled examples include a Ben Eater-style 6502 computer with an LCD.

### Logic analyzer (`A`)
- **Panel.** Bottom-docked.
- **Channels.** Named nets, buses, or any net added from the probe. Channels are saved in the document; reorder them by dragging.
- **Recording** captures every tick, even inside batches, up to 8000 columns.
- **Drawing.**
  - Net lanes: Z dashed, X as an amber hatch.
  - Bus lanes: decoded to hex.
  - Under Spice Lite: voltage traces.
- **Cursors.** A and B cursors show tick and time deltas; follow mode auto-scrolls.
- **Export** as SVG or PNG.

---

## 10. Probe, schematic, 3D, build guide, external signals

### Probe (`I`/`P`)
- **Highlight.** Hovering highlights a whole net across holes, pins and wires; a click pins it. The highlight is shared with the schematic.
- **Readout:** name, level, hole/pin/wire counts, the rails and terminals on the net, and under Spice Lite the voltage and lead current.
- **Hover tooltips** everywhere give `ref pin n · name → address`.

### Schematic view (`Tab`)
- **A projection, not a separate document.**
  - Chips are drawn as labelled boxes, with gate-shape badges for gate chips.
  - Discretes use real symbols with values.
  - Power uses local symbols; signals use orthogonal routes with net labels; buses become thick bus lines.
- **Layout.** Automatic, left-to-right. Dragging a symbol stores a position hint, and **Auto-layout** clears all hints.
- **Live.** Nets tint by level, LEDs light, and chips show health badges.

### 3D view (enable in Settings)
- **Read-only WebGL scene**, written in raw WebGL2/1 with no library and lazily created.
- **Contents:** boards, chips on legs, every part modelled, arched or flat wires, ribbon buses, flags and labels.
- **Controls.** Drag orbits; right-, middle- or shift-drag pans; the wheel zooms; double-click fits.
- **Live state:** lit and smoking LEDs, blinking clocks, LCD text.

### Build guide (`⌘B`)
A right-docked, live, read-only panel.
- **Warnings:** floating leads, unpowered chips, single-member nets.
- **BOM tab.** Lines are split by type, value, colour, voltage, rate, package and part number. It includes a **wire cutting list**: one numbered line per colour and length in cm.
- **Steps tab.** A checklist: place boards → power → seat chips (e.g. "straddling e5–f11, pin 1 at bb1.e5") → discretes → wires (`[n] from → to`, naming chip pins).
- **Export** to RTF.

### External signals
Up to **10 stimulus buttons per desktop** sit on a rail at the desk's right edge, each with a **flag** planted in a breadboard hole.
- **Types:** momentary or toggle, resting low or high, in 7 colours.
- **Keyboard.** Keys `1`–`9`, `0` press them while running, and several can be held at once.
- **Drive.** Signals drive at chip-output strength, so fights report as conflicts.
- **Elsewhere.** Signals appear in the schematic and can be added to the analyzer.

---

## 11. Integrations and generators

### AI circuit builder and desk review
- **Providers.**
  - **Anthropic:** Messages API, streamed, with adaptive thinking, structured JSON-schema output and a prompt-cached system prompt.
  - **OpenAI-compatible:** Ollama by default; also LM Studio, OpenRouter, vLLM and others.
  - Requests go straight to the user's endpoint and are billed to their key. They are never proxied.
- **Core principle: an LLM never emits geometry.** The model returns a coordinate-free netlist spec:
  ```json
  { "title": "…", "notes": "…",
    "parts": [{"id":"U1","ref":"74LS283"}],
    "nets":  [{"name":"A0","members":["U1.A1","SW1.1A"]}],
    "tests": [{"set":[{"target":"SW1","value":"1011"}],"edges":null,"expect":[…]}] }
  ```
  A pure compiler (`autobuild.js`) then:
  - resolves pin names;
  - lints the spec (no output on a rail, no multiple drivers unless tri-state or open-collector);
  - auto-inserts LED series resistors, switch pull resistors and CMOS spare-input ties;
  - seats the parts with exclusive column runs, ordered by connectivity and split across boards at the fewest severed nets;
  - lays out power by the shared three rules;
  - routes star-per-net wires, minimizing length plus 20× crossings.
- **Verify ladder.** Nothing unproven reaches the desk:
  - **L3:** seating.
  - **L4:** declared nets vs derived nets (shorts, severed nets).
  - **L5:** settle (chip health, burns, oscillation).
  - **L6:** drive (undriven, X, disabled outputs, floating inputs).
  - **L7:** run the spec's own tests (at least 2, no duplicates).
  - Spec mistakes go back to the model for up to **2 repair rounds**.
  - About 52 demo specs run through this ladder in CI with no network.
- **Placement.** A passing build arms a **placement ghost**; the user clicks to place it, as one undo step.
- **Builder exclusions:** timed parts, capacitors, discretes such as transistors, diodes and inductors, the pot, and custom chips.
- **Desk review mode.** The engine's own analysis finds the faults: no supply, unpowered or underpowered chips, floating inputs, disabled outputs, bus fights, shorts, oscillation, fan-out, unlimited LEDs, damage and so on. The model then **explains** them in prose. Review works on a running desk and changes nothing.
- **Panel.** Bottom-docked chat with Build and Review modes and prompt history.
  - It shows **exact token usage**, including cache read and write, and deliberately no dollar figures.
  - It stays disabled until a connection is valid.

### Custom chip designer
- **What it is.** The user designs a DIP: part number, 74LS or CD4000 family, 300- or 600-mil, 2–20 pins per side, up to 6 units, power pins, and a port table (in, out or inout, 1–16 bits wide, with auto-assign).
- **Behaviour** is written in a **Verilog subset**: a pure lexer, parser, analyzer and 4-state interpreter.
  - **Supported:**
    - `wire`, `reg`, `integer`, `parameter`, `localparam`
    - `assign`, `always @(*)` and `@(posedge/negedge …)`, `initial`
    - `if`, `case`, `casez`, `casex`; blocking and non-blocking assignment
    - constant-bounded `for` and `repeat`
    - the full operator set, part and indexed selects, concatenation and replication
    - `inout` ports
    - 1-D arrays up to 32K words (64K per module)
  - **Refused with named diagnostics:** `while`, `forever`, delays, functions and tasks, system tasks, `signed`, multi-dimensional arrays, instances, gate primitives, directives.
  - **Mistakes it catches:** latches, multiple drivers, combinational loops, incomplete sensitivity lists, and assigning to inputs.
  - One clock per module.
- **Storage.**
  - An app-wide library holds up to 256 chips.
  - A project embeds the chips it places.
  - Desktop export carries them; import merges them and re-mints clashing ids.
- **Where custom chips work:** the simulation, schematic, 3D view, BOM and KiCad export. Digital export, the AI builder and Spice silicon do not support them.
- **Debugger.** The circuit is never truly paused: a **stall plus replay** reveals each settle pass.
  - Line breakpoints shift with edits. Break on Settled is set per placed chip.
  - Controls: Continue, Step, Step Out, To Settled, Detach.
  - A tab per paused chip.
  - The watch panel shows every signal, pending non-blocking values, and a hex grid for arrays.

### Arduino serial integration
- **Elements.**
  - **Output elements** (circuit → board) and **Input elements** (board → circuit) are dragged onto the desk. Each has 1–16 pins grouped into Bit, Byte and Word fields.
  - Up to 16 elements per desk.
  - Each has a trigger (auto, rising, falling, either) with an optional trigger tag.
- **Timing model.**
  - When an Output fires, the simulation **stalls** until the device's handler returns and ACKs. Request/response therefore works inside one step.
  - Inputs drive Z until their first value.
- **Wire protocol v1.**
  - Framing: `0x7E`, a CRC-16/CCITT checksum, and byte escaping.
  - Reliability: stop-and-wait with SEQ numbers, ACK/NAK, a 500 ms timeout and 3 tries.
  - Each run gets a session handshake with a CRC-32 **layout signature**, so a stale sketch refuses to run.
  - The board can send LOG frames.
  - The protocol is documented as a normative user-guide page, and a test holds that page to the code.
- **Connections.**
  - Configured in Settings: port, baud, parity, stop bits, flow control, and language.
  - Ports open on Run and close on Stop, so the Arduino IDE can reflash in between.
  - A built-in **Mock device** emulates the board at the byte level. It can inject faults: drop ACK, corrupt frame, ignore handshake, wrong signature.
- **Code generation.**
  - **C++:** `ChipHippo.h` plus an example `.ino`, for any USB-serial Arduino (Uno, Nano, Mega, Leonardo…).
  - **Python:** one `chiphippo.py` that runs on MicroPython and CircuitPython (Pico, ESP32, Nano ESP32, RP2040, Adafruit boards), plus `main.py`, `code.py` and `boot.py`.
  - Generated code is free for any firmware under the license exception.
  - Conformance tests run the same bytes through the Mock, the compiled header and the Python module.
- **Connection log window** per connection.
  - Filters: Log, Data, Protocol.
  - Timestamps, raw-byte hover, and Save.
  - TX, RX and LG lamps sit on the desk.

### Example circuits
- **94 per-chip benches**, opened from a chip's pin-assignments window: 52 74LS, 41 CD4000, and the NE555 as three hand-built desktops. Each bench is a powered breadboard with switches, pull-downs and LED read-outs.
- **Group projects** in the repo's `demos/`: one per function (gates, counters, decoders…) for each family.
- **Whole computers:** 65xx blink, 65xx with LCD, and a Ben Eater 6502 core plus I/O, each with a `.hex` ROM.
- **Pipeline.** `make demos` regenerates every bench from specs and validates it through the real engine.

---

## 12. Projects, files, export

### Single-file project (`.chiphippo`, schema v5)
- **Contents.** One JSON file holds every desktop's document, the custom chips it uses, the serial connections (without ports), and the ROM bytes, deduplicated by content hash.
- **Migrations.** Desk documents have their own schema, v14, with a migration chain from v1. A newer file is never downgraded.
- **Desktops** are tabs, and each tab is a document; there is one shared desk, controller and simulator.
  - Desktops can be added, renamed, duplicated, deleted, exported (`.desktop.chiphippo` snapshot) or imported.
  - Copy and paste works across them.
  - Each keeps its own camera and undo history.
- **Saving.**
  - An untitled project saves silently to a working slot; Save As gives it a home.
  - Open Recent holds 10 entries (`⇧⌘O`).
  - **Autosave** stashes to the working slot every 30 s, never to the user's file. A leftover stamped slot at startup means a crash, and the work is **recovered silently** as unsaved.
- **Close guard.** A pure state machine with no timeout, safe against crashed renderers. It asks to save on close, quit, New, Open, and restart-to-update.
- **Window bounds** are restored only if they still fit a connected display.

### Export (Desktop ▸ Export To)
An export report lists what won't come across, what changes, and which footprints to check.
- **KiCad 8 project:** `.kicad_pro`, `.kicad_sch`, a symbol library and `sym-lib-table`.
  - **Symbols and nets.** One symbol per chip with physical pins. Net labels, power symbols and `PWR_FLAG`s are included, and the sheet passes KiCad's electrical rules check.
  - **Footprints** are verified against KiCad's stock libraries: DIP 300/600, DO-35, TO-92 and TO-220, and others.
  - **Re-export** rewrites only the schematic and symbol library. Stable UUIDs make Update-PCB incremental.
- **Digital (hneemann) `.dig`.** Uses Digital's own DIL chip models, with tunnels per net.
  - Translations: resistors to rails become pull resistors, push buttons become toggles, and floating inputs get pull-ups.
  - Many CD4000 parts and analog parts are omitted and listed.
  - Verified against Digital's command-line runner.
- **Elsewhere:**
  - BOM and build steps as RTF.
  - Analyzer as SVG or PNG.
  - Memory as `.bin` or Intel HEX.
  - Serial logs and generated code.
- **Deferred:** SVG, PNG and PDF export of the desk and schematic (Feature 160).

---

## 13. Settings, UI chrome, i18n

### Header toolbar
Three pills plus the Settings gear:
- **File:** New · Open (right-click for recent) · Save · Save As.
- **Desk tools:**
  - Wire (colour dot) · Bus (width badge) · Auto-route · Fade · Probe · Analyzer · Fit · BOM · Schematic · 3D
  - AI · Generate (Arduino code, with a dot when stale)
- **Transport:** Run; while running, Stop · Pause · Step · Speed (which shows "behind").

### Native menu
- **File:** project actions and BOM.
- **Desktop:** New, Duplicate, Import, Export, Export To ▸ KiCad/Digital, Properties, Delete.
- **Edit, View and Window.**
- **Help:** User Guide `⌘/`, Keyboard Shortcuts `⌘K`, Check for Updates (absent in store builds).

### Settings tabs
- **Appearance:**
  - Language: system, en, de, es, fr, it, ja, zh.
  - Font size: 11–18, default 13. All interface text derives from one base, and a test forbids bare px font sizes.
  - Theme: System, Light or Dark.
  - Selection colour.
  - Default LED colour and default wire layout.
  - Auto-close tray folders, and enable 3D.
- **Serial I/O:** Arduino connections, applied explicitly.
- **Spice Lite:** on/off, settle gap, and per-family overrides of every figure.
- **Data Sheets:**
  - Chip family filter.
  - Datasheet folder.
  - **Download…**, which fetches the PDFs from TI, Microchip, WDC, Zilog and others into the app folder.
- **AI:** provider, base URL, model, API key (OS keychain), and Test connection.
- **About:** version, opt-in automatic update checks, check now, restart to update.

### Pin-assignments window
A pinout diagram plus a hand-cropped datasheet image for each 74LS part. It also has buttons to open the full datasheet PDF and the part's example circuit.

### User guide
- **One Markdown source** (24 pages) builds three outputs: the in-app viewer, the website docs, and a PDF.
- **Coverage.** The guide is English-only. The interface ships 7 locales, resolved by main, and relabels in place without a reload. Five guard tests enforce catalog parity and no hard-coded strings.

### Keyboard summary
| Group | Keys |
|---|---|
| Run and signals | `Space`/`⌘R` Run/Stop · `1`–`0` signals while running |
| Tools | `W` wire · `B` bus · `I`/`P` probe · `M` put away · `H` fade · `A` analyzer |
| Edit | `R` rotate/flip · `F` LED polarity |
| Views and panels | `Tab` schematic · `⌘F`/`⇧⌘F` fit · `⌘L` wheel lock · `⌘P` tray · `⌘B` build guide |
| Clipboard and history | `⌘C`/`⌘V` · `⌘A` · `⌘Z`/`⇧⌘Z` |
| App | `⌘,` settings · `⌘K` shortcuts · `⌘/` guide |

`Esc` unwinds in order: drag → pinned probe → probe → pending wire → placement → selection.

---

## 14. Release, packaging, tooling

### Targets
| Platform | Formats | Notes |
|---|---|---|
| macOS | dmg + zip, arm64/x64 | Developer ID-signed and notarized when credentials are present |
| Windows | NSIS + portable, x64/arm64 | unsigned |
| Linux | AppImage + deb, x64/arm64 | |
| Mac App Store | universal `.pkg` | sandboxed |

**Mac App Store build:**
- Exactly six entitlements, including serial and network client.
- Security-scoped bookmarks for recent files and the datasheet folder.
- The auto-updater is gated off.

### Auto-update
`electron-updater` against GitHub Releases.
- **Opt-in.** Off by default; a manual check is always available.
- **Install.** On quit or restart, through the close guard.

### CI and release
- **CI** runs lint, format check and tests, plus per-OS packaging smoke tests.
- **Release:** `make release VERSION=x.y.z` tags the release, and the workflow builds every OS, publishes the GitHub Release, refreshes the site and uploads the Mac App Store build. Store submission is done by hand.

### Make targets
| Area | Targets |
|---|---|
| Dev | `install`, `debug` (hot-reload, isolated user-data) |
| Quality | `fmt`, `lint`, `test`, `test-i18n`, `license-headers` |
| Assets and data | `icons`, `datasheets`, `datasheet-urls`, `demos` |
| Performance | `bench`, `profile` |
| Docs and site | `docs`, `pdf`, `site` |
| Build and ship | `build`, `dmg`, `dist-*`, `mas`, `mas-dev`, `upload`, `release`, `clean` |

### Tests
- **Count:** 244 files.
- **Engine:** truth-table and circuit fixtures, incremental-vs-full equality, digital-vs-Spice parity over all examples.
- **Generators:** AI corpus, KiCad and Digital exports, a C++ header compiled with `-Werror`, Python run under CPython and MicroPython.
- **Guards:** IPC parity, packaging and entitlements, i18n, type scale, license headers.

### License headers
Every first-party source file carries the GPL notice, enforced in `make test`.

---

## 15. Status and roadmap

### Landed
Every numbered feature from 00 to 410, except those listed below, plus:
- KiCad and Digital export
- the 3D view
- the custom chip designer
- Spice Lite, through its four phases
- capacitors and timers, and the discretes
- batched ticks (uncommitted)

### Open
- **260 step 15:** move `make demos` onto the AI compiler.
- **360 auto-routing:** working, but the plan is not formally closed.

### Deferred
- **160:** image and PDF export.
- **300:** selection drags, mostly superseded by cluster drags.

### Backlog ideas
- two-board memory straddle
- more 74xx parts
- more discretes (buzzer…)
- an interactive build mode
- assembler hooks for the memory inspector
- Windows code signing

### Known gaps
- No CD4000 datasheet crops yet.
- CD4536B, CD4521B and CD4046B were deliberately left out, and there is no 4060 crystal mode.
