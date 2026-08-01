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
| `Escape` | Abandon a drag in flight, then unpin a probed net, then disarm the probe, then cancel a pending wire/bus, then cancel a placement in hand, then deselect — whichever applies first |
| `Delete` / `Backspace` | Remove the current selection (a part, wire, bus, annotation, board, or a whole marquee selection) |

## Tools

| Shortcut | Action |
|---|---|
| `W` | Arm/disarm the wire tool |
| `B` | Arm/disarm the bus tool |
| `I` or `P` | Arm/disarm the probe tool (works even while the simulation is running) |
| `M` | Disarm whichever of the wire/bus/probe tool is currently armed |
| `H` | Fade the wires down to a stub at each end, and back (works while running — it only changes what's drawn) |
| `1`–`8` | While the wire tool is armed, pick a wire color |
| `1`–`8` | While the bus tool is armed, pick the bus width — `2`–`8` for that many bits, `1` for 16-bit |

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
| `Cmd+F` | Fit the desk (recentring it) — or the schematic, when it is showing |
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

## App

| Shortcut | Action |
|---|---|
| `Cmd+,` | Open Settings |
| `Cmd+K` | Open the quick Keyboard Shortcuts popup |
| `Cmd+/` | Open the Chip Hippo User Guide (this guide) |
| `Alt+Cmd+I` | Toggle Developer Tools |
