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

// The tutorial player against a fake clock, view and actuator: the sequence,
// the skips, the waits, Pause/Next/Exit, and the fake cursor's click and drag
// reaching the handlers it is given — with no window at all.

import test from "node:test";
import assert from "node:assert/strict";

import { TutorialPlayer } from "../tutorials/player.js";

/** A clock whose every frame is 16 ms later and resolves at once. `hook`
    runs on each frame — a test's way to press a control mid-tour. */
function fakeClock() {
  const clock = {
    t: 0,
    frames: 0,
    hook: null,
    now: () => clock.t,
    frame: async () => {
      clock.t += 16;
      clock.frames += 1;
      clock.hook?.(clock);
    },
  };
  return clock;
}

/** A view that records what it was told. */
function fakeView() {
  return {
    steps: [],
    cursor: [],
    pressed: [],
    paused: [],
    size: { width: 1000, height: 600 },
    showStep(info) {
      this.steps.push(info);
    },
    setCursor(p) {
      this.cursor.push(p);
    },
    setPressed(on) {
      this.pressed.push(on);
    },
    setPaused(on) {
      this.paused.push(on);
    },
  };
}

/** Targets as plain rects; an element per target that records clicks and
    carries `aria-expanded` when given one. */
function fakeTargets(spec) {
  const clicks = [];
  const elements = {};
  for (const [id, { expanded }] of Object.entries(spec)) {
    elements[id] = {
      id,
      getAttribute: (name) =>
        name === "aria-expanded" && expanded != null ? String(expanded) : null,
    };
  }
  return {
    clicks,
    rect: (id) => spec[id]?.rect ?? null,
    element: (id) => elements[id] ?? null,
  };
}

function actuator(log) {
  return {
    click: (el) => log.push(["click", el?.id]),
    dragStart: (el) => log.push(["dragStart", el?.id]),
    dragMove: (p) => log.push(["dragMove", p]),
    dragEnd: (p) => {
      log.push(["dragEnd", p]);
      return true;
    },
  };
}

const R = (left, top, width = 40, height = 20) => ({
  left,
  top,
  width,
  height,
});
const say = (text) => ({ text, placement: "auto", decoration: "none" });
const silent = { warn: () => {} };

function player(
  steps,
  targets,
  { clock = fakeClock(), log = [], warn = silent } = {},
) {
  const view = fakeView();
  const p = new TutorialPlayer({
    tutorial: { steps },
    rect: targets.rect,
    element: targets.element,
    view,
    actuator: actuator(log),
    clock,
    log: warn,
  });
  return { p, view, clock, log };
}

test("it plays every step in order, each for its time, and completes", async () => {
  const targets = fakeTargets({ a: { rect: R(10, 10) } });
  const { p, view, clock } = player(
    [
      {
        target: null,
        callout: say("one"),
        advance: { mode: "timed", ms: 1000 },
      },
      { target: "a", callout: say("two"), advance: { mode: "timed", ms: 500 } },
    ],
    targets,
  );
  assert.equal(await p.play(), "completed");
  assert.deepEqual(
    view.steps.map((s) => [s.index, s.total, s.target, s.callout.text]),
    [
      [0, 2, null, "one"],
      [1, 2, "a", "two"],
    ],
  );
  assert.ok(clock.t >= 1500 && clock.t < 1600, "dwelt as long as it said");
});

test("a missing target is logged and shown centred; an OPTIONAL one is skipped silently", async () => {
  const warnings = [];
  const targets = fakeTargets({});
  const { p, view } = player(
    [
      {
        target: "gone",
        optional: true,
        callout: say("opt"),
        advance: { mode: "timed", ms: 10 },
      },
      {
        target: "gone",
        callout: say("req"),
        advance: { mode: "timed", ms: 10 },
      },
    ],
    targets,
    { warn: { warn: (...a) => warnings.push(a.join(" ")) } },
  );
  assert.equal(await p.play(), "completed", "the tour never crashes on it");
  assert.deepEqual(
    view.steps.map((s) => [s.callout.text, s.target]),
    [["req", null]],
    "the optional step is gone; the required one is centred",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gone/);
});

test("a click glides the cursor to the target and clicks THAT element", async () => {
  const targets = fakeTargets({ btn: { rect: R(100, 200, 40, 20) } });
  const { p, view, log } = player(
    [
      {
        target: "btn",
        callout: say("click"),
        action: { type: "click", target: "btn" },
        advance: { mode: "afterAction", ms: 100 },
      },
    ],
    targets,
  );
  await p.play();
  assert.deepEqual(log, [["click", "btn"]]);
  assert.deepEqual(view.cursor[0], { x: 500, y: 300 }, "it appears mid-window");
  assert.deepEqual(
    view.cursor.at(-1),
    { x: 120, y: 210 },
    "…and ends on target",
  );
  assert.ok(view.cursor.length > 10, "animated, not teleported");
  assert.deepEqual(view.pressed, [true, false]);
});

test("onlyIf reads aria-expanded: a section already open is not clicked shut", async () => {
  const targets = fakeTargets({
    open: { rect: R(0, 0), expanded: true },
    shut: { rect: R(0, 40), expanded: false },
  });
  const steps = ["open", "shut"].map((id) => ({
    target: id,
    callout: say(id),
    action: { type: "click", target: id, onlyIf: "collapsed" },
    advance: { mode: "afterAction", ms: 10 },
  }));
  // …and an OPTIONAL step whose condition fails is skipped whole.
  steps.push({
    target: "open",
    optional: true,
    callout: say("opt"),
    action: { type: "click", target: "open", onlyIf: "collapsed" },
    advance: { mode: "afterAction", ms: 10 },
  });
  const { p, view, log } = player(steps, targets);
  await p.play();
  assert.deepEqual(log, [["click", "shut"]]);
  assert.deepEqual(
    view.steps.map((s) => s.callout.text),
    ["open", "shut"],
    "the required step still shows its words",
  );
});

test("a drag picks up, carries frame by frame, and drops at the named point", async () => {
  const targets = fakeTargets({
    item: { rect: R(10, 100, 200, 20) },
    desk: { rect: R(240, 60, 760, 540) },
  });
  const { p, log } = player(
    [
      {
        target: "desk",
        callout: say("drag"),
        action: { type: "drag", from: "item", to: "desk", at: [0.5, 0.5] },
        advance: { mode: "afterAction", ms: 10 },
      },
    ],
    targets,
  );
  await p.play();
  const kinds = log.map(([k]) => k);
  assert.equal(kinds[0], "dragStart");
  assert.equal(log[0][1], "item");
  assert.equal(kinds.at(-1), "dragEnd");
  assert.ok(kinds.filter((k) => k === "dragMove").length > 10, "tracked live");
  assert.deepEqual(log.at(-1)[1], { x: 620, y: 330 }, "the desk's centre");
  assert.deepEqual(
    log.at(-2)[1],
    { x: 620, y: 330 },
    "the last move is there too",
  );
});

test("Exit stops at once, mid-step", async () => {
  const targets = fakeTargets({});
  const clock = fakeClock();
  const steps = [1, 2, 3].map((n) => ({
    target: null,
    callout: say(String(n)),
    advance: { mode: "timed", ms: 5000 },
  }));
  const { p, view } = player(steps, targets, { clock });
  clock.hook = (c) => {
    if (c.t >= 2000) p.exit();
  };
  assert.equal(await p.play(), "exited");
  assert.equal(view.steps.length, 1, "never reached the second step");
  assert.ok(clock.t < 2100);
});

test("Pause freezes the dwell, and stays paused through Next — only Resume resumes", async () => {
  const targets = fakeTargets({});
  const clock = fakeClock();
  const steps = ["a", "b", "c"].map((text) => ({
    target: null,
    callout: say(text),
    advance: { mode: "timed", ms: 1000 },
  }));
  const { p, view } = player(steps, targets, { clock });
  const at = {};
  clock.hook = (c) => {
    if (!at.paused && c.t >= 500) {
      at.paused = c.t;
      p.togglePause();
    } else if (at.paused && !at.next && c.t >= 3000) {
      // Two and a half seconds paused, and step one is still up.
      assert.equal(view.steps.length, 1);
      at.next = c.t;
      p.next();
    } else if (at.next && !at.resumed && c.t >= 6000) {
      // Next moved on — and the tour stayed paused on step two.
      assert.deepEqual(
        view.steps.map((s) => s.callout.text),
        ["a", "b"],
      );
      assert.equal(p.paused, true);
      at.resumed = c.t;
      p.togglePause();
    }
  };
  assert.equal(await p.play(), "completed");
  assert.deepEqual(view.paused, [true, false], "resumed once, by Resume");
  // From Resume: the rest of step two's second, then step three's.
  assert.ok(clock.t >= 8000 && clock.t < 8100, `took ${clock.t} ms`);
});

test("Previous goes back a step, paused or not, and is greyed on the first", async () => {
  const targets = fakeTargets({});
  const clock = fakeClock();
  const steps = ["a", "b", "c"].map((text) => ({
    target: null,
    callout: say(text),
    advance: { mode: "timed", ms: 1000 },
  }));
  const { p, view } = player(steps, targets, { clock });
  let backed = false;
  clock.hook = (c) => {
    if (!backed && view.steps.length === 2 && c.t >= 1500) {
      backed = true;
      p.togglePause();
      p.previous();
    } else if (backed && view.steps.length === 3 && p.paused) {
      p.togglePause();
    }
  };
  await p.play();
  assert.deepEqual(
    view.steps.map((s) => [s.callout.text, s.canPrevious]),
    [
      ["a", false],
      ["b", true],
      ["a", false],
      ["b", true],
      ["c", true],
    ],
  );
});

test("a step revisited shows again but does not click again; Previous walks past a skipped step", async () => {
  const targets = fakeTargets({ btn: { rect: R(100, 200) } });
  const clock = fakeClock();
  const steps = [
    {
      target: null,
      callout: say("intro"),
      advance: { mode: "timed", ms: 100 },
    },
    {
      target: "btn",
      callout: say("click"),
      action: { type: "click", target: "btn" },
      advance: { mode: "afterAction", ms: 100 },
    },
    {
      target: "gone",
      optional: true,
      callout: say("opt"),
      advance: { mode: "timed", ms: 100 },
    },
    { target: null, callout: say("end"), advance: { mode: "timed", ms: 1000 } },
  ];
  const { p, view, log } = player(steps, targets, { clock });
  let backed = false;
  clock.hook = () => {
    if (!backed && view.steps.at(-1)?.callout.text === "end") {
      backed = true;
      p.previous();
    }
  };
  await p.play();
  assert.deepEqual(
    view.steps.map((s) => s.callout.text),
    ["intro", "click", "end", "click", "end"],
    "back over the skipped optional step to the click, then on again",
  );
  assert.deepEqual(log, [["click", "btn"]], "the click happened once");
});

test("the fake cursor shows only on a step whose action uses it", async () => {
  const targets = fakeTargets({ btn: { rect: R(100, 200) } });
  const { p, view } = player(
    [
      {
        target: "btn",
        callout: say("click"),
        action: { type: "click", target: "btn" },
        advance: { mode: "afterAction", ms: 10 },
      },
      {
        target: "btn",
        callout: say("point"),
        advance: { mode: "timed", ms: 10 },
      },
    ],
    targets,
  );
  await p.play();
  assert.notEqual(view.cursor[0], null, "shown for the click");
  assert.equal(
    view.cursor.at(-1),
    null,
    "hidden for the step that only points",
  );
});
