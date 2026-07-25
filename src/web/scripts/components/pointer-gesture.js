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

// pointer-gesture.js — the event plumbing every wire/bus drag gesture shares:
// start it, get a teardown back, and be sure the RELEASE always arrives.
//
// The gestures inside the wire SVG (WireTools' endpoint + whole-wire drags,
// BusTools' whole-bus + end-handle drags) used to hang their pointermove /
// pointerup / pointercancel listeners on the SVG element itself and rely
// entirely on `setPointerCapture` to route the pointer there. That left the
// release with exactly ONE delivery route, and no backstop when it failed:
//
//   • `setPointerCapture` is best-effort — it can throw (and did, silently,
//     inside a swallowing try/catch), and the browser can yank the capture
//     mid-gesture with no up/cancel to follow;
//   • while a drag is in flight, app.css turns OFF every hit target inside
//     that SVG (`.desk-viewport--wire-dragging .bus-band-hit`,
//     `.bus-end-handle-hit`, `.wire--dragging .wire-hit`), and the SVG root's
//     own box is a token 1×1 at the world origin — so without the capture
//     nothing inside it can be hit-tested at all;
//   • so a release over the bare desk landed on `.desk-viewport`, which has
//     no gesture listener — the pointerup went nowhere, and the drag stayed
//     live with Escape as the only way out.
//
// Hence: the listeners go on `window` in the CAPTURE phase, which sees the
// release whether or not the pointer capture held, and `lostpointercapture`
// (plus the window losing focus) ends the gesture too — those are the only
// signals the browser gives for "this pointer isn't yours any more" when no
// up or cancel is coming. The capture itself is still taken, purely so the
// MOVE stream keeps flowing while the cursor wanders off the grabbed shape.

/**
 * Begin one pointer-drag gesture's plumbing; returns its teardown.
 *
 * `onEnd` receives the real `pointerup`/`pointercancel` event, or — for the
 * two "the pointer is gone and nothing else is coming" cases — a synthetic
 * `{ type: "pointercancel", pointerId }`, exactly the shape every one of
 * these handlers already treats as "tear down, revert, never commit" (the
 * same object `DeskController#cancelDragGesture` feeds them for Escape).
 *
 * The teardown is safe to call from inside `onEnd` (that is the normal path)
 * and idempotent enough to call twice — `removeEventListener` on a listener
 * that is already gone is a no-op, and the capture release is guarded.
 *
 * @param {Element} target - the element that takes the pointer capture
 * @param {number} pointerId
 * @param {{onMove: (e: PointerEvent) => void, onEnd: (e: {type: string, pointerId: number}) => void}} handlers
 * @returns {() => void} teardown
 */
export function beginPointerGesture(target, pointerId, { onMove, onEnd }) {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    /* best-effort — the window listeners below don't depend on it */
  }
  const abort = () => onEnd({ type: "pointercancel", pointerId });
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onEnd, true);
  window.addEventListener("pointercancel", onEnd, true);
  // Fires on a normal release too, AFTER pointerup — by then the gesture has
  // already torn down, so this only ever bites when the capture was yanked
  // with no up/cancel behind it.
  target.addEventListener("lostpointercapture", abort);
  window.addEventListener("blur", abort);
  return () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onEnd, true);
    window.removeEventListener("pointercancel", onEnd, true);
    target.removeEventListener("lostpointercapture", abort);
    window.removeEventListener("blur", abort);
    try {
      target.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
  };
}

/**
 * The world point a release actually happened at — the other half of not
 * missing a drop. Every one of these gestures used to commit whatever its
 * last `pointermove` had resolved, but the move stream is coalesced (and a
 * costly per-move preview can fall behind the cursor outright), so that
 * sample can be several frames stale: a drop then lands at a delta the user
 * had already moved past, or, if that stale sample sat somewhere illegal,
 * silently doesn't land at all. Resolving from the release event's own
 * position instead makes the drop depend only on where the pointer was let
 * go.
 *
 * `fallback` covers the synthetic aborts (`DeskController#
 * cancelDragGesture`, a yanked pointer capture, the window losing focus),
 * which carry no position — those never reach a commit anyway.
 *
 * @param {{worldFromEvent: (e: PointerEvent) => {x:number,y:number}}} deskView
 * @param {{clientX?: number, clientY?: number}} e
 * @param {{x:number,y:number}} fallback
 * @returns {{x:number,y:number}}
 */
export function releaseWorld(deskView, e, fallback) {
  if (typeof e.clientX !== "number" || typeof e.clientY !== "number") {
    return fallback;
  }
  return deskView.worldFromEvent(e);
}
