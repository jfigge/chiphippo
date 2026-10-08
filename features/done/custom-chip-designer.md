# ChipHippo Feature Spec: Custom Chip Designer

## Summary

Let users design and emulate their own chip when the part they need isn't in the library. The user defines the physical package, then writes the chip's behaviour in a deliberately small subset of Verilog. A split-pane editor links the code to the package diagram, and a live debug mode lets them step through the chip's logic while the circuit runs.

Both combinational and sequential (stateful) logic must be supported.

---

## 1. Package Designer

- User specifies the **number of pins per side** (top and bottom are always equal, so total pins = 2 x N).
- User chooses the **chip width**: 300 mil or 600 mil (cosmetic, but selectable).
- Pin names and directions (input / output) are defined here and become the chip's pinout.
- The finished chip appears in the parts panel like any other chip.

---

## 2. Logic Language: a Verilog Subset

### Principles

- The language is a **cut-down derivation of real Verilog**, not a homegrown syntax.
- Anything that is implemented must be **syntactically and semantically compatible with real Verilog**, so code reads as genuine Verilog to anyone who knows it. Unsupported constructs should be rejected clearly, never approximated.

### Supported constructs (initial scope)

| Area | Constructs |
|---|---|
| Combinational | Continuous `assign` statements |
| Sequential | `always @(posedge clk)` blocks (and negedge as appropriate) |
| Assignment | Blocking `=` and non-blocking `<=`, with correct Verilog semantics |
| Bitwise operators | `&`, `\|`, `^`, `~` |
| Logical operators | `&&`, `\|\|`, `!` |
| Other | Equality/comparison, shifts, ternary `?:` as needed |

### Constraints

- **No unbounded loops.** Every evaluation pass must be guaranteed to terminate.
- Internal state variables (e.g. a counter's tick value) are supported for sequential logic.

### Module wrapper is generated

- ChipHippo **auto-generates the module header** (pin declarations and the input/output list) from the package design.
- The user only sees and edits the **body**: the `assign` and `always` statements.
- This guarantees the code's pins can never drift from the physical package.

---

## 3. Single Clock per Module, Replication for Multi-Unit Chips

- Each module is **single-clock and self-contained**. There is no multi-clock logic inside one module.
- Multi-unit packages (e.g. a dual D flip-flop, quad NAND) are built by **replicating the same module** across separate pin groups in one package.
- A custom chip supports **up to 6 module instances**.
- Workflow: the user writes the logic once, marks it as replicated (up to 6 times), then **assigns pins separately for each instance**.

---

## 4. Editor UI

A **single split-pane view**:

- **Left/one side:** the chip package diagram with its pinout.
- **Other side:** the code editor with **syntax highlighting**.
- The editor understands pin identifiers as pin variables.
- **Two-way hover linking:** hovering a pin name in the code highlights that pin on the package diagram, and hovering a pin on the diagram highlights its references in the code.
- The dialogue should build on ChipHippo's standard properties dialogue conventions (name, description, divider, element-specific fields) for visual consistency.

---

## 5. Debug Mode

The chip can be placed in a **running circuit**, and its code editor opened while the whole simulation runs.

### Pin-change breakpoints

1. A pin on the chip changes value.
2. Execution pauses in the editor at the `assign` / `always` block sensitive to that pin.
3. The user **steps through** the block statement by statement.
4. When the block finishes writing its outputs, control returns to ChipHippo's settle engine, which propagates the change.
5. This repeats (hitting further breakpoints downstream) until the board is **settled**.

### Settled flag

- The debug view shows a **settled indicator** that goes green once a full pass completes with no further pending pin changes.
- A **second breakpoint type** can be set on the settled flag itself, pausing at the moment of quiescence so the user can inspect final state.

### Variable inspection

- A **watch panel is automatically populated** (no manual watch setup).
- It shows live values for **both** pin-backed variables **and** internal state variables, updating as the user steps.

---

## 6. Performance Notes

- Hover linking is a cheap text-position-to-pin lookup.
- Live evaluation walks a small AST of `assign` and `always` blocks, comparable in cost to a built-in chip's logic, just interpreted.
- The ban on unbounded loops guarantees every settle pass terminates.

---

## 7. Debugger UI

### Custom chip appearance

- Custom chips are drawn with a **distinct body color and style** (e.g. a corner glyph or different notch) so they are never confused with library chips. The glyph means it is not color-only.
- The same style is used consistently on the board, in the parts panel, and in the designer/debugger window.

### Toolbar

The existing global run menu (**Stop / Pause / Step / x1**) is unchanged and remains the only control that affects the whole simulation. The debugger gets its own bar in the same pill style, scoped to the chip in view:

| Control | Behaviour |
|---|---|
| **Continue** | Resume until the next armed breakpoint fires, on any chip |
| **Step** | Execute one statement in the paused chip |
| **Step Out** | Finish the current `assign`/`always` block, write outputs, hand control back to the settle engine |
| **To Settled** | Run, ignoring pin-change breaks, until the board is quiescent |
| **Detach** | Remove this chip's breakpoint and return it to normal run mode (see below) |
| **Break on** | Two toggles: *Pin change* and *Settled* |
| **Settled lamp** | Green when the board has reached quiescence |

- **x1 (speed) is not repeated** in the debugger, since speed is meaningless while paused inside a block.
- **Detach** is deliberately not called Stop and is not red. Red is reserved for the global Stop.

### Per-chip arming

- Debugging is enabled **per chip**, off by default, so a custom chip behaves like any other until opted in.
- Toggles live in the debugger bar and are mirrored in the chip's right-click menu.
- An armed chip shows a small badge on the board; a chip currently paused shows a pulsing outline.

### Detach semantics

- Detach only removes the breakpoint and puts the chip back in run mode.
- It **does not stop the simulation**.
- Re-arming the chip later causes it to enter the debugger again on its next change.
- **Only the main Stop button ends the simulation.**

### One popup window, tabbed

- A single popup window serves as the **designer** when the simulation is stopped and the **debugger** when it is running.
- The chip that is selected, or currently being debugged, is shown in the window.
- Selecting a chip on the board focuses its tab.
- A new tab appearing never steals focus while the user is mid-step in another tab.

### Tabs

- **Multiple chips changing state at the same time each get their own tab**, so the user can switch between step-throughs.
- **Order** reflects the order in which changes arrived. If several chips change at the same instant, they are ordered **alphabetically** so order is predictable.
- **Any tab can be selected and stepped at any time**, regardless of position.
- When an idle tab receives a new change it moves to the end of the strip, because order follows arrival (to confirm; the alternative is a stable position once created).

Tab states, shown as a badge on each tab:

| State | Meaning |
|---|---|
| **Paused** | Stopped at a breakpoint, waiting for the user |
| **Pending (held marker)** | Has a change queued from another chip's output. The prototype shows this as an **"N held" marker on a Paused tab**, because a change can only be held while the chip is paused in its own evaluation. Keep it as a separate tab state only if a chip can ever have a queued change without being mid-evaluation |
| **Detached** | The chip's pin-change breakpoint is off. It runs normally and never pauses; the tab stays in the strip, dashed badge, and can be re-armed |
| **Idle (disabled)** | Step finished and outputs written; no code is executing. Debug controls are disabled, the tab keeps its last values, and the code stays visible but read-only. It re-enables when a new change arrives |

### Concurrency rule

Modelled on Verilog's non-blocking semantics:

1. Every chip that changes in a pass reads inputs **as they were at the start of the pass**.
2. Outputs commit when each chip finishes its block.
3. If chip A's output changes chip B's input while B is mid-step, that change is **held**, not applied to B mid-step. It is held rather than dropped so a real event is never lost.
4. When B finishes, it re-evaluates against the held value **only if it differs** from the value B already used. This preserves the existing glitch-invisibility rule.
5. The board reports **settled** only when every tab is Idle and nothing is held.

---

## 8. Out of Scope for This Spec

- **Error handling and validation** (parse errors, references to nonexistent pins, rejected constructs, runaway logic) is deliberately left to implementation-time judgment. Questions should be raised during implementation.

---

## 9. Integration Notes

- Reuses ChipHippo's existing **settle engine** and quiescence flag (also used by the Arduino output/inbound integration).
- Custom chips should work alongside the TTL and CD4000 families already planned.
