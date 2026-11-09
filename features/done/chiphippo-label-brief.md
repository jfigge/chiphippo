ChipHippo toolbar labels brief
A standalone brief for Claude Code, independent of the other UI polish work. Use existing design tokens only, and add every new string to all 7 locales so the i18n guards pass.
1. Goal
Make the header toolbar easier to understand for new users without taking much more of the bar's limited width:
• An optional short label under each icon.
• Less clutter: drop the app name and the Bill of Materials button.
• Provisionally, turn the Wire and Bus controls into icon buttons.
2. Remove the app name
• Remove the "Chip Hippo" text next to the app icon. The icon stays, and clicking it still opens About.
• The window title still carries the product name.
3. Remove the Bill of Materials button
• Remove the clipboard (Bill of Materials) button from the toolbar.
• It stays reachable from File ▸ Bill Of Materials… (⌘B), and the shortcut is unchanged.
4. Toolbar labels option
Setting
• New Appearance setting: Toolbar labels, On / Off, default Off. It uses the standard segmented control and the Settings row rule.
• Changes apply live, with no restart.
Placement and style
• When on, each icon shows a one-word label directly underneath it, in small type (around 10–11 px) and the muted text colour. The label turns to the active colour when its button is active.
• One line only. Two lines are a last-resort fallback for a single label that won't fit, never the norm.
• Each button is as wide as the larger of its icon or its label. Keep labels short so the bar barely widens.
• The bar gets slightly taller when labels are on. Every pill (File, Tools, Run) and the right-hand icons stay vertically aligned.
• Keep every existing tooltip unchanged, with or without labels. Labels add to tooltips; they never replace them. Tooltip timing: if the toolbar uses native title tooltips, their delay is set by the OS/browser and can't be changed. If it uses the app's own tooltip component, shorten the show delay to about 300 ms. Report which one is in use, and don't swap native tooltips for custom ones without asking Jason first. Translations: give each label a maximum width. A label that doesn't fit wraps to a second line, and only as a last resort is truncated with an ellipsis (the tooltip still shows what the button does). Add a translator note to each label key saying it is a toolbar label with a limit of about 8 characters, so translators choose short words over literal ones. Check the bar in the locale with the longest labels (likely German) as well as English.
Labels (left to right)
• File pill: New · Open · Save · Save As · Browse
• Tools pill: Wire · Bus · Route · Fade · Probe · Scope · Fit · Schematic · 3D · AI · Code
• Run keeps its existing text and gets no extra label.
• Right side: Guide · Settings
• If "Schematic" makes its button noticeably wider than its neighbours, use "Sch." instead.
What each label is for
• Route: auto-route the wires.
• Fade: fade the middles of wires.
• Probe: the probe tool.
• Scope: open or close the analyzer window.
• Fit: zoom to fit.
• Schematic: schematic view.
• 3D: 3D view.
• AI: AI view.
• Code: generate the serial I/O code (the square-with-angle-brackets icon).
• Guide: user guide.
5. Wire and Bus as icon buttons (provisional, needs review)
Today
• The words "Wire" and "Bus" are the mode toggles. Clicking one activates that mode, and the word turns green while it's active.
• The colour dot opens the wire colour picker. The number badge opens the bus width picker (2–8, 16).
Proposed
• Wire: replace the word and the separate dot with one wire glyph, tinted in the current wire colour. Clicking the glyph toggles Wire mode. A small caret or corner badge opens the colour picker, which is unchanged.
• Bus: replace the word with a bundle-of-wires glyph carrying the current width (for example 8) as a small badge on its corner. Clicking the glyph toggles Bus mode. Clicking the badge opens the width picker, which is unchanged.
• Active state: shown on the glyph (the pill's active background or a green tint), so it's always clear which mode is on.
• With labels on: "Wire" and "Bus" appear underneath, like every other button.
Review requirement — important
• This change is provisional. Jason will look at it in the running app and decide whether to keep it or go back to the current word-plus-dot / word-plus-badge design.
• This is not a user setting. Don't add any Settings option for it.
• Implement it so it's trivial to revert: keep it in its own isolated commit(s), separate from the labels work, with the old markup and styles easy to restore. Don't entangle it with the labels option.
• The pickers, keyboard shortcuts, tooltips and mode behaviour must work identically in both designs.
• When it's done, report back so Jason can review it before anything else builds on it.
6. Out of scope
• Changing what any toolbar action does.
• Reordering the tools.
• The menu-actions and Browse-window work, beyond adding the Browse label to its button.
7. Verification
• With labels off, the toolbar looks as it does today, minus the app name and the Bill of Materials button.
• With labels on, every icon has its label directly beneath it on one line, and the bar's width grows only slightly.
• Measure the bar's width with labels on and off at the default window size, and report both numbers.
• Wire and Bus: the mode toggles, active state, colour picker and width picker all work. The provisional change sits in its own revertible commit(s).
• Check that ⌘B still opens the Bill of Materials.
• Run the i18n guards for the new strings.
