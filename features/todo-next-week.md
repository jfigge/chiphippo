# To do — week of 2026-11-02

Carried over from the 2026-10-28 regrade and fix rounds. Only items ABOVE low
importance are listed here; everything low was reviewed and marked acceptable
(see "Accepted" at the end), so a future review should not raise those again.

## To do

1. **Spice Lite speed (finding E) — MEDIUM, the path to Spice Lite A.** The slow test
   desk runs ~610× slower than real time (wall seconds per simulated second); most of
   what remains is in `linearizeGroup` (~4 solves per corner, `sim/spice/voltages.js` /
   `engine.js`), deferred since round 2. Conditions as always: no slowdown elsewhere,
   within 2 % of ngspice, golden suite unchanged. Repros: the regrade-5/6 Spice
   reviewers' scratch (`/tmp/chh-regrade5/spice/`, `/tmp/chh-regrade6/spice/` —
   volatile; recreate from the finding-E desk if /tmp has been cleared).
2. **Custom chips · AI · exports review — MEDIUM, the path to that area's A.** Graded
   A− with no specific defects named; it needs its own focused review (HDL subset and
   designer, AI builder, KiCad / Digital exports) to find what stands between it and A.
3. **Web build on other platforms — MEDIUM (verification, not code).** Everything so
   far ran on macOS: try the web build in Chrome/Edge/Firefox on Windows and Linux, and
   on a phone/tablet (touch, small screens), and record what works.
4. **Browser storage across days — MEDIUM (verification).** Save a project in Safari and
   Firefox (browser storage), come back a day or more later, confirm File ▸ Open still
   lists it (Safari clears site storage after 7 days without a visit unless the site is
   added to the Dock).
5. **Drag threshold frame on very large desks — MEDIUM, the last runtime gap to A.**
   busy64's first drag frame is ~58 ms (target < 50; drops and releases already met their
   targets on 2026-10-28). Two measured options, both needing a decision:
   (a) a permanent `.layer-boards { opacity: 0.99999 }` makes the strips' fade a value
   change — threshold 58 → 46, pointerup 50 → 44, drop 51 → 45, wire-drag p95 30 → 23 —
   but at rest it is not pixel-identical (788 px differ by ≤ 15/255 on hole edges;
   HEAD's own run-to-run noise is ~1200 px); (b) a `data-dragging` attribute instead of the
   `desk-viewport--dragging` class (a class change costs a 12 ms whole-tree prepaint at
   release, plain clicks included) — needs the same change in wire-tools.js, bus-tools.js
   and integration-tools.js; ~−3 ms a drop, −5 ms a click. Scratch:
   `/tmp/chh-runtimeA/editor/` (volatile).

(Not on this list because it is a feature, not a fix: the Homebrew cask,
`features/homebrew-cask.md`.)

## Accepted (low — do not re-raise)

- **Logic engine:** the per-tick `netLevels` Map (`warmStartOf`, ~56 KB/tick) stays
  fresh each tick — callers keep it (last shown board, the worker's cut cache, the
  integration); recycling it would need an ownership contract.
- **Logic / runtime, latent:** `DeskDoc` getters hand out part `params` by live
  reference (a caller writing into one would bypass `revision` — none does); a spread
  copy of a tick result carries the original's `strongAt` (nothing reads one);
  `SIGNATURE_TRUST_MS` uses `Date.now()` (a clock stepping back stretches it).
- **Multimeter:** the first clock edge with a meter re-solves ~128 clusters (6 without);
  after a mid-run load change the 5 mV `HUB_EPS` hold leaves a meter-fed chip ~2.6 mV
  off (meter +0.011 %); edited runs 36–147 µV off the twin; the 0.225 mA flag-LOW
  over-read (meter.md "Accepted exception" — fold in only when that code is changed for a
  bigger bug).
- **Platform & web:** re-opening a saved file may cost a write-permission prompt on the
  next ⌘S (seen only with a per-handle test stand-in; Chrome grants by path).
- **Spice Lite:** a clock brick / bench signal uses its rail as a voltage REFERENCE,
  not a draw (spice-lite.md — by design, never change without asking).
- **Safari:** no LED glow (CSS drop-shadow on SVG shapes).
- **Editor:** a big group drop's settle frame lands later than before (busy64 time to
  idle 60 → 74 ms) so the first painted frame comes sooner (96 → 50 ms) — the carry
  hold; `CARRY_HOLD.min = Infinity` turns it off.
- **Examples:** an untouched example is not kept across a reload (it arrives clean).
