---
paths:
  - "src/web/scripts/sim/**"
  - "src/web/scripts/catalog/families.js"
  - "src/web/scripts/catalog/chips-*.js"
  - "src/web/scripts/catalog/pin-builders.js"
  - "src/web/scripts/components/sim-*.js"
  - "src/web/scripts/components/netlist-cache.js"
  - "src/web/scripts/components/probe-inspector.js"
  - "src/web/scripts/tests/engine*.test.js"
  - "src/web/scripts/tests/sim-*.test.js"
  - "src/web/scripts/tests/cd4000*.test.js"
  - "src/web/scripts/tests/chips-*.test.js"
  - "src/web/scripts/tests/netlist.test.js"
  - "src/web/scripts/tests/resolve.test.js"
  - "src/web/scripts/tests/levels.test.js"
  - "src/web/scripts/tests/chip-eval.test.js"
---

## Simulation

- **Netlist** (`sim/netlist.js`): a pure union-find partition of every point into nets,
  keyed by the lexicographically smallest member address (stable across rebuilds). Part
  state (switch position, button pressed) is an INPUT — a switch's `internalBridges`
  conduct; chip pins are net MEMBERS, never conduits (that is the simulator's job).
  Always a full rebuild, invalidated on `chiphippo:doc-changed` / `chiphippo:part-state`
  by `NetlistCache`.
- **Two partitions, and which question each answers.** The CONDUCTING one (default) is
  the live circuit — the engine solves it, and app.js's one shared `netlistCache` serves
  the sim, the analyzer, the AI review and the probe's level tint. The WIRING one
  (`{bridges: false}`: every switch and button an open contact) is what the BUILD
  connected — app.js's `wiringNetlistCache` serves the schematic, the build guide and the
  probe's highlight, readout and naming; the exports and the AI verifier's L4 build their
  own. **Net names (Feature 120) always resolve on the wiring partition** (Jason,
  2026-10-05): a name bound beside a slide switch used to ride its closed contact onto
  the + rail and every VCC pin on it, naming the other side read as a merge conflict, and
  renaming deleted the rail's own name as a "stale" binding. So `buildNetlist` returns
  `wiringNetOfPoint` + `wiringNames` beside `names`, conflicts are two names on one WIRED
  net, and a CONDUCTING net carries a name only when every wired net inside it carries
  that same name. Anything pointing at one place asks `NetlistCache.nameAt(address)` (the
  analyzer's channel labels), whichever partition it holds. The probe emits WIRING net
  ids on `chiphippo:net-probed`, which are the ids the schematic draws. Its readout —
  the pinned net, else the point the cursor RESTS on (`#hoverAt`) — is redrawn by
  `refresh()` on every sim-state, doc-changed and part-state (the fourth regrade,
  2026-10-22: drawn only as the pointer moved, a resting hover kept its arrival
  level and volts).
- **Levels** (`sim/levels.js`): H/L/Z/X, `asInput` = "floating reads HIGH" (TTL),
  `asCmosInput` = "floating reads X" (CMOS), ternary gate primitives. Which one a part
  reads through is its FAMILY's (`chip-eval.js`'s `readerFor`; see "Logic families").
- **Chip behaviour is DATA, never per-chip code.** Combinational chips carry a
  `logic.units` block the ONE generic `evaluate(def, pinLevels)` in `sim/chip-eval.js`
  walks — gate primitives (incl. `XNOR` and the non-inverting `BUF`), tri-state `BUF3`,
  and `COMB` units (a pure `compute` over fanning-out inputs: the decoder/mux
  vocabulary). Sequential chips carry `{ state0, step, outputs }` built by the pure
  family builders in `sim/sequential.js` (D-FF with active-low OR active-high async
  controls, JK-FF, transparent latch, sync + up/down counters, SIPO/PISO shift, and the
  CMOS `johnsonCounter`/`binaryCounter` and batch-2 MSI builders); analog switches carry
  `logic.channels` (`sim/analog-switch.js`, below);
  `step(state, inputs, prevInputs)` advances on detected edges + level-sensitive async
  overrides, `outputs(state, inputs)` drives the pins. **A new 74xx part is data** — if
  it can't be expressed, extend the vocabulary, never fork. Zero-delay and
  power-agnostic; the truth-table harness enumerates every gate unit exhaustively,
  MSI/sequential parts prove out in circuit fixtures.
- **The CPUs and the PROCESSOR group** (`catalog/chips-cpu.js` + `sim/w65c02.js` +
  `sim/z80.js` + `sim/z80-ops.js`) are the far end of "genuine per-part code behind the
  STANDARD sequential contract" — a whole instruction set behind
  `{state0, step, outputs}`. They live in their OWN group, which is why the W65C02 left
  `chips-io.js` (that file is the 65xx PERIPHERAL wave). The group is `PROGRAM_ONLY`
  (`scripts/demo-build.mjs`) so it gets no bench demo — its example button opens a
  whole computer instead (`scripts/demo-computers.mjs`, see generated-circuits.md) — and it is in
  `PROTOCOL_GROUPS` (`chips-tristate.test.js`) because a CPU floats pins on a bus
  PROTOCOL, not on any pin you can tie.
  - **Z80 interrupt mode 0 takes ONE byte from the bus** (`doInt` in `z80-ops.js`; left as
    is by Jason, 2026-10-22). The byte the device puts on the bus at the acknowledge is
    dispatched as an instruction — an RST (or $FF, `RST 38h`, off a floating bus), which
    is all anything on the bench supplies. A multi-byte instruction (an 8080-style
    controller's `CALL nn`) would read its operands from MEMORY at PC and push past them,
    where the silicon takes them from the bus in further acknowledge cycles. **If a part
    that answers /INTA with more than one byte is ever added** (an 8259 in 8080 mode, a
    user's custom chip), `doInt` needs a bus-fed operand fetch: each further operand
    read through `bus.intAck` (another /M1+/IORQ cycle), the push of the return address
    being the PC before the interrupt, not after the operands.
  - **They disagree about the clock, and that is the design difference.** A 6502 IS one
    bus access per PHI2 cycle, so `w65c02.js` collapses to that and loses nothing. A Z80
    is not (an opcode fetch is four T-states with a REFRESH cycle glued to its back half,
    a read is three, an I/O cycle four), so `z80.js` runs a real M-cycle/T-state machine
    — the only way `/M1`, `/RFSH` and `/WAIT` mean anything. It is affordable because the
    transport ticks the engine once per clock EDGE (`sim-controller.js`'s
    `1000 / (2 * hz * speed)`), i.e. HALF-T resolution — what the Z80's timing diagrams
    are drawn at. Each edge records the half it begins in the state (`high`), and
    `outputs` draws THAT, never the live clock pin: the engine's pre-settle shows the new
    clock with the OLD state, so a half read off the pin pulsed every strobe back a
    half-cycle at each rising edge (2026-10-14). `SIGNALS` is the datasheet's timing
    diagram transcribed as DATA, not code: an I/O cycle's /IORQ + /RD|/WR run T2↑ to
    T3↓; /BUSRQ is granted at the END of an M-cycle, the next one held from its T1; in
    RESET every control line sits HIGH, under BUSACK only /MREQ /IORQ /RD /WR float.
  - **The W65C02 is CYCLE-exact** (Jason, 2026-10-10): every dummy cycle of the
    W65C02S datasheet is a real bus READ — implied/accumulator ops read the next byte;
    zp,X/(zp,X) and an index carried into the high byte (always, for a store, and for
    INC/DEC abs,X) re-read the LAST INSTRUCTION BYTE (the 65C02's fix for the NMOS
    part's half-formed address); RMW reads its address twice before the write; PLx/RTS/
    RTI/JSR spend a cycle on the stack at S, RTS another on the return address; JMP
    (a)/(a,X) are 6; taken branches (and BBR/BBS, 5 + the same) read the next
    instruction's address, +1 across a page; decimal ADC/SBC +1; WAI/STP 3; `$5C` 8;
    undefined one-byte opcodes 1. Reset and IRQ/NMI are 7 (two reads of PC first —
    an interrupt's first, the fetch it abandons, with SYNC high;
    reset then three stack reads stepping S from 0 to $FD — `resetHold` starts S at 0
    and drives PC, not $FFFC, while held). Where WDC gives only a COUNT, the address is
    the next instruction's (no stray I/O read). `tests/w65c02.test.js` holds the count
    of every addressing mode and the addresses of the documented ones. A dummy read is
    a REAL read: an RMW on a VIA register reads it twice, as the silicon does.
  - **They latch the data byte from opposite places.** `w65c02.js` reads from `prev`
    because a 65xx peripheral gates its bus drivers on PHI2 — an INPUT already flipped by
    the falling-edge settle. (The W65C21/W65C22 drive X on D0–D7 when a chip select,
    R/W̄ or PHI2 is unknown and none is definitely off — read as deselected, the bus
    floated and the CPU took `$FF`; the regrade, 2026-10-26.) `z80.js` reads from `ins`, because it enables the device
    with its OWN `/MREQ` + `/RD`, still asserted in the pre-settle picture. The corollary
    is the subtle one: the byte is taken on the edge ENTERING the sampling T-state
    (`t + 1 === sample`), since an M1 releases `/MREQ`//`/RD` and puts the REFRESH
    address up at T3's rising edge — sample a tick later and every fetch reads a
    deselected memory, i.e. `$FF`.
  - **The CPU monitor reads them through a DESCRIPTOR, never by ref**
    (`sim/cpu-cores.js` — `w65c02Monitor`/`z80Monitor`, hung on the def as
    `logic.cpu` by `chips-cpu.js` `monitored`; `chip-eval.js` `isCpu`). Each descriptor
    provides the bus/clock pins, `peekState`, `startOf`, `view`,
    `vectorOf` and `disassemble` (`sim/disasm-6502.js` on the core's exported
    `W65C02_OPCODES`, `sim/disasm-z80.js`).
    - `SimController.#observeCpus` feeds every CPU's record each tick
      (`sim/cpu-monitor.js` `observeTick`: counted edges and instruction starts). Cheap, so a monitor opened mid-run has history; the records ride
      `exportRun`.
    - The WATCHED CPU's `cpuSummary` rides `sim-state` as `cpuMonitor` (null otherwise).
      `monitorCpu(id)` is forwarded to the Worker, and the start message carries it.
    - Memory is read through `sim/cpu-memory-map.js`. Per 256-byte page it runs a
      what-if `settle()` on the LOGIC engine with the CPU swapped for
      `peekState(addr)` and every clock forced HIGH. A page counts only if exactly one
      memory chip has CE/OE asserted, at both the page's first and last address, every
      pin of it is followable by net (a CPU address/data net, or a level held), and the
      data bus agrees with the image; otherwise it reads null (`--`). The cache lasts as
      long as the doc snapshot and netlist; bank switching is not followed.
    - **Breakpoints** (`setCpuBreakpoints(compId, addrs)`). `observeTick` returns the
      operation a counted edge STARTED. When that is an `"instr"` whose `pcOf` is a
      breakpoint, `#observeCpus` notes the hit, and `#tickNow` handles it after the
      tick (`#breakAt`):
      - a RUNNING board pauses exactly as Pause leaves it: the pacer cancelled, the
        schedule cleared, time frozen at THAT tick, so the rest of the batch is left
        unrun;
      - it then dispatches `chiphippo:cpu-break {compId, addr, paused}`.
      The moment is the opcode fetch's first edge: the start state, before any of the
      instruction has run (a 1-access 6502 op would be finished one edge later).
      `cpu-break` is FORWARDED from the Worker, and `SimHost` flips its own `#mode`
      to paused on one with `paused`, since the Worker paused itself.
    - **`stepCpu(compId)`** — the monitor's Step. PAUSED only, refused during a stall
      (the chip debugger's or the integration's). Transport Steps (`#advance` +
      `#tickNow`), one edge each, inside `#batchDepth` so the views are told once at
      the end, until `#observeCpus` sees that CPU START an operation (any kind:
      instruction, reset, interrupt — `#opStep.done`) or `#breakAt` fires on any CPU.
      Gives up at `MAX_OP_EDGES` (4096) or `OP_STEP_BUDGET_MS` (500 ms), and at once
      with no ticking clock and no `wakeAt` (a manual clock is the user's). Returns
      whether it reached a start. A CPU WAITING (`waiting`: the Z80 halted, the 6502
      in WAI/STP) starts nothing until an interrupt, so there a Step is ONE bus cycle
      (`idleFrom`, the track's cycle count) — it used to burn the whole budget, the
      board run ~2000 clocks per press — and a Step that BECOMES waiting (pressed on
      the HALT/WAI itself) ends the moment it does. Forwarded to the Worker (`CALLS`). A microstep mode
      (one counted edge) and a forecast of the whole instruction (`planOperation`)
      were built and REMOVED (Jason, 2026-10-10): the cores emulate results, not the
      silicon's cycle-by-cycle insides — see ui-chrome.md "CPU monitor".
    - **Live registers** (`liveRegisters` in both cores; each descriptor's `view` shows
      them, flags included). The cores keep the COMMITTED registers until an operation
      ends, so a run paused mid-instruction showed the instruction's starting values:
      the view replays the interpreter over `log` (the Z80's in-flight byte too, once
      its sampling T has passed) up to the access in flight and shows that scratch
      copy. `pcOf`, the pipeline, breakpoints and the status line keep the
      instruction's START.
    - **`pokeCpuMemory(compId, addr, value)`** writes one byte into the run image
      through the map (see ui-chrome.md "CPU monitor").
    - **`stepOverCpu(compId)`** — Step Over, offered at a call (the descriptor's
      `isCall`: a 6502 JSR; a Z80 CALL, CALL cc, RST). The stop is `{ret, sp, mask}`:
      an instruction START at the return address with the stack no deeper than the
      call found it (`returned()` — `spOf`/`spMask`, the COMMITTED pointer; "shallower"
      only within `SHALLOW_SLACK`, so a 6502 recursion over half a page deep does not
      wrap round to read as shallow), so a recursive call's inner return does not count — OR
      (`#cameBack`) where a routine that skips its inline arguments (`JSR PRIMM /
      .byte …`, an RST that steps its return address) comes back: an instruction start
      within `MAX_INLINE_BYTES` past the return address, the stack where the call found
      it (`unwound`, the same `SHALLOW_SLACK` as `returned`), NOTHING run between the
      return address and it since the Step Over began (`over.ran`, the nearest start in
      the window, kept by `#noteRan`) — the bytes there are the arguments, never
      executed — and, when the instruction run last (`over.prev`) lies further into the
      window (a routine right after its call site), that instruction NOT a jump naming
      its target (the descriptor's `isJump`: JMP abs/BRA/branches/BBR/BBS; JP nn/JP cc/
      JR/JR cc/DJNZ) — that is the routine going to a helper below its entry. A return
      or a computed jump (`JP (HL)`, `JMP (ptr)`, the inline-argument routine's idiomatic
      way back) still counts. Only that case reads memory (`#jumpedFrom`, one decode
      through the circuit; `CpuMemoryMap` keeps its pages per CPU). An interrupt taken
      meanwhile sets `over.prev` aside and puts it back at its return
      (`carryAcrossInterrupt`: the first instruction with the stack where the sequence
      found it; one taken straight after another's return at the SAME stack is not
      set aside twice; a reset forgets them), so a handler cannot hide the routine's
      jump. A return through a
      SELF-MODIFIED `JMP abs` reads as a jump and runs on to Pause — undecidable from the
      instruction, and the safe miss. A stack-only test here REGRESSED `POP HL · INC HL · JP (HL)`
      (2026-10-12). Such a routine pops its return
      address, so inside it the stack is at the call's level too; a stop there would be
      somewhere code has run (its own instructions, a nested CALL, an untaken RET cc).
      Two earlier rules guessed from the bytes BEFORE the landing (is it a call ending
      here?) and from the instruction before it (a taken RET?): both were fooled — an
      argument ending in an RST opcode, a string with a space (JSR) two from its end, a
      pushed return and a jump, an interrupt right after the RET (2026-10-11/12). No
      memory is read; a routine that leaves by a jump far away runs on to Pause. A redundant DD/FD is part of the instruction it prefixes, in the
      core and the disassembler alike (`isCall` looks past it). First
      the Step's loop (`#runCpuStep`, up to `MAX_OVER_EDGES` inside the same 500 ms
      budget); a call that outlasts it is HANDED TO THE RUN: `#overStop` is armed (a
      breakpoint of one use, checked in `#observeCpus`, hit → `#breakHit` with
      `over: true`), the controller `resume()`s ITSELF and dispatches
      `chiphippo:cpu-resumed` — FORWARDED, because the Worker's host answers the
      transport itself and must follow the Worker back to running. `pause()`, `stop()`,
      a run's start and any breakpoint hit clear `#overStop`; it rides
      `exportRun`/`importRun`. Returns `"done"`, `"running"` or false.
    - **`setCpuRegister(compId, name, value)`** — PAUSED only, and only at an
      instruction's start (the descriptor's `canEdit`: the 6502's opcode fetch with an
      empty log; the Z80's M1 T1, not halted), where the committed registers ARE the
      live ones. The descriptor's `setRegister` does the field work (a new PC moves the
      fetch's `addr` too; the Z80's I/R recompute `rfsh`; the 6502's P drops B and sets
      the unused bit). The controller swaps the state into a NEW `#state` map (the
      incremental settle re-evaluates a sequential chip whose state object changed),
      moves the track's last history note to the new PC (the pipeline must not list an
      instruction that never ran) and `wake()`s the board.
    - **`monitorCpu(compId, view)`** — `view.memAt` pins the summary's memory block
      (`memBase`: a whole row, inside memory), null follows PC; `setCpuBreakpoints`
      republishes a watched, paused board so the window's breakpoint list
      (`breakLines`, decoded at publish) is current at once. The summary also carries
      `stack` (`stackOf`, `STACK_LINES`), `io` (the Z80's `ioOf` — an IN/OUT cycle
      completing on its rising edge — recorded by `observeTick` into `track.io`, the
      `IO_LINES` most recent ports in port order), `pipeline.current.call` and
      `regsEditable`.
  - Both cores keep a small `log` of the bytes already returned for the current
    instruction and RE-RUN a clean interpreter from the committed registers each M-cycle,
    throwing at the first new access — plain data, no generators, so the engine's
    structural `sameState` still works. **`step` MUST be edge-gated and return its state
    VERBATIM off-edge**, or the tick's step fixpoint never settles and the circuit is
    reported as oscillating.
- **The engine** (`sim/resolve.js` + `sim/engine.js`) is pure and DOM-free. `resolveNet`
  picks a net's level by strength precedence (supply beats chip output; opposing supplies
  → `X` + short; disagreeing outputs → `X` + conflict; `Z`/undriven contributes nothing;
  a clock source drives its `out` net at output strength).
  **The fixed context is built once per document + netlist, not per tick**:
  `prepareCircuit(doc, netlist)` returns it, and `tick`/`settle` take it back as
  `context`, reusing it only while BOTH are the very same objects (`contextFor`) — so a
  caller editing a document in place must not pass one. SimController keeps one, and
  ONE document snapshot (`#document()`, shared by the clocks and signals too), both
  dropped on `doc-changed`, `part-state`, its own damage write, Run and Stop
  (`#forgetDocument`). The resistor relaxation re-resolves only the nets a pull can
  reach (`pullReach`: resistor ends, diode cathodes, and whatever a channel joins to
  them); every other net keeps its no-pulls resolution, which is exactly what it would
  resolve to. Together they halved a busy tick (`make bench`) with identical results.
  Under HOOKS a context is never reused (Spice Lite's `psuVolts`, `chipDrop` and
  `curves` are read while one is built, and change tick to tick) — only its `fixed`
  facts (`fixedFacts`: pin→net maps, resistors, diodes, the RC trace, and memos of each
  timed part's timing per def, the index per `logicOf` (a WeakMap — Spice Lite's
  silicon twins are stable objects) and the boundary warnings per chips' power). Re-reading
  every part's pins off the geometry each settle was a fifth of a Spice Lite tick.
- **The settle is INCREMENTAL, and bit-identical to the full loop**
  (`sim/incremental.js`, `features/done/event-driven-simulation.md`). The passes are the full
  loop's exactly — same count, same starting levels, same fixpoint test, same marking,
  same warnings in the same order, same observer record, same hook calls — but a pass
  evaluates only the chips whose READ nets changed (`settle-index.js` `readers`: unit
  inputs/enables, or a sequential/memory chip's input+io pins), whose state object the
  step replaced, or that the debugger WATCHES, and re-resolves only the nets whose drivers
  or channel joins changed, with everything they are coupled to. The coupling is STATIC
  (`settle-index.js`): union-find over every resistor, diode and channel that COULD
  conduct, rails never a union point (a rail resolves to its supply whatever reaches it);
  a component is resolved by `resolveAll` with a `scope` that keeps the desk's FLAGS and
  CAPS (the relaxation's pass cap decides where a pull loop that never settles ends —
  VCC–R–A–R–B–R–GND alternates, so its result depends on the desk's resistor+diode count's
  parity; kept, not fixed), a net in no component (a LONE net) from its own drivers, and a
  component no driver can reach (`fixed`) once per context. What is cached is the CERTAIN
  channels' narrow resolution; where the full loop (`resolveReadings`) reads a pass more
  than one way — a channel control unknown, a diode's end unknown — the other readings
  are read on the components they can differ on ALONE (`scopedReading`): the channels'
  on `channelGroups`' `maybeNets` (the terminals whose joins differ between readings),
  each component once per distinct join (`work.readings`, kept while its drivers and
  joins stand), the diodes' on the components an unknown end is in. A whole-desk
  fallback per reading took a busy desk with one bare powered CD4066B (sixteen
  readings) from 0.27 to 10.7 ms a tick (the 2026-10-26 review; now ~0.34 cold).
  A solve's first pass re-reads the channels only where a channel part's STATE moved
  (or always under Spice Lite), not every solve. Spice Lite's `outputs` hook (it counts holds per
  call, books spikes) hears the chips evaluated again plus those it says are HOLDING
  (`hooks.holding()`), in `ctx.chips` order — for any other the call is a no-op, so it is
  not made (2026-10-09, `features/06-sparse-outputs-hook.md`; `SPICE_ASSERT_OUTPUTS=1`
  makes them anyway and throws if one does anything; `mode: "full"` still calls every chip). With an observer every pass gets fresh
  complete maps (the debugger keeps them by reference); otherwise one map is updated in
  place — Spice Lite's levels hook included, as `levelsDelta` (only the nets it shows
  otherwise; 2026-10-09, `features/07-delta-level-maps.md`, `SPICE_ASSERT_DELTA`). One quirk is reproduced on purpose:
  with no resistor, diode or LED-limiting part a pass's strong map IS its level map, so
  the oscillation marking reaches both. The work is carried across one tick's re-solves
  (`carry`: `pending`, `stale`), and across ticks only when the caller hands the last
  tick's `result.warm` back as `warm` (features/08) — SimController does on BOTH engines
  since the 2026-10-26 review (the logic path passed none: a busy tick 0.185 → 0.086 ms);
  otherwise every tick starts cold (evaluates
  every chip, resolves every net once), which bounds the gain near the passes per tick
  (`make bench`: 3.8× per tick at 8 slices, 4.4× at 16; 1.4× under Spice Lite when its
  hooks saw every chip every pass — see 06/07). The cache is held by net INDEX (arrays cloned from
  `settle-index.js`'s `start`), not in Maps: cloning a string-keyed Map per tick cost
  more than the passes it saved. A tick's `strongLevels` left in the cache are built only
  when READ (`strongLater`, an accessor on the result; the next solve on that work copies
  the strong array first — `work.beforeChange`), and each chip reads its pins into one
  scratch map (`c.reads`; fresh under an observer): busy8 285 → 206 KB/tick unread, 258
  read (round 2, 2026-10-27). The index is power-blind: a clock is a source by the net it
  is WIRED to (`clk.wired`), and `sourcesBase` drives it only while this context powers it
  (`outNet`) — a clock past a meter's shunt, powered later, read Z. `opts.mode: "full"` runs the old loop
  (`solveFull`) — the reference `tests/engine-incremental.test.js` holds the default to,
  field by field, observer record and every Spice Lite field included; `opts.stats`
  counts passes, evaluations, resolutions and fallbacks. Tests and the bench only.
  `settle({document, netlist, warmStart})` gates each chip on its VCC net and EVERY
  ground-role pin's net (a CD405x's VEE beside its VSS; the AM27C1024's two VSS) against
  its FAMILY's supply range (`catalog/families.js` `supplyRange`: 74LS and every
  family-less part 4.75–5.25 V, CD4000 3–18 V; below → underpowered-inert, above →
  damaged; `chipStatus` entries are `{ status, volts }`; under Spice Lite SimController
  holds an underpowered chip's toast through Run's `SETTLE_S` (a rail still rising —
  bench-parts.md "The settling window"), and says it again only once its volts have moved `UNDER_REPEAT_V`
  (0.5 V) from those it was said at — #warn's `reading`, the fourth regrade: a droop
  settling was three toasts; every other warning the same while its words are, numbers
  aside, and no number has grown a quarter (`WARN_GROWTH`) past the most said — an LED
  on an AC adapter, read at a new phase every frame, was "LED overdriven" 360 times in
  2 s, the regrade, 2026-10-23); and a warning GONE — no tick reporting it — for
  `REARM_S` (1 simulated second, an assumption; `clearedAt` on its `#warned` entry, set
  at the end of `#report`) is said afresh when it comes back, while one back sooner is
  the same fault still standing (a push button's short, released and pressed again, was
  silent for the rest of the run — the release review, 2026-10-23); **the margin**
  (2026-10-27, Jason: "keep a chip working a little below its documented range"): down
  to `supplyFloor` (74LS and family-less 4.5 V — TI's SN54LS minimum; CD4000 2.7 V; a
  part with its own `def.supply` its `min`) a chip under its range is `ok` with
  `margin: true` on its entry (`marginOf`) — evaluated like any ok chip, so every reader
  of "ok" stays right — and `assemble` warns `{type: "underpowered", margin: true}`
  (toast `sim.underpoweredMarginMessage`, "still working"); and EVERY underpowered toast,
  margin or inert, both engines, waits until the chip has stood under `UNDER_HOLD_S`
  (0.5 simulated s) without a break (`#underSince`, a wake at `#underDue`; REARM_S is
  measured to when it came back, #warn's `since`), then loops resolve →
  `evaluate` → re-drive to a
  fixpoint or the 200-iteration cap (→ still-changing nets marked `X` + oscillation).
  **Warm-starting net levels by stable netId is exactly why cross-coupled NAND latches
  HOLD.** A latch with BOTH inputs idle at once (settled from all-floating at Run, or
  both released in one tick) has two steady states and flips L/L, H/H to the cap in a
  simultaneous update, so a capped logic-engine settle (no hooks — not Spice Lite)
  breaks the tie (`solve`, 2026-10-14): it settles again from where it ended, the
  first racing net in netId order LOW and the rest HIGH; a settle that comes of it is a
  real steady state and replaces the report, a true ring oscillator keeps it. Since
  2026-10-21 (the appraisal) up to `MAX_TIE_BREAKS` (4) times, each from the best
  settle so far with the next untried racing net LOW, keeping one that leaves FEWER
  nets racing: once, two idle latches on one 74LS00 stayed X for good (one seed
  settled one latch, the other raced on H/H), and a latch beside a ring oscillator
  was X with it. **Each round seeds one LOW per feedback LOOP** (engine.js
  `feedbackLoops`, the regrades of 2026-10-22): the strongly connected sets of nets — a
  powered gate unit's inputs/enable lead to its output, a channel's control to its
  terminals and its terminals to each other, a resistor or diode either way, rails left
  out, a SEQUENTIAL chip leading nowhere (its outputs are its state) — each its nets in
  netId order and its ENTRIES (the nets outside it a gate in it reads, flagged when a
  CMOS input reads one), once per context (a WeakMap). Seeding only loop nets: one LOW
  per knot of all a gate joined spent its rounds on a latch's LOADS (four inverters to
  its left, earlier netIds) or merged six latches through one '273's pins, X for good.
  **A settle that ENDS with a loop at X, every entry definite** (H/L, or Z read only by
  TTL inputs — `stuckLoops`) is the same tie at a standstill and is broken the same way,
  kept only when it leaves fewer loop nets X: a CD4011B latch idle at Run read its
  floating nets X, NAND(H, X) is X, so it never raced and stayed X silently; a TTL one,
  once raced, held X as a warm-started fixed point. **In a settle a ring oscillator caps,
  every loop it is NOT racing in is checked the same way** (`stuckAll` skips only loops
  with a racing net; each round seeds the racing loops and the stuck ones together, and a
  round is kept when the race grows no wider and either fewer nets race or fewer stay X
  — the fourth regrade, 2026-10-22): before, a stuck loop was broken only in a settle
  that SETTLED, so a CD4011B latch idle at Run beside any ring stayed X for good. A loop
  whose X comes in from outside
  (a floating CMOS input, a fight) stays X. **A stuck loop tried and failed is not
  tried again as it stands** (the run's `ties.failed` — below — keyed by the loop's first net, its X nets and
  its entries' levels; third regrade, 2026-10-22): an X for good (an RC relaxation
  oscillator the logic engine cannot time, an X round a gate through a resistor) cost up
  to four settles to the cap every tick — a 40106 oscillator 0.1 → 1.2 ms a tick.
  **A stuck loop of gates alone that RACES once seeded is a ring oscillator** (the grade,
  2026-10-23): three CD4069UB inverters read X, X, X and SETTLED, silent, where 74LS04s
  raced and said so — the seeded race is kept as the report (`ringNets`/`gatesOnly`: stuck
  loops with no capacitor on them and no resistor between two of their nets; a race that
  moves from a latch onto such a loop is kept too). A loop with a capacitor (an RC
  relaxation oscillator the logic engine cannot time) or a feedback resistor (an inverter
  biased as an amplifier — taken for a ring it warned every tick, the regrade) stays X and
  unsaid, and remembered failed. **The memo is the RUN's** (`tieMemo()`, handed to
  `tick`/`settle` as `ties`; the 2026-10-26 review): kept per NETLIST it was shared by
  every settle on it — Stop → Run, a desk review, the CPU monitor's what-ifs — and a
  run's results hung on what ran before it. SimController keeps one per Run (forgotten
  on a new netlist); a call without one remembers nothing. It also remembers a RING
  (`rings`): a loop seeded that raced on, keyed by its entries' levels — every racing
  loop known, no stuck loop untried, the capped settle is the report without the
  rounds (busy fixture + a ring of three 2.1 → 1.1 ms a tick). **A capped solve skips the
  periods it repeats** (incremental, in place, no hooks/observer — `CYCLE_FROM`; the
  regrade, 2026-10-26): a pass is a function of its starting levels, so once Brent's search
  sees them come round (a snapshot at doubling distances, kept as each net's level when
  it first moves) the whole periods left are skipped and the last few run — the capped
  pass, its marking and warnings are the cap's own (`compareRuns` holds it to the full
  loop, which never skips). A capped tick's work is now carried to the next tick as
  `warm` too (`pending`, its marked nets, joins the warm start's delta). Busy fixture + a
  ring of three 0.79 → 0.26 ms a tick. **Per settle MODE**
  (`ties.full`/`.incremental`): shared by netlist, a reference run beside the
  default never tried a tie the other had given up on, and the two parted one settle
  apart (the grade's fuzz: 3 seeds in 600 → 0 in 3000).
  **A tie-break's seed runs round its loop** (`seedFromPicks`, the regrade, 2026-10-23):
  the picks LOW, then every combinational gate driving a loop net evaluated off the seed
  until nothing more is learnt, HIGH only where no gate decides — seeded HIGH everywhere,
  an even loop of inverters (six in a ring, a latch with an inverter pair in each
  feedback) carried the one LOW round as a defect for ever, "oscillation".
  **A transistor its own channel feeds** (settle-pass.js `selfFedControls`, logic
  engine only, 2026-10-14): as a plain switch a diode-connected transistor, or the second
  of a Darlington of two discretes (its base on the first's emitter, the collectors
  tied), has no fixed point — on, its channel joins its base to its emitter's LOW; off,
  the base is pulled up again — so it oscillated to the cap. Where its own channel WOULD
  join its control to itself (`selfFedCandidates`: the control reaches an end through
  the other channels, any state; a rail joins nothing), the control reads its net as it
  resolves WITHOUT that channel (this pass's drivers, the other channels' joins, the
  resistors' pulls off the last levels) — what pulls the base up with the transistor out
  of the way turns it on, as on the bench. Those controls ride the channels as `forced`
  (published by `channelsOf`, so its lamp shows it on); the incremental settle reads the
  channels again whenever a net they hear moves, level or drivers (`selfFedNets`).
  **A BJT's base divider is read by its voltage** (settle-pass.js `biasedControls`,
  logic engine only, the fourth regrade, 2026-10-22): a base net's level is a divider's
  only past two thirds (resolve.js `DIVIDER_SIDE`), so 10 k/10 k off 5 V read X — the
  switch OFF, silently — and 47 k/10 k LOW, where 2.5 V and 0.88 V both turn it on. A
  BJT whose base ONLY resistors reach (`biasCandidates`: no diode, no channel end, no
  supply on it, not self-fed, every resistor's value known), each from a FIXED source —
  a rail at its volts, or a net a chip, clock or signal drives (a driven HIGH at the
  desk's highest supply) — and nothing driving the base itself, reads its on level when
  the divider's Thévenin voltage stands past its emitter's by `VBE_ON_V` (0.7 V, the
  textbook junction drop — an assumption), else its off one. The EMITTER is read off
  fixed sources too, never at its level (`emitterVolts`, the regrade, 2026-10-23): a
  rail, what drives it, or what its resistors and diodes reach from fixed sources (Re to
  ground reads 0 V). Read at its level, a FOLLOWER's emitter (an LED to ground, a
  source follower) was the HIGH its own channel lifted it to — off, fell, on again: X
  and an oscillation every pass, 0.6–1.4 ms a tick. An emitter no fixed source holds,
  or a source only pulled, leaves it to the base net's level. **A far end no fixed source
  holds is read THROUGH** (`throughNet`, the grade, 2026-10-23): a net nothing drives, no
  diode on, the last pass left HIGH (a ring of five RTL inverters, read without that, had
  every other stage on and settled), every channel on it OFF (`netParts`), its
  own resistors each to a fixed source, stands for its Thévenin source in series — a
  collector pulled up while its transistor is off (RTL: 1 k up, 10 k across, 10 k down
  is 2.4 V; it read X and the next transistor stayed off). One step out only; and for a transistor whose base is fed from THIS one's channel,
  rails aside (a flip-flop), only while this base's divider leaves it X (10 k base
  pull-downs stood both OFF, silent — the regrade): otherwise the tie-break settles the
  pair, the same way round as Spice Lite falls. Keyed by component (an
  NPN and a PNP on one base read their own), applied under `forced`; the incremental
  settle reads the channels again when its base, emitter, a source or what the emitter
  is read by moves (`biasedNets`). A
  **MOSFET's gate** likewise against its source, past its GRADE's threshold (`vgsOn` →
  spice/transistor-figures.js `transistorModelFor`'s `vtoV`: a TO-92 2N7000 2.1 V, the
  TO-220 IRF540N it is placed as 3.63 V — so 10 k/10 k off 5 V turns on the one and not
  the other, as Spice Lite does). The biased level rides the settle as `biased`
  (compId → level, beside `forced`): `channelsOf` publishes the channel by it and
  `samplePins` STEPS by it, so a MOSFET whose divider is taken away holds the gate its
  divider set. Spice Lite agrees on every divider row of `engine-appraisal-fixes.test.js`; the
  base NET itself still reads X/L as before.
  Under Spice Lite (`read` set) the solve answers instead. The engine is a pure function: it REPORTS `chipStatus` and returns
  run-volatile `state`/`pinLevels`, never mutating `params` and never touching a timer.
  **A chip that loses its power loses its state** (2026-10-22, Jason: "reset the
  counter"): UNPOWERED or REVERSED, its state is `initialState` (tick's step loop), so
  power back it comes up as at Run; UNDERPOWERED (a sagging rail, short of its range)
  still holds. A VOLATILE memory's image (SimController's) is wiped back to its Run seed
  the same way, once while it stays unpowered (`#forgetUnpowered`, its byte changes
  sent to an open inspector); a ROM keeps its file's bytes.
  **Unknowns that reach a net weakly are unknown** (resolve.js, 2026-10-22, Jason:
  "I want the right outcome"): an X through a resistor PULLS X (`addPull` takes X; a Z
  pulls nothing) — read as nothing pulling, a 74LS input behind it read a clean HIGH and
  a CD4000 one was told it floated. **Only where no H or L pulls beside it**
  (`resolveNet`, the same day, from the regrade): counted against a definite pull, a
  resistor-feedback Schmitt trigger (10 k in, 100 k from its output) went X the first
  time its two pulls disagreed and pulled ITSELF X for good, no input clearing it
  (`engine-appraisal-fixes.test.js`). So {H, X} → H (a divider chain VCC–R–A–R–B–R–GND still
  settles X/X). **Opposing pulls are a DIVIDER, weighed by conductance** (resolve.js
  `DIVIDER_SIDE`, the regrade, 2026-10-22: 1 k from an output against 10 k to ground read
  the base X, a transistor reads an X base as OFF, and the textbook switch never switched,
  unwarned): each resistor carries `siemens` (engine.js), `addPull` passes it with the
  level, and past ⅔ of the way to one side the net reads that side, else X; a diode passes
  its anode's HIGH with the conductance of what pulls the anode up (`highSiemens`, last
  pass's — a DTL gate's 4.7 k through two diodes against 10 k). A pull of no known
  conductance among opposing ones is X as before. An open-collector output at X drives `OC_X` (sim/levels.js — a DRIVER
  level only, never a net's; chip-eval.js `driverLevel`): a LOW beside it wins (a
  wired-AND), anything else is X, no conflict. The logic engine's alone (`maybeSinks`,
  `!hooks`): under Spice Lite the solve decides whether the LOW holds (`wiredLow`). The
  incremental settle's `loneLevel` reads it as `resolveNet` does.
  **An output driven against a supply is a `conflict`** (resolve.js, 2026-10-22): the
  rail still wins the level, but an L on a `+` net (or H on a `−`) is a fight — a
  74LS04's LOW wired to the + rail, or fed it through a diode (Spice Lite: 152 mA, the
  output overloaded, the diode within its rating — so no diode burns), was silent. The
  incremental settle reads a rail's warning again whenever its drivers move
  (`incremental.js` `railed`; its LEVEL stays the index's `railRes`), so it says what
  the full loop says. **A diode passes a LOW too** (settle-pass.js `diodeLows`, the
  regrades of 2026-10-22): a diode whose cathode is LOW — a − rail, or an output's LOW of
  its own (never one a diode pulled it to: two drops up is no LOW; never a `+` rail, whatever
  fights it — the 2026-10-26 review; a shorted rail, + and − both, is a − still) — adds an L at output
  strength on an anode something FEEDS (`fedNets`: a resistor's end or a TTL input,
  which sources its own current; a lone CMOS input floats) — a diode-AND, a diode-
  isolated wired-AND (they read HIGH whatever their inputs) — and, into a − rail, on an
  anode an output drives HIGH: that output shorted through the diode, a `conflict` (it
  was silent). An output's HIGH into any other cathode passes on as a HIGH, the fight
  said at the cathode as before. An unknown cathode is the "maybe" reading (`uncertain`)
  only where something feeds the anode (`fedNets`; the incremental settle's `ix.anodes`
  takes such a cathode from a status-blind superset, `feedable`; there the wide
  reading is read on the COMPONENTS an unknown diode end is in alone, agreed with the
  cache — `scopedReading`, the fourth regrade: a whole-desk fallback, it took a busy
  desk with one floating CMOS output into a diode from 0.26 to 1.9 ms a tick, now 0.34). **Drops are counted**
  (`depth`, third regrade): an anode a chain holds `d` drops up is LOW only where every
  input on it reads `d`·0.7 V as one (`readsLowAt`: TTL to 0.8 V — one drop; CMOS to
  30 % of its supply — two at 5 V, five at 12), else X — and such an X anode is no HIGH
  (`notHigh`: it passes none on, in any reading, and is no `uncertain` anode). "Two drops
  is never a LOW" was wrong for a CD4069 at 12 V.
- **Analog switches JOIN nets; they drive none** (CD4066B, CD4051B/52B/53B — Phase 2b
  of Feature 410 — and the CD4007UB, whose six MOSFETs are six channels built by
  `mosfetChannels`: N on while its gate is HIGH, P while LOW, a floating gate X through
  the family reader, with no gate memory, unlike a discrete MOSFET's. Its pair 1 sits on
  the part's own VDD/VSS pins inside the package, so a supply pin may be a channel
  terminal on a def flagged `transistorArray`, which also makes a rail-to-rail join
  through it a short `via: "transistor"` — tagged per JOIN, not per net, since its
  terminals 14 and 7 sit on the rails and a net tag made every rail short on the desk a
  transistor's; a terminal whose channel runs to a rail is that gate's OUTPUT to the
  boundary warnings (`mixed-supply` at the `+` rail's volts, `ls-fanout` through an N to
  `−`); shelved under Inverter, its headline use; out of the AI builder, since which
  terminal is an output is decided by wiring the card cannot show). The NETLIST stays static (wiring + hand-set switch positions only),
  so the probe, schematic, warm-start ids and every netlist consumer are untouched; the
  join is the SOLVER's, per pass. A def states `logic.channels: [{a, b, inputs, on}]`
  (terminal pins, control pins, a pure `on(levels)` → H/L/X, built by
  `bilateralSwitches`/`muxSection`); `chip-eval.js`'s `channelStates` reads the controls
  through the family reader. `engine.js`'s `channelGroups` unions the nets of every ON
  channel of a POWERED switch (union-find), from the previous pass's levels exactly as a
  chip's outputs are, and `resolveAll` resolves each member net from every member's
  drivers and pulls — but a member RAIL only as its supply at OUTPUT strength, so a rail
  through a switch FIGHTS an output on the far side (conflict, said once per group)
  where the same rail wired straight on would win, and a group holding both rails warns
  `short` with `via: "switch"` (its own sentence everywhere). **A rail is never a union
  point** (`groupsOf`): it is stiff, so two nets each switched onto `+` are not joined to
  each other, and a fight on one does not turn the other X; it is a MEMBER of each group
  it touches (never a key — it resolves as itself), and a channel straight between two
  rails is a group of its own, reported as the short. **A floating control is read
  every way it could be** (`channelGroups`' `readings`, keyed by control NET): each
  assignment of the unknown controls is a real switch position, resolved on its own, and
  the pass keeps what every reading agrees on — a wide reading closing every
  maybe-channel at once joined a mux's channels to each other through COM, which no
  select value does. Past `MAX_UNKNOWN_CONTROLS` (4) it falls back to that one wide
  reading (more X, never less). Warnings come from the CERTAIN channels alone
  (`definite`). Levels that crossed a channel stay STRONG for every purpose but one:
  at ≤ 5 V a channel's on-resistance limits an LED's current, so the LED rule's
  `strongLevels` leave such a switch's joins out (each reading's `hardOn` — see "Logic
  families"); from 9 V an LED off a switch with no resistor burns, as off an output. Channel
  terminals are `io` pins the boundary warnings skip, KiCad exports as PASSIVE, and the
  AI card marks `~`.
- **`tick(...)`** adds the synchronous two-phase step on the same solver: ① pre-settle
  with the OLD per-component state (propagating the new `clockPhase` + input changes),
  ② sample each sequential chip's inputs and `step` it (edges from the pre-settle vs the
  last tick's `prevPinLevels`; async overrides win), ③ post-settle with the NEW state —
  so all edges are observed at once and then the combinational cloud settles.
- **`SimController`** (renderer) owns the **transport** (Run / Pause / Step / speed),
  drives the free-running clocks' edges in BATCHES (below; handing `tick` each clock's
  level via `clockPhase`), re-ticks on every input event, routes warnings to the
  `NotificationStack`, and publishes `chiphippo:sim-state` (net levels + chip status +
  clock levels) that live views render from — **views never query the engine**.
  Sequential state and clock phases are run-volatile (reset on Run, never serialized).
  - **A batch lets the thread go every `sliceMs` (2 ms)** (2026-10-28, sim-pacer.js +
    sim-controller.js): the Worker's pacer batch yields through its continuation and
    carries on as ONE batch, so a Pause or an input landing between back-to-back batches
    runs at most one slice, then drops the rest as an over-budget batch does — Pause p50
    17–27 ms → 3–4 ms, ×real-time unchanged or better. Two old Pause bugs went with it:
    the "frame put off to now" rule applies to PACER batches only (it cut Pause's
    catch-up short — Pause froze past edges it never ran, an input could tick ahead of
    edges due before it), and Pause freezes at the LAST TICK instead of re-reading the
    sim clock after dropping debt (at 10 kHz ×4 that landed past unrun edges).
    **Hot loops never `for (const [k, v] of map)`** — on this V8 it allocates an entry
    array per entry: walk `keys()` + `get`, or the chip record's parallel
    `pinList`/`netList`; combinational outputs go into `work.spare`, an unchanged
    reading is handed back as the same map (`inputLevels` `prev`, `c.lastIns`),
    `LampAverage.spare()` reuses its brightness map (busy8 218 → 137 KB/tick, results
    byte-identical). The tick's `netLevels` (warmStartOf's Map, ~56 KB) stays fresh per
    tick: callers keep it (the last shown board, the worker's cut cache by identity).
  - **Batched ticks** (2026-10-07, `features/done/batched-ticks.md`). Clock edges and the
    timed parts' `wakeAt` are ONE queue in SIMULATED seconds (`sim/schedule.js`
    `EdgeSchedule`: edges COUNTED from an origin, never accumulated; coincident edges
    one event, every clock in it flipped together, as Step does). A **PWM** clock
    (2026-10-09) has UNEQUAL halves — `clockHalves(hz, duty)`, HIGH for its pulse width —
    handed to `set` as `[present, next]` by its level (SimController `#halvesOf`), so
    its n-th edge is ⌈n/2⌉ of one and ⌊n/2⌋ of the other, still counted; a square is
    one number and today's `n·half` to the bit. Step moves time by the shortest
    PRESENT half; a pulse width moved mid-run (same period, `periodOf`) keeps the
    clock's place in its half (`#reconcileClocks`' `elapsed` — a slider drag must not
    hold an edge off); a re-rate still restarts it. ONE timer (`#arm`) runs
    `#runBatch`: every event due, each its own tick at its own exact `now`, then ONE
    `sim-state` for the last — batches no oftener than `FRAME_MS` (8) after the last
    publish, the publish itself no oftener than `PUBLISH_MS` (40, 25 fps — since
    2026-10-09; an input's tick still publishes at once), and
    stopping after `BATCH_BUDGET_MS` (6) of work, when the debt is DROPPED (the sim clock
    re-anchors at the last tick; edges are skipped, never bunched — a stall's rule) and
    `RunMeter` (`components/sim-pacer.js`) reports the speed achieved as `behind` on
    sim-state, which the speed button shows in amber (`app.js` `showSpeed`). A frame
    that showed it behind owes one more when the meter's window closes
    (`#behindShown`, `RunMeter.clearsAt` — `#arm` wakes for it, `#runBatch` republishes):
    a desk that went quiet published nothing more, and its stale "×1 · ×0.13" stood
    (the release review, 2026-10-23). So there is
    no timer floor and no rate ceiling: a rate on offer runs true until the desk is too
    busy, and then SAYS so (the old floor was derived from `CLOCK_HZ` for that reason).
    **A clock's Rate is a `"preset"` field** (2026-10-13, `CLOCK_RATE_FIELD` in
    catalog/parts.js): `CLOCK_HZ`, Manual, then **Custom…**, whose box (`customHz`,
    unit `hertz` in model/component-value.js — `Hz`/`hertz`, a `k`) takes ANY rate in
    `CLOCK_CUSTOM_RANGE` (1 Hz – 10 kHz, `VALUE_RANGES.clock`). `params.hz` stays a
    number or "manual" — no reader knows a custom rate from a preset; `normalizeParams`
    holds a stored number to the range (a desk at 2 kHz used to be cut to 1 kHz).
    Past `CLOCK_FAST_HZ` (2000) the box shows an amber (i), "may be slowed as
    necessary" — a preset figure's `advise(n)` → message code (`fastClock`), the
    combobox's `advice` (value-combobox.js), worded by `comboMessage`.
  - **The simulation Worker** (2026-10-09, `features/03-sim-worker.md`). The app holds a
    `SimHost` (`components/sim-host.js`), SimController's public surface method for
    method, which runs the run on a module Worker (`components/sim-worker.js` →
    `sim-worker-host.js`: the SAME SimController, `scope` = the Worker's global,
    `pacing` = `WORKER_PACING`, 30 ms batches) and re-dispatches what it dispatches
    (sim-state, sim-tick cut to the analyzer's nets, mem-state) with this thread's
    netlist of the same version; toasts, damage latches and ROM loads cross back as
    messages, every message tagged with its run. The transport answers on the main
    thread at once and Stop entirely (latches cleared, stopped board told) — an input
    shows a frame later. MAIN THREAD (a local SimController) for an Arduino integration
    on the desk, a custom chip armed for debugging (armed mid-run: `exportRun` →
    `importRun`, there until Stop — Jason accepted the cost; the hand-over carries
    the warnings already said, `#warned`, the pending settle check and `memLost`, so
    a toast is neither said twice nor lost — the regrade, 2026-10-22; the switches'
    bounces and move counts, `ContactBounce.export`, the lamps' averaging window,
    `LampAverage.export`, and the glow the last frame showed, which the first frame
    after the hand-over shows again, `#heldGlow` — the fourth regrade: a press just
    before it closed solid, the next bounced on the run's first seed, and a PWM LED
    showed its bare tick for a frame; and since this
    thread never raises those toasts again, SimHost's `stop()` takes down the ones the
    Worker raised, `#toastKeys`), no Worker (tests), or
    `localStorage["chiphippo.simWorker"] === "off"`. `tests/sim-worker.test.js` holds a
    scripted run identical both ways.
    **Each forwarded event names ITS OWN netlist version** (2026-10-21): the Worker's
    cache wrapper records the version each netlist was built from (`builtAt`), since an
    edit's catch-up/run-on ticks go out on the board as it stood, in the same message as
    the edited board's; and `SimHost` keeps what each of the last `KEPT_VERSIONS` (8)
    was built from (`#sent`), so a version the Worker answers after this thread has moved
    on still gets its own netlist (`#netlistAt`). Paired with the newest, a net the edit
    RENAMED (a join takes the smaller address as its id — a pot's wiper reaching 100 %)
    read no voltage, and the analyzer drew a glitch at each step of a slider drag.
    **A run that is behind keeps the Worker busy** (runtime review R2, 2026-10-26): a
    PACER batch with budget left re-reads the sim clock and runs on into what fell due
    while it worked (a catch-up — an input's, Pause's — still runs to its moment only);
    debt is DROPPED only for what was due when the batch BEGAN — what fell due as it ran
    on is left to the next batch (`left`), whose frames stop short of it — so `behind`
    and the drop mean what they did (dropping that too read ×3.95 on a desk that keeps
    ×4). A frame put off to now (`#publishTimer` due) also ends a batch, debt kept, so
    back-to-back batches still publish every `PUBLISH_MS`. When the next event is
    already due, or the last batch dropped debt, a wait under `TIMER_CLAMP_MS` (4) goes
    on SimController's `continuation` — the Worker's `urgentTimer` (sim-worker-host.js:
    a MessageChannel hop, then an un-nested timer for any rest) — since a timer set
    from a timer is held to 4 ms once nested: ×4 ran ×2.25 with the Worker 15 % idle. A
    run keeping up keeps the plain timer (its clamp gathers fast edges into fewer
    batches). Measured ×4: busy16 1 kHz ×3.14 → ×3.84, busy32 Spice ×2.0 → ×2.69,
    Jason's Regulated 5V ×1.78 → ×2.55 (Worker ~84 → ~99 % busy); W65C02/busy16
    unchanged. **Behind is the LAST batch's drop, not the meter's window** (runtime
    regrade NEW-1, 2026-10-27): N3's first try kept a run on the continuation for the
    whole `BEHIND_WINDOW_MS` after any drop, and a timer's whole-ms wait (cut DOWN from
    a fraction) woke it early — a batch with nothing due, set again for the fraction
    left: 35–70k empty batches a second on busy16 Spice ×4, and `RunMeter`'s one sample
    per batch (40–60k, shifted off one by one) stalled the first record after a clock's
    pause 330–710 ms. Now **`urgentTimer` never runs `fn` before its moment** (whole ms
    on a timer, the fraction left hopped on the channel — rounding UP slept a ms after
    every drop, busy32 Spice and Regulated 5V 1.5–3 % slower), and **`RunMeter` keeps a
    sample a wall ms at most from a head index** (O(1) amortized, ~1000 held). busy16s:
    #arm ~200/s (phase 6 the same), resume ≤ 12 ms in 64 presses, Worker ~84 % (phase
    6 ~84 % on the same machine). **While
    someone is at the desk** — an input (`#catchUp`) within `INPUT_WINDOW_MS` (2 s, an
    assumption) — a pacer's batch, continuation or timer, works
    `WORKER_PACING.behindMs` (10 ms), not 30, so the next input waits a third as long: busy16k ×4, a clock's pause 20–41 ms →
    4–16 ms after the first press (that one still meets a 30 ms batch). Not always: 10 ms
    batches throughout ran busy16k ×3.80 not ×3.90 (each batch costs). And a sim-tick
    with no analyzer channel goes only with other events or `PUBLISH_MS` on from the
    last (`loneAt`): batches that publish nothing post nothing (busy16k 50 → 25 messages
    a second). Speeds held: busy16k ×3.99 → ×4.00, busy32 Spice ×2.70 → ×2.74,
    Regulated 5V ×2.56 → ×2.54 (noise), busy16 Spice/W65C02 10 kHz at their caps. **What the Worker sends** (R9): a sim-tick reaches the host straight
    (`tickSink`, no event dispatched on the Worker); with no analyzer channel only ONE
    sim-tick a message goes (scope-view only learns from it that a run is under way); a
    tick's levels are cut to the analyzer's nets once and shared by the curve samples
    after it (`cutOnce` — one Map in the message's clone; a tick's own is cut afresh, its
    map may be updated in place), lamps one shared empty Map; `SimHost` puts the
    netlist back on the received detail in place. Mains example: Worker JS 84 → 58 ms/s;
    busy desks with no channel 820 → 75–200 events/s. The main thread's remaining cost
    was one window `CustomEvent` per analyzer column — since the scope batch
    (2026-10-26) `SimHost` tells a message's run of sim-ticks as ONE
    `chiphippo:sim-ticks` (spice-analyzer.md → "The columns arrive in BATCHES").
  - **Who hears every tick**: the sim-ticks (`{at, mode, netlist, netLevels,
    nodeVolts, supplies, lamps}`), told on the window as `chiphippo:sim-ticks`
    `{ticks}` — a batch's in one event, cut to the analyzer's nets while it has
    channels, each at once with the tick's own maps while it has none (scope batch,
    2026-10-26) — the logic analyzer, the only window listener, records from them; the settle boundary (integration) and the debugger's observer run per
    tick as before; memory writes are merged per batch (`#memOwed`). A stall inside a batch
    freezes the sim clock at the stalling tick (`#freeze(this.#tickAt)`) and publishes
    that board; with a debugger observer every tick publishes.
  - **Run's first tick is AT 0** (`#afterSeed`: `#tickNow(0)`, THEN `#thaw`, 2026-10-21).
    Read off the wall clock it landed a few ms in — the snapshot and netlist are built
    before `now` is read — so an AC supply came on part-way up its sine, and the step
    charged a reservoir capacitor through a bridge at 56 A and burnt it at Run
    (`sim-controller-timing.test.js` "first tick is AT 0").
  - **An input catches up first** (`#catchUp`): a switch, signal key, manual clock, clock
    pause, doc change, part-state or `wake()` runs whatever is due, THEN ticks and
    publishes synchronously — so the board answers on the same event and synchronous
    readers (the Properties dialog) keep working. `#tickAt` keeps time monotonic.
    **An EDIT (doc change, part-state) under Spice Lite also runs the old board on to
    its moment** (`#runOnTo`, 2026-10-13): the engine replays a late tick's history on
    the board it is handed, so without it a switch thrown after a quiet stretch charged
    its RC from the last tick (see spice-analyzer.md → "Analyzer x axis").
    **Pause catches up too**, then freezes AT THE PRESS (or where an out-of-budget
    batch re-anchored): frozen with a frame of edges unrun, the first Step only
    caught up to the press — no edge, or several — instead of moving one
    (`sim-controller-timing.test.js` pins it with a driven clock).
  - **A timed part's wake comes no sooner than `MIN_SHOWN_S` after the last tick — under
    Spice Lite** (`#nextEvent`). Spice Lite asks for a wake at every crossing; ticked at each
    exactly, a tick never spans the crossings `spice/cycles.js` recognises a cycle by, and a
    fast oscillator would run edge by edge. Clock edges keep their exact moments. **The
    logic engine's wakes are their own moments** (the grade, 2026-10-23): its timers'
    schedules are already held to the cap (`capSchedule`, `shownPulse`), and clamped after
    any tick a one-shot's end under half a millisecond past a clock edge merged into the
    next edge — a 0.7 ms one-shot on a 1 kHz trigger never went LOW
    (`lamp-average-bounce.test.js`). And a one-shot's step takes a new trigger on the tick
    its pulse ENDS: the 555's TRIG HIGH at the last tick and LOW now past `until` is a new
    fall (`held` in timer-555.js — TRIG held LOW across the end still holds the output),
    the 4047's +TRIG rising as its period loop ends starts a pulse (monostable.js; it
    returned idle and lost the edge). A CD4060B rewired between its RC oscillator and a
    clock carries its count both ways (`oscillatorCount`; it was zeroed).
  - **The lamps lose their glow past `GLOW_MAX_HZ` (25)**: sim-state's `fastestHz` (the
    fastest ticking clock and each timed part's `oscillationHz`, × speed) → SimOverlay's
    `glowing` → `desk-viewport--flat-lamps`, which drops the drop-shadow on lit LEDs,
    segments, clock lamps and transistor lamps. Per RUN, not per lamp. Toggling a CSS
    filter re-layers the frame; at speed it was most of the desk's drawing cost.
  - **A frame shows each LED/segment at its AVERAGE over the frame** (2026-10-13,
    `sim/lamp-average.js`): `#tickOnce` books every tick's brightness (`lampBrightness`:
    Spice Lite's lamp `level` while lit, incl. an LCD backlight; the digital engine's
    junction rule → 1/0, over `lampJunctions`, cached per snapshot) into `LampAverage`, and
    `#publish` takes the mean over the sim time since the last frame (to `#shownAt()`) as
    sim-state's `lampGlow` (key → mean) — null when nothing changed in the frame (a steady
    desk draws exactly as before), when not RUNNING, or for a debugger replay. SimOverlay's
    `#verdict` lights a glowing key at that level (a burn is still the tick's); the digital
    engine's verdict `level` is now null (plain lit) unless averaged. A 250 Hz 20 % PWM LED
    draws at 0.2, in both engines. The halo rule above is unchanged.
  - **Over-voltage damage is run-volatile, and that took work to be true.** `#persistDamage`
    writes `params.damaged` into the DOCUMENT because that is what the pure engine reads
    (`powerStatus`) and a chip that let its smoke out at tick 5 must stay dead at tick 6
    — a timerless solver has nowhere else to remember it. But burning a chip is a WIRING
    mistake, not a property of the circuit, so `stop()` calls `#clearAllDamage()`
    **before** `#onTransportChange` (stopping re-baselines undo/redo against the live
    document via `#history.sync`, and a later clear would leave the baseline holding
    damage for ⌘Z to bring back), and `DeskDoc`'s load path drops the flag through
    `loadParams` (deliberately NOT `normalizeParams`, which `setComponentParams` shares
    and the latch needs) — covering a project ⌘S'd mid-run, older documents, every import
    and every paste. `SimController.replaceChip` is GONE: Stop recovers every damaged
    chip.

## Logic families (Features 400, 410)

**Two logic families, one catalog**: 74LS TTL (`chips-gates.js`, `chips-seq.js`,
`chips-74ls.js`) and CD4000 CMOS (`chips-cd4000.js`). `catalog/index.js` stamps
`family` per MODULE (`ofFamily`); memory, the 65xx peripherals and the CPUs are
deliberately FAMILY-LESS (they are not 74LS, and tagging them would hide a Z80 in
CD4000 mode). The family lives in the catalog ONLY — never in a document — so no
migration exists or is needed. **Everything that branches on a family asks
`catalog/families.js`** (`familyOf`, `supplyRange`, `supplyText`, `floatsUnknown`,
`lsFanoutOf`, `limitsLedCurrent`, `familiesShown`), never `def.family` by hand, and keys off
`family === "CD4000"`, never "is CMOS" (the W65C02 is CMOS and a Z80 test depends on
its floating bus reading `$FF`).

- **Every CD4000 pinout is from its TI datasheet**, cited at each def by literature
  number; most are Harris scans, read from rendered pages. Pin names are the sheet's
  (`A`–`M`, `0`–`9` on the 4017/4022/4028 — which, like the '148, need `#N` in an AI
  spec — VDD/VSS, VCC on the 4049/4050), less the bar on an active-LOW pin (the 4511's
  `LT`/`BL`, the counters' `CARRY IN`/`CARRY OUT`), as the 74LS names are. TI's CD4050B
  pin table wrongly says "Inverting output"; its function table is right.
- **A floating CMOS input reads `X`** (`asCmosInput`), at both input sites in
  `chip-eval.js`. Every TTL sequential part reads X as a clean **H** — clock, controls and data
  (`ttlReads` → `unknownsHigh` in sequential.js; Jason, 2026-10-22: "TTL generally has
  pull up resistors"): the counters and shift registers ('161, '193, '169, '164, '165,
  '595, '90, '92, wrapped where they are built) and, since the fourth regrade the same
  day (Jason: "yes"), the 74LS flip-flops and latches ('73, '74, '75, '76, '107, '112,
  '173, '174, '175, '273, '279, '259, '533, '573 — each def's `logic` wrapped in the
  catalog, since their units are shared with the CD4000 parts). So LOW → X on a clock is
  a rising edge, an X clear clears nothing and an X ŌĒ turns the outputs off. The UNITS
  themselves (`dffUnit`, `jkUnit`, `latchUnit`, `latchTs`, `registerTs4`,
  `srLatchUnit`, `addressableLatch8` — whose X address merges every latch it may pick,
  `addresses`) still carry an unknown, which is what a CD4000 def reads straight; and the CMOS units (`johnsonCounter`,
  `binaryCounter`, `presetUpDownCounter`, `shiftStoreRegister`, `bcd7segLatch`,
  `bcdDecimalUnits`) carry an UNKNOWN state — X on an async control → unknown; X on the
  clock → "maybe clocked" (`merge` of held and clocked value); a clean reset recovers;
  power-up stays deterministic. Every rule is idempotent, so a stuck X still reaches the
  tick fixpoint. `overUnknowns(levels, fn)` tries each X both ways and keeps what every
  reading agrees on, so an unknown that cannot change an output does not spoil it (a 4028
  with D floating still holds outputs 2–7 LOW) — and, since the 2026-10-26 review, the
  74LS decoders, muxes and selectors' select bits and strobes ('138/'139, '151/'153,
  '157/'257: a '138 with A unknown holds Y2–Y7 HIGH). The timed parts keep the same doubt
  (2026-10-14): a 4060 whose RESET floated stays unknown until a clean RESET HIGH, in
  either mode, and an X on φI is a maybe-edge, as the 4040's clock; a 4047 whose RESET
  floats runs on as though it were not and shows X wherever that and a reset disagree,
  until a clean RESET or the pulse's own end.
- **The batch-2 MSI parts' facts that are not obvious from a pinout**: a 4027 with SET
  and RESET both HIGH drives Q and Q̄ HIGH (as the 4013); the 4094's storage latches are
  TRANSPARENT while STROBE is HIGH and its OUTPUT ENABLE is active HIGH, QS/Q'S never
  floating; the 4511 is a latch BEFORE its decoder (LT/BL act on a held code) and BLANKS
  codes 10–15 (`CD4511_FONT`); the up/down counters' CARRY OUT is combinational and an
  async PRESET ENABLE holds the count while HIGH, the 4510/4516 RESET beating it. A
  decade count above 9 follows `bcdNext` — the CD4510B's logic-diagram gates for all 16
  states, which keep its sheet's "out of non-BCD states within two clocks up, four down";
  the CD4029B's sheet says nothing about it, so its decade mode reuses that logic (an
  assumption, flagged in the def). The CD4020B's Q2/Q3 count but have no pin
  (`binaryCounter`'s `q` takes `null`); the CD4024B is a 14-pin part.
- **A CD405x's VEE is a GROUND-ROLE pin** (`VEE` in `chips-cd4000.js`): the app has no
  negative supply, single-supply use ties it to VSS, and being a supply pin is what
  makes every consumer right with no special case — the engine powers the part only
  with it on the `−` net (else `unpowered`, and the build guide's unconnected-power-pin
  warning names VEE), the AI compiler and the demo bench wire EVERY supply pin (VCC
  first, then each ground, so single-ground parts lay out exactly as before), the spec
  may not list it (`POWER_PIN_LISTED`, which now names the pin), and `pin-resolve`'s
  role rung prefers the ground pin the token NAMES (`vss` is VSS, not the lower-numbered
  VEE). The catalog test allows exactly this second ground pin.
- **A CD4000 output at ≤ 5 V cannot burn an LED** (`ledLimit` 5 /
  `limitsLedCurrent(def, volts, level)` — the datasheet arithmetic is in its comment:
  ~4 mA typical at 5 V; at 9 V ~15 mA puts ~105 mW in the output transistor against
  its 100 mW absolute max; 12–15 V is 22–28 mA, past the LED too). So `strongLevels` —
  all `junctionState` ever reads, and why no consumer changed — is no longer the
  relaxation's `strong` map when a limiting part is on the desk (`ctx.limitsLed`): it
  is resolved AGAIN from the HARD drivers only (`driversFor`'s `hard`, which drops a
  limiting chip's output levels) across the HARD joins only (`channelGroups`'
  `hardOn` in each reading, which drops a ≤ 5 V switch's channels — rON 470 Ω, ~6 mA). The
  resistor relaxation's basis is untouched (a CD4000 output still pulls through a
  resistor), and a desk with no limiting part resolves nothing twice. A part whose
  output stage is not the small MOSFET names its hard side: `highCurrent: "sink"`
  (CD4049UB/CD4050B buffers, ~19.5 mA typical at 5 V — Fig. 5-3 levels off there, the
  LED's whole 20 mA rating with half the spread past it; a judgement call) or `"source"`
  (the CD4511B's bipolar segment drivers). The compiler still puts a resistor in every lamp leg on a
  rail — good practice, and the prompt's "not between two outputs" holds as advice.
- **Warnings no level expresses** (the engine has no net voltages), all STRUCTURAL and
  reported once per net/chip: `floating-input` (a powered CD4000 input on a net that
  resolved `Z`, spare gates INCLUDED — computed in `assemble`), and from
  `buildContext`'s `boundaryWarnings`: `marginal-high` (74LS output → CD4000 input with
  no resistor to a supply `+`; level stays H — LS VOH 3.4 V typ vs CMOS VIH 3.5 V),
  `ls-fanout` (a CD4000 output on more 74LS inputs than `lsFanoutOf`: 1, or the
  4049/4050's 8), `mixed-supply` (one net, chips on different supply volts — judged by
  `supplyClash`: outputs and ordinary inputs need the net at their own supply's level,
  while a level shifter's input, `def.inputsAboveSupply` on the 4049/4050, takes anything
  at or ABOVE its own; ground nets are skipped like supply `+` ones, since every supply
  shares one). Spice Lite MEASURES what these guess, and retires `marginal-high`,
  `ls-fanout` and `mixed-supply` from its results (spice-lite.md).
  And one that is not a family's: `supplies-meet` (`engine.js` `suppliesMeet`, in the
  context beside `clockWarnings`) — one `+` net fed by PSUs SET to different voltages
  (the halves of a split rail jumpered, two supplies on one rail), judged on the set
  volts so Spice Lite's droop cannot part two equal supplies; same-voltage parallel
  supplies and every `−` net are left alone, and the net still runs at the highest.
  A danger toast and a `SUPPLIES_MEET` FAULT in the desk review.
  **Two supplies STACKED** (one's + on the other's −, a ± rail; or one on top) are no
  `short` (2026-10-26 review, `sim/floating-grounds.js` `stackedSupplies`): `buildContext`
  leaves a stacked supply's shared end to the other supply and puts its own end on a + rail
  at the stack's volts or a − (`belowGround`, so a chip grounded there runs on the whole
  span); a + on a ground both −s share is still a short (spice-lite.md "A PSU shorted").
  **A chip whose supply pins are all on supply nets but not across a + rail and ground**
  (the upper of two stacked supplies; 0 V..−5 V of a ± pair) runs on the span between
  their potentials — ground 0, a + rail its volts, a stacked − below ground
  (`supplyPotentials`/`supplySpan`: VCC less its highest ground, as Spice Lite's
  `chipVolts`) — through `fedStatus`, so both engines agree (it read damaged at 10 V, or
  unpowered; the regrade, 2026-10-26). Such a chip reads a supply net on the far side of
  its span the other way to the desk (`railReads`: the lower supply's + is its LOW, 0 V
  the HIGH of a chip on 0..−5 V), wherever it reads its pins. Its OUTPUTS are still H/L on
  the desk's one scale: what a chip on 0..5 V makes of a 5..10 V chip's LOW is Spice Lite's
  — but the logic engine WARNS of it: `mixed-supply` keys each chip on its (ground, VCC)
  POTENTIALS (`supplyLow`/`supplyHigh` on the chip record), not its span, so 0..5 into
  5..10 is a mixed supply (the toast's volts each chip's VCC from ground, 5 V / 10 V; the
  spans when only the grounds differ), and a level shifter's input clashes with a lower
  HIGH or another ground (phase 7b, 2026-10-27). A chip whose VCC is on a supply but whose
  ground floats is unpowered at 0 V across it (it said its VCC's 5), as Spice Lite reads it.
  `SimController.#report`, the desk review's `engineFinding` and the AI ladder's
  `describeWarning` each say them; the AI's L5 skips `floating-input` because L6's
  `INPUT_FLOATING` names the same pins better. A fault symbol's hover hint IS the
  Properties card's warning sentence (`part-symbols.js` `statusHint`, fed the volts
  from `chipStatus`) — it was a hand-kept English list that told a burnt chip to
  "replace this part" long after Stop learnt to restore it.
- **The tray shows a family, or both** (`settings.logicFamily`: `"74LS"` default |
  `"CD4000"` | `"combined"`; switched from Settings ▸ Data Sheets — app-wide, NOT per
  project, since a project flag is an unsaved change). Combined inserts a `74LS` and a
  `CD4000` folder under CHIPS; their groups' collapse keys are `74LS/NAND` etc., so the
  two NANDs never open together (`foldersOf` gives `#openOnly` the whole path). A family
  the open project uses is always shown (`noteProjectFamilies`, sticky until
  `resetProjectFamilies` from `ProjectWorkspace`'s `onProjectAdopted`), and a filter
  matching only a hidden family says where to switch it on. Every family lists its
  groups in the 74LS order (`CHIP_GROUP_RANK`: first appearance in the whole catalog,
  which 74LS leads), not its own part-number order — that would open CD4000 on NOR.
- **The AI builder knows both**: the card brackets each logic chip's family
  (`[DIP-14, CD4000]`), the prompt's family rule picks parts from the request (CMOS /
  CD4000 → CD4000; TTL / 74LS → 74LS; neither → 74LS; never mixed unless asked), and the
  compiler ties every input of an UNUSED CD4000 gate/section to GND (`spareCmosInputs`,
  `SPARE_INPUTS_TIED`, told to the repair round) — an input a USED section needs stays the
  spec's mistake for L6, whose message turns CMOS for a CMOS part. The section rule reads
  the CMOS sheets' TRAILING digit (`CLOCK1`) for CD4000 parts only — on a TTL part it
  would turn the '193's `D0`…`D3` into four sections.
- **The Digital export places six CD4000 parts** as their pin-for-pin twins in Digital
  v0.31's library (`DIGITAL_FILES`: CD4002B→744002, CD4017B→744017, CD4069UB→7404,
  CD4075B→744075, CD4077B→747266, CD40106B→7414); the other 40 are
  `noDigitalModel` (that library has no 4000-series folder), as is the NE555, and a
  capacitor is left out with its own reason (`capacitor` — it joins no net anyway). A floating CMOS input
  gets the TTL rule's PullUp — Digital refuses an open input and has no X — and the
  report says so (`cmosFloating`). `export-digital-cli.test.js` runs only with
  `DIGITAL_JAR` set and the release's `lib/` folder BESIDE the jar (a bare jar draws
  every chip as "7400.dig is missing", which the load check now fails on).
