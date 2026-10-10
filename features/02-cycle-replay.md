# 02 — Replay a drawn cycle from its recording

**Review refs:** engine review §3.5 ("Cycles"), §5, §6 (fast 555 rows), §7.2
**Depends on:** 01
**Accuracy:** must not change any engine result. The golden suite must be
**bit-identical**. Counted parts must end in exactly the state they reach today.

## Problem

`runCycle` runs **one full digital settle per segment** of a drawn cycle's
schedule, for the whole desk:

- A fast 555 alone costs 1.2 s per simulated second.
- Busy board + fast 555 costs 4.1 s: 53% of the run is `runCycle`
  re-settling the counter board.

Once a cycle is recognised, each segment's digital outcome is already in the
recording. `runCycle` checks it against `drive`.

## Goal

A drawn cycle advances without settling in the steady state. It settles only
when something has changed.

## Design

1. **Record per segment** what the settle produced: the levels of the nets the
   cycle drives and of their readers, plus any state changes.
2. **Apply the recording** for each due segment, instead of settling:
   - **Counting parts** (`stepEnv`): advance by the true number of cycles
     between the last applied time and `target`, in one step where the part
     supports it. Otherwise apply each edge's effect from the recording.
     Their final state must equal today's.
   - **Memory writes / CPUs** reading the cycle's nets: if any such consumer
     exists, fall back to settling per segment. Correctness first; list these
     cases in RESULTS.md.
3. **Settle only when needed**:
   - when the drive check fails (the circuit no longer drives what was
     recorded);
   - on the last segment due before `target`, so the tick ends in a fully
     settled state, if that is required for the end-of-tick work;
   - whenever a non-cycle event lands inside the replay window.
4. **Frame jumps.** With 01 in place, a drawn cycle with no fallback consumers
   needs at most one tick per display frame. That tick replays the segments
   up to the frame time.
   - Remove the `MIN_SHOWN_S` floor's per-segment wakes for such cycles.
   - Any event that could change the cycle's drive must still tick
     immediately: a user input on the island, a crossing elsewhere in it.

## Must hold

- Golden suite bit-identical; tick-spacing invariance green.
- A counter driven by a drawn 555, run for N simulated seconds, ends with the
  same count as today.
- A cycle broken mid-run stops being drawn at the same simulated moment as
  today. Example cases: a switch opens the timing resistor; a chip's power is
  removed.

## Tests to add

- Counter-on-555 equivalence over 10 s at 3 frequencies, against settle-per-segment.
- Drive-check break: the cycle ends at the same simulated time ±1 quantum.
- A CPU or memory consumer on a cycle net falls back and matches today.

## Acceptance

`make bench-compare` vs the previous step:

- `555-fast` and `busy+555-fast` drop sharply. The target is under 200 ms/sim-s
  for `555-fast`.
- Settles per sim-s for those fixtures fall by orders of magnitude.

Record in RESULTS.md.

## Out of scope

Per-island cycle signatures (04).
