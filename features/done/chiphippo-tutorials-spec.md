# ChipHippo — Guided Tutorials Feature Spec

## Purpose

ChipHippo's engine is capable, but new users have no guided way to learn the UI. This feature adds a tutorial system: fully automated, guided overlay "tours" that play on top of the live app, run in their own desktop tab, and never touch the user's existing work.

Error-detection/feedback for miswired circuits is explicitly **out of scope** (an arbitrary circuit is too unpredictable for static checks). This spec covers onboarding and tutorials only.

---

## 1. Entry points

### 1.1 Toolbar button
- Add a **Tutorials** button to the main toolbar using the **existing open-book icon** already used elsewhere in the app. Find and reuse that asset; don't create a new one.
- Clicking it opens the **Tutorial Menu** (see 1.3).
- The button is always available, regardless of the opt-out flag.

### 1.2 First-run welcome gate
- On launch, if the user has never seen a tutorial **and** has not opted out, show a welcome pop-up:
  - Title/body along the lines of: *"Welcome to ChipHippo! Looks like this is your first time here. Would you like a quick tour?"*
  - Buttons:
    - **Yes, show me**: closes the pop-up and starts Tutorial 1.
    - **Not now**: closes the pop-up and does not set the flag, so it is offered again next launch.
  - Checkbox: **Don't show tutorials automatically again**. When checked, the global opt-out flag is set, whichever button is pressed.
- Only Tutorial 1 is ever auto-shown. Every other tutorial is reached only through the Tutorial Menu.
- The welcome pop-up should follow the app's existing dialogue styling.

### 1.3 Tutorial Menu
- A simple list of available tutorials, each with a title and a one-line description.
- Order:
  1. **Getting around ChipHippo** (the orientation tour, Tutorial 1)
  2. **Creating your first breadboard** (Tutorial 2)
  3. Further tutorials to be added later.
- Selecting an entry starts that tutorial.
- The tutorial list should be data-driven (a registry or definitions file) so new tutorials can be added without touching the menu code.

---

## 2. Settings / persistence

- One **global, application-level** flag (not per-project), e.g. `tutorials.autoShowDismissed: bool`, default `false`.
- Set to `true` when:
  - the user ticks "Don't show tutorials automatically again" on the welcome gate, **or**
  - the user completes Tutorial 1 (they've seen it, so don't auto-show it again).
- When `true`, nothing auto-shows. The toolbar book still works normally.
- Opt-out is **global**. There is no per-tutorial opt-out.
- *Open question for Jason:* should a "Reset tutorials / show welcome again" control live somewhere in Settings? Not required for v1.

---

## 3. Tutorial content

### Tutorial 1 — Getting around ChipHippo (orientation only, builds nothing)
Steps, each a callout over the real UI:
1. **Component tray**: curly brace spanning the full height of the tray. *"This is the component tray. It's where you pick parts to place on your desktop."* May briefly expand one group to show it opens.
2. **Desktop tabs**: the tabbed desktops (Desktop 1, 2, 3...).
3. **Save / Load / Save As**: point to these menu items.
4. **Toolbar action icons**: Wire, Bus, Generate, etc. One callout for the group, or a short callout per icon.
5. **Settings**: point to where Settings opens.
6. **Final step: the book**: point to the open-book toolbar button. *"That's the tour. Click here any time for more tutorials, starting with building your first breadboard."*

No components are placed in this tutorial.

### Tutorial 2 — Creating your first breadboard
- Choreographed demo: the fake cursor moves to the component tray, opens the boards group, picks the breadboard, and drags it onto the desktop, with callouts explaining each action.
- Detailed step list to be written together later. The engine must support it from day one.

---

## 4. Overlay engine

### 4.1 Model
A tutorial is an ordered list of **steps**. Each step is pure data:

```
Step {
  target:   TutorialId | null      // UI element to highlight; null = centred message
  callout: {
    text:       string
    placement:  above | below | left | right | auto
    decoration: brace | arrow | ring | none
  }
  action?:  CursorAction           // optional choreography (see 4.4)
  advance:  { mode: timed, ms } | { mode: afterAction }
}
```

Tutorial definitions live in data (a JSON/YAML or Go-defined table), separate from engine code.

### 4.2 Target registry
- A central registry maps a stable **TutorialId** (e.g. `componentTray`, `toolbar.save`, `toolbar.settings`, `toolbar.tutorials`, `desktop.tabs`) to a live widget handle.
- Widgets register on creation and deregister on destruction.
- At each step the engine resolves ID → widget → **current screen rectangle**. Never hard-code coordinates, so tours survive resizing and layout changes.
- If a target can't be resolved, skip the step (or fall back to a centred callout) and log it. The tour must not crash.

### 4.3 Overlay rendering
- A **transparent full-window layer** above the app.
- Dims everything except the target's rectangle (spotlight cut-out).
- Draws the callout text and decoration (curly brace along the target's long edge, arrow, or ring).
- Repositions on window resize.
- Blocks normal user input to the app underneath while a tutorial is playing, except for the tutorial's own controls (4.5).

### 4.4 Choreographed cursor
- Use a **fake cursor sprite** drawn on the overlay. Do **not** move the real OS pointer.
- `CursorAction` types: `moveTo(targetId)`, `click(targetId)`, `drag(fromTargetId, toTargetId | point)`.
- Movement is animated (eased, roughly 0.5–1s) so it reads naturally.
- A "click" or "drag" invokes the **same handlers the real UI uses** (e.g. the tray's open-group handler, the existing drag-and-drop placement path) rather than synthesising OS events. Results must be identical to a real user action.

### 4.5 Playback
- Tutorials are **fully automated**. No "do it yourself" mode and no waiting for user input to advance.
- Steps advance on a timer, or once their action's animation completes plus a short read pause.
- Minimal on-screen controls: **Exit tutorial** (always visible; Esc also exits). *Suggested, optional for v1:* Pause/Resume and Next.
- To repeat a tutorial, the user reopens it from the book.

---

## 5. Tutorial desktop (isolation)

- Starting **any** tutorial creates a **new desktop tab** (e.g. named "Tutorial: Creating your first breadboard") and switches to it. All tutorial actions happen there.
- The user's existing desktops are never modified.
- When the tutorial ends (completed or exited), show a prompt:
  - **Keep this desktop**: the tab stays as a normal desktop the user can play with.
  - **Close it**: the tab is removed and focus returns to the desktop the user was on before.
- For Tutorial 1, which builds nothing, still use the tab for consistency. *Open question:* auto-close silently if the tab is still empty instead of prompting.

---

## 6. Acceptance criteria

- [ ] Open-book button on the toolbar opens the Tutorial Menu.
- [ ] First launch with the flag unset shows the welcome gate. Yes starts Tutorial 1; Not now defers; the checkbox sets the global flag.
- [ ] Completing Tutorial 1 sets the flag. Nothing auto-shows afterwards.
- [ ] Tutorial 1 highlights the tray (with brace), desktop tabs, save/load/save as, toolbar icons and settings, and ends on the book.
- [ ] Targets are resolved via the registry; resizing mid-tour keeps callouts aligned.
- [ ] The fake cursor drives real handlers; a dragged breadboard behaves exactly as if the user had placed it.
- [ ] Every tutorial runs in a new desktop tab; existing desktops are untouched; the keep/close prompt appears at the end.
- [ ] Exit / Esc ends a tutorial cleanly at any step.
- [ ] New tutorials can be added by adding definition data plus any new TutorialIds.

## 7. Out of scope (v1)
- Automatic detection or explanation of wiring errors.
- Interactive / user-performs-the-step mode.
- Tutorials beyond 1 and 2 (content to be designed later).

---

## As built (2026-10-10)

- **Code**: `src/web/scripts/tutorials/` (`definitions.js` — the tutorials as data;
  `targets.js` — the TutorialId registry; `player.js`; `geometry.js`) and
  `components/tutorial-controller.js` + `components/tutorial-overlay.js`. Notes for
  future work: `.claude/rules/tutorials.md`.
- **The book** sits in the header's right-hand action panel, left of the Settings gear,
  drawn from the app's one open-book glyph (`bookSvg`, the guide-page buttons' icon).
- **The flag** is `settings.tutorials.autoShowDismissed` (main's DEFAULTS), written
  through the ordinary settings seam.
- **Definitions are JS data**, not JSON/YAML: the app has no loader for either, and a
  frozen module is what every other table in the catalog is. Text is catalog keys
  (`tutorials.*`), translated into all seven languages.
- **Placement** gained `inside-top` beside the five listed — the desk is a target with no
  room on any side of it.
- **A "drag" from the tray** is this app's click-to-arm then click-to-place: the tray row's
  own click arms the ghost, then `DeskController.trackPlacementAt` / `dropPlacementAt`
  (the bodies of the desk's own pointermove and click) carry and drop it. A test holds the
  result identical to a real click.
- **Pause/Resume, Previous and Next** were built (Pause/Resume and Next optional in v1;
  Previous added on request). Pause is sticky: Previous and Next move between steps but
  only Resume restarts the clock. Stepping back onto a step that clicked or dragged shows
  it without repeating the action.
- **The fake cursor appears only when a step's action uses it** (a click, a drag, or the
  move leading into one); steps that only point show the callout alone.
- **Close** removes the tutorial's tab with no confirm, returns to the previous desktop and
  un-mints its "Desktop N" number, so a project clean before a tutorial is clean after.
  While a tutorial plays its tab is held out of the auto-save. If the desktop on screen
  changes under a tour (⌘N / Open from the native menu, whose accelerators the overlay
  cannot intercept), the tour stops without asking.
- **Tutorial 2** has a first-cut step list (intro · open the tray if shut · open Boards ·
  point at Full-size · carry it to the desk · ring the placed board · what next). Its
  detailed script is still to be written together.
- **Reset**: Settings ▸ About ▸ **Reset tutorials** clears the flag, so the welcome is
  offered at the next launch (added the same day, on request).
- **Open question, not done**: auto-closing Tutorial 1's still-empty tab instead of
  asking (it asks, as the spec's main text says).
