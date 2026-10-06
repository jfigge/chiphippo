# Custom Chips

When the part you need isn't in the library, design it. A **custom chip** is a
DIP package you lay out yourself — how many pins, which is which — with its
behaviour written in a small, strict subset of **Verilog**. It sits in the
parts tray beside the library, places like any chip, and runs in the
simulation like any chip. While the circuit runs you can stop inside it and
step through its code a statement at a time.

Custom chips are **yours, not one project's**: every chip you design is kept
in Chip Hippo's own chip library on this computer, so it is in the tray of
every project you open. A project file carries the chips its desktops use, so
it opens complete on another computer — and opening a project that uses a
chip your library doesn't have adds that chip to your library. Exporting a
desktop takes the chips it uses with it, and importing one brings them in the
same way.

If a project carries its own, older copy of a chip you have since changed,
that project keeps using its copy while it is open, so its circuit is built
exactly as it was. Editing the chip there saves the edit to your library too.

## Making a chip

In the parts tray, open **CHIPS ▸ CUSTOM** (after the library's chips, or
beside the 74LS and CD4000 folders when the tray shows both families) and
click **New chip…**. The
**Chip Designer** window opens on a fresh design — a two-input NAND on a
14-pin package, so there is something working to change. Right-click a chip
in the tray for **Edit Design…**, **Duplicate Design** and **Delete Design**.
Deleting a design removes it from your library; a chip placed on a desktop of
the open project can't be deleted until it has been removed from the desk.

The designer is one window with a tab per open design. The left half is the
package — its pinout drawn as a datasheet draws it, which stays in view at the
top, and under a line the fields that define it, which scroll on their own.
The right half is the code. Drag the divider between the halves to give the
package more room (a chip of several units has a wide pin table); double-click
it to put it back. Chip Hippo remembers where you left it.

### The package

- **Part number** — what is printed on the chip, up to 16 letters, digits,
  `-` and `_`. It is also the Verilog module's name.
- **Description** — a line shown beside it in the tray and in the BOM.
- **Logic family** — 74LS or CD4000. It decides what an input left open reads
  (HIGH for 74LS, unknown for CD4000) and the supply the chip needs, exactly
  as for the library's parts of that family.
- **Body width** — 300 mil or 600 mil, which is where it seats on the board:
  a 300-mil chip straddles the trench in rows e and f, a 600-mil one in rows d
  and h.
- **Pins per side** — from 2 to 20, so from 4 to 40 pins.
- **Units** — how many copies of the module the package holds, up to six
  (see [Units](#units)).
- **Power pins** — which pins are VCC and GND (VDD and VSS for CD4000).
- **Ports** — the module's inputs and outputs: a name, a direction and a width
  of 1 to 16 bits, and at the end of the row the pin it is on — one column
  per unit. A port wider than one bit takes one pin per bit, so its bits are
  listed under it, each with its own pins. **Auto-assign** puts every bit
  that has no pin on the next free one. When there are more units than the
  pane has room for, the pin columns scroll sideways while each port's name
  stays in view.

While a chip is placed on any desktop of the open project its **size and
width are fixed** — its instances are seated in holes, and moving their pins
would silently rewire every desk it is on. Everything else, the code included,
can still change. To change the package of a chip in use, remove it from the
desk first, or duplicate the design. (Other projects that use the chip are not
rewired by a change made here: each keeps its own copy in its file.)

### The code

The **module header** — `module`, the port list, `endmodule` — is generated
from the package and shown above and below the editor, read-only. You write
only the **body**: declarations, `assign` statements and `always` blocks. So
the code's pins can never drift from the chip's: rename a port in the package
and the header follows. The header takes up to two fifths of the code area
and scrolls past that; drag the line under it to make it taller or shorter,
and double-click the line to put it back.

The code is checked as you type. Problems are listed under the editor with
their line numbers, and the line is marked in the gutter. A chip whose
package or code has a problem still places, but it **drives nothing** (every
output floats), and pressing Run says which chips those are.

Hover a pin on the package to light every use of it in the code; hover a name
in the code to light its pins on the package.

## The Verilog subset

What is supported behaves as real Verilog does, so code written here reads
correctly to anyone who knows the language — and anything outside the subset
is **refused with a message saying so**, never approximated.

```verilog
// A 4-bit binary counter with an asynchronous reset.
reg [3:0] count = 4'd0;

always @(posedge CLK or negedge RST_N)
  if (!RST_N)
    count <= 4'd0;
  else
    count <= count + 1;

assign Q = count;
```

**Supported**

- `wire` and `reg` declarations, with a constant range (`reg [7:0] r;`) and
  an optional initial value (`reg q = 1'b0;`); `parameter` and `localparam`.
- Continuous `assign`.
- `always @(*)` (or a full list of signals, `@(a or b)`) for combinational
  logic.
- `always @(posedge CLK)`, with `negedge` as needed, and asynchronous controls
  in the same list: `@(posedge CLK or negedge RST_N)`, tested in the block's
  leading `if`, as a synthesis tool expects.
- `initial` blocks, for a starting value.
- `begin … end`, `if` / `else`, and `case` / `casez` / `casex` with `default`.
- Blocking `=` and non-blocking `<=`, with Verilog's semantics: a
  non-blocking assignment takes effect after every block triggered by the same
  edge has run.
- Operators: bitwise `& | ^ ~ ~^`, reduction (`&a`, `|a`, `^a` and their
  negations), logical `&& || !`, equality `== != === !==`, comparison
  `< <= > >=`, shifts `<< >> <<< >>>`, arithmetic `+ - * / %`, the ternary
  `?:`, concatenation `{a, b}` and replication `{4{a}}`, and bit and constant
  part selects (`a[3]`, `a[7:4]`).
- Numbers in Verilog's forms — `13`, `4'b1010`, `8'hFF`, `'d9` — with `x`
  and `z` digits.

Values are four-state (`0`, `1`, `x`, `z`) and unsigned, up to 32 bits wide.
A `reg` with no initial value starts as `x`, as in a real simulator.

**Not supported** — loops of every kind (every evaluation has to finish),
delays (`#`; the simulation is zero-delay), functions and tasks, system tasks
such as `$display` (the debugger's watch panel shows every value), arrays,
`signed`, the `**` operator, indexed part selects (`+:`), gate primitives,
module instances (use units instead), and compiler directives.

**Also refused, because they are mistakes**: assigning an input; driving one
signal from two places; a `reg` driven by `assign` or a `wire` set in an
`always` block; an `always @(*)` that leaves a signal unset on some path (it
would be a latch); an event list that misses a signal the block reads; and a
combinational loop (`assign` and `always @(*)` cannot hold state — a clocked
block can). Undriven outputs and unused registers are warnings rather than
errors.

### One clock per module

A module has at most **one clock**. Every edge-triggered block uses the same
clock input, and any other signal in an edge list must be an asynchronous
control tested first in the block. Logic on a second clock belongs in a
second chip.

### Units

A multi-unit package — a quad NAND, a dual flip-flop — is the **same module
repeated** on separate pins. Write the module once, set **Units**, then give
each unit its own pins in its column of the Ports table. The pinout prefixes each unit's pin
names with its number, as the datasheets do (`1A`, `2A`, …). A port can share
one pin between units — a common clock or enable — in which case that pin
keeps the bare name. An output can never share a pin.

## Debugging a chip while it runs

Place the chip, wire it up and press **Run**. The Chip Designer window turns
into the **debugger** while the circuit runs, and back into the designer when
you press Stop. (A design can't be edited while the circuit runs.)

### Breakpoints

A custom chip runs like any other until you give it somewhere to stop. Two
kinds of breakpoint do that:

- **A line of code.** Click a line number in the editor's margin (or press
  **F9** on the line) and the number turns into a solid red circle. When a
  change on a chip's pins makes its code run that line, the chip stops there,
  before the line executes. Click the circle to take the breakpoint off. A
  breakpoint belongs to the design, so it stops every placed copy of the chip,
  and you can set it before you press Run or while the circuit is running. It
  stays with its line as you edit the code above it.
- **Break on Settled** — pause at the moment the board settles after the chip
  has changed, to inspect where everything ended up. Switch it on for one
  placed chip from its right-click menu on the desk, or from the debugger bar.

A breakpoint on a line that can never stop the chip — a comment, a
declaration, `begin` or `end`, the second line of a statement — is drawn as a
**hollow** circle and ignored. Click it to take it off. While the package or
the code has an error, the chip runs no code, so every breakpoint is hollow
until the error is fixed.

A chip with a breakpoint it can reach carries a small red badge on the board,
and a chip paused in its code pulses. When a breakpoint fires the board
**stalls** — clock edges wait, nothing else moves — and the debugger window
comes forward with the paused statement highlighted.

### The debugger bar

The global Run / Stop / Pause / Step controls are unchanged, and remain the
only ones that act on the whole simulation. The debugger has its own bar,
scoped to the chip in view:

| Control | What it does |
|---|---|
| **Continue** | Run on until the next breakpoint — later in the same block, or on any chip. |
| **Step** | Execute one statement. Stepping past the end of a chip's reaction stops at the next statement it runs. |
| **Step Out** | Finish this chip's reaction and hand its outputs to the board. |
| **To Settled** | Run until the board settles, ignoring breakpoints, and stop there. |
| **Detach** | Stop debugging this chip and let it run — the simulation carries on. |
| **Break on Settled** | The settled breakpoint, for the chip in view. |
| **Settled** lamp | Green when the board has settled: every chip idle, nothing held. |

Detach is not Stop: the chip just ignores its breakpoints for the rest of the
run. Switch on **Break on Settled**, or set a breakpoint while its tab is
showing, and it stops again. The next Run debugs it as usual.

### Tabs

Each chip being debugged has its own tab — several chips reacting to the same
change each get one, so you can step them in any order. Tabs are ordered by
when their change arrived, alphabetically when changes arrive together.
Selecting a custom chip on the desk switches the window to its tab, and a new
tab never takes the focus from the one you are stepping. A tab's badge says
what it is doing:

| Badge | Meaning |
|---|---|
| **Paused** | Stopped at a breakpoint, waiting for you. |
| **Paused · N held** | Paused, with N changes from other chips waiting for it. |
| **Idle** | Its reaction is finished and its outputs are written; it keeps its last values until a new change arrives. |
| **Settled** | Stopped at the settled breakpoint. |
| **Detached** | Nothing will stop it (no breakpoint it can reach, and Break on Settled off), or it was detached — it runs normally and never pauses. |

### How changes are ordered

Within one pass, every chip that reacts reads its inputs **as they were when
the pass began**, and its outputs reach the board when it finishes — the
same rule as Verilog's non-blocking assignment. A change that arrives at a
chip while it is paused mid-reaction is **held**, not dropped and not applied
halfway through; when the chip finishes, it reacts to the held value only if
it differs from the one it used. The board is settled only when every tab is
idle and nothing is held.

### The watch panel

Under the code, the **Watch** panel lists every pin and every internal `wire`
and `reg` of the chip with its current value — in Verilog's notation, with
the decimal beside it when no bit is unknown — updating as you step. A value a
non-blocking assignment is about to write is shown after an arrow beside the
old one. For a multi-unit chip, pick which unit to watch.

## On the desk

A placed custom chip is the design you drew. Its **Properties…** card shows
the design's **part number** as its *Name* and the design's *Description*.
Changing either one there changes the design, so the desk, the tray and the
Chip Designer all show the change, and a change made in the designer shows on
the card too. The part number follows the same rule in both places. Neither
can be changed while the circuit runs.

**Pin Assignment** opens the same floating pin-assignments window every chip
has, drawn from the design's pins and headed by its part number. It stays up
to date while you change the design. Where a library chip's window has its
datasheet and example-circuit buttons, a custom chip's has one button, which
opens the chip in the **Chip Designer**. The right-click menu also has
**Open in Chip Designer**.

## Elsewhere in the app

A custom chip appears as itself in the schematic, the 3D view, the build
guide and the BOM (by its part number and description), and in a KiCad
export as a DIP of its size, valued with its part number. The Digital export
leaves it out, and says so — Digital has no way to run its Verilog. The AI
circuit builder does not use custom chips.
