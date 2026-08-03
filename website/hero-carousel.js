/* Chip Hippo website — hero image carousel.
 *
 * The slide list in index.html is the whole manifest: every <img class="hero-slide">
 * inside .hero-track is a slide, in order. This script measures them, sizes the
 * frame, and adds the controls — so with one slide (or with JS off) the page is
 * exactly the static screenshot it has always been, and adding an image is one
 * <img> line and nothing else.
 *
 * Sizing: the frame is as wide as the WIDEST slide and as tall as the TALLEST
 * one, so it never resizes as slides advance. Each image then keeps its own
 * scale relative to that box and is centred in it — a narrow slide stays narrow
 * rather than being blown up to fill.
 *
 * The page's CSP is script-src 'self', so this rides as its own file (see the
 * meta tag in index.html); there are no inline handlers anywhere below. */
(function () {
  "use strict";

  var ADVANCE_MS = 6000;
  var SWIPE_PX = 40;

  var CHEVRON =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="POINTS"/></svg>';

  function reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      return false;
    }
  }

  var carousel = document.querySelector(".hero-carousel");
  if (!carousel) return;

  var track = carousel.querySelector(".hero-track");
  var slides = [].slice.call(carousel.querySelectorAll(".hero-slide"));
  if (!track || slides.length < 2) return; // Nothing to advance to.

  // Give every slide a full-frame cell of its own: the track then steps by
  // exactly one frame, while the image inside is free to be smaller than the
  // frame and centred in it.
  for (var c = 0; c < slides.length; c++) {
    var cell = document.createElement("div");
    cell.className = "hero-cell";
    track.insertBefore(cell, slides[c]);
    cell.appendChild(slides[c]);
  }

  var index = 0;
  var timer = null;
  var stopped = false; // The visitor took control; never auto-advance again.
  var hovered = false;
  var focused = false;

  // ── Frame ────────────────────────────────────────────────────────────────
  // Prefer the width/height attributes (known before the images load, so the
  // frame is right from the first paint), and re-measure from the decoded image
  // for any slide that shipped without them.

  function dims(img) {
    var w = parseInt(img.getAttribute("width"), 10) || img.naturalWidth || 0;
    var h = parseInt(img.getAttribute("height"), 10) || img.naturalHeight || 0;
    return { w: w, h: h };
  }

  function measure() {
    var maxW = 0;
    var maxH = 0;
    var i;
    var d = [];
    for (i = 0; i < slides.length; i++) {
      d[i] = dims(slides[i]);
      if (d[i].w > maxW) maxW = d[i].w;
      if (d[i].h > maxH) maxH = d[i].h;
    }
    if (!maxW || !maxH) return;

    carousel.style.setProperty("--hero-max-w", maxW + "px");
    carousel.style.setProperty("--hero-ratio", maxW + " / " + maxH);

    // Each image at its own share of the frame, centred by the slide's margin.
    for (i = 0; i < slides.length; i++) {
      slides[i].style.width = d[i].w ? (d[i].w / maxW) * 100 + "%" : "";
    }
  }

  measure();
  for (var s = 0; s < slides.length; s++) {
    if (!slides[s].complete) slides[s].addEventListener("load", measure);
  }

  // ── Controls ─────────────────────────────────────────────────────────────
  // Built here rather than in the markup, so they can never be on the page
  // without a script behind them.

  function button(cls, label, points) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.setAttribute("aria-label", label);
    b.innerHTML = CHEVRON.replace("POINTS", points);
    return b;
  }

  var prev = button("hero-nav hero-nav--prev", "Previous image", "15 18 9 12 15 6");
  var next = button("hero-nav hero-nav--next", "Next image", "9 18 15 12 9 6");
  carousel.appendChild(prev);
  carousel.appendChild(next);

  var dotRow = document.createElement("div");
  dotRow.className = "hero-dots";
  var dots = [];
  for (var i = 0; i < slides.length; i++) {
    var dot = document.createElement("button");
    dot.type = "button";
    dot.className = "hero-dot";
    dot.setAttribute("aria-label", "Show image " + (i + 1) + " of " + slides.length);
    dotRow.appendChild(dot);
    dots.push(dot);
    (function (n) {
      dot.addEventListener("click", function () {
        take();
        go(n);
      });
    })(i);
  }

  // Under the framed screenshot, not over it — dots overlaid on a busy
  // breadboard would be unreadable.
  var frame = carousel.closest ? carousel.closest(".app-window") : null;
  if (frame && frame.parentNode) frame.parentNode.insertBefore(dotRow, frame.nextSibling);
  else carousel.appendChild(dotRow);

  // ── Moving ───────────────────────────────────────────────────────────────

  function go(n) {
    index = (n + slides.length) % slides.length;
    track.style.transform = "translateX(" + -index * 100 + "%)";
    for (var i = 0; i < slides.length; i++) {
      slides[i].setAttribute("aria-hidden", i === index ? "false" : "true");
      dots[i].setAttribute("aria-current", i === index ? "true" : "false");
      // Wake the neighbours so a lazy slide is never a blank frame.
      var near = Math.abs(i - index) <= 1 || Math.abs(i - index) === slides.length - 1;
      if (near && slides[i].loading === "lazy") slides[i].loading = "eager";
    }
  }

  // The visitor took control: stop advancing on our own (the WCAG 2.2.2 way out
  // of auto-updating content) and let a screen reader announce what they pick.
  function take() {
    stopped = true;
    pause();
    track.setAttribute("aria-live", "polite");
  }

  function play() {
    if (timer || stopped || hovered || focused || document.hidden || reducedMotion()) return;
    timer = window.setInterval(function () {
      go(index + 1);
    }, ADVANCE_MS);
  }

  function pause() {
    if (timer) window.clearInterval(timer);
    timer = null;
  }

  prev.addEventListener("click", function () {
    take();
    go(index - 1);
  });
  next.addEventListener("click", function () {
    take();
    go(index + 1);
  });

  function onKey(e) {
    if (e.key === "ArrowLeft") {
      take();
      go(index - 1);
    } else if (e.key === "ArrowRight") {
      take();
      go(index + 1);
    } else return;
    e.preventDefault();
  }
  carousel.addEventListener("keydown", onKey);
  dotRow.addEventListener("keydown", onKey);

  // Hover and focus are tracked apart: tabbing between two arrows fires
  // focusout before focusin, and a shared flag would resume the timer under a
  // pointer that never moved.
  function watch(node) {
    node.addEventListener("pointerenter", function () {
      hovered = true;
      pause();
    });
    node.addEventListener("pointerleave", function () {
      hovered = false;
      play();
    });
    node.addEventListener("focusin", function () {
      focused = true;
      pause();
    });
    node.addEventListener("focusout", function () {
      focused = false;
      play();
    });
  }
  watch(carousel);
  watch(dotRow);

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) pause();
    else play();
  });

  // Swipe — on a phone there is no hover and the arrows are small.
  var startX = null;
  carousel.addEventListener("pointerdown", function (e) {
    startX = e.clientX;
  });
  carousel.addEventListener("pointerup", function (e) {
    if (startX === null) return;
    var dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) < SWIPE_PX) return;
    take();
    go(dx < 0 ? index + 1 : index - 1);
  });
  carousel.addEventListener("pointercancel", function () {
    startX = null;
  });

  go(0);
  play();
})();
