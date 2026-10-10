# CPU monitor

Landed 2026-10-10. It has no feature number.

## Context

Jason's breadboard TTL 6502 had a CLI debugger (`~/src/go/projects/logic-ctl`) with the
following areas:

- a 16×16 memory block that followed PC;
- the flags, the microcode step, the IRQ/NMI/clock/reset pins;
- an 11-line decoded instruction pipeline, with the current instruction on the 6th line;
- the bus contents;
- the ALU;
- a grid of the 48 EPROM control lines per step and phase.

He asked for a CPU monitor for Chip Hippo's CPUs modelled on that tool. He set three
rules (2026-10-10):

- **Design for what the app supports.** Match the original's features where an honest
  equivalent exists, and leave out the rest. The microcode areas (control lines,
  internal buses, ALU) have no equivalent in a single-chip W65C02 or Z80A, so they are
  not built.
- **A floating window like the Chip Designer.**
- **Read-only for now.**

## What it shows

One CPU at a time. Each area of the window, and what it shows:

| Area | W65C02 | Z80A |
|---|---|---|
| Memory | 256 bytes around PC. The opcode is filled and its operands tinted; the byte the current access touches is outlined. | same |
| Flags | N V – B D I Z C | S Z 5 H 3 P/V N C |
| Step | Number of the bus access within the instruction | The M-cycle's number, kind and T-state |
| Clock | Φ1 / Φ2 (PHI2) | CLK ↑ / ↓ |
| Inputs | RESB IRQB NMIB RDY BE, bold when asserted | /RESET /INT /NMI /WAIT /BUSRQ |
| Doing | running, reset, IRQ, NMI, WAI or STP | running, reset, NMI, INT, halted or bus granted |
| Instructions | 5 recorded instructions, the one in flight, then 5 decoded ahead | same |
| Registers | A X Y S PC, at the instruction's start | AF BC DE HL IX IY SP PC, the shadow set, I R IM IFF1 IFF2 |
| Buses | Address, data, RWB, SYNC | Address, data, /M1 /MREQ /IORQ /RD /WR /RFSH /HALT /BUSACK |
| This instruction | The bus accesses completed so far, then the one in flight; a bit changed from the row above is lit | The M-cycles completed so far |
| Counter | Cycles since Run | T-states since Run |

## How

- **`sim/cpu-cores.js`** holds one descriptor per core: `w65c02Monitor` and
  `z80Monitor`. The catalog hangs the descriptor on the part's `logic` as `cpu`
  (`chips-cpu.js` `monitored`), and `chip-eval.js` `isCpu(def)` tests for it. Nothing else
  names a part. Each descriptor provides:
  - the bus pins, plus the clock pin and the edge it counts on;
  - `peekState(addr)`;
  - `startOf`, `completed` and `current`;
  - `view`;
  - `vectorOf`;
  - `disassemble`.
- **The disassemblers** are `sim/disasm-6502.js` (on the core's own exported
  `W65C02_OPCODES`) and `sim/disasm-z80.js` (x/y/z/p/q decoding with the
  CB/ED/DD/FD/DDCB prefixes).
- **The address map** (`sim/cpu-memory-map.js`) asks the circuit which memory chip
  answers each address:
  - For each 256-byte page, it does a what-if `settle()` with the CPU swapped for
    `peekState` and every clock held HIGH. It does this at the page's first address and
    again at its last.
  - It then reads the chip's address and data pins by net.
  - A page where no chip answers, where two do, or where the chip changes inside the
    page reads as null. So does a pin the map cannot follow. As a check, the byte the
    settle puts on the CPU's data nets must match the image.
  - The cache lasts as long as the document snapshot and netlist do. It does not follow
    a bank latch.
- **The record and the summary** live in `sim/cpu-monitor.js`.
  - `observeTick` runs every tick for every CPU on the desk. On each counted edge it
    records the cycle count, the instruction-start history and the completed rows. This
    is cheap, and it means a monitor opened mid-run still has a history.
  - `cpuSummary` builds the window's picture whenever a board is published, and only
    for the CPU being watched.
- **SimController** handles four pieces:
  - `monitorCpu(id)` sets which CPU is watched;
  - `#observeCpus` runs per tick;
  - the publish carries `cpuMonitor`;
  - `exportRun`/`importRun` carry the records.
- **SimHost and the Worker** forward `monitorCpu`, and the start message carries the
  watched CPU.
- **The window plumbing** mirrors the Chip Designer:
  - main has `openCpuMonitorWindow` and the `cpumonitor:open|to-window|to-host` relays,
    plus `isCpuMonitor` in `identifySender`;
  - `ipc-guard.js` restricts `open` and `to-window` to the app window, and lets only the
    monitor send `to-host`;
  - main closes the window only when the app's main window closes;
  - `components/cpu-monitor-bridge.js` chooses which CPU is shown. It subscribes the sim
    only while the window is open and sends at most every 100 ms, with a trailing send.
    It keeps the last summary after Stop;
  - `cpu-monitor.html` → `scripts/cpu-monitor.js` → `components/cpu-monitor-view.js`.
- **The entry point** is the CPU's context menu, which gains **Open CPU Monitor**. This
  is the second exception to the menu's one shape, after the custom chip's. Selecting a
  CPU on the desk while the window is open switches the monitor to it.

## Round 2 (2026-10-10): editing and breakpoints

Jason asked for two things on the memory block: editing a byte "just like in the
memory viewer", and breakpoints like the chip designer's, which stop the simulation
when the instruction at that address begins and show the byte in red.

- **Editing.** Click a byte, then type hex digits; type-through, Enter, Escape and the
  arrows work as in the inspector. It works while the run is live (running or paused),
  because that is when the monitor shows memory at all.
  - The byte is written into the RUN image of whichever chip the address map
    `locate`s, so it shows in any open inspector at once.
  - A ROM edit lasts until Stop. The document is locked while running, so the file is
    never written; a permanent ROM change is still the inspector's job, while stopped.
- **Breakpoints.** Set one with F9 on the selected byte, the byte's right-click menu,
  or a click in an instruction line's margin. A set byte turns red and its line gets a
  red dot.
  - The run pauses at the opcode fetch's first edge, before any of the instruction has
    run. On the 6502 a one-access instruction is complete one edge later, so this is
    the only moment that is still "the start" for every instruction.
  - The transport shows Paused, including when the Worker paused itself.
  - The window comes forward on that CPU.
  - Breakpoints are session state, kept through Stop and Run and dropped on another
    document. They fire with the window closed.

## Round 3 (2026-10-10): keeping ROM edits

Jason asked for a checkbox that decides whether the monitor's memory edits are kept
when the run ends. **Keep ROM edits after Stop** sits in the window's header and is
stored as `settings.cpuMonitorKeepEdits` (default off).

When it is ticked:

- Every ROM edited during the run is saved at Stop from Stop's final images, through
  the memory inspector's Save (`MemoryBridge.keepRunEdits`). The file is written, the
  chip is flagged programmed and edited as one undo step, and an open inspector is told
  to reload.
- A toast names each chip that was saved.
- An SRAM is never kept; it has no file.

Jason then asked for the box to appear only once memory has been edited. It is shown
from the first ROM edit of a run until Stop; an SRAM edit does not bring it up,
because RAM is never kept. The box is read at Stop, so ticking it mid-run counts. This was verified in the app:
an edit at `$8019` survived Stop and the next Run.

## Left out, on purpose

- **Predicted rows for the rest of an instruction.** The cores' cycle counts are
  bus-access-accurate rather than datasheet-exact, and the monitor shows only what
  actually happened.
- **Backward disassembly.** It is ambiguous, so the earlier lines are recorded as they
  run.
- **Run control in the window.** Step and Resume stay on the toolbar's transport.
- **A picture before Run.** ROM images are loaded when Run is pressed, so there is nothing
  to show earlier.
