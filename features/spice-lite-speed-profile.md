# Spice Lite — where a tick goes (profile, 2026-10-30)

Read-only survey before any Spice Lite speed work. Headless, Node 26, `bench/drive-spice.js`
(SimController's transport), on `main` after the digital-engine work
(`features/digital-event-tick.md`).

## Every example desktop, 0.25 simulated s each

All 124 run faster than real time at ×1. Slowest (wall s per simulated s):

| Desk | s/s | ticks |
|---|---|---|
| adapter#0 Clipping | 0.82 (0.40 over 4 s, warm) | 481 |
| speaker#0 Tone | 0.58 (0.41 over 1 s) | 456 |
| speaker#1 Pitch | 0.49 | 444 |
| speaker#3 Siren | 0.49 | 332 |
| inductor#0 Ringing | 0.47 (0.36 over 1 s) | 501 |
| Z80A / W65C02 computers | 0.17 / 0.11 | 126 / 51 |

At ×4 the AC, speaker and ringing desks are 1.5–2 s/s, so they read as behind.

## Two kinds of desk, two different costs

**Analog-heavy** (adapter#0, 0.21 ms/tick): ~85 % is the analog machinery.
- `updateNodes` 47 % (`runGroup` 27, crossings 16, `restate` 18).
- Newton 16 %, curves (`dynamics.js`/`rc-curve.js`) ~23 % self.
- The digital tick is 13 %, and Phase A's walks are ~1–2 % of that.
- No cheap lever: the earlier review rounds tuned this code.

**Logic-heavy** (busy-16 fixture, 1.03 ms/tick, ~10× the logic engine):
- The digital tick (`sim/engine.js` `tick`) is 35 %, of which `warmStartOf` + `keepLevels`
  (Phase A's per-tick walks, switched off under hooks) are ~5 %.
- **End-of-tick reporting is 35–40 %, recomputed for the whole desk every tick:**
  - `report` 34 %;
  - `measure`/`measureDroop` 23 %;
  - `lampsNow` 16 %;
  - `supplySag` 8.6 % (sag over every draw);
  - `mergeEntries` 7.9 %.
- The `levels` hook's pass solves (`levelsDelta` → `solveDirty`) are 11 %, and the `input`
  hook 7 %.

## Candidate work, best first

1. **Incremental end-of-tick report on logic-heavy desks.** Re-book supplies, sag and lamps
   only for the clusters whose draws moved. This is the one place a large gain (1.3–1.6×)
   looks possible.
2. **Phase A under hooks** (in-place levels and journal, Spice Lite's own after-tick writes
   journaled): ~5 % on logic desks, ~1 % on analog ones.
3. Analog-heavy desks: nothing cheap; leave.

Gate for each: a Spice Lite mode in `scripts/engine-diff.mjs` (tick by tick, bit-identical,
against a ref), plus the ngspice golden suite, `engine-parity`, `engine-incremental` (full
reference) and `spice-cycle-replay`.

## Done

- **`engine-diff.mjs --spice` (2026-10-30):** Spice Lite compared tick by tick, bit for bit,
  against a ref.
  - It drives each desk with that tree's own `drive-spice.js` and compares every tick's
    moment, levels, voltages, states, pins, warnings, status, supplies, lamps, currents,
    wakes, settled and iterations.
  - Against v1.5.0 it flags 117 of 125 desks, so it does catch differences.
- **Phase A under hooks (2026-10-30).** `keep` hands Spice Lite the map itself
  (`levelsOut`), not a level array, and `keepLevels`/`spareLevels` are gone. Spice Lite's
  writes after a tick (a wired-AND shown LOW, a replay) already go into copies. There is no
  in-place mode under hooks.
  - Identical to HEAD over 20 763 ticks (2 s each desk), and to v1.5.3 over 10 349 ticks.
  - Speed is within noise: busy-16 about 1.11 → about 1.07–1.13 ms/tick, adapter#0 about
    0.23. The copy stays, and the walks were a smaller share than the profile's 5 %
    suggested. It is kept as a simplification, since it is less code and gives the same
    results.
- **#1 re-scoped (2026-10-30).** A closer look showed `report()` already caches per
  cluster, as do the at-SET bookings. Only `mergeEntries` (~8 %) and `supplySag` (~8.6 %)
  run over the whole desk every tick. The realistic prize is ~10–15 %, not 1.3–1.6×.
- **`supplySag` without per-draw allocations (2026-10-30).** There is no array literal, spread
  or terminal-key string per draw, and the memo's path arrays are read in place, so the
  additions happen in the same order. Identical to HEAD (20 763 ticks) and v1.5.3 (10 349).
  `spice-sag`, golden, parity, current and incremental all pass. Busy-16 under Spice Lite,
  4 alternating runs: HEAD 1.12–1.18 ms/tick, tree 1.07–1.12 (about 5 %).
- **Next, if wanted:** an incremental `mergeEntries` (~8 %). For bit identity, a hole that
  several clusters' leads share (the rails) must be re-summed in cluster order, and every map
  must keep its key order.
