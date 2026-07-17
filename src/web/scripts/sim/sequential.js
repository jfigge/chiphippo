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

// sequential.js — the sequential-logic vocabulary (Feature 100). Each family
// (D-FF, JK-FF, transparent latch, sync counter, up/down counter, SIPO/PISO
// shift) is a PURE builder: given a unit's pin map it returns
// `{ state0, step, outputs }` operating on that unit's slice of the chip's
// state. `seqChip` composes one or more units into a chip-level
// `{ state0, step, outputs }` block the engine drives — DATA plus pure
// functions, never per-chip engine code.
//
//   step(state, inputs, prevInputs) → nextState   (prevInputs null on tick 0)
//   outputs(state, inputs)          → Map<pin, level>
//
// `inputs`/`prevInputs` are Map<pin, level>, already asInput'd (Z→H) so only
// H/L/X reach here. Edge detection compares prev vs current; async
// (level-sensitive) preset/clear/load/reset override the clocked path per
// datasheet. Combinational MSI parts (decoders, muxes) live here too as
// `COMB` unit builders — their inputs legitimately fan out to every output.

import { H, L, inv } from "./levels.js";

/** A control/data line reads as a clean bit: H stays H, everything else L. */
const asBit = (lv) => (lv === H ? H : L);
const high = (lv) => lv === H;
const edgeRose = (p, c) => p === L && c === H;
const edgeFell = (p, c) => p === H && c === L;

/** Read a little-endian bus (LSB first) of input pins into an integer. */
const readBus = (pins, ins) =>
  pins.reduce((n, pin, i) => n + (high(ins.get(pin)) ? 1 << i : 0), 0);

/** Integer → array of `count` levels, LSB first. */
const busBits = (value, count) =>
  Array.from({ length: count }, (_, i) => ((value >> i) & 1 ? H : L));

/**
 * Compose per-unit `{ state0, step, outputs }` into one chip-level block. The
 * chip state is the array of unit states; outputs merge (each unit owns
 * distinct pins).
 */
export function seqChip(units) {
  return {
    state0: () => units.map((u) => u.state0()),
    step: (state, ins, prev) =>
      units.map((u, i) => u.step(state[i], ins, prev)),
    outputs: (state, ins) => {
      const out = new Map();
      units.forEach((u, i) => {
        for (const [pin, lv] of u.outputs(state[i], ins)) out.set(pin, lv);
      });
      return out;
    },
  };
}

/** Q/Q̄ output pair, honoring the illegal both-async-asserted case (both H). */
function ffOutputs(s, qPin, qnPin) {
  if (s.both) {
    const out = new Map([[qPin, H]]);
    if (qnPin != null) out.set(qnPin, H);
    return out;
  }
  const out = new Map([[qPin, s.q]]);
  if (qnPin != null) out.set(qnPin, inv(s.q));
  return out;
}

/** Resolve async preset/clear (active-low). Returns a state or null. */
function asyncOverride(ins, preN, clrN) {
  const clr = clrN != null && ins.get(clrN) === L;
  const pre = preN != null && ins.get(preN) === L;
  if (pre && clr) return { q: H, both: true };
  if (clr) return { q: L };
  if (pre) return { q: H };
  return null;
}

/**
 * Edge-triggered D flip-flop with optional async active-low preset/clear.
 * @param {{d,clk,preN?,clrN?,q,qn?,edge?}} m - pin map; `edge` "rise"|"fall".
 */
export function dffUnit(m) {
  const clocked = m.edge === "fall" ? edgeFell : edgeRose;
  return {
    state0: () => ({ q: L }),
    step(s, ins, prev) {
      const forced = asyncOverride(ins, m.preN, m.clrN);
      if (forced) return forced;
      if (prev && clocked(prev.get(m.clk), ins.get(m.clk))) {
        return { q: asBit(ins.get(m.d)) };
      }
      return { q: s.q };
    },
    outputs: (s) => ffOutputs(s, m.q, m.qn),
  };
}

/**
 * Edge-triggered JK flip-flop with optional async active-low preset/clear.
 * @param {{j,k,clk,preN?,clrN?,q,qn?,edge?}} m - `edge` defaults "fall".
 */
export function jkUnit(m) {
  const clocked = m.edge === "rise" ? edgeRose : edgeFell;
  return {
    state0: () => ({ q: L }),
    step(s, ins, prev) {
      const forced = asyncOverride(ins, m.preN, m.clrN);
      if (forced) return forced;
      if (prev && clocked(prev.get(m.clk), ins.get(m.clk))) {
        const j = high(ins.get(m.j));
        const k = high(ins.get(m.k));
        if (j && k) return { q: inv(s.q) }; // toggle
        if (j) return { q: H }; // set
        if (k) return { q: L }; // reset
        return { q: s.q }; // hold
      }
      return { q: s.q };
    },
    outputs: (s) => ffOutputs(s, m.q, m.qn),
  };
}

/**
 * Level-sensitive (transparent) D latch: while `en` is HIGH the output follows
 * D live; while LOW it holds. Transparency shows up within a settle because
 * `outputs` reads the current inputs.
 * @param {{d,en,q,qn?}} m
 */
export function latchUnit(m) {
  return {
    state0: () => ({ q: L }),
    step(s, ins) {
      if (ins.get(m.en) === H) return { q: asBit(ins.get(m.d)) };
      return { q: s.q };
    },
    outputs(s, ins) {
      const q = ins.get(m.en) === H ? asBit(ins.get(m.d)) : s.q;
      const out = new Map([[m.q, q]]);
      if (m.qn != null) out.set(m.qn, inv(q));
      return out;
    },
  };
}

/**
 * Synchronous 4-bit binary counter (74161-style): async active-low clear, sync
 * active-low parallel load, count-enable P & T, ripple carry (RCO = count==15
 * AND ENT). Rising-edge clocked.
 * @param {{clk,clrN,loadN,enP,enT,data:number[],q:number[],rco}} m
 */
export function syncCounter4(m) {
  return {
    state0: () => ({ n: 0 }),
    step(s, ins, prev) {
      if (ins.get(m.clrN) === L) return { n: 0 }; // async clear
      if (prev && edgeRose(prev.get(m.clk), ins.get(m.clk))) {
        if (ins.get(m.loadN) === L) return { n: readBus(m.data, ins) }; // sync load
        if (ins.get(m.enP) === H && ins.get(m.enT) === H) {
          return { n: (s.n + 1) & 15 };
        }
      }
      return { n: s.n };
    },
    outputs(s, ins) {
      const bits = busBits(s.n, 4);
      const out = new Map(m.q.map((pin, i) => [pin, bits[i]]));
      out.set(m.rco, s.n === 15 && ins.get(m.enT) === H ? H : L);
      return out;
    },
  };
}

/**
 * 4-bit up/down binary counter (74193-style): separate rising-edge up (`cpu`)
 * and down (`cpd`) clocks, async active-HIGH master reset (`clr`), async
 * active-low parallel load (`loadN`); active-low carry (`coN`, count==15 while
 * up-clock low) and borrow (`boN`, count==0 while down-clock low).
 * @param {{cpu,cpd,loadN,clr,data:number[],q:number[],coN,boN}} m
 */
export function upDownCounter4(m) {
  return {
    state0: () => ({ n: 0 }),
    step(s, ins, prev) {
      if (ins.get(m.clr) === H) return { n: 0 }; // async master reset
      if (ins.get(m.loadN) === L) return { n: readBus(m.data, ins) }; // async load
      let n = s.n;
      if (prev && edgeRose(prev.get(m.cpu), ins.get(m.cpu))) n = (n + 1) & 15;
      if (prev && edgeRose(prev.get(m.cpd), ins.get(m.cpd))) n = (n + 15) & 15;
      return { n };
    },
    outputs(s, ins) {
      const bits = busBits(s.n, 4);
      const out = new Map(m.q.map((pin, i) => [pin, bits[i]]));
      out.set(m.coN, s.n === 15 && ins.get(m.cpu) === L ? L : H);
      out.set(m.boN, s.n === 0 && ins.get(m.cpd) === L ? L : H);
      return out;
    },
  };
}

/**
 * Serial-in parallel-out shift register (74164-style): serial data is `a AND
 * b`, rising-edge clocked, async active-low clear; `q` lists the stage output
 * pins Q0…Qn (Q0 the input end).
 * @param {{a,b,clk,clrN,q:number[]}} m
 */
export function shiftSipo(m) {
  const width = m.q.length;
  return {
    state0: () => ({ bits: Array(width).fill(L) }),
    step(s, ins, prev) {
      if (ins.get(m.clrN) === L) return { bits: Array(width).fill(L) };
      if (prev && edgeRose(prev.get(m.clk), ins.get(m.clk))) {
        const serial = high(ins.get(m.a)) && high(ins.get(m.b)) ? H : L;
        return { bits: [serial, ...s.bits.slice(0, width - 1)] };
      }
      return s;
    },
    outputs: (s) => new Map(m.q.map((pin, i) => [pin, s.bits[i]])),
  };
}

/**
 * Parallel-in serial-out shift register (74165-style): async parallel load
 * while `shLdN` is LOW; otherwise, with clock-inhibit `clkInhN` LOW, a rising
 * clock shifts from the A end toward H. `data` lists parallel inputs A…H;
 * serial input `ser` enters the A end. Outputs QH (`qh`) and its complement
 * (`qhN`).
 * @param {{shLdN,clk,clkInhN,ser,data:number[],qh,qhN?}} m
 */
export function shiftPiso(m) {
  const width = m.data.length;
  return {
    state0: () => ({ bits: Array(width).fill(L) }),
    step(s, ins, prev) {
      if (ins.get(m.shLdN) === L) {
        return { bits: m.data.map((pin) => asBit(ins.get(pin))) }; // async load
      }
      if (
        ins.get(m.clkInhN) === L &&
        prev &&
        edgeRose(prev.get(m.clk), ins.get(m.clk))
      ) {
        return { bits: [asBit(ins.get(m.ser)), ...s.bits.slice(0, width - 1)] };
      }
      return s;
    },
    outputs(s) {
      const qh = s.bits[width - 1];
      const out = new Map([[m.qh, qh]]);
      if (m.qhN != null) out.set(m.qhN, inv(qh));
      return out;
    },
  };
}

// ── Combinational MSI vocabulary (decoders, muxes) — COMB units ──────────────

/** A COMB unit: `compute(levels)` over shared, fanning-out inputs. */
const comb = (inputs, output, compute) => ({
  fn: "COMB",
  inputs,
  output,
  compute,
});

/**
 * n-to-2ⁿ decoder with active-low outputs. `sel` lists the address pins (LSB
 * first); `enabled(levels)` reads the enable pins; `out` lists the 2ⁿ active-
 * low output pins in address order. Returns the `units` array.
 * @param {{sel:number[], enable:number[], enabled:Function, out:number[]}} m
 */
export function decoderUnits(m) {
  const inputs = [...m.sel, ...m.enable];
  return m.out.map((pin, addr) =>
    comb(inputs, pin, (levels) => {
      const byPin = new Map(inputs.map((p, i) => [p, levels[i]]));
      const en = m.enabled(byPin);
      const value = m.sel.reduce(
        (n, p, i) => n + (high(byPin.get(p)) ? 1 << i : 0),
        0,
      );
      return en && value === addr ? L : H;
    }),
  );
}

/**
 * 2ⁿ-to-1 multiplexer. `sel` address pins (LSB first), `data` the 2ⁿ data
 * pins in address order, `strobeN` an active-low enable (output forced LOW
 * when high). Drives `y` (and optional complement `yn`). Returns `units`.
 * @param {{sel:number[], data:number[], strobeN?, y, yn?}} m
 */
export function muxUnits(m) {
  const inputs = [
    ...(m.strobeN != null ? [m.strobeN] : []),
    ...m.sel,
    ...m.data,
  ];
  const value = (levels) => {
    const byPin = new Map(inputs.map((p, i) => [p, levels[i]]));
    if (m.strobeN != null && byPin.get(m.strobeN) === H) return L; // disabled
    const addr = m.sel.reduce(
      (n, p, i) => n + (high(byPin.get(p)) ? 1 << i : 0),
      0,
    );
    return asBit(byPin.get(m.data[addr]));
  };
  const units = [comb(inputs, m.y, value)];
  if (m.yn != null)
    units.push(comb(inputs, m.yn, (levels) => inv(value(levels))));
  return units;
}

/**
 * Quad 2-to-1 selector (74157-style): one shared select `sel` and active-low
 * enable `strobeN`; each unit picks input `a` (sel low) or `b` (sel high),
 * forced LOW when disabled. `units` = [{a,b,y}…]. Returns COMB `units`.
 * @param {{sel, strobeN, units:Array<{a,b,y}>}} m
 */
export function selectorUnits(m) {
  return m.units.map((u) => {
    const inputs = [m.strobeN, m.sel, u.a, u.b];
    return comb(inputs, u.y, ([strobe, sel, a, b]) => {
      if (strobe === H) return L; // disabled
      return sel === H ? asBit(b) : asBit(a);
    });
  });
}
