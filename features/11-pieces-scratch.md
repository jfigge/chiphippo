# 11 — Allocation-free `piecesAt` in `linearizeGroup`

**Review refs:** engine review §7.7
**Depends on:** 00
**Accuracy:** must not change any result. The golden suite must be
**bit-identical**.

## Problem

`piecesAt` builds two `Map`s per network per sample. A corner search takes
about 100 samples. That is roughly 5% of a tick with nonlinear groups, mostly
in allocation and GC.

## Goal

The same results with no per-sample allocation.

## Design

- Reuse scratch arrays (typed arrays where indices are dense) owned by the
  group or network, sized once.
- Compare signatures by index rather than by building and comparing Maps.
- Keep the public shape of `pieces` if other callers depend on it. Add an
  internal fast path for `groupCorner` and `linearizeGroup`.

## Must hold

Bit-identical golden suite, especially the multi-RC, coupled-oscillator and
CMOS-stage areas, which exercise group corners.

## Acceptance

`piecesAt` falls in the profile on a nonlinear-group fixture. Add one if 00
doesn't cover it, e.g. the two-gate CD4069UB oscillator. Record in
RESULTS.md.
