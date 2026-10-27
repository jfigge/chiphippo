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

// desk-view.js — the infinite desk's DOM shell: a fixed `.desk-viewport` that
// clips one `.desk-surface` child carrying the camera transform. All camera
// math lives in desk/desk-geometry.js; this component only translates DOM
// events (pointer-capture drags, wheel/pinch) into camera changes and applies
// the resulting transform + grid background. Pan/zoom never re-renders or
// re-lays-out surface children — only the transform and the viewport's grid
// background mutate.

import {
  finePercentZoom,
  gridForCamera,
  normalizeCamera,
  panBy,
  roundTransform,
  screenToWorld,
  stepZoom,
  surfaceTransform,
  wheelZoom,
  zoomAboutPoint,
  ZOOM_MIN,
} from "../desk/desk-geometry.js";
import { beginPointerGesture } from "./pointer-gesture.js";

/** Pointer travel (px) below which a press stays a click, not a pan. */
const DRAG_THRESHOLD = 4;

/** How long the zoom must hold still before the surface is re-rasterized at
    it (#scheduleReraster) — long enough that a wheel or pinch stream, an
    event every frame or so, re-rasters once at its end and not per step. */
const RERASTER_SETTLE_MS = 200;

/** Below this zoom the desk's small print is hidden (`desk-viewport--far`,
    app.css). Every board and part label is ≤ 1.2 pitch, so at half scale the
    largest is 6 screen px and the commonest (a chip's 0.8, a board's 0.6 row
    and column numbers) 3–4 px — a smear, not text — while every zoom step
    re-laid-out ~1.8k of them (busy32). 100 % and anything readable are
    untouched. */
export const SMALL_PRINT_ZOOM = 0.5;

/** The next animation frame — or a timer where there is none (a test DOM). */
const nextFrame = (fn) =>
  globalThis.requestAnimationFrame?.(fn) ?? setTimeout(fn, 16);
const cancelFrame = (id) =>
  globalThis.cancelAnimationFrame ? cancelAnimationFrame(id) : clearTimeout(id);

export class DeskView {
  #viewport;
  #surface;
  #camera;
  #onViewportChange;
  #size = { width: 0, height: 0 };
  #resizeObserver;
  // The desk padlock (components/desk-lock.js) shut: the wheel stops moving the
  // camera. Every other route still works — see setWheelLocked.
  #wheelLocked = false;
  // Active pan: { pointerId, lastX, lastY, startX, startY, active, teardown }.
  #drag = null;
  // Whether a plain left-drag on EMPTY desk pans. The schematic keeps that;
  // the breadboard does not — there a drag on the background is the
  // rubber-band select, and the pan lives on Space-drag and the middle button
  // (see CLAUDE.md → "Selection").
  #panOnEmptyDrag = true;
  // Space is held: a left-drag ANYWHERE pans, ahead of whatever is under the
  // pointer (set by app.js, which owns the key — it is also Run/Stop).
  #spaceHeld = false;
  // A Space-drag pan happened during the current hold, so the Space's release
  // is not a tap (app.js reads and clears it: a tap runs the circuit).
  #spacePanned = false;
  // The scale the surface's compositor layer was last rasterized at, and the
  // pending settle timer / animation frame that re-rasters it at a new one
  // (see #scheduleReraster).
  #rasterScale = null;
  #rerasterTimer = 0;
  #rerasterFrame = 0;
  // Whether the small print is hidden (zoom below SMALL_PRINT_ZOOM), so the
  // class is written only when the zoom crosses it.
  #far = null;

  /**
   * @param {HTMLElement} viewport - the `.desk-viewport` element to own.
   * @param {object} [opts]
   * @param {object} [opts.camera] - initial `{ cx, cy, zoom }` (persisted
   *   values are normalized, so junk falls back to the origin at 100%).
   * @param {(camera: object) => void} [opts.onViewportChange] - constructor
   *   callback fired after every camera change (pan step, zoom, setCamera).
   * @param {boolean} [opts.panOnEmptyDrag] - a plain left-drag on empty desk
   *   pans (default). The breadboard passes false: there that drag is the
   *   rubber-band select, and panning is Space-drag or the middle button.
   */
  constructor(
    viewport,
    { camera, onViewportChange, panOnEmptyDrag = true } = {},
  ) {
    this.#viewport = viewport;
    this.#camera = normalizeCamera(camera);
    this.#onViewportChange = onViewportChange;
    this.#panOnEmptyDrag = panOnEmptyDrag;

    this.#surface = document.createElement("div");
    this.#surface.className = "desk-surface";
    // First child, so overlay siblings (hint, zoom cluster, HUD) stay on top.
    viewport.prepend(this.#surface);

    viewport.addEventListener("pointerdown", this.#onPointerDown);
    // Space-drag is claimed in the CAPTURE phase, ahead of the part, board and
    // wire listeners below it: with Space down a press anywhere is a pan, never
    // a grab of whatever happens to be under the pointer.
    viewport.addEventListener("pointerdown", this.#onSpacePointerDown, true);
    viewport.addEventListener("wheel", this.#onWheel, { passive: false });

    const rect = viewport.getBoundingClientRect();
    this.#size = { width: rect.width, height: rect.height };
    this.#resizeObserver = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) this.#size = { width: box.width, height: box.height };
      this.#apply(true); // camera unchanged — keep its center centered
    });
    this.#resizeObserver.observe(viewport);

    this.#apply(true);
  }

  /** A snapshot of the current camera. */
  get camera() {
    return { ...this.#camera };
  }

  /**
   * The world container element. DeskController mounts its layers (boards /
   * parts / wires / overlay) here; children position in world px.
   */
  get surface() {
    return this.#surface;
  }

  /** Replace the camera wholesale (normalized), e.g. a restored viewport. */
  setCamera(camera) {
    this.#camera = normalizeCamera(camera);
    this.#apply(true);
    this.#emit();
  }

  /** The world point (units) under a pointer/mouse event. */
  worldFromEvent(event) {
    const rect = this.#viewport.getBoundingClientRect();
    return screenToWorld(
      this.#camera,
      { width: rect.width, height: rect.height },
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
    );
  }

  /** @param {{fine?: boolean}} [opts] `fine` steps the readout by ONE percentage
      point (Option-clicking the zoom cluster) instead of one exponential step. */
  zoomIn({ fine = false } = {}) {
    const z = this.#camera.zoom;
    this.#zoomAtCenter(fine ? finePercentZoom(z, 1) : stepZoom(z, 1));
  }

  /** @param {{fine?: boolean}} [opts] see zoomIn(). */
  zoomOut({ fine = false } = {}) {
    const z = this.#camera.zoom;
    this.#zoomAtCenter(fine ? finePercentZoom(z, -1) : stepZoom(z, -1));
  }

  resetZoom() {
    this.#zoomAtCenter(1);
  }

  /** Zoom all the way out to the floor (5%) — a fast way to spot a lost
      component without recentering the camera, unlike fitToScreen(). */
  zoomOutFull() {
    this.#zoomAtCenter(ZOOM_MIN);
  }

  /**
   * Space is down (or up) — pushed in by app.js, which owns the key because a
   * TAP of it is also Run/Stop. While it is held a left-drag anywhere pans and
   * the viewport shows the open hand. Dropping it ends no pan already under
   * way: a drag finishes on its own release.
   */
  setSpaceHeld(on) {
    const next = Boolean(on);
    if (next === this.#spaceHeld) return;
    this.#spaceHeld = next;
    if (next) this.#spacePanned = false;
    this.#viewport.classList.toggle("desk-viewport--pan-ready", next);
  }

  /** Did a Space-drag pan happen during the hold just ended? Reading it
      clears it — app.js asks once, at the Space's release, to tell a tap
      (Run/Stop) from a hold (pan). */
  takeSpacePanned() {
    const panned = this.#spacePanned;
    this.#spacePanned = false;
    return panned;
  }

  dispose() {
    this.#endPan();
    clearTimeout(this.#rerasterTimer);
    cancelFrame(this.#rerasterFrame);
    this.#viewport.removeEventListener("pointerdown", this.#onSpacePointerDown, true); // prettier-ignore
    this.#viewport.removeEventListener("pointerdown", this.#onPointerDown);
    this.#viewport.removeEventListener("wheel", this.#onWheel);
    this.#resizeObserver.disconnect();
    this.#surface.remove();
  }

  // ── Pointer pan (capture + 4 px threshold; never HTML5 DnD) ───────────────

  /** Space held + left press, anywhere on the viewport: a pan, claimed
      before anything under the pointer hears of the press. */
  #onSpacePointerDown = (e) => {
    if (!this.#spaceHeld || e.button !== 0 || this.#drag) return;
    // Only presses on the desk itself — the zoom cluster, padlock and rails
    // sit inside the viewport too and keep their own clicks.
    if (!this.#surface.contains(e.target) && e.target !== this.#viewport) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    this.#beginPan(e, true);
  };

  #onPointerDown = (e) => {
    if (this.#drag) return;
    const emptyDesk = e.target === this.#viewport || e.target === this.#surface;
    // Left-drag pans only from empty desk (overlays keep their own clicks),
    // and only where that drag means nothing else (the schematic; on the
    // breadboard it is the rubber band). Middle-drag pans from anywhere,
    // immediately (no click meaning to keep).
    if (e.button === 0 && !(emptyDesk && this.#panOnEmptyDrag)) return;
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault(); // suppress autoscroll
    this.#beginPan(e, e.button === 1);
  };

  /**
   * Pan from a press someone else claimed — an Option/Alt press that found no
   * lead to pick (DeskController's pin-targeting mode): a drag past the
   * click threshold pans, a click does nothing. Whether it began one.
   * @param {PointerEvent} e
   */
  beginPan(e) {
    if (this.#drag || e.button !== 0) return false;
    this.#beginPan(e, false);
    return true;
  }

  /** Start a pan gesture; `immediate` skips the click-vs-drag threshold. */
  #beginPan(e, immediate) {
    this.#drag = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      active: immediate,
    };
    if (this.#spaceHeld) this.#spacePanned = true;
    if (this.#drag.active) this.#markPanning(true);
    // The one plumbing every desk drag uses (pointer-gesture.js): the release
    // is heard on the window whether or not the capture held, and a capture
    // yanked away (the window losing focus mid-drag) ends it — listening on
    // the viewport alone left a pan that missed its pointerup panning on
    // under a bare hover.
    this.#drag.teardown = beginPointerGesture(this.#viewport, e.pointerId, {
      onMove: this.#onPointerMove,
      onEnd: this.#onPointerUp,
    });
  }

  #onPointerMove = (e) => {
    const d = this.#drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      if (
        Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD
      ) {
        return;
      }
      d.active = true;
      this.#markPanning(true);
    }
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    this.#camera = panBy(this.#camera, dx, dy);
    this.#apply(false); // mid-drag: unrounded for buttery motion
    this.#emit();
  };

  #onPointerUp = (e) => {
    const d = this.#drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.#endPan();
    this.#apply(true); // settle on whole device pixels
  };

  #endPan() {
    const d = this.#drag;
    if (!d) return;
    this.#drag = null;
    this.#markPanning(false);
    d.teardown?.();
  }

  #markPanning(on) {
    this.#viewport.classList.toggle("desk-viewport--panning", on);
  }

  /**
   * Lock the WHEEL out of the camera, or let it back in — what the desk's
   * padlock toggles (components/desk-lock.js).
   *
   * It is deliberately the one INPUT and not the camera: drag-to-pan, the zoom
   * cluster, the keyboard and Fit all still move the desk while it is locked.
   * The reason is a Magic Mouse, whose touch surface reports a scroll from a
   * finger merely resting on it, so the wheel is the one input that moves the
   * desk without having been asked to.
   *
   * @param {boolean} on
   */
  setWheelLocked(on) {
    this.#wheelLocked = on === true;
  }

  // ── Wheel: plain scroll pans; ctrl/cmd-wheel and pinch zoom at the cursor ──

  #onWheel = (e) => {
    // preventDefault FIRST, locked or not: what the wheel must not do while the
    // desk is locked is drift the camera, not fall through to whatever the
    // browser would otherwise make of it (ctrl+wheel is page zoom).
    e.preventDefault();
    if (this.#wheelLocked) return;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as a ctrlKey wheel stream in Chromium.
      const rect = this.#viewport.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this.#camera = zoomAboutPoint(
        this.#camera,
        this.#size,
        anchor,
        wheelZoom(this.#camera.zoom, e.deltaY),
      );
    } else {
      // Two-finger scroll / wheel pans; shift maps a vertical wheel sideways.
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
      this.#camera = panBy(this.#camera, -dx, -dy);
    }
    this.#apply(true);
    this.#emit();
  };

  // ── Camera application ─────────────────────────────────────────────────────

  #zoomAtCenter(zoom) {
    const anchor = { x: this.#size.width / 2, y: this.#size.height / 2 };
    this.#camera = zoomAboutPoint(this.#camera, this.#size, anchor, zoom);
    this.#apply(true);
    this.#emit();
  }

  #apply(atRest) {
    let t = surfaceTransform(this.#camera, this.#size);
    if (atRest) t = roundTransform(t, window.devicePixelRatio);
    this.#surface.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`;
    // The first apply is the scale the layer is created at; after that, a
    // pan, a resize and the at-rest rounding leave the scale alone.
    this.#rasterScale ??= t.scale;
    if (t.scale !== this.#rasterScale) this.#scheduleReraster(t.scale);
    const far = this.#camera.zoom < SMALL_PRINT_ZOOM;
    if (far !== this.#far) {
      this.#far = far;
      this.#viewport.classList.toggle("desk-viewport--far", far);
    }

    const grid = gridForCamera(this.#camera, this.#size, t);
    if (grid.visible) {
      this.#viewport.style.backgroundImage = ""; // restore the CSS dot tile
      this.#viewport.style.backgroundSize = `${grid.spacing}px ${grid.spacing}px`;
      this.#viewport.style.backgroundPosition = `${grid.offsetX}px ${grid.offsetY}px`;
    } else {
      this.#viewport.style.backgroundImage = "none";
    }
  }

  /**
   * Re-raster the surface at a new zoom, once the zoom has settled.
   *
   * `.desk-surface` carries `will-change: transform`, which is what makes a pan
   * or a pinch cheap: the compositor moves and scales the bitmap it already
   * has instead of repainting the desk every frame. The price is that Chromium
   * then KEEPS that bitmap's resolution through a scale change (cc's
   * `ShouldAdjustRasterScale` holds a will-change layer's raster scale while it
   * is at least the device's), so after zooming in the desk is the old pixels
   * stretched — the small print on the parts (a pot's value, a TO-220's part
   * number, its 3 px pin letters) reads as a blurred image. Dropping the hint
   * for ONE painted frame lets the layer go and come back rasterized at the
   * scale on screen. Two frames, not one: a single requestAnimationFrame runs
   * BEFORE the frame that would paint `auto`, so the toggle would be undone
   * before anything saw it. Neither removing the hint for good (every pan
   * frame would repaint the desk) nor this toggle may be tidied away.
   */
  #scheduleReraster(scale) {
    clearTimeout(this.#rerasterTimer);
    this.#rerasterTimer = setTimeout(() => {
      this.#rerasterTimer = 0;
      cancelFrame(this.#rerasterFrame);
      this.#surface.style.willChange = "auto";
      this.#rerasterFrame = nextFrame(() => {
        this.#rerasterFrame = nextFrame(() => {
          this.#rerasterFrame = 0;
          this.#surface.style.willChange = ""; // the stylesheet's hint again
          this.#rasterScale = scale;
        });
      });
    }, RERASTER_SETTLE_MS);
  }

  #emit() {
    this.#onViewportChange?.(this.camera);
  }
}
