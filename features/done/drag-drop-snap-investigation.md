# Drag/Drop Snap Divergence — Investigation

2026-10-10 · scoped investigation — **fix applied the same day** (see "Applied" at the end)

## Summary

- Drag and drop use the **same** snap function. Nothing drifted.
- The circled hole is saved but only used as a **last resort**. The drop recalculates first.
- The likely cause of the snap-back is that the recalculation can pick the hole the item **started from**.
- The fix is to commit the circled hole whenever there is one and recalculate only when there isn't. It's a small change in four places, plus updating a few tests and one CLAUDE.md rule.

The two paths haven't drifted apart; the problem is the reverse. Every ringed drag works out its target on every move and then works it out again at the release. The circled target is kept, but it's only used when the release point lands nowhere.

## 1. Do drag and drop share one snap function?

Yes. All four ringed single-point drags call the same resolver for the preview and for the drop. It is `nearestLegalPoint` (`src/web/scripts/model/part-geometry.js:221`), with the same radius (`END_SNAP_RADIUS` 1.2) and the same accept test:

| Drag | Shared resolver | Release handler |
|---|---|---|
| Wire end | `#resolveEndpointTarget` (`wire-tools.js:643`) | `#onEndpointUp` (`wire-tools.js:658`) |
| Resistor/LED end | `#trackResistorEndDrag` (`desk-controller.js:1326`) | `desk-controller.js:4092` |
| Signal flag | `#resolveSignalFlag` (`desk-controller.js:4534`) | `desk-controller.js:4593` |
| Output/Input tag | `#resolve` (`integration-tools.js:233`) | `integration-tools.js:294` |

`git log -S` shows the bounded search and the circled-target fallback arrived together in `db581a1`. So the hypothesis about a stale drop path doesn't match the history.

## 2. Is the circled target kept for the drop?

It's stored (`m.shown`, or `shown` in the other handlers), but only as a fallback. The release always re-resolves at the release point first, and that result wins whenever it finds anything. This was a deliberate rule (CLAUDE.md: "The release point still wins whenever it lands"), added because coalesced moves lag the cursor.

That re-resolve is how a drop can break what the ring showed:

- **Snap back to the origin (likely the reported symptom).** The hole the end came from counts as a legal landing spot, because `canReendWire` (`occupancy.js:481`) accepts the wire's own hole. On a short drag, the origin is within the 1.2-pitch reach of the release point. If the cursor drifts back half a pitch as the button comes up, the re-resolve picks the origin. `target.address === m.origin` then skips the commit, so the end jumps back even though the ring was on the new hole.
- **Lands on a different hole.** In a scratch jsdom test (since deleted), ringing `c14` and releasing 0.6 pitch to the right committed `c15`. Releases closer than that stayed on `c14`, and a release far off the board correctly fell back to `c14`.
- **Flags and tags go back to the rail.** For a planted flag or tag, a release just past the last hole in reach counts as an unplug. That beats the ring, so the item returns to the rail it came from.

The revert could not be reproduced in the real app: the automated (CDP) mouse kept colliding with the real cursor over the Electron window. The findings above come from code reading and jsdom.

## Proposed minimal fix (not applied)

If something was circled, commit it and skip the release re-resolve. Only re-resolve when nothing was circled.

**Wire end** (`wire-tools.js` ~678):

```js
let target, at;
if (m.shown) ({ target, world: at } = m.shown);
else {
  at = releaseWorld(this.#host.deskView, e, m.lastWorld);
  target = this.#resolveEndpointTarget(m.wireId, m.end, at);
}
```

**Resistor/LED end:** `d.target`/`d.legal` already hold the circled seat from the last move. Wrap the existing re-resolve in `if (!d.legal) { … }` and drop the `shown` dance.

**Flag and tag:** wrap the re-resolve in `if (!d.holeFree) { … }`. An unplug still happens when the last move had nothing ringed, which is the case once the item has been dragged off the board.

## Trade-offs to decide on

- A fast flick could commit the hole one frame behind the cursor. It is still what was circled on screen, which is the intended behaviour.
- These tests encode the current rule and would need flipping:
  - `desk-drag-release.test.js:848` ("lands at the RELEASE point, not the last move")
  - `desk-drag-release.test.js:910` ("an UNPLUG at the release still beats the ring")
  - any resistor-end or tag test that uses a different release point from the last move
- The rule text in CLAUDE.md ("Document model" → single-point snap) and the comment above `END_SNAP_RADIUS` would need rewording.
- Out of scope, same root: the whole-wire drag, resistor/LED body drag and chip drag have no circled-target fallback at all. A release that resolves to nothing there reverts.

## Applied (2026-10-10)

A release commits exactly what the last move showed and never reads the release position. A green ring drops on that hole; a red ring or no ring reverts. For a planted flag or tag, no ring over bare desk is still the unplug the move was already previewing.

- `wire-tools.js` `#onEndpointUp`, `desk-controller.js` resistor/LED end + signal flag, `integration-tools.js` tag.
- Tests flipped/added in `desk-drag-release.test.js` and `desk-gestures.test.js` (incl. the short-drag snap-back-to-origin case).
- CLAUDE.md, `part-geometry.js` comments and the user guide (`wiring.md`) updated.
