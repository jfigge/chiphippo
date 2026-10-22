# Feature Request: Add Veroboard / Stripboard Support to Chip Hippo

## Objective

Implement Veroboard (stripboard) as a new board type in Chip Hippo, integrated with the existing circuit-building workspace, component placement system, wiring tools, project persistence, and electrical simulation engines.

Before making changes, inspect the existing codebase and identify the relevant board models, rendering components, 3D scene implementation, connectivity/netlist builder, simulation engines, project serialization, undo/redo system, and board-selection UI. Follow the existing architecture and conventions wherever possible. Avoid duplicating functionality that already exists.

Implement the feature end-to-end, not just a visual mock-up.

## 1. Add a Veroboard Category Under Boards

Add a Veroboard folder or category under the existing Boards section of the parts palette.

Selecting it should reveal a collection of standard commercial Veroboard sizes. Each item should have a recognizable name and its physical dimensions displayed in millimetres.

Use these initial presets:

### Compact / Pedal Boards
- 92 × 54 mm — approximately 3 5/8 × 2 1/8 inches
- 93 × 55 mm — approximately 3.66 × 2.17 inches
- 25 × 64 mm

### Medium Boards
- 65 × 144 mm — commonly described as 24 columns × 56 pins long; verify the actual dimensions and orientation against the intended hole pitch before fixing the grid dimensions
- 122 × 102 mm
- 121 × 102 mm
- 70 × 90 mm
- 100 × 150 mm

### Large / Eurocard-Style Boards
- 100 × 160 mm
- 38.1 × 214.6 mm
- 12 × 17 inches (304.8 × 431.8 mm), representing a large sheet
- Custom-size Veroboard

Treat these as physical-size presets, not assumptions that all commercial boards have identical hole counts or track layouts. Some nominal dimensions and pin-count descriptions vary by manufacturer. Keep the preset definitions data-driven so they can be corrected or expanded later.

For custom boards, allow the user to specify width and height in millimetres, subject to sensible minimum and maximum limits.

If Chip Hippo already has a convention for board sizes, palette folders, or board metadata, reuse it.

## 2. Model the Physical Veroboard Correctly

Veroboard differs electrically from a solderless breadboard.

It consists of:
- An insulating substrate.
- A regular grid of through-holes.
- Parallel copper strips running along one axis on the underside.
- Electrically continuous copper tracks between holes unless the track has been cut.
- Component terminals and jumper wires that connect to the relevant pads.

Use a configurable hole pitch, defaulting to the standard 2.54 mm (0.1 inch), and configurable board-edge margins.

Calculate the number and position of holes from the selected board dimensions, hole pitch, and margins. Do not stretch a fixed number of holes across arbitrary dimensions.

Keep track orientation consistent across the board model, visual rendering, component placement, and connectivity engine.

Each board should have its own dimensions, hole grid, copper-track layout, and cut state.

## 3. Add Interactive Track Cutting

Add a dedicated Cut Track tool to the existing workspace tool system.

Expected behaviour:
- Clicking a valid hole while Cut Track mode is active cuts the associated copper strip at that position.
- A cut visually interrupts the copper track.
- Clicking an existing cut removes it, restoring electrical continuity.
- The user can switch back to normal selection, placement, and wiring tools without losing the cut state.
- Hovering over a cuttable position should provide visual feedback.
- Existing cuts should remain clearly visible at normal zoom levels.
- Respect the existing undo/redo mechanism, with each cut or restored cut represented as an undoable operation.

Use a consistent and documented definition of what a cut at a hole means. Prefer modelling a cut as a break in the copper track at that hole, isolating the pad at the cut position from the track segments on either side. Ensure this is reflected consistently in the rendered geometry and electrical model.

If the existing architecture makes a different cut representation more appropriate, use it only if the electrical behaviour remains accurate and predictable.

Prevent invalid cuts and handle board-edge positions safely.

## 4. Integrate Track Cuts with Electrical Connectivity

This is a core requirement, not an optional visual feature.

Inspect the existing connectivity builder and netlist generation code. Extend the existing model so that:
- Adjacent pads on an uncut track are electrically connected.
- A cut interrupts the copper track at the corresponding location.
- Pads on opposite sides of a cut are no longer connected through that copper track.
- The pad at a cut position is handled according to the defined cut semantics.
- Jumper wires and component terminals can independently reconnect electrically separated regions.
- Adding, removing, saving, or loading cuts correctly updates the electrical graph.
- The simulation engines, connectivity highlighting, probes, and circuit validation all observe the same connectivity.
- The simulator does not retain stale nets after a cut or restoration.

Reuse Chip Hippo's existing net-building and simulation infrastructure. Do not introduce a separate simulation engine for Veroboard.

Ensure all new board types and track cuts remain backward-compatible with existing projects.

## 5. Support Components and Wiring

Allow components to be positioned on the Veroboard's hole grid using the existing component placement system.

Reuse existing terminal anchoring and wiring functionality wherever possible.

Requirements:
- Components can be placed, selected, moved, rotated, and deleted as supported by the existing workspace.
- Component terminals can connect to individual Veroboard pads.
- Jumper wires can connect arbitrary valid pads.
- Wire routing and terminal snapping work consistently with other supported boards.
- Components remain aligned to the 2.54 mm grid where appropriate.
- Moving or rotating a component updates terminal connectivity correctly.
- Electrical connectivity comes from actual track segments, component terminals, and wires, not from approximate visual proximity.

Do not require the user to solder components in the simulator.

## 6. Add 3D Rendering and an Underside View

Veroboard must support the existing 3D workspace, including the ability to inspect both the top and underside of the board.

First inspect how Chip Hippo renders existing boards and manages camera controls. Integrate the Veroboard into that system rather than introducing a separate 3D viewer.

### Top-side rendering
Show:
- The insulating substrate, using a realistic neutral board colour.
- Through-holes arranged on the correct physical grid.
- Component bodies and leads where supported by the existing rendering system.
- Board dimensions consistent with the selected preset.

### Underside rendering
Show:
- The underside of the insulating substrate.
- Parallel copper tracks aligned to the through-holes.
- Clear gaps in the copper at cut positions.
- Through-hole positions consistent with the top-side geometry.
- Any existing component leads or solder representations only if they fit the current rendering architecture.

Cuts must change the actual copper geometry. Do not merely draw a red cross or an icon on an otherwise continuous track.

### Camera interaction
Allow users to rotate the existing 3D camera to inspect the board from underneath. Reuse existing orbit controls and camera behaviour.

If the application already has a standard view-switching or camera preset mechanism, consider adding a convenient “View Underside” action. Otherwise, ensure the existing camera can reach the underside naturally without obstructing normal workspace interaction.

The underside view is essential for Veroboard. Breadboards do not need a physically detailed underside; if the shared rendering system requires an underside representation for other board types, a blank substrate underside is sufficient.

### Underside attribution
On the underside of Veroboard, add subtle, low-contrast text:

"Designed by Jason, coded by Claude"

Requirements:
- Keep the text understated and secondary to the copper tracks.
- Use a very light grey or similarly subtle colour.
- Keep it legible in the 3D view without competing with circuit details.
- Place it on the underside substrate, not floating above the board.
- Scale and position it appropriately for different board sizes.
- For small boards, reduce the font size or omit the text if it would interfere with track visibility.
- Do not add this text to breadboards or unrelated components.

Use the project's existing text rendering, material, and attribution conventions where available.

## 7. Board Preset Data Model

Keep the standard board definitions in a reusable data structure rather than scattering hard-coded dimensions throughout the UI and rendering code.

Each preset should support, as appropriate:
- Stable identifier.
- Display name.
- Category.
- Width and height in millimetres.
- Hole pitch.
- Edge margins.
- Track orientation.
- Number of rows and columns derived from geometry or explicitly specified when a manufacturer-specific layout requires it.
- Board material and rendering properties.
- Optional manufacturer-specific metadata.

Make it easy to add further presets without rewriting the board renderer or connectivity system.

Ensure custom-size boards use the same underlying model and remain fully editable and simulatable.

## 8. Project Persistence and Undo/Redo

Persist all relevant board information:
- Board type and dimensions.
- Selected preset or custom dimensions.
- Hole-grid and track-layout configuration where necessary.
- Track-cut positions.
- Component placement and orientation.
- Wire connections.

Prefer persisting the preset identifier and user-editable parameters rather than redundant derived geometry, unless the existing project format requires otherwise.

Ensure old Chip Hippo projects continue to load unchanged.

Test that a project with a Veroboard, placed components, wires, and multiple cuts can be saved, reopened, and simulated with the same connectivity.

Use the existing undo/redo architecture for board creation, resizing where supported, track cutting, and cut restoration.

## 9. Performance and Usability

Large boards, including 12 × 17 inch sheets, must not cause excessive rendering or simulation overhead.

Requirements:
- Avoid unnecessary scene objects for every decorative detail if instancing or batched geometry is supported.
- Keep the board responsive when zooming, panning, rotating, placing components, and cutting tracks.
- Avoid rebuilding unrelated circuit data when only one board is modified, where the existing architecture allows incremental updates.
- Make track cuts visible at normal zoom levels without overwhelming the board at distant zoom levels.
- Follow the existing UI's styling, accessibility, keyboard controls, and interaction patterns.
- Provide sensible validation for custom dimensions and board placement.

## 10. Automated Tests

Add tests using the project's existing test framework.

At minimum, verify:
1. Each preset has valid dimensions and board metadata.
2. Hole positions are calculated correctly for a 2.54 mm grid and defined margins.
3. All pads along an uncut track are electrically connected.
4. A cut correctly splits the affected track.
5. Pads at and around a cut behave according to the documented cut semantics.
6. A jumper wire can reconnect otherwise separate track segments.
7. Removing a cut restores continuity.
8. Undo and redo correctly restore cut state and connectivity.
9. Component placement and terminal snapping work on Veroboard.
10. Save/load preserves dimensions, cuts, and connections.
11. The connectivity model is consistent across simulation engines and circuit probes.
12. Existing breadboard behaviour and existing project loading are unaffected.
13. The 3D underside geometry aligns with the top-side hole positions and shows gaps at cuts.
14. Custom-size and large boards render and remain usable.

## 11. Implementation Approach

Work incrementally:

1. Inspect the codebase and identify the existing abstractions to extend.
2. Summarize the proposed implementation and identify any architectural risks.
3. Implement the Veroboard board model and data-driven presets.
4. Add the board category and selection UI.
5. Implement track-cut editing and undo/redo.
6. Integrate cuts with the connectivity builder and simulation engines.
7. Add top-side and underside 3D rendering.
8. Integrate persistence and custom-size boards.
9. Add automated tests.
10. Run relevant tests, type checking, linting, and build commands supported by the project.
11. Fix regressions and document the implementation.

Do not stop after writing a plan. Once the architecture is understood, proceed with implementation unless a genuinely blocking ambiguity requires clarification.

Do not replace existing architecture wholesale, duplicate simulation logic, or introduce unnecessary dependencies.

At completion, provide:
- A summary of what was implemented.
- The files changed and the purpose of each major change.
- Any assumptions about cut semantics, grid dimensions, or commercial board presets.
- Tests run and their results.
- Any known limitations or follow-up work.

## Definition of Done

A user can select a standard or custom Veroboard from the Boards palette, place it in Chip Hippo's workspace, position and wire components, cut copper tracks, observe the resulting electrical connectivity in the simulator, rotate the 3D view to inspect the underside, and save and reopen the project without losing the board or its cuts.

The feature must work with the existing application rather than as an isolated demonstration or static visual mock-up.
