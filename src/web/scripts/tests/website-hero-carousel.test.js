/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// website-hero-carousel.test.js — the hero carousel on chiphippo.com
// (website/hero-carousel.js).
//
// The slide list in index.html is the whole manifest, so these tests run against
// the REAL markup: adding or removing an <img class="hero-slide"> changes what
// they measure, which is the point. Sizes are read from the width/height
// attributes rather than from layout, so no rendering engine is needed.
//
// jsdom does not reflect `img.loading` (setting the property leaves the
// attribute alone), so the lazy-loading tests install a recording accessor in
// its place. That is a stand-in for a browser behaviour, not for the code under
// test — the assertion is still about which slides the script decides to wake,
// and when.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPage } from "./website-page.js";

/** Replace `loading` with a recorder, since jsdom does not reflect it. */
function watchLoading(document) {
  const woken = [];
  [...document.querySelectorAll(".hero-slide")].forEach((img, i) => {
    let value = img.getAttribute("loading") || "eager";
    Object.defineProperty(img, "loading", {
      get: () => value,
      set: (next) => {
        value = next;
        if (next === "eager") woken.push(i);
      },
    });
  });
  return woken;
}

const slideCount = (document) =>
  document.querySelectorAll(".hero-slide").length;
const dims = (img) => ({
  w: Number(img.getAttribute("width")),
  h: Number(img.getAttribute("height")),
});

// ── Building the controls ───────────────────────────────────────────────────

test("the controls are built from the slides in the markup", async (t) => {
  const page = loadPage();
  t.after(page.close);
  const n = slideCount(page.document);
  assert.ok(n > 1, "index.html should ship more than one hero slide");

  // Nothing exists before the script runs: controls must never be on the page
  // without a script behind them.
  assert.equal(page.document.querySelectorAll(".hero-nav").length, 0);
  assert.equal(page.document.querySelectorAll(".hero-dot").length, 0);

  page.run("hero-carousel.js");

  assert.equal(page.document.querySelectorAll(".hero-cell").length, n);
  assert.equal(page.document.querySelectorAll(".hero-nav").length, 2);
  assert.equal(page.document.querySelectorAll(".hero-dot").length, n);
  // Under the framed screenshot, not over it.
  assert.equal(
    page.document.querySelector(".hero-dots").previousElementSibling.className,
    "app-window",
  );
});

test("a single slide builds nothing at all", async (t) => {
  const page = loadPage();
  t.after(page.close);
  const slides = [...page.document.querySelectorAll(".hero-slide")];
  slides.slice(1).forEach((s) => s.remove());

  page.run("hero-carousel.js");

  assert.equal(page.document.querySelectorAll(".hero-nav").length, 0);
  assert.equal(page.document.querySelectorAll(".hero-dot").length, 0);
  assert.equal(page.document.querySelectorAll(".hero-cell").length, 0);
  // The lone slide is left exactly as the static page had it.
  assert.equal(page.document.querySelector(".hero-slide").style.width, "");
});

// ── Sizing ──────────────────────────────────────────────────────────────────

test("the frame takes the widest width and the tallest height in the set", async (t) => {
  const page = loadPage();
  t.after(page.close);
  const slides = [...page.document.querySelectorAll(".hero-slide")];
  const maxW = Math.max(...slides.map((s) => dims(s).w));
  const maxH = Math.max(...slides.map((s) => dims(s).h));

  page.run("hero-carousel.js");

  const frame = page.document.querySelector(".hero-carousel");
  assert.equal(frame.style.getPropertyValue("--hero-max-w"), maxW + "px");
  assert.equal(
    frame.style.getPropertyValue("--hero-ratio"),
    maxW + " / " + maxH,
  );

  // Each image at its own share of the frame — a narrow slide stays narrow
  // rather than being blown up to fill.
  slides.forEach((s) => {
    assert.equal(s.style.width, (dims(s).w / maxW) * 100 + "%");
  });
});

test("no slide can be drawn taller than the frame", async (t) => {
  // The property that makes the fixed frame safe: at its own share of the
  // width, every slide's height comes out at or under the frame's.
  const page = loadPage();
  t.after(page.close);
  const slides = [...page.document.querySelectorAll(".hero-slide")];
  const maxW = Math.max(...slides.map((s) => dims(s).w));
  const maxH = Math.max(...slides.map((s) => dims(s).h));
  const frameH = 1000 * (maxH / maxW); // frame drawn at an arbitrary 1000px wide

  for (const s of slides) {
    const { w, h } = dims(s);
    const drawn = 1000 * (w / maxW) * (h / w);
    assert.ok(
      drawn <= frameH + 0.001,
      `${s.getAttribute("src")} overflows the frame`,
    );
  }
});

test("the CSS contract the frame sizing rests on is still declared", async (t) => {
  // jsdom has no layout engine, so this cannot assert the RESULT — the measured
  // behaviour (a 13" laptop lands at 588x702, a large monitor is untouched)
  // lives in index.html's own comment. What it can do is hold the three
  // declarations that produce it, because each is individually deletable and
  // silently so:
  //   · aspect-ratio + max-height TOGETHER are what make the height constraint
  //     transfer back through the ratio, so the frame scales down keeping its
  //     shape instead of letterboxing. Drop either and the pair stops working.
  //   · .app-window must be fit-content, or a narrowed carousel sits inside a
  //     full-width frame with ~400px of empty desk down each side.
  const page = loadPage();
  t.after(page.close);
  const css = page.document.querySelector("style").textContent;

  const rule = (selector) => {
    const m = css.match(
      new RegExp(`\\n\\s*${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`),
    );
    assert.ok(m, `${selector} should have a rule of its own`);
    return m[1];
  };

  const frame = rule(".hero-carousel");
  assert.match(frame, /aspect-ratio:/, "the ratio is half of the transfer");
  assert.match(frame, /max-height:/, "the cap is the other half");
  assert.match(rule(".app-window"), /width:\s*fit-content/);
});

test("a slide is never left draggable", async (t) => {
  // A drag starting on an <img> is a native image drag: the browser takes the
  // pointer, fires pointercancel, and peels a ghost of the screenshot off the
  // page — so the swipe below did nothing at all with a mouse.
  const page = loadPage();
  t.after(page.close);
  page.run("hero-carousel.js");

  for (const img of page.document.querySelectorAll(".hero-slide")) {
    assert.equal(img.draggable, false);
  }
});

// ── Lazy loading ────────────────────────────────────────────────────────────

test("the first paint fetches only the visible slide", async (t) => {
  // Every slide is within one step of every other once there are three of them
  // (next, and previous wrapping to the last), so waking neighbours from the
  // opening go(0) marked the WHOLE set eager and loading="lazy" deferred
  // nothing — the entire hero payload was fetched before first paint.
  const page = loadPage();
  t.after(page.close);
  const woken = watchLoading(page.document);

  page.run("hero-carousel.js");

  assert.deepEqual(
    woken,
    [],
    "nothing may be woken before the page has loaded",
  );
});

test("the reachable neighbours are woken once the page has loaded", async (t) => {
  const page = loadPage();
  t.after(page.close);
  const n = slideCount(page.document);
  const woken = watchLoading(page.document);
  page.run("hero-carousel.js");

  page.window.dispatchEvent(new page.window.Event("load"));

  // Next and previous — from slide 0 that is slide 1 and the last one.
  assert.deepEqual([...woken].sort(), [1, n - 1].sort());
});

test("advancing does not re-wake a slide that is already eager", async (t) => {
  const page = loadPage();
  t.after(page.close);
  const woken = watchLoading(page.document);
  page.run("hero-carousel.js");
  page.window.dispatchEvent(new page.window.Event("load"));
  const after = woken.length;

  page.document
    .querySelector(".hero-nav--next")
    .dispatchEvent(new page.window.Event("click", { bubbles: true }));

  assert.equal(woken.length, after, "a woken slide is not woken again");
});

// ── Moving ──────────────────────────────────────────────────────────────────

test("advancing moves the track and marks the current slide", async (t) => {
  const page = loadPage();
  t.after(page.close);
  page.run("hero-carousel.js");
  const { document, window } = page;
  const n = slideCount(document);
  const click = (sel) =>
    document
      .querySelector(sel)
      .dispatchEvent(new window.Event("click", { bubbles: true }));

  const current = () =>
    [...document.querySelectorAll(".hero-slide")].findIndex(
      (s) => s.getAttribute("aria-hidden") === "false",
    );

  assert.equal(current(), 0);
  // `-index * 100` is -0 at rest, and String(-0) is "0" — not "-0".
  assert.equal(
    document.querySelector(".hero-track").style.transform,
    "translateX(0%)",
  );

  click(".hero-nav--next");
  assert.equal(current(), 1);
  assert.equal(
    document.querySelector(".hero-track").style.transform,
    "translateX(-100%)",
  );

  // The dot tracks it, and exactly one dot is current at a time.
  const currentDots = [...document.querySelectorAll(".hero-dot")].filter(
    (d) => d.getAttribute("aria-current") === "true",
  );
  assert.equal(currentDots.length, 1);
  assert.equal(currentDots[0], document.querySelectorAll(".hero-dot")[1]);

  // Backwards from the first slide wraps to the last.
  click(".hero-nav--prev");
  click(".hero-nav--prev");
  assert.equal(current(), n - 1);
});

test("taking control stops the carousel advancing on its own", async (t) => {
  // WCAG 2.2.2: a visitor who has touched it must not have it move under them.
  const page = loadPage();
  t.after(page.close);
  page.run("hero-carousel.js");
  const { document, window } = page;

  const track = document.querySelector(".hero-track");
  assert.equal(
    track.getAttribute("aria-live"),
    null,
    "silent while it moves itself",
  );

  document
    .querySelector(".hero-nav--next")
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(
    track.getAttribute("aria-live"),
    "polite",
    "announced once it is theirs",
  );
});

// ── Accessibility of the built controls ─────────────────────────────────────

test("every control the script adds is labelled and typed", async (t) => {
  const page = loadPage();
  t.after(page.close);
  page.run("hero-carousel.js");
  const n = slideCount(page.document);

  for (const b of page.document.querySelectorAll(".hero-nav, .hero-dot")) {
    // Inside no <form> here, but a bare <button> defaults to type=submit.
    assert.equal(b.getAttribute("type"), "button");
    assert.ok(b.getAttribute("aria-label"), "every control needs a name");
  }
  const dots = [...page.document.querySelectorAll(".hero-dot")];
  assert.equal(dots[0].getAttribute("aria-label"), "Show image 1 of " + n);
});
