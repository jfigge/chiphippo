# 13 — Per-island quantum (optional)

**Review refs:** engine review §4.2 ("The quantum"), §8.2 (risks), §8.3 step 5
**Depends on:** 12
**Accuracy:** an **intentional model change**. It is more correct, but it moves
numbers on desks mixing logic families. Single-family desks must be
bit-identical. Every golden case must stay A.

**Do not merge without Jason's explicit sign-off** on the list of changed
values.

## Problem

The gate-delay quantum is the shortest gate delay on the whole desk. A
CD4000 island's passes are cut at a 74LS island's 10 ns, and `maxIterations`
is lifted by the slowest hold anywhere.

## Goal

Each island uses the quantum and hold limits of its own chips.

## Design

- `analyze` (cached per 09) computes the quantum and holds per island.
- The island's settle uses its own quantum.
- `t += passes × quantum` uses the island's quantum.

## Must hold

- Single-family desks: bit-identical.
- Golden: all A.
- Every changed value in any test or shipped example is listed in RESULTS.md
  with old value, new value and the reason. Expected cause: mixed families on
  one desk.

## Acceptance

- Mixed-family fixture: the CD4000 island's settle passes fall.
- No accuracy regressions on single-family desks.

Stop for sign-off before merging.
