# Keyboard Shortcuts

Chip Hippo follows Electron's `CmdOrCtrl` convention throughout, so every
shortcut listed here as `Cmd` also works as `Ctrl` on Windows and Linux.
Most shortcuts are disabled while a text field has focus, and some are
further gated on the current tool or simulation state — those conditions
are noted alongside the shortcut.

## Desk & simulation

| Shortcut | Action |
|---|---|
| `Space` (tap) | Run / Stop the simulation (not while typing, or while a placement/wire/bus tool is armed) — it acts as the key comes up |
| `Space` (hold) + drag | Pan the desk, from anywhere — over a board or a part too |
| `Option` (hold) + drag | Pan the desk, from anywhere that isn't a lead (a wire end or a movable leg — those it picks up instead) |
| `Cmd+R` | Run / Stop the simulation |
| `1`–`9`, `0` | Press signal buttons 1–10, top to bottom (`0` is the tenth) — **only while the circuit runs**, and several at once (see [External signals](power-and-clocks.md#external-signals)) |
| `Tab` | Switch between the Breadboard and Schematic views (not while typing); from the [3D view](3d-view.md), to the Schematic |
| `Escape` | Abandon a drag in flight, then unpin a probed net, then disarm the probe, then cancel a pending wire/bus, then cancel a placement in hand, then deselect — whichever applies first |
| `Delete` / `Backspace` | Remove the whole current selection in one step, no questions (a part, wire, bus, annotation, board with everything on it, a picked leg's part, or a whole multi-selection); a selected [Output or Input tag](arduino.md#outputs-and-inputs) is unplugged back onto its card instead |

## Selecting & moving

These are mouse chords rather than keystrokes, but they are the modifiers the
desk answers to — four jobs, and they never combine. A click is just a drag
that didn't move: it selects what you pressed. [The
Desk](the-desk.md#selecting-things) covers building a selection; [Chips &
Components](components.md#moving-several-parts-at-once) covers moving one.

| Chord | Action |
|---|---|
| click / drag a thing | Select just that thing; dragging moves it — **with its wiring** (wires on what moves come along; one with an end left behind stretches) |
| drag empty desk | Draw a selection box (a drag can start on a board's bare holes too) — it replaces the selection with everything it encloses **completely**; a click on empty desk clears the selection |
| click a board | Select the whole board — every strip snapped to it, its parts riding along |
| `Cmd`-click | Add one item to the selection, or take it back out (`Ctrl`-click on Windows/Linux; on a Mac `Ctrl`-click stays the context menu). On empty desk it does nothing |
| drag any member of a selection | Move the whole selection as one unit — boards, parts and wires — all or nothing |
| hold `Option` | Pin targeting: only a lead that can move on its own (a wire end, a resistor's or LED's leg, a TO-92 transistor's leg) reacts, its hole ringed red |
| `Shift`-drag a part or selection | Move it **bare** — the selected parts move, every wire and leg plugged into them stays in its hole |
| `Option`-click / -drag a lead | Pick just that lead (never added to the selection) / move it to another hole, the other end staying put |
| `Option+Cmd`-click a lead | Add that lead to the selection, or take it back out (`Alt+Ctrl`-click on Windows/Linux); drag the selection and every picked lead moves with it |
| `Space`-drag, `Option`-drag, middle-drag | Pan the desk |
## Tools

| Shortcut | Action |
|---|---|
| `W` | Arm/disarm the wire tool |
| `B` | Arm/disarm the bus tool |
| `K` | Arm/disarm the Cut Track tool (veroboard) |
| `I` or `P` | Arm/disarm the probe tool (works even while the simulation is running) |
| `M` | Disarm whichever of the wire/bus/probe tool is currently armed |
| `H` | Fade the wires down to a stub at each end, and back (works while running — it only changes what's drawn) |
| `1`–`8` | While the wire tool is armed, pick a wire color |
| `1`–`8` | While the bus tool is armed, pick the bus width — `2`–`8` for that many bits, `1` for 16-bit |

## Placing & rotating parts

| Shortcut | Action |
|---|---|
| `R` | Rotate or flip the part being placed or selected — see [Chips & Components](components.md) for the exact behavior per part type |
| `R` (Output/Input tag) | Turn the tag being dragged, or the selected tag, a quarter-turn |
| `F` | Flip an LED's polarity while its placement ghost is armed |
| `Cmd+C` | Copy the selection — one part, a whole multi-selection of parts, or (if it includes boards) the whole sub-assembly |
| `Cmd+V` | Paste a copy as a new placement ghost |

## View

| Shortcut | Action |
|---|---|
| `Cmd+F` | Fit the desk (recentring it) — or the schematic or 3D view, when it is showing |
| `Cmd+Shift+F` | Zoom out to fit everything at once |
| `Cmd+=` | Increase the interface text size |
| `Cmd+-` | Decrease the interface text size |
| `Cmd+0` | Reset the interface text size (13 px) |
| `Option+Cmd+=` | Zoom the desk in |
| `Option+Cmd+-` | Zoom the desk out |
| `Option+Cmd+0` | Reset the desk zoom |
| `Cmd+L` | Lock or unlock the desk against the scroll wheel |
| `A` | Toggle the Logic Analyzer panel |
| `Cmd+P` | Toggle the parts palette panel |

Both scale shortcuts want the **unshifted** key. On a layout where `+`
needs `Shift`, use `Cmd+=` rather than `Cmd+Shift+=` — the shifted chord is
deliberately ignored, so it can't collide with anything else.

The two families above do different jobs. `Cmd+=` and friends change **Chip
Hippo's own text**: toolbars, panels, menus and dialogs, in every window at
once — the same setting as Settings ▸ Appearance ▸ **Editor font size**. Hold
**Option** as well and you move the **desk camera** instead, zooming the
circuit, chips, boards, wires and all. Markings on the desk are printed on the
circuit, so they follow the desk zoom rather than the text size.

> **On a Mac**, `Option+Cmd+=` and `Option+Cmd+-` are also macOS's own
> Zoom shortcuts (System Settings ▸ Accessibility ▸ Zoom ▸ *Use keyboard
> shortcuts to zoom*). If you have that turned on, the system takes the keys
> first and Chip Hippo never sees them — use the zoom cluster in the bottom
> corner of the desk, or `Cmd+F` to fit, instead.

## Files & editing

| Shortcut | Action |
|---|---|
| `Cmd+N` | New Project (a blank slate, one empty desktop) |
| `Cmd+O` | Open… (load a saved project) |
| `Cmd+Shift+O` | Recent projects (the same menu a right-click on the toolbar's Open button drops) |
| `Cmd+S` | Save the project to its file |
| `Cmd+Shift+S` | Save As… (give the project a new file) |
| `Cmd+B` | Toggle the build guide (Bill Of Materials) panel |
| `Cmd+A` | Select All — every board, part and wire on the desk; in a text field, its text |
| `Cmd+Z` | Undo |
| `Cmd+Shift+Z` | Redo |

## Chip Designer & debugger

In the Chip Designer window. The debugger keys act while the circuit runs, and
only when their button on the debugger bar is not greyed out.

| Shortcut | Action |
|---|---|
| `F9` | While designing: set or remove a breakpoint on the caret's line |
| `F8` | Continue — run on to the next breakpoint |
| `F6` | Step — execute one statement |
| `F7` | Step Out — finish this chip's reaction |
| `F9` | To Settled — run until the board settles, ignoring breakpoints |
| `F10` | Detach — stop debugging this chip for the rest of the run |

## CPU monitor

In the CPU monitor window. Each function key acts only when its button on the
monitor's bar is not greyed out.

| Shortcut | Action |
|---|---|
| `F8` | Pause the run, or Continue it to the next breakpoint |
| `F6` | Step — run to the start of the CPU's next instruction (paused) |
| `F7` | Step Over — run a JSR, CALL or RST's subroutine and pause after the call (paused) |
| `F9` | Set or remove a breakpoint on the selected byte |
| `Page Up` / `Page Down` | Move the selected byte 256 bytes, the memory block with it |
| `Escape` | Drop a typed digit, let go of the selection, or close the window |

## Floating slider

In a [floated potentiometer slider's window](components.md#turning-it-while-the-circuit-runs).

| Shortcut | Action |
|---|---|
| `←` `→` / `↑` `↓` | Turn it 1 % |
| `Shift+←` `→` / `Shift+↑` `↓` | Turn it 10 % |
| `Page Up` / `Page Down` | Turn it 10 % |
| `Home` / `End` | Turn it all the way to either end |
| Mouse wheel | Turn it 1 % a notch, up raising it |
| `Space` (tap) | Run / Stop the simulation, as on the desk |

## App

| Shortcut | Action |
|---|---|
| `Cmd+,` | Open Settings |
| `Cmd+K` | Open the quick Keyboard Shortcuts popup |
| `Cmd+/` | Open the Chip Hippo User Guide (this guide) |
| `Alt+Cmd+I` | Toggle Developer Tools |
