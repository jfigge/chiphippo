# 00 — Islands benchmark fixtures and work counters

**Review refs:** engine review §6, §8.3 step 1 ("Measure"), Appendix B
**Depends on:** nothing — do this first
**Accuracy:** no engine change. Bench and test code only.

## Problem

Every optimization in this series has to be judged by a number. Today the
measurements in the engine review (§6) came from throwaway scripts. They are
not in `make bench`, so nothing ratchets and nothing shows a regression.

## Goal

`make bench` reports, for each fixture below, a stable JSON + table of:

- **ms of wall-clock work per simulated second**
- **ticks per simulated second**
- **settles per simulated second** (calls to the digital tick from Spice Lite)
- **passes per simulated second**
- **chip evaluations per simulated second** (calls into `logicOf` or equivalent)
- **`outputs`-hook calls per simulated second**
- **running check**: for each oscillator, the measured period over the run
  against its expected period. Report `not running` when no edges are seen.
  The 68 kHz 555 row in §6 "looks cheap" because it is not running; the bench
  must expose that.

## Fixtures

Build them from `bench/busy-circuit.js` (`busyDocument(4)`, 28 chips) and
`tests/timing-fixtures.js` (`bench`, `astable555`). Each 555 sits on its own
board and its own PSU, sharing nothing with the counter board.

| Name                  | Desk                                                |
| --------------------- | --------------------------------------------------- |
| `busy-square`         | Busy board alone, 100 Hz square clock               |
| `busy-triangle`       | Busy board, 100 Hz triangle, scope channels on      |
| `busy-triangle-noscope` | Same, no scope channels                           |
| `555-slow`            | 555 astable ~69 Hz alone                            |
| `busy+555-slow`       | Both, not connected                                 |
| `555-fast`            | 555 ~6.9 kHz alone                                  |
| `555-fast-x2`         | Two fast 555s, not connected                        |
| `busy+555-fast`       | Busy board + fast 555, not connected                |
| `555-68k+wave`        | 555 ~68 kHz + 10 Hz triangle clock elsewhere        |
| `rc-sine`             | RC on a 250 Hz sine                                 |

## Driver

Drive `ENGINES.spice.tick` exactly as SimController does (Appendix B). Each
tick gets the previous tick's `netLevels`, `state`, `pinLevels` and `analog`.
The next `now` is the earlier of the next clock edge and
`max(wakeAt, now + MIN_SHOWN_S)`.

- Put the driver in `bench/` as a reusable module (`bench/drive-spice.js`), so
  later steps can change the transport rules in one place.
- Count the work through optional instrumentation: a counters object passed in
  opts, with no cost when absent. Don't use global state.

## Output

- `make bench` prints the table.
- `make bench BENCH_JSON=path` writes JSON.
- Commit a baseline as `bench/baselines/spice-perf-00.json`.
- Add `make bench-compare BASE=… HEAD=…`. It prints the ratio per fixture and
  per counter.

## Acceptance

- Every fixture runs headless in under ~30 s total.
- The baseline numbers are within reason of the review's §6 table (same
  machine class). Record any large discrepancy in RESULTS.md and explain it.
- `make test` is unchanged and green.

## Out of scope

Any engine change.
