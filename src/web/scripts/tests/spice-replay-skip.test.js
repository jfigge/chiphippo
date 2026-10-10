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

// The replay settle a quiet tick skips (features/05-skip-replay-settle.md):
// a late tick's first settle replays the last tick's own final moment on its
// inputs, and when that tick ended RESTED with the bench unchanged it could
// change nothing — so it is not run. In steady state a desk with analog
// nodes settles about once a tick, not twice.

import test from "node:test";
import assert from "node:assert/strict";
import { driveSpice } from "../bench/drive-spice.js";
import { islandFixtures } from "../bench/islands-fixtures.js";
import { ASSERT_REPLAY } from "../sim/assert-modes.js";

/** Settles per tick over the last half of `seconds` of fixture `name`. */
function settlesPerTick(name, seconds) {
  const f = islandFixtures().find((x) => x.name === name);
  const stats = {};
  let from = null;
  let ticks = 0;
  driveSpice(f.doc, {
    seconds,
    scope: f.scope,
    stats,
    onTick: (now) => {
      if (now < seconds / 2) return;
      from ??= stats.settles;
      ticks++;
    },
  });
  return (stats.settles - from) / ticks;
}

for (const [name, seconds] of [
  ["rc-sine", 0.2],
  ["busy-triangle", 0.1],
]) {
  // (`SPICE_ASSERT_REPLAY` runs every skipped settle anyway.)
  test(
    `${name}: settles per tick fall toward one in steady state`,
    { skip: ASSERT_REPLAY },
    () => {
      // prettier-ignore
      const per = settlesPerTick(name, seconds);
      assert.ok(per < 1.2, `${per.toFixed(2)} settles a tick`);
    },
  );
}
