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

import { H, L, Z, inv } from "./levels.js";

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

// ── Memory vocabulary (ROM / SRAM / EEPROM) — an addressable byte/word image ──

/**
 * A memory unit: an address-indexed array of bytes/words backing a ROM, SRAM,
 * or EEPROM. Reads are COMBINATIONAL — while the part is selected and
 * output-enabled (and not mid-write) the data pins present `image[addr]`, one
 * bit per data pin; otherwise they float (`Z`), so a shared data bus resolves
 * through Feature 90's strength precedence. Writes are LEVEL-latched and
 * REPORTED, never applied here: the engine stays pure (it never mutates the
 * image), and the renderer's SimController owns the image and applies the
 * reported `{ addr, value }` after each tick (Feature 170; Feature 180 swaps
 * the volatile image for a file-backed one behind this same contract).
 *
 * The returned block is neither `logic.units` (combinational) nor
 * `logic.step`/`outputs` (sequential) — it carries a `memory` marker plus
 * `read`/`write` fns the engine dispatches to (see sim/chip-eval.js). The
 * `image` is passed IN as an argument (it lives with run-volatile state,
 * keyed by component id), so the shared/frozen def holds no per-instance bytes.
 *
 * @param {object} m
 * @param {number} m.size   addressable locations (a power of two = 2**addr.length)
 * @param {number} m.width  data-bus width in bits (8 or 16)
 * @param {number[]} m.addr address pins, LSB first (length = log2(size))
 * @param {number[]} m.data data pins, LSB first (length = width)
 * @param {number} m.ceN    active-low chip-enable pin
 * @param {number} m.oeN    active-low output-enable pin
 * @param {number} [m.weN]  active-low write-enable pin — OMIT for a read-only ROM
 * @param {number} [m.ce2]  optional active-HIGH second chip-enable (some SRAMs)
 * @param {boolean} [m.volatile]  true for SRAM — the contents are lost at power-
 *   off, so the chip is NEVER file-backed (run-volatile only). A non-volatile
 *   chip (ROM/EPROM/EEPROM) is file-backed and, in this app, read-only (the
 *   circuit can't drive its write cycle). Consumed by the SimController.
 * @param {Uint8Array|number[]|((size:number)=>Uint8Array|number[])} [m.initial]
 *   seed for a volatile image (undefined → zero-filled). Consumed by SimController.
 */
export function memUnit(m) {
  const mask = m.size - 1;
  const wordMask = (1 << m.width) - 1;
  const selected = (ins) =>
    ins.get(m.ceN) === L && (m.ce2 == null || ins.get(m.ce2) === H);
  const writing = (ins) => m.weN != null && ins.get(m.weN) === L;
  const address = (ins) => readBus(m.addr, ins) & mask;

  return {
    memory: {
      size: m.size,
      width: m.width,
      addr: m.addr,
      data: m.data,
      ceN: m.ceN,
      oeN: m.oeN,
      weN: m.weN ?? null,
      ce2: m.ce2 ?? null,
      volatile: m.volatile === true,
      initial: m.initial ?? null,
    },
    /** Data-pin levels driven this settle: the stored word, or Z when idle. */
    read(ins, image) {
      // Float unless selected, output-enabled, and not mid-write (so an
      // external writer owns the bus during a write cycle).
      const drive = selected(ins) && ins.get(m.oeN) === L && !writing(ins);
      if (!drive) return new Map(m.data.map((pin) => [pin, Z]));
      const word = image ? (image[address(ins)] ?? 0) : 0;
      return new Map(m.data.map((pin, i) => [pin, (word >> i) & 1 ? H : L]));
    },
    /** The write op to apply after this tick, or null (idle / read-only). */
    write(ins) {
      if (!writing(ins) || !selected(ins)) return null;
      return { addr: address(ins), value: readBus(m.data, ins) & wordMask };
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

/**
 * Quad 2-to-1 selector with 3-STATE outputs (74257/258-style): a shared select
 * and active-low output-enable `oeN` — disabled outputs float (`Z`), not LOW.
 * `invert` gives the inverting 258. `units` = [{a,b,y}…].
 * @param {{sel, oeN, invert?:boolean, units:Array<{a,b,y}>}} m
 */
export function selectorTsUnits(m) {
  return m.units.map((u) => {
    const inputs = [m.oeN, m.sel, u.a, u.b];
    return comb(inputs, u.y, ([oe, sel, a, b]) => {
      if (oe === H) return Z; // output disabled → high-impedance
      const v = sel === H ? asBit(b) : asBit(a);
      return m.invert ? inv(v) : v;
    });
  });
}

/**
 * A bank of 3-state buffers sharing one active-low enable (an octal driver's
 * 4-bit group — 74240 inverting / 74244 non-inverting). Each pair drives its
 * `y` from `a` while `enableN` is LOW, else floats (`Z`).
 * @param {{enableN, invert?:boolean, pairs:Array<{a,y}>}} m
 */
export function busDriverUnits(m) {
  return m.pairs.map((p) => {
    const inputs = [m.enableN, p.a];
    return comb(inputs, p.y, ([oe, a]) => {
      if (oe === H) return Z;
      return m.invert ? inv(asBit(a)) : asBit(a);
    });
  });
}

/**
 * Octal bus transceiver (74245-style): each A/B pin PAIR is BIDIRECTIONAL. With
 * the active-low output-enable `oeN` low, data flows A→B when `dir` is HIGH and
 * B→A when LOW; the passive side (and both sides while disabled) is
 * high-impedance (`Z`). The A/B pins carry the catalog's `io` role — a unit
 * both reads and drives them, which the engine already permits (it drives
 * whatever a unit returns, and reads every pin's net level). Each direction is
 * a separate COMB unit, so a pin is driven exactly once and read once.
 * @param {{dir, oeN, pairs:Array<{a,b}>}} m
 */
export function transceiverUnits(m) {
  const units = [];
  for (const { a, b } of m.pairs) {
    // B follows A when enabled and pointing A→B; otherwise it floats.
    units.push(
      comb([m.dir, m.oeN, a], b, ([dir, oe, av]) =>
        oe === H ? Z : dir === H ? asBit(av) : Z,
      ),
    );
    // A follows B when enabled and pointing B→A; otherwise it floats.
    units.push(
      comb([m.dir, m.oeN, b], a, ([dir, oe, bv]) =>
        oe === H ? Z : dir === L ? asBit(bv) : Z,
      ),
    );
  }
  return units;
}

/**
 * 4-bit binary full adder (74283-style). `a`/`b` are the addend bit pins LSB
 * first, `cin` the carry-in, `s` the sum pins LSB first, `cout` the carry-out.
 * @param {{a:number[], b:number[], cin, s:number[], cout}} m
 */
export function adder4Units(m) {
  const inputs = [...m.a, ...m.b, m.cin];
  const total = (levels) => {
    const byPin = new Map(inputs.map((p, i) => [p, levels[i]]));
    const a = readBus(m.a, byPin);
    const b = readBus(m.b, byPin);
    return a + b + (high(byPin.get(m.cin)) ? 1 : 0);
  };
  const units = m.s.map((pin, i) =>
    comb(inputs, pin, (levels) => ((total(levels) >> i) & 1 ? H : L)),
  );
  units.push(comb(inputs, m.cout, (levels) => (total(levels) > 15 ? H : L)));
  return units;
}

/**
 * 4-bit magnitude comparator (7485-style). `a`/`b` are the operand pins LSB
 * first; `gtIn`/`eqIn`/`ltIn` the cascade inputs; `gtOut`/`eqOut`/`ltOut` the
 * results. On equality the outputs follow the cascade inputs (so stages chain).
 * @param {{a:number[], b:number[], gtIn, eqIn, ltIn, gtOut, eqOut, ltOut}} m
 */
export function comparator4Units(m) {
  const inputs = [...m.a, ...m.b, m.gtIn, m.eqIn, m.ltIn];
  const decide = (levels) => {
    const byPin = new Map(inputs.map((p, i) => [p, levels[i]]));
    const a = readBus(m.a, byPin);
    const b = readBus(m.b, byPin);
    if (a > b) return { gt: H, eq: L, lt: L };
    if (a < b) return { gt: L, eq: L, lt: H };
    // Equal: the datasheet-exact cascade form (reproduces the abnormal rows a
    // naive pass-through would miss). OA>B = AEB·ĪA=B·ĪA<B, etc.
    const igt = high(byPin.get(m.gtIn));
    const ieq = high(byPin.get(m.eqIn));
    const ilt = high(byPin.get(m.ltIn));
    return {
      gt: !ieq && !ilt ? H : L,
      eq: ieq ? H : L,
      lt: !ieq && !igt ? H : L,
    };
  };
  return [
    comb(inputs, m.gtOut, (l) => decide(l).gt),
    comb(inputs, m.eqOut, (l) => decide(l).eq),
    comb(inputs, m.ltOut, (l) => decide(l).lt),
  ];
}

/**
 * 8-to-3 priority encoder (74148-style), all active-low. `data` lists I0…I7,
 * `eiN` the enable-in; `a` the address output pins A0…A2 (active-low), `gsN`
 * the group-strobe, `eoN` the enable-out. Highest index wins; a floating (Z)
 * input reads HIGH = inactive.
 * @param {{data:number[], eiN, a:number[], gsN, eoN}} m
 */
export function priorityEncoder8Units(m) {
  const inputs = [...m.data, m.eiN];
  const state = (levels) => {
    const byPin = new Map(inputs.map((p, i) => [p, levels[i]]));
    if (byPin.get(m.eiN) !== L) return { enabled: false, idx: -1 };
    let idx = -1;
    for (let i = 7; i >= 0; i--) {
      if (byPin.get(m.data[i]) === L) {
        idx = i;
        break;
      }
    }
    return { enabled: true, idx };
  };
  const units = m.a.map((pin, k) =>
    comb(inputs, pin, (levels) => {
      const s = state(levels);
      if (!s.enabled || s.idx < 0) return H; // idle → active-low outputs high
      return (s.idx >> k) & 1 ? L : H; // address, active-low
    }),
  );
  units.push(
    comb(inputs, m.gsN, (levels) => {
      const s = state(levels);
      return s.enabled && s.idx >= 0 ? L : H;
    }),
  );
  units.push(
    comb(inputs, m.eoN, (levels) => {
      const s = state(levels);
      return s.enabled && s.idx < 0 ? L : H; // enabled, nothing active
    }),
  );
  return units;
}

/**
 * BCD-to-seven-segment decoder (7447-style), active-LOW segment outputs.
 * `bcd` lists A…D (LSB first); active-low controls `biN` blanking-input,
 * `ltN` lamp-test, `rbiN` ripple-blank-in; `seg` the seven segment pins a…g.
 * `patterns` is a 16-entry table of 7-bit segment-ON masks (a…g) — the
 * display font (incl. the 7447 6/9 quirks) baked in as DATA. Priority matches
 * the datasheet: BI (all off) → lamp-test (all on) → zero-blank → decode. The
 * chip's BI/RBO pin is bidirectional; we model its dominant BI (input)
 * direction, so ripple-blank-OUT cascading is out of scope.
 * @param {{bcd:number[], biN, ltN, rbiN, seg:number[], patterns:number[][]}} m
 */
export function bcd7segUnits(m) {
  const inputs = [...m.bcd, m.biN, m.ltN, m.rbiN];
  const decode = (levels) => {
    const byPin = new Map(inputs.map((p, i) => [p, levels[i]]));
    if (byPin.get(m.biN) === L) return [0, 0, 0, 0, 0, 0, 0]; // blank (dominant)
    if (byPin.get(m.ltN) === L) return [1, 1, 1, 1, 1, 1, 1]; // lamp test
    const v = readBus(m.bcd, byPin);
    if (byPin.get(m.rbiN) === L && v === 0) return [0, 0, 0, 0, 0, 0, 0]; // zero-blank
    return m.patterns[v];
  };
  return m.seg.map((pin, i) =>
    comb(inputs, pin, (levels) => (decode(levels)[i] ? L : H)),
  );
}

// ── Sequential families added with the 74LS wave ─────────────────────────────

/**
 * Synchronous 4-bit up/down binary counter with a SINGLE clock and a direction
 * pin (74169-style): rising-edge clocked, `updn` HIGH counts up / LOW down,
 * active-low count-enables `enPN` & `enTN`, active-low synchronous `loadN`
 * (load beats count). Active-low ripple carry `rcoN` asserts at the terminal
 * count (15 up / 0 down) while `enTN` is LOW.
 * @param {{clk,updn,enPN,enTN,loadN,data:number[],q:number[],rcoN}} m
 */
export function upDownCounter4Sync(m) {
  return {
    state0: () => ({ n: 0 }),
    step(s, ins, prev) {
      if (prev && edgeRose(prev.get(m.clk), ins.get(m.clk))) {
        if (ins.get(m.loadN) === L) return { n: readBus(m.data, ins) };
        if (ins.get(m.enPN) === L && ins.get(m.enTN) === L) {
          const up = high(ins.get(m.updn));
          return { n: (s.n + (up ? 1 : 15)) & 15 };
        }
      }
      return { n: s.n };
    },
    outputs(s, ins) {
      const bits = busBits(s.n, 4);
      const out = new Map(m.q.map((pin, i) => [pin, bits[i]]));
      const terminal = high(ins.get(m.updn)) ? s.n === 15 : s.n === 0;
      out.set(m.rcoN, ins.get(m.enTN) === L && terminal ? L : H);
      return out;
    },
  };
}

/**
 * 4-bit D register with 3-STATE outputs (74173-style): positive-edge common
 * clock, active-HIGH async `clr`, two active-low data-enables `gN` (BOTH low to
 * load, else hold), two active-low output-enables `oeN` (BOTH low to drive,
 * else `Z`). `d`/`q` are the data/output pins.
 * @param {{clk,clr,gN:number[],oeN:number[],d:number[],q:number[]}} m
 */
export function registerTs4(m) {
  const width = m.d.length;
  return {
    state0: () => ({ bits: Array(width).fill(L) }),
    step(s, ins, prev) {
      if (ins.get(m.clr) === H) return { bits: Array(width).fill(L) };
      if (prev && edgeRose(prev.get(m.clk), ins.get(m.clk))) {
        if (m.gN.every((p) => ins.get(p) === L)) {
          return { bits: m.d.map((pin) => asBit(ins.get(pin))) };
        }
      }
      return s;
    },
    outputs(s, ins) {
      const on = m.oeN.every((p) => ins.get(p) === L);
      return new Map(m.q.map((pin, i) => [pin, on ? s.bits[i] : Z]));
    },
  };
}

/**
 * Octal transparent D latch with 3-STATE outputs (74573 non-inverting /
 * 74533 inverting): while latch-enable `le` is HIGH the outputs follow D;
 * while LOW they hold. Active-low output-enable `oeN` floats the pins (`Z`).
 * @param {{d:number[],q:number[],le,oeN,invert?:boolean}} m
 */
export function latchTs(m) {
  const width = m.d.length;
  return {
    state0: () => ({ bits: Array(width).fill(L) }),
    step(s, ins) {
      if (ins.get(m.le) === H)
        return { bits: m.d.map((p) => asBit(ins.get(p))) };
      return s;
    },
    outputs(s, ins) {
      const on = ins.get(m.oeN) === L;
      const transparent = ins.get(m.le) === H;
      return new Map(
        m.q.map((pin, i) => {
          if (!on) return [pin, Z];
          const bit = transparent ? asBit(ins.get(m.d[i])) : s.bits[i];
          return [pin, m.invert ? inv(bit) : bit];
        }),
      );
    },
  };
}

/**
 * 8-bit addressable latch (74259-style), level-sensitive. `sel` are the three
 * address pins (LSB first), `d` the data input, `gN` the active-low enable,
 * `clrN` the active-low clear, `q` the eight outputs. The four modes fall out
 * of (clrN, gN): addressable-latch, memory, demux, clear.
 * @param {{sel:number[], d, gN, clrN, q:number[]}} m
 */
export function addressableLatch8(m) {
  const resolve = (s, ins) => {
    const clr = ins.get(m.clrN) === L;
    const en = ins.get(m.gN) === L;
    const bits = clr ? Array(8).fill(L) : s.bits.slice();
    if (en) bits[readBus(m.sel, ins)] = asBit(ins.get(m.d)); // addressed follows D
    return bits;
  };
  return {
    state0: () => ({ bits: Array(8).fill(L) }),
    step: (s, ins) => ({ bits: resolve(s, ins) }),
    outputs: (s, ins) =>
      new Map(m.q.map((pin, i) => [pin, resolve(s, ins)[i]])),
  };
}

/**
 * S̄R̄ latch (74279-style), asynchronous, active-low. `sN` is one set pin or a
 * list of set pins (any LOW sets — the dual-set latches); `rN` resets. Both
 * low → Q HIGH (the NAND-latch resolution). Q output only.
 * @param {{sN:number|number[], rN, q}} m
 */
export function srLatchUnit(m) {
  const setPins = Array.isArray(m.sN) ? m.sN : [m.sN];
  const level = (s, ins) => {
    const set = setPins.some((p) => ins.get(p) === L);
    if (set) return H; // set wins (both-low → H on a NAND latch)
    if (ins.get(m.rN) === L) return L;
    return s.q;
  };
  return {
    state0: () => ({ q: L }),
    step: (s, ins) => ({ q: level(s, ins) }),
    outputs: (s, ins) => new Map([[m.q, level(s, ins)]]),
  };
}

/**
 * 8-bit serial-in shift register with an output storage register and 3-state
 * parallel outputs (74595-style). Two clocks: `shcp` shifts `ds` in on its
 * rising edge (async active-low master reset `mrN` clears the shift register);
 * `stcp` latches the shift register into the storage register on its rising
 * edge. Parallel outputs `q` are gated by active-low `oeN` (else `Z`); the
 * serial output `q7s` (the last shift stage) is never tri-stated.
 * @param {{ds,shcp,stcp,mrN,oeN,q:number[],q7s}} m
 */
export function shiftRegister595(m) {
  return {
    state0: () => ({ shift: Array(8).fill(L), store: Array(8).fill(L) }),
    step(s, ins, prev) {
      let shift = s.shift;
      if (ins.get(m.mrN) === L) {
        shift = Array(8).fill(L);
      } else if (prev && edgeRose(prev.get(m.shcp), ins.get(m.shcp))) {
        shift = [asBit(ins.get(m.ds)), ...s.shift.slice(0, 7)];
      }
      const store =
        prev && edgeRose(prev.get(m.stcp), ins.get(m.stcp))
          ? shift.slice()
          : s.store;
      return { shift, store };
    },
    outputs(s, ins) {
      const on = ins.get(m.oeN) === L;
      const out = new Map(m.q.map((pin, i) => [pin, on ? s.store[i] : Z]));
      out.set(m.q7s, s.shift[7]); // serial cascade out — always driven
      return out;
    },
  };
}

/**
 * Decade (÷10) ripple counter (7490-style): two independent sections — a ÷2
 * stage (`qa`, clocked on the falling edge of `cka`) and a ÷5 stage
 * (`qb`/`qc`/`qd`, clocked on the falling edge of `ckb`). Async gated resets:
 * `r0` = both R0 inputs HIGH → 0; `r9` = both R9 inputs HIGH → 9 (priority).
 * Wire QA→CKB externally for a BCD decade count.
 * @param {{cka,ckb,r0:number[],r9:number[],qa,qb,qc,qd}} m
 */
export function decadeCounter7490(m) {
  const reset9 = (ins) => m.r9.every((p) => ins.get(p) === H);
  const reset0 = (ins) => m.r0.every((p) => ins.get(p) === H);
  return {
    state0: () => ({ a: L, v: 0 }), // a = QA; v = the ÷5 stage's 0…4 count
    step(s, ins, prev) {
      if (reset9(ins)) return { a: H, v: 4 }; // 1001 = 9 (QD QC QB QA)
      if (reset0(ins)) return { a: L, v: 0 };
      let a = s.a;
      let v = s.v;
      if (prev && edgeFell(prev.get(m.cka), ins.get(m.cka))) a = inv(a);
      if (prev && edgeFell(prev.get(m.ckb), ins.get(m.ckb))) v = (v + 1) % 5;
      return { a, v };
    },
    outputs: (s) =>
      new Map([
        [m.qa, s.a],
        [m.qb, s.v & 1 ? H : L],
        [m.qc, (s.v >> 1) & 1 ? H : L],
        [m.qd, (s.v >> 2) & 1 ? H : L],
      ]),
  };
}
