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

// desk-view.js — the infinite desk's DOM shell: a fixed `.desk-viewport` that
// clips one `.desk-surface` child carrying the camera transform. All camera
// math lives in desk/desk-geometry.js; this component only translates DOM
// events (pointer-capture drags, wheel/pinch) into camera changes and applies
// the resulting transform + grid background. Pan/zoom never re-renders or
// re-lays-out surface children — only the transform and the viewport's grid
// background mutate.

import {
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

/** Pointer travel (px) below which a press stays a click, not a pan. */
const DRAG_THRESHOLD = 4;

export class DeskView {
  #viewport;
  #surface;
  #camera;
  #onViewportChange;
  #size = { width: 0, height: 0 };
  #resizeObserver;
  // Active pan: { pointerId, lastX, lastY, startX, startY, active }.
  #drag = null;

  /**
   * @param {HTMLElement} viewport - the `.desk-viewport` element to own.
   * @param {object} [opts]
   * @param {object} [opts.camera] - initial `{ cx, cy, zoom }` (persisted
   *   values are normalized, so junk falls back to the origin at 100%).
   * @param {(camera: object) => void} [opts.onViewportChange] - constructor
   *   callback fired after every camera change (pan step, zoom, setCamera).
   */
  constructor(viewport, { camera, onViewportChange } = {}) {
    this.#viewport = viewport;
    this.#camera = normalizeCamera(camera);
    this.#onViewportChange = onViewportChange;

    this.#surface = document.createElement("div");
    this.#surface.className = "desk-surface";
    // First child, so overlay siblings (hint, zoom cluster, HUD) stay on top.
    viewport.prepend(this.#surface);

    viewport.addEventListener("pointerdown", this.#onPointerDown);
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

  zoomIn() {
    this.#zoomAtCenter(stepZoom(this.#camera.zoom, 1));
  }

  zoomOut() {
    this.#zoomAtCenter(stepZoom(this.#camera.zoom, -1));
  }

  resetZoom() {
    this.#zoomAtCenter(1);
  }

  /** Zoom all the way out to the floor (5%) — a fast way to spot a lost
      component without recentering the camera, unlike fitToScreen(). */
  zoomOutFull() {
    this.#zoomAtCenter(ZOOM_MIN);
  }

  dispose() {
    this.#endPan();
    this.#viewport.removeEventListener("pointerdown", this.#onPointerDown);
    this.#viewport.removeEventListener("wheel", this.#onWheel);
    this.#resizeObserver.disconnect();
    this.#surface.remove();
  }

  // ── Pointer pan (capture + 4 px threshold; never HTML5 DnD) ───────────────

  #onPointerDown = (e) => {
    if (this.#drag) return;
    // Shift-left-drag is the controller's marquee selection, never a pan.
    if (e.button === 0 && e.shiftKey) return;
    const emptyDesk = e.target === this.#viewport || e.target === this.#surface;
    // Left-drag pans only from empty desk (overlays keep their own clicks);
    // middle-drag pans from anywhere, immediately (no click meaning to keep).
    if (e.button === 0 && !emptyDesk) return;
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault(); // suppress autoscroll

    this.#drag = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      active: e.button === 1,
    };
    if (this.#drag.active) this.#markPanning(true);
    try {
      this.#viewport.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (e.g. synthetic events) */
    }
    this.#viewport.addEventListener("pointermove", this.#onPointerMove);
    this.#viewport.addEventListener("pointerup", this.#onPointerUp);
    this.#viewport.addEventListener("pointercancel", this.#onPointerUp);
  };

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
    try {
      this.#viewport.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }
    this.#viewport.removeEventListener("pointermove", this.#onPointerMove);
    this.#viewport.removeEventListener("pointerup", this.#onPointerUp);
    this.#viewport.removeEventListener("pointercancel", this.#onPointerUp);
  }

  #markPanning(on) {
    this.#viewport.classList.toggle("desk-viewport--panning", on);
  }

  // ── Wheel: plain scroll pans; ctrl/cmd-wheel and pinch zoom at the cursor ──

  #onWheel = (e) => {
    e.preventDefault();
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

    const grid = gridForCamera(this.#camera, this.#size, t);
    if (grid.visible) {
      this.#viewport.style.backgroundImage = ""; // restore the CSS dot tile
      this.#viewport.style.backgroundSize = `${grid.spacing}px ${grid.spacing}px`;
      this.#viewport.style.backgroundPosition = `${grid.offsetX}px ${grid.offsetY}px`;
    } else {
      this.#viewport.style.backgroundImage = "none";
    }
  }

  #emit() {
    this.#onViewportChange?.(this.camera);
  }
}
