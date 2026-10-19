/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// tutorials/definitions.js — THE TUTORIALS, as data. The menu lists this
// array in order and the player plays a tutorial's `steps` verbatim; neither
// knows any tutorial by name. A new tutorial is a new entry here, its text in
// the locale catalogs (`tutorials.<id>.*`), and — only if it points at
// something no tutorial pointed at before — a `registerTarget` call where that
// widget is built. `tutorials-definitions.test.js` holds every entry to the
// shape below and every text key to en.json.
//
// A tutorial: `{ id, title, description, autoShow?, steps }` — `title` and
// `description` are catalog KEYS (pure data cannot call `t()`; it is
// evaluated before any catalog is loaded). `autoShow` marks the one tutorial
// the first-run welcome offers; completing it is what stops the offer.
//
// A step:
//   target    a TutorialId (tutorials/targets.js) to spotlight, or null for a
//             message centred over the dimmed app.
//   callout   { text: catalog key, placement: above|below|left|right|auto|
//             inside-top, decoration: brace|arrow|ring|none }
//   action    optional choreography for the fake cursor — and the ONLY thing
//             that brings it on screen: a step without one points with its
//             callout alone (a hand with nothing to do is noise):
//               { type: "moveTo", target }
//               { type: "click",  target, onlyIf?: "collapsed"|"expanded" }
//               { type: "drag",   from, to, at?: [fx, fy] }
//             A click and a drag drive the SAME handlers the user's own would
//             (see components/tutorial-controller.js). `onlyIf` reads the
//             target's `aria-expanded`, so "open the Boards section" never
//             CLOSES one that was already open.
//   advance   { mode: "timed", ms } — shown for `ms` (after any action), or
//             { mode: "afterAction", ms? } — the action, then a read pause.
//   optional  true when the step only makes sense in some states (the tray
//             is already open, so there is nothing to open): it is skipped
//             silently when its target is absent or its action's `onlyIf`
//             says no, where any other step with an absent target is LOGGED
//             and shown centred instead.
//
// Callout text is interpolated with `{mod}` (⌘ or Ctrl), like the toolbar's.

/** The first-run welcome's tutorial id (the one `autoShow` entry). */
export const AUTO_SHOW_TUTORIAL = "getting-around";

const timed = (ms) => ({ mode: "timed", ms });
const afterAction = (ms) => ({ mode: "afterAction", ...(ms ? { ms } : {}) });

export const TUTORIALS = Object.freeze([
  {
    id: "getting-around",
    title: "tutorials.gettingAround.title",
    description: "tutorials.gettingAround.description",
    autoShow: true,
    // Orientation only: it points at things and builds nothing.
    steps: [
      {
        target: null,
        callout: {
          text: "tutorials.gettingAround.welcome",
          placement: "auto",
          decoration: "none",
        },
        advance: timed(5500),
      },
      {
        // The tray may be shut to its rail; open it with its own chevron.
        target: "palette.open",
        optional: true,
        callout: {
          text: "tutorials.gettingAround.openTray",
          placement: "right",
          decoration: "arrow",
        },
        action: { type: "click", target: "palette.open" },
        advance: afterAction(),
      },
      {
        target: "componentTray",
        callout: {
          text: "tutorials.gettingAround.tray",
          placement: "right",
          decoration: "brace",
        },
        advance: timed(5500),
      },
      {
        // …and show that a heading opens.
        target: "palette.chips",
        callout: {
          text: "tutorials.gettingAround.trayGroup",
          placement: "right",
          decoration: "arrow",
        },
        action: { type: "click", target: "palette.chips", onlyIf: "collapsed" },
        advance: afterAction(4500),
      },
      {
        target: "desktop.tabs",
        callout: {
          text: "tutorials.gettingAround.tabs",
          placement: "below",
          decoration: "ring",
        },
        advance: timed(7000),
      },
      {
        target: "toolbar.file",
        callout: {
          text: "tutorials.gettingAround.file",
          placement: "below",
          decoration: "brace",
        },
        advance: timed(6500),
      },
      {
        target: "toolbar.tools",
        callout: {
          text: "tutorials.gettingAround.tools",
          placement: "below",
          decoration: "brace",
        },
        advance: timed(7000),
      },
      {
        target: "toolbar.wire",
        callout: {
          text: "tutorials.gettingAround.wire",
          placement: "below",
          decoration: "arrow",
        },
        advance: timed(4500),
      },
      {
        target: "toolbar.bus",
        callout: {
          text: "tutorials.gettingAround.bus",
          placement: "below",
          decoration: "arrow",
        },
        advance: timed(4500),
      },
      {
        target: "toolbar.generate",
        callout: {
          text: "tutorials.gettingAround.generate",
          placement: "below",
          decoration: "arrow",
        },
        advance: timed(4500),
      },
      {
        target: "toolbar.run",
        callout: {
          text: "tutorials.gettingAround.run",
          placement: "below",
          decoration: "arrow",
        },
        advance: timed(5000),
      },
      {
        target: "toolbar.settings",
        callout: {
          text: "tutorials.gettingAround.settings",
          placement: "below",
          decoration: "arrow",
        },
        advance: timed(4500),
      },
      {
        target: "toolbar.tutorials",
        callout: {
          text: "tutorials.gettingAround.book",
          placement: "below",
          decoration: "ring",
        },
        advance: timed(6000),
      },
    ],
  },
  {
    id: "first-breadboard",
    title: "tutorials.firstBreadboard.title",
    description: "tutorials.firstBreadboard.description",
    // A first cut of the choreography; the detailed script is still to be
    // written (features/done/chiphippo-tutorials-spec.md ▸ Tutorial 2).
    steps: [
      {
        target: null,
        callout: {
          text: "tutorials.firstBreadboard.intro",
          placement: "auto",
          decoration: "none",
        },
        advance: timed(4500),
      },
      {
        target: "palette.open",
        optional: true,
        callout: {
          text: "tutorials.firstBreadboard.openTray",
          placement: "right",
          decoration: "arrow",
        },
        action: { type: "click", target: "palette.open" },
        advance: afterAction(),
      },
      {
        target: "palette.boards",
        callout: {
          text: "tutorials.firstBreadboard.boards",
          placement: "right",
          decoration: "arrow",
        },
        action: {
          type: "click",
          target: "palette.boards",
          onlyIf: "collapsed",
        },
        advance: afterAction(3500),
      },
      {
        target: "palette.board.full",
        callout: {
          text: "tutorials.firstBreadboard.full",
          placement: "right",
          decoration: "arrow",
        },
        action: { type: "moveTo", target: "palette.board.full" },
        advance: timed(4500),
      },
      {
        // Picking a board arms a ghost that follows the pointer; a click on
        // the desk puts it down — the drag the user would make.
        target: "desk",
        callout: {
          text: "tutorials.firstBreadboard.place",
          placement: "inside-top",
          decoration: "none",
        },
        action: {
          type: "drag",
          from: "palette.board.full",
          to: "desk",
          at: [0.5, 0.58],
        },
        advance: afterAction(2500),
      },
      {
        target: "desk.boards",
        callout: {
          text: "tutorials.firstBreadboard.board",
          placement: "auto",
          decoration: "ring",
        },
        advance: timed(7000),
      },
      {
        target: null,
        callout: {
          text: "tutorials.firstBreadboard.next",
          placement: "auto",
          decoration: "none",
        },
        advance: timed(6000),
      },
    ],
  },
]);

/** The tutorial with this id, or null. */
export function tutorialById(id) {
  return TUTORIALS.find((tutorial) => tutorial.id === id) ?? null;
}

/** Every TutorialId the definitions name — step targets and action targets
    alike, once each (app-boot.test.js holds the booted app to registering
    them all). */
export function tutorialTargets() {
  const ids = new Set();
  for (const tutorial of TUTORIALS) {
    for (const { target, action } of tutorial.steps) {
      for (const id of [target, action?.target, action?.from, action?.to]) {
        if (id) ids.add(id);
      }
    }
  }
  return [...ids];
}
