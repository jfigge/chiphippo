# Keyboard Shortcuts

Chip Hippo follows Electron's `CmdOrCtrl` convention throughout, so every
shortcut listed here as `Cmd` also works as `Ctrl` on Windows and Linux.
Most shortcuts are disabled while a text field has focus, and some are
further gated on the current tool or simulation state — those conditions
are noted alongside the shortcut.

## Desk & simulation

| Shortcut | Action |
|---|---|
| `Space` | Run / Stop the simulation (not while typing, or while a placement/wire/bus tool is armed) |
| `Cmd+R` | Run / Stop the simulation |
| `Tab` | Switch between the Breadboard and Schematic views (not while typing) |
| `Escape` | Unpin a probed net, then disarm the probe, then cancel a pending wire/bus, then cancel a placement in hand, then deselect — whichever applies first |
| `Delete` / `Backspace` | Remove the current selection (a part, wire, bus, annotation, board, or a whole marquee selection) |

## Tools

| Shortcut | Action |
|---|---|
| `W` | Arm/disarm the wire tool |
| `B` | Arm/disarm the bus tool |
| `I` or `P` | Arm/disarm the probe tool (works even while the simulation is running) |
| `M` | Disarm whichever of the wire/bus/probe tool is currently armed |
| `1`–`8` | While the wire tool is armed, pick a wire color |
| `1`–`2` | While the bus tool is armed, pick the bus width (8-bit / 16-bit) |

## Placing & rotating parts

| Shortcut | Action |
|---|---|
| `R` | Rotate or flip the part being placed or selected — see [Chips & Components](components.md) for the exact behavior per part type |
| `F` | Flip an LED's polarity while its placement ghost is armed |
| `Cmd+C` | Copy the selected part |
| `Cmd+V` | Paste a copy as a new placement ghost |

## View

| Shortcut | Action |
|---|---|
| `Cmd+F` | Fit the whole desk to the window |
| `Cmd+Shift+F` | Zoom out to fit everything at once |
| `Cmd+=` or `Cmd++` | Zoom in |
| `Cmd+-` | Zoom out |
| `Cmd+0` | Reset zoom |
| `Cmd+A` | Toggle the Logic Analyzer panel |
| `Cmd+P` | Toggle the parts palette panel |

## Files & editing

| Shortcut | Action |
|---|---|
| `Cmd+N` | New Schematic |
| `Cmd+O` | Open Schematic… |
| `Cmd+S` | Save |
| `Cmd+Shift+S` | Save As… |
| `Cmd+Z` | Undo |
| `Cmd+Shift+Z` | Redo |

## App

| Shortcut | Action |
|---|---|
| `Cmd+,` | Open Settings |
| `Cmd+K` | Open the quick Keyboard Shortcuts popup |
| `Cmd+/` | Open the Chip Hippo User Guide (this guide) |
| `Alt+Cmd+I` | Toggle Developer Tools |
