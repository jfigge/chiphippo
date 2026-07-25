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

// pin-builders.js — the shorthand builders every catalog/chips-*.js file used
// to redeclare on its own (`pin`/`input`/`output`/`io`/`nc`/`gnd`/`vcc`, plus
// the `unit`/`buf3` logic-block builders). One shared source so a chip's pin
// table and the "logic is data, not per-chip code" vocabulary stay readable
// without every file hand-copying the same handful of one-liners.

/** A pin: number, silkscreen name, and electrical role. */
export const pin = (n, name, role) => ({ n, name, role });
export const input = (n, name) => pin(n, name, "input");
export const output = (n, name) => pin(n, name, "output");
/** A bidirectional (I/O) pin — a bus line a unit both reads and drives. */
export const io = (n, name) => pin(n, name, "io");
export const nc = (n) => pin(n, "NC", "nc");
/** `name` overrides the silkscreen label (e.g. VSS/VDD on a CMOS memory part). */
export const gnd = (n, name = "GND") => pin(n, name, "gnd");
export const vcc = (n, name = "VCC") => pin(n, name, "vcc");

/** A logic unit: a gate (`inputs → output`) or a tri-state buffer. */
export const unit = (fn, inputs, output) => ({ fn, inputs, output });
/** A 74125-style tri-state buffer: `data` in, active-low `enable`, `output`. */
export const buf3 = (data, enable, output) => ({
  fn: "BUF3",
  inputs: [data],
  enable,
  output,
});
