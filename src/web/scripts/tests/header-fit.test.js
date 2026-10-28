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

// header-fit.js keeps the toolbar inside the header: the fewest squeeze
// steps that make its content fit, in order. jsdom lays nothing out, so the
// toolbar's two widths are stated here as a function of the steps applied —
// each step frees a known amount, as it does in the running app.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { fitHeader, watchHeaderFit, HEADER_FIT_STEPS, HEADER_FIT_SLACK } =
  await import("../components/header-fit.js");

/** The freed px per step (gaps, wordmark, transport words). */
const FREED = { tight: 32, "no-logo": 110, glyphs: 90 };

/** A header whose toolbar holds `content` px of pills in `room` px. */
function fakeHeader(content, room) {
  const header = document.createElement("header");
  header.className = "app-header";
  const toolbar = document.createElement("div");
  toolbar.className = "app-header-toolbar";
  const pill = document.createElement("div");
  const last = document.createElement("div");
  toolbar.append(pill, last);
  header.append(toolbar);
  document.body.append(header);
  const has = (step) => header.classList.contains(`app-header--${step}`);
  const size = { content, room };
  const client = () =>
    size.room +
    (has("tight") ? FREED.tight : 0) +
    (has("no-logo") ? FREED["no-logo"] : 0);
  // How wide the pills lay out: the tools pill gives up the rest at the
  // last step, so then they never overflow.
  const laid = () => {
    const natural = size.content - (has("glyphs") ? FREED.glyphs : 0);
    return has("scroll") ? Math.min(natural, client()) : natural;
  };
  Object.defineProperty(toolbar, "clientWidth", { get: client });
  Object.defineProperty(toolbar, "scrollWidth", {
    get: () => Math.max(laid(), client()),
  });
  toolbar.getBoundingClientRect = () => ({ left: 0, right: client() });
  last.getBoundingClientRect = () => ({ width: 10, right: laid() });
  return { header, toolbar, pill, size };
}

const steps = (header) =>
  HEADER_FIT_STEPS.filter((s) => header.classList.contains(s)).map((s) =>
    s.replace("app-header--", ""),
  );

test("a toolbar that fits takes no step", () => {
  resetDom();
  const { header, toolbar } = fakeHeader(800, 800);
  assert.equal(fitHeader(header, toolbar), 0);
  assert.deepEqual(steps(header), []);
});

test("the fewest steps, in order: gaps, wordmark, words, then the tools scroll", () => {
  resetDom();
  for (const [over, want] of [
    [20, ["tight"]],
    [100, ["tight", "no-logo"]],
    [200, ["tight", "no-logo", "glyphs"]],
    [400, ["tight", "no-logo", "glyphs", "scroll"]],
  ]) {
    const { header, toolbar } = fakeHeader(800 + over, 800);
    fitHeader(header, toolbar);
    assert.deepEqual(steps(header), want, `${over} px over`);
    assert.ok(toolbar.scrollWidth <= toolbar.clientWidth, "it fits");
  }
});

test("room given back takes the steps off again, last first", () => {
  resetDom();
  const { header, toolbar, size } = fakeHeader(1000, 800);
  fitHeader(header, toolbar);
  assert.equal(steps(header).length, 3);
  size.room = 1000 + HEADER_FIT_SLACK; // the window widened, or the circuit stopped
  fitHeader(header, toolbar);
  assert.deepEqual(steps(header), []);
  size.room = 700; // and narrowed past every step but the last
  fitHeader(header, toolbar);
  assert.deepEqual(steps(header), ["tight", "no-logo", "glyphs", "scroll"]);
  size.room = 1000 - FREED.tight + HEADER_FIT_SLACK;
  fitHeader(header, toolbar);
  assert.deepEqual(steps(header), ["tight"]);
});

test("a step comes off only with the slack to spare, so a readout ticking at a boundary never flips it", () => {
  resetDom();
  const { header, toolbar, size } = fakeHeader(1000, 1000);
  assert.equal(fitHeader(header, toolbar), 0, "exactly full still fits");
  // The speed readout one digit wider, then narrower, then wider …
  const seen = [];
  for (const content of [1003, 998, 1004, 997, 1002, 999, 1003, 996]) {
    size.content = content;
    fitHeader(header, toolbar);
    seen.push(steps(header).join(","));
  }
  assert.deepEqual(new Set(seen), new Set(["tight"]), "tightened once, held");
  // (Within the band a refit tries the step off and puts it back inside one
  // task, so no frame ever shows the trial.)
  size.content = 1000 - FREED.tight - HEADER_FIT_SLACK;
  fitHeader(header, toolbar);
  assert.deepEqual(steps(header), [], "with the slack to spare it relaxes");
});

test("a stray step past a gap is cleared, and the steps stay a prefix", () => {
  resetDom();
  const { header, toolbar } = fakeHeader(800, 800);
  header.classList.add("app-header--glyphs");
  fitHeader(header, toolbar);
  assert.deepEqual(steps(header), []);
});

test("trying the scroll step off and putting it back keeps the tools' scroll position", () => {
  resetDom();
  const { header, toolbar, pill } = fakeHeader(1400, 800);
  let left = 0;
  let scrollable = true;
  Object.defineProperty(pill, "scrollLeft", {
    get: () => left,
    set: (v) => {
      left = scrollable ? v : 0;
    },
  });
  fitHeader(header, toolbar, { scroller: pill });
  assert.equal(steps(header).at(-1), "scroll");
  left = 120;
  // A real pill un-scrolled loses its offset; the fake does the same while
  // the scroll class is off.
  const was = header.classList.remove.bind(header.classList);
  header.classList.remove = (...c) => {
    was(...c);
    if (c.includes("app-header--scroll")) {
      scrollable = false;
      left = 0;
    }
  };
  const add = header.classList.add.bind(header.classList);
  header.classList.add = (...c) => {
    add(...c);
    if (c.includes("app-header--scroll")) scrollable = true;
  };
  fitHeader(header, toolbar, { scroller: pill });
  assert.equal(steps(header).at(-1), "scroll", "still needed");
  assert.equal(left, 120, "where the user had scrolled it");
});

test("watchHeaderFit refits on the next frame after a resize, and the wheel scrolls the tools at the last step", () => {
  resetDom();
  const observed = [];
  let fire = null;
  const RO = globalThis.ResizeObserver;
  const RAF = globalThis.requestAnimationFrame;
  globalThis.ResizeObserver = class {
    constructor(cb) {
      fire = cb;
    }
    observe(el) {
      observed.push(el);
    }
    disconnect() {}
  };
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  try {
    const { header, toolbar, pill, size } = fakeHeader(800, 800);
    const watch = watchHeaderFit(header, toolbar, pill);
    assert.ok(observed.includes(header), "the header is watched");
    assert.ok(
      [...toolbar.children].every((p) => observed.includes(p)),
      "and every pill",
    );
    assert.deepEqual(steps(header), [], "fitted at once");

    size.room = 300;
    fire([]);
    fire([]); // a second report in the same frame is one refit
    assert.equal(frames.length, 1);
    assert.deepEqual(steps(header), [], "not inside the observer callback");
    frames.shift()();
    assert.equal(steps(header).at(-1), "scroll");

    pill.scrollLeft = 0;
    let scrolled = 0;
    Object.defineProperty(pill, "scrollLeft", {
      get: () => scrolled,
      set: (v) => {
        scrolled = v;
      },
    });
    const wheel = new window.WheelEvent("wheel", {
      deltaY: 40,
      cancelable: true,
    });
    pill.dispatchEvent(wheel);
    assert.equal(scrolled, 40);
    assert.ok(wheel.defaultPrevented);
    watch.disconnect();
  } finally {
    globalThis.ResizeObserver = RO;
    globalThis.requestAnimationFrame = RAF;
  }
});

test("at the scroll step a tool focused half under an edge scrolls fully into view, and the clipped edges are marked", () => {
  resetDom();
  const RAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => fn();
  try {
    const { header, toolbar, pill, size } = fakeHeader(1400, 800);
    let left = 0;
    Object.defineProperty(pill, "scrollLeft", {
      get: () => left,
      set: (v) => {
        left = Math.max(0, Math.min(200, v));
      },
    });
    Object.defineProperty(pill, "clientWidth", { get: () => 200 });
    Object.defineProperty(pill, "scrollWidth", { get: () => 400 });
    Object.defineProperty(pill, "clientLeft", { get: () => 1 });
    pill.getBoundingClientRect = () => ({ left: 100, right: 302 });
    const at = (x0, x1) => {
      const b = document.createElement("button");
      b.getBoundingClientRect = () => ({ left: x0 - left, right: x1 - left });
      pill.append(b);
      return b;
    };
    const first = at(101, 130);
    const clipped = at(290, 320); // the pill's inside ends at 301
    const watch = watchHeaderFit(header, toolbar, pill);
    assert.equal(steps(header).at(-1), "scroll");
    const marks = () =>
      ["start", "end"].filter((e) =>
        pill.classList.contains(`toolbar-pill--clip-${e}`),
      );
    assert.deepEqual(marks(), ["end"], "only the far edge clips at first");

    clipped.focus();
    assert.equal(left, 320 - 301, "scrolled just far enough");
    pill.dispatchEvent(new window.Event("scroll"));
    assert.deepEqual(marks(), ["start", "end"]);
    first.focus();
    assert.equal(left, 0, "and back for one half off the near edge");

    // A PRESS focuses its button too, and must not scroll it out from under
    // the pointer (the release would land on the pill, the click lost).
    first.blur?.();
    clipped.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    clipped.focus();
    assert.equal(left, 0, "a pressed tool stays put");
    document.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
    first.focus();
    clipped.focus();
    assert.equal(left, 320 - 301, "the keyboard still scrolls once released");
    first.focus();

    size.room = 2000; // room enough: nothing scrolls, nothing is marked
    watch.refit();
    assert.deepEqual(steps(header), []);
    assert.deepEqual(marks(), []);
    left = 0;
    clipped.focus();
    assert.equal(left, 0, "no step, no focus scroll");
    watch.disconnect();
  } finally {
    globalThis.requestAnimationFrame = RAF;
  }
});
