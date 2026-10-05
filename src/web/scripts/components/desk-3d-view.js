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

// desk-3d-view.js — the 3D VIEW: the active desktop's breadboards, parts and
// wiring stood up in three dimensions, to orbit round and look at. The
// toolbar's cube segment swaps it in for the desk exactly as the schematic is
// swapped in (app.js's `setMode`); the app always opens on the breadboard.
//
// It is a PROJECTION, like the schematic: it reads the same DeskDoc, stores
// nothing, and edits nothing — editing stays on the breadboard. The scene is
// rebuilt from the document on `chiphippo:doc-changed` / `:part-state` (only
// while showing; a hidden view just remembers it is stale), and the live
// simulation only recolours its lamps and repaints its LCD glass from
// `chiphippo:sim-state` — never by asking the engine, and never deciding a
// lamp for itself: an LED or segment shows the verdict the desk's own
// SimOverlay reached (`ledOf` / `segmentOf`), so the two views cannot disagree.
//
// Drawing is on demand — one frame per change, coalesced into the next
// animation frame — so a 3D view nobody is moving costs nothing, and a hidden
// one costs nothing at all.
//
// Gestures (the usual 3D viewer's, so a hand that knows one knows this):
// drag to orbit; right-, middle- or Shift-drag to pan; scroll or pinch to
// zoom; double-click to frame the desk. The desk padlock (⌘L) locks the wheel
// here too, for the Magic Mouse reason it does on the desk.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { readPalette } from "../scene3d/palette.js";
import { buildScene, groundMesh, lampState } from "../scene3d/scene.js";
import {
  DEFAULT_CAMERA,
  eyeOf,
  fitBounds,
  normalizeCamera,
  orbitBy,
  panBy,
  viewProjection,
  wheelFactor,
  zoomBy,
} from "../scene3d/orbit-camera.js";
import { GlRenderer } from "./gl-renderer.js";
import { beginPointerGesture } from "./pointer-gesture.js";

/** Pointer travel (px) below which a press is a click, not a drag. */
const DRAG_THRESHOLD = 3;

/** How bright a lit lamp glows: 1 ignores the light entirely. */
const LIT_GLOW = 0.85;

/** One zoom-cluster step (⌥⌘= / ⌥⌘−), as a dolly factor. */
const ZOOM_STEP = 1.25;

/** The next animation frame — or a timer where there is none (a test DOM). */
const nextFrame = (fn) =>
  globalThis.requestAnimationFrame?.(fn) ?? setTimeout(fn, 16);
const cancelFrame = (id) =>
  globalThis.cancelAnimationFrame ? cancelAnimationFrame(id) : clearTimeout(id);

export class Desk3DView {
  #viewport;
  #canvas;
  #hint;
  #fallback;
  #renderer = null; // made on first show — see #ensureRenderer
  #doc;
  #ledOf;
  #segmentOf;
  #camera = normalizeCamera(DEFAULT_CAMERA);
  #scene = null;
  #stale = true; // the document changed since the scene was built
  #fitPending = true; // frame the desk on the next draw
  #visible = false;
  #frame = 0;
  #sim = null; // the last sim-state's detail
  #screenKeys = [];
  #drawnLive = null; // #liveKey() as of the last frame drawn
  #drag = null;
  #endGesture = null; // the live drag's pointer-gesture teardown
  #wheelLocked = false;
  #resizeObserver;
  #darkQuery = null;
  #listeners = [];

  /**
   * @param {HTMLElement} viewport - the `.desk3d-viewport` section to fill
   * @param {object} opts
   * @param {import("../model/desk-doc.js").DeskDoc} opts.doc
   * @param {(id: string) => object|null} opts.ledOf - the desk's LED verdict
   * @param {(id: string, seg: string) => object|null} opts.segmentOf
   */
  constructor(viewport, { doc, ledOf, segmentOf }) {
    this.#viewport = viewport;
    this.#doc = doc;
    this.#ledOf = ledOf;
    this.#segmentOf = segmentOf;

    this.#canvas = el("canvas", { class: "desk3d-canvas" });
    this.#hint = el("div", { class: "desk3d-hint", text: t("view3d.hint") });
    this.#fallback = el("div", {
      class: "desk3d-fallback",
      text: t("view3d.unsupported"),
      hidden: true,
    });
    viewport.append(this.#canvas, this.#hint, this.#fallback);

    const stale = () => {
      this.#stale = true;
      this.#schedule();
    };
    this.#listen(window, "chiphippo:doc-changed", stale);
    this.#listen(window, "chiphippo:part-state", stale);
    this.#listen(window, "chiphippo:sim-state", (e) => {
      this.#sim = e.detail ?? null;
      // Hidden, the detail is all that is wanted: the frame drawn on showing
      // reads it. Showing, a running circuit publishes every tick and most
      // ticks change no lamp and no glass — only a change is worth a frame.
      if (!this.#visible) return;
      if (this.#scene && !this.#stale && this.#liveKey() === this.#drawnLive) {
        return;
      }
      this.#schedule();
    });
    // The colours are the theme's: a light/dark flip rebuilds in the new ones.
    this.#darkQuery =
      window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    if (this.#darkQuery) this.#listen(this.#darkQuery, "change", stale);

    this.#listen(this.#canvas, "pointerdown", this.#onPointerDown);
    this.#listen(this.#canvas, "wheel", this.#onWheel, { passive: false });
    this.#listen(this.#canvas, "dblclick", () => this.fit());
    this.#listen(this.#canvas, "contextmenu", (e) => e.preventDefault());

    this.#resizeObserver = new ResizeObserver(() => this.#schedule());
    this.#resizeObserver.observe(viewport);
  }

  /** A snapshot of the camera (scene3d/orbit-camera.js's shape). */
  get camera() {
    return structuredClone(this.#camera);
  }

  /** Replace the camera wholesale (normalized). */
  setCamera(camera) {
    this.#fitPending = false;
    this.#setCamera(camera);
  }

  /** Whether the 3D view is the one on screen. */
  get visible() {
    return this.#visible;
  }

  /** Show or hide the view. Shown, it catches up on whatever changed while
      it was hidden — and frames the desk the first time. */
  setVisible(on) {
    this.#visible = on === true;
    this.#viewport.hidden = !this.#visible;
    if (this.#visible) {
      this.#ensureRenderer();
      this.#schedule();
    } else {
      this.#endDrag();
    }
  }

  /** Frame the desk on the next draw — a newly loaded or switched-to desktop
      is a different circuit, possibly somewhere else entirely. */
  frameNext() {
    this.#fitPending = true;
    this.#stale = true;
    this.#schedule();
  }

  /** Frame everything on the desk (Fit, ⌘F, a double-click). */
  fit() {
    this.#fitPending = true;
    this.#schedule();
  }

  zoomIn() {
    this.#setCamera(zoomBy(this.#camera, 1 / ZOOM_STEP));
  }

  zoomOut() {
    this.#setCamera(zoomBy(this.#camera, ZOOM_STEP));
  }

  /** "Actual size" has no meaning in perspective; reset is a fresh frame. */
  resetZoom() {
    this.fit();
  }

  /** Back right off — the whole desk small in the middle (⇧⌘F). */
  zoomOutFull() {
    this.#refreshScene();
    const framed = fitBounds(
      this.#camera,
      this.#scene?.bounds ?? null,
      this.#aspect(),
      {
        keepPitch: true,
      },
    );
    this.#setCamera(zoomBy(framed, 3));
  }

  /** The padlock: shut, the wheel stops moving the camera (DeskView's rule). */
  setWheelLocked(on) {
    this.#wheelLocked = on === true;
  }

  /** Re-label in a new language (app.js's relabelChrome). */
  relocalize() {
    this.#hint.textContent = t("view3d.hint");
    this.#fallback.textContent = t("view3d.unsupported");
  }

  dispose() {
    cancelFrame(this.#frame);
    this.#endDrag();
    for (const [target, type, fn, opts] of this.#listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this.#listeners = [];
    this.#resizeObserver.disconnect();
    this.#renderer?.dispose();
    this.#canvas.remove();
    this.#hint.remove();
    this.#fallback.remove();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  /**
   * The WebGL renderer, made the first time the view is SHOWN rather than at
   * boot: the setting is off by default, a WebGL context is GPU memory a user
   * who never opens the view should not pay for, and a GPU that refuses one
   * must never be able to touch startup. No WebGL → the fallback sentence.
   */
  #ensureRenderer() {
    if (this.#renderer) return;
    const style = getComputedStyle(document.documentElement);
    this.#renderer = new GlRenderer(this.#canvas, {
      fonts: {
        sans: style.getPropertyValue("--font-sans").trim() || "sans-serif",
        mono: style.getPropertyValue("--font-mono").trim() || "monospace",
      },
      // A lost context comes back empty-handed: the renderer re-uploads the
      // scene, and the view forgets what it last painted so it paints again.
      onRestored: () => {
        this.#screenKeys = this.#screenKeys.map(() => undefined);
        this.#drawnLive = null;
        this.#schedule();
      },
    });
    // Anything built before there was a renderer never reached the GPU.
    this.#stale = true;
    const ok = this.#renderer.supported;
    this.#fallback.hidden = ok;
    this.#hint.hidden = !ok;
    this.#canvas.hidden = !ok;
  }

  #listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.#listeners.push([target, type, fn, opts]);
  }

  #setCamera(camera) {
    this.#camera = normalizeCamera(camera);
    this.#schedule();
  }

  /** Coalesce everything that wants a frame into the next animation frame. */
  #schedule() {
    if (!this.#visible || this.#frame) return;
    this.#frame = nextFrame(() => {
      this.#frame = 0;
      this.#draw();
    });
  }

  #aspect() {
    const r = this.#viewport.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r.width / r.height : 1;
  }

  /** Rebuild the scene if the document (or the theme) moved under it. */
  #refreshScene() {
    if (!this.#stale && this.#scene) return;
    this.#stale = false;
    const palette = readPalette((token) =>
      getComputedStyle(this.#viewport).getPropertyValue(token).trim(),
    );
    const doc = this.#doc;
    const scene = buildScene(
      {
        boards: doc.boards,
        components: doc.components,
        wires: doc.wires,
        buses: doc.buses,
        signals: doc.signals,
        integrations: doc.integrations,
        annotations: doc.annotations,
      },
      palette,
    );
    for (const { id, error } of scene.errors) {
      console.error(`[renderer] 3D view could not model ${id}:`, error);
    }
    this.#scene = { ...scene, palette };
    this.#screenKeys = scene.screens.map(() => undefined);
    this.#renderer?.setScene(scene, groundMesh(scene.bounds, palette));
  }

  #draw() {
    if (!this.#visible || !this.#renderer?.supported) return;
    const rect = this.#viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.#refreshScene();
    if (this.#fitPending && this.#scene) {
      this.#fitPending = false;
      this.#camera = fitBounds(
        this.#camera,
        this.#scene.bounds,
        rect.width / rect.height,
      );
    }
    this.#applyLive();
    this.#renderer.resize(
      rect.width,
      rect.height,
      window.devicePixelRatio || 1,
    );
    this.#renderer.render(
      viewProjection(this.#camera, rect.width / rect.height),
      eyeOf(this.#camera),
      this.#scene.palette.base,
    );
  }

  /** What the last sim-state asks the lamps and glass to show. */
  #live() {
    const sim = this.#sim;
    return {
      running: sim?.running === true,
      ledOf: this.#ledOf,
      segmentOf: this.#segmentOf,
      clockLevels: sim?.clockLevels,
      channels: sim?.channels,
    };
  }

  /** The framebuffer screen `screen` shows on the last sim-state, or null. */
  #framebuffer(screen, live) {
    return live.running
      ? (this.#sim?.displayState?.get(screen.compId) ?? null)
      : null;
  }

  /** Every lamp's state and every screen's contents as one string — equal
      to the last frame's means a frame would draw nothing new. */
  #liveKey() {
    const live = this.#live();
    const code = { on: "1", off: "0", burnt: "x" };
    const lamps = this.#scene.lamps.map((lamp) => code[lampState(lamp, live)]);
    const glass = this.#scene.screens.map((s) =>
      framebufferKey(this.#framebuffer(s, live)),
    );
    return `${lamps.join("")}#${glass.join("#")}`;
  }

  /** Light the lamps and paint the glass from the last sim-state. */
  #applyLive() {
    const live = this.#live();
    this.#scene.lamps.forEach((lamp, i) => {
      const state = lampState(lamp, live);
      if (state === "on") this.#renderer.setLamp(i, lamp.on, LIT_GLOW);
      else if (state === "burnt") this.#renderer.setLamp(i, lamp.burnt, 0);
      else this.#renderer.setLamp(i, lamp.off, 0);
    });
    this.#scene.screens.forEach((screen, i) => {
      const fb = this.#framebuffer(screen, live);
      const key = framebufferKey(fb);
      if (key === this.#screenKeys[i]) return;
      this.#screenKeys[i] = key;
      this.#renderer.paintScreen(i, fb);
    });
    this.#drawnLive = this.#liveKey();
  }

  // ── Gestures ──────────────────────────────────────────────────────────────

  #onPointerDown = (e) => {
    if (this.#drag) return;
    const pan =
      e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
    if (e.button !== 0 && !pan) return;
    if (e.button === 1) e.preventDefault(); // no autoscroll
    this.#drag = {
      id: e.pointerId,
      pan,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    // The app's one drag plumbing (pointer-gesture.js): window listeners in
    // the capture phase, so a release lands whether or not the capture held,
    // and a yanked capture or a lost window focus end the drag too.
    this.#endGesture = beginPointerGesture(this.#canvas, e.pointerId, {
      onMove: this.#onPointerMove,
      onEnd: this.#onPointerUp,
    });
  };

  #onPointerMove = (e) => {
    const d = this.#drag;
    if (!d || e.pointerId !== d.id) return;
    // Every button already up is a release this drag never heard about.
    if (typeof e.buttons === "number" && (e.buttons & 7) === 0) {
      this.#endDrag();
      return;
    }
    if (!d.active) {
      if (
        Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD
      ) {
        return;
      }
      d.active = true;
      this.#viewport.classList.add("desk3d-viewport--dragging");
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    const height = this.#viewport.getBoundingClientRect().height;
    this.#setCamera(
      d.pan
        ? panBy(this.#camera, dx, dy, height)
        : orbitBy(this.#camera, dx, dy),
    );
  };

  #onPointerUp = (e) => {
    if (!this.#drag || (e.pointerId != null && e.pointerId !== this.#drag.id))
      return;
    this.#endDrag();
  };

  #endDrag() {
    if (!this.#drag) return;
    this.#drag = null;
    this.#viewport.classList.remove("desk3d-viewport--dragging");
    const end = this.#endGesture;
    this.#endGesture = null;
    end?.();
  }

  #onWheel = (e) => {
    // preventDefault first, locked or not — ctrl+wheel must never fall
    // through to the page's own zoom (DeskView's rule).
    e.preventDefault();
    if (this.#wheelLocked) return;
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this.#setCamera(zoomBy(this.#camera, wheelFactor(e.deltaY * lines)));
  };
}

/** What a framebuffer looks like, as a string — a repaint happens only when
    it changes (a running LCD republishes every tick). */
function framebufferKey(fb) {
  if (!fb || !fb.displayOn) return "blank";
  const c = fb.cursor;
  return `${fb.cols}x${fb.rows}|${c?.on ? `${c.row},${c.col}` : "-"}|${fb.chars.join(",")}|${
    fb.cgram ? Array.from(fb.cgram).join(",") : ""
  }`;
}
