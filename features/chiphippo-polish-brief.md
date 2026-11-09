ChipHippo UI polish briefs
Four scoped briefs for Claude Code. Each is a polish pass, not a redesign: keep behaviour, change presentation. Use existing design tokens only, and run the i18n guards for any new strings across all 7 locales.
1. Properties dialogs
Goal: every properties dialog looks and behaves the same, building on the standard layout of name, description, a divider, then the element-specific fields.
Changes
• Title pattern everywhere: "<Element type> properties" (sentence case), for example "Clock source properties".
• The Name field gets a placeholder showing the default name the element would get (for example "Clock 1").
• The Description field gets a short placeholder ("Optional notes").
• Disabled fields (for example Pulse width when the wave type doesn't use it) keep their greyed state and gain a tooltip or a one-line hint saying why they're disabled and what enables them.
• Element-specific rows use the same row rule as Settings (see brief 3): label left, control right-aligned, consistent row height and spacing.
• Sliders show their value in the same font as the rest of the dialog, not monospace.
Out of scope: changing what any field does, and adding new fields.
Verification: open the properties dialog for every element type in the parts panel and confirm the title, placeholder, spacing and disabled-hint rules hold.
2. Right-click (context) menus
Goal: lighter, consistent context menus on every surface: components, chips, boards, wires, tabs and the "+" button.
Changes
• Remove dividers between ordinary items. Keep a single divider only before destructive items (Delete …), and between genuinely distinct groups where the shared action table already defines a separator.
• Tighten the item padding and height to match the native menu density.
• Don't show a focus ring on the first item when the menu is opened with the mouse. Show focus only for keyboard opening or navigation (:focus-visible).
• Ellipsis rule: an item that opens a dialog or window ends in "…". Apply it everywhere, for example "Pin Assignment…".
• Destructive items stay red and last.
• Labels use title case consistently, matching the native menus.
Out of scope: changing which items appear. That is governed by the menu-actions table work.
Verification: right-click each object type and compare padding, dividers, ellipses and focus behaviour. Open one menu with the keyboard and check that the focus ring appears.
3. Settings dialog
Goal: every Settings tab follows one layout grammar.
Row rule
• Label on the left (with its optional info icon), control right-aligned to one shared right edge.
• Action buttons sit right-aligned under the control they belong to, never wider than the control column, and never spilling left past the control column's start.
• Helper or status text sits under its row, left-aligned with the labels, in the muted text style.
• Consistent row height and vertical spacing on every tab.
Per-tab fixes
• Simulator: give the TTL/CMOS switch a label ("Chip family") and put it on the row grammar. Align "Reset to defaults" and the datasheet note with the rule.
• Serial I/O: currently uses a left-aligned control column. Convert it to the shared row rule. Keep the connection picker plus its + / delete / info buttons as a header row. Keep the Port validation red state.
• AI: the Clear key / Save key / Test connection row currently overflows left of the field column. Right-align it within the control column, wrapping if needed.
• Gallery: align the "Your shares" list with the label column. Each row shows the name and date on the left and the status right-aligned to the shared edge. (The gallery entry point is moving to the main window separately; don't touch that.)
• About: show the version as plain text, not a read-only input that looks editable. Use the product name consistently.
• Appearance: use one spelling throughout ("colour" vs "color"), matching the locale.
Selected tab
• One selected-tab style on every tab. Show the blue focus ring only for keyboard focus (:focus-visible), never after a mouse click.
Verification: screenshot every tab at the same window size and check that labels, controls and buttons share the same left and right edges.
4. Pin Assignment window
Goal: keep it as a floating window (it's meant to stay open beside the board while editing), but make it visually match the rest of the app.
Changes
• Use the app's normal sans font for the title, pin names and descriptions. Keep monospace only for the small pin-id badges.
• Subtitle: "Pin assignments" in sentence case and the normal font, replacing the lowercase monospace "terminal assignments".
• Lay out each row as badge · coloured pin name · role · description, with descriptions left-aligned in their own column rather than ragged right-aligned.
• Keep the role colours (OUT green, VCC red, GND blue) and use the app tokens for them.
• Spacing and padding should match the properties dialogs.
• Window title pattern: "<name> · <element type>", as now.
Out of scope: changing the floating or non-modal behaviour, or the content shown.
Verification: open pin assignments for a clock, a chip and a component, and confirm the fonts, alignment and spacing match the properties dialogs.
