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
// `inputs`/`prevInputs` are Map<pin, level>, already read through the part's
// family reader (Z→H for TTL, Z→X for CMOS) so only H/L/X reach here. Edge
// detection compares prev vs current; async (level-sensitive)
// preset/clear/load/reset override the clocked path per datasheet.
// Combinational MSI parts (decoders, muxes) live here too as `COMB` unit
// builders — their inputs legitimately fan out to every output.
//
// UNKNOWN STATE (Feature 400). The TTL builders read an `X` control or clock
// as a clean LOW — a floating TTL input never reaches them as X, and changing
// what a 74LS part does on a fought-over net is not this feature's business.
// A CMOS part's floating input DOES arrive as X, and reading it as LOW would
// hide the classic mistake (a 4017 with RESET left open counts perfectly in a
// sim and erratically on a bench). So the CMOS units — `dffUnit` and `jkUnit`
// with `unknown: true`, `johnsonCounter`, `binaryCounter`, and the batch-2 MSI
// builders at the end of the file — carry an unknown state:
//   · an X on an async input makes the state unknown;
//   · an X on the clock (now, or on the sample before) MIGHT have clocked, so
//     the state becomes whatever the clocked and the held value agree on —
//     unknown wherever they differ;
//   · an unknown state drives X on every output it governs;
//   · a clean async reset/set (or, for a D-FF, a clean edge with clean D)
//     makes it known again.
// Power-up stays deterministic, as on the TTL parts: an unknown power-up
// would leave an un-reset 4017 chaser dark forever, which no real 4017 does.
// Every rule is idempotent, so a stuck X settles the tick's step fixpoint.

import { H, L, Z, X, and, inv, overUnknowns } from "./levels.js";

/** A control/data line reads as a clean bit: H stays H, everything else L. */
const asBit = (lv) => (lv === H ? H : L);
const high = (lv) => lv === H;
const edgeRose = (p, c) => p === L && c === H;
const edgeFell = (p, c) => p === H && c === L;
/** A clean bit, or X when the level is anything but H/L (the CMOS units). */
const bitX = (lv) => (lv === H || lv === L ? lv : X);
/** Two candidate states agree, or are unknown: the "might have clocked" merge. */
const merge = (a, b) => (a === b ? a : X);
/**
 * Did the clock produce an edge in `dir` ("rise"|"fall")? "yes" for a clean
 * transition, "maybe" when either sample is unknown (a floating clock picks up
 * whatever is near it), "no" otherwise. The CMOS units' edge test.
 */
function edgeOf(p, c, dir) {
  if (p === X || c === X) return "maybe";
  if (dir === "fall") return edgeFell(p, c) ? "yes" : "no";
  return edgeRose(p, c) ? "yes" : "no";
}
/** True when any of `levels` is unknown/contested — a shorted or conflicting
    net (never Z; callers always asInput() first). Used by the COMB units
    below to propagate X instead of silently reading it as a clean L, the way
    `asBit`/`high` do for ordinary clocked control lines. */
const anyX = (levels) => levels.some((lv) => lv === X);

/** A clean little-endian list of levels → its number. */
const bitsValue = (bits) =>
  bits.reduce((n, lv, i) => n + (lv === H ? 1 << i : 0), 0);

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

/**
 * Resolve async preset/clear. Returns a state or null. The ACTIVE LEVEL is per
 * pin: `preN`/`clrN` are active-LOW (the 74LS74's PRE̅/CLR̅), `set`/`reset`
 * active-HIGH (the CD4013B's SET/RESET); a part names whichever it has. Both
 * asserted is the datasheet's both-outputs-HIGH case either way.
 */
function asyncOverride(ins, m) {
  const pre =
    (m.preN != null && ins.get(m.preN) === L) ||
    (m.set != null && ins.get(m.set) === H);
  const clr =
    (m.clrN != null && ins.get(m.clrN) === L) ||
    (m.reset != null && ins.get(m.reset) === H);
  if (pre && clr) return { q: H, both: true };
  if (clr) return { q: L };
  if (pre) return { q: H };
  return null;
}

/**
 * The unknown-aware async override (CMOS units): as `asyncOverride`, but a
 * control at X MIGHT be asserted, so whenever one is in doubt the state is
 * unknown. (Set HIGH with reset in doubt does pin Q HIGH, but Q̄ is then either
 * level, and the unit keeps one Q for both — so the honest answer is X.)
 * Returns a state, or null when neither is, or might be, asserted.
 */
function asyncOverrideX(ins, m) {
  const level = (pin, active) => {
    if (pin == null) return "off";
    const lv = ins.get(pin);
    if (lv === X) return "maybe";
    return lv === active ? "on" : "off";
  };
  const pre = m.preN != null ? level(m.preN, L) : level(m.set, H);
  const clr = m.clrN != null ? level(m.clrN, L) : level(m.reset, H);
  if (pre === "off" && clr === "off") return null;
  if (pre === "on" && clr === "on") return { q: H, both: true };
  if (pre === "on" && clr === "off") return { q: H };
  if (clr === "on" && pre === "off") return { q: L };
  return { q: X };
}

/**
 * Edge-triggered D flip-flop with optional async preset/clear — active-LOW
 * (`preN`/`clrN`) or active-HIGH (`set`/`reset`). `unknown: true` makes it a
 * CMOS unit that carries an unknown state (see the header).
 * @param {{d,clk,preN?,clrN?,set?,reset?,q,qn?,edge?,unknown?}} m - pin map;
 *   `edge` "rise"|"fall".
 */
export function dffUnit(m) {
  const clocked = m.edge === "fall" ? edgeFell : edgeRose;
  if (m.unknown) {
    return {
      state0: () => ({ q: L }),
      step(s, ins, prev) {
        const forced = asyncOverrideX(ins, m);
        if (forced) return forced;
        const edge = prev
          ? edgeOf(prev.get(m.clk), ins.get(m.clk), m.edge ?? "rise")
          : "no";
        const d = bitX(ins.get(m.d));
        if (edge === "yes") return { q: d };
        if (edge === "maybe") return { q: merge(s.q, d) };
        return { q: s.q };
      },
      outputs: (s) => ffOutputs(s, m.q, m.qn),
    };
  }
  return {
    state0: () => ({ q: L }),
    step(s, ins, prev) {
      const forced = asyncOverride(ins, m);
      if (forced) return forced;
      if (prev && clocked(prev.get(m.clk), ins.get(m.clk))) {
        return { q: asBit(ins.get(m.d)) };
      }
      return { q: s.q };
    },
    outputs: (s) => ffOutputs(s, m.q, m.qn),
  };
}

/** A JK flip-flop's next Q for one clean reading of Q, J and K. */
function jkNext(q, j, k) {
  if (j === H && k === H) return inv(q); // toggle
  if (j === H) return H; // set
  if (k === H) return L; // reset
  return q; // hold
}

/**
 * Edge-triggered JK flip-flop with optional async preset/clear — active-LOW
 * (`preN`/`clrN`, the 74LS parts) or active-HIGH (`set`/`reset`, the CD4027B).
 * `unknown: true` makes it a CMOS unit that carries an unknown state, as
 * `dffUnit`'s does: a floating J or K makes the clocked value whatever every
 * reading of it agrees on (J=1, K=X sets or toggles — from Q LOW both give
 * HIGH, so that one stays known).
 * @param {{j,k,clk,preN?,clrN?,set?,reset?,q,qn?,edge?,unknown?}} m - `edge`
 *   defaults "fall".
 */
export function jkUnit(m) {
  const clocked = m.edge === "rise" ? edgeRose : edgeFell;
  if (m.unknown) {
    return {
      state0: () => ({ q: L }),
      step(s, ins, prev) {
        const forced = asyncOverrideX(ins, m);
        if (forced) return forced;
        const edge = prev
          ? edgeOf(prev.get(m.clk), ins.get(m.clk), m.edge ?? "fall")
          : "no";
        if (edge === "no") return { q: s.q };
        const next = overUnknowns(
          [s.q, bitX(ins.get(m.j)), bitX(ins.get(m.k))],
          ([q, j, k]) => jkNext(q, j, k),
        );
        return { q: edge === "yes" ? next : merge(s.q, next) };
      },
      outputs: (s) => ffOutputs(s, m.q, m.qn),
    };
  }
  return {
    state0: () => ({ q: L }),
    step(s, ins, prev) {
      const forced = asyncOverride(ins, m);
      if (forced) return forced;
      if (prev && clocked(prev.get(m.clk), ins.get(m.clk))) {
        return { q: jkNext(s.q, asBit(ins.get(m.j)), asBit(ins.get(m.k))) };
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
      // A confidently-disabled decoder is H regardless of an unknown select
      // bus (dominant, same shortcut the gate primitives use) — only while
      // enabled does an X select bit make the address genuinely uncertain.
      if (!en) return H;
      if (m.sel.some((p) => byPin.get(p) === X)) return X;
      const value = m.sel.reduce(
        (n, p, i) => n + (high(byPin.get(p)) ? 1 << i : 0),
        0,
      );
      return value === addr ? L : H;
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
    if (m.strobeN != null) {
      const strobe = byPin.get(m.strobeN);
      if (strobe === H) return L; // confidently disabled (dominant)
      if (strobe === X) return X; // unknown whether enabled at all
    }
    if (m.sel.some((p) => byPin.get(p) === X)) return X; // address uncertain
    const addr = m.sel.reduce(
      (n, p, i) => n + (high(byPin.get(p)) ? 1 << i : 0),
      0,
    );
    return byPin.get(m.data[addr]); // route the selected input as-is (X-preserving)
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
      if (strobe === H) return L; // confidently disabled (dominant)
      if (strobe === X || sel === X) return X; // enable/select uncertain
      return sel === H ? b : a; // route the selected input as-is
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
      if (oe === X || sel === X) return X; // enable/select uncertain
      const v = sel === H ? b : a; // route the selected input as-is
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
      if (oe === X) return X; // unknown whether enabled at all
      return m.invert ? inv(a) : a; // pass through as-is (X-preserving)
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
    // B follows A when enabled and pointing A→B; otherwise it floats — unless
    // `dir`/`oeN` is itself unknown, in which case whether this side drives
    // at all is uncertain, so it reads X rather than confidently floating.
    units.push(
      comb([m.dir, m.oeN, a], b, ([dir, oe, av]) => {
        if (oe === H) return Z;
        if (oe === X) return X;
        if (dir === H) return av; // pass through as-is (X-preserving)
        if (dir === L) return Z;
        return X; // dir unknown
      }),
    );
    // A follows B when enabled and pointing B→A; otherwise it floats.
    units.push(
      comb([m.dir, m.oeN, b], a, ([dir, oe, bv]) => {
        if (oe === H) return Z;
        if (oe === X) return X;
        if (dir === L) return bv; // pass through as-is (X-preserving)
        if (dir === H) return Z;
        return X; // dir unknown
      }),
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
  // A contested/shorted operand bit makes the whole sum uncertain (carry
  // ripples through every more-significant bit) — coarse but sound, rather
  // than confidently computing a specific wrong total off a collapsed X.
  const units = m.s.map((pin, i) =>
    comb(inputs, pin, (levels) =>
      anyX(levels) ? X : (total(levels) >> i) & 1 ? H : L,
    ),
  );
  units.push(
    comb(inputs, m.cout, (levels) =>
      anyX(levels) ? X : total(levels) > 15 ? H : L,
    ),
  );
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
  // A contested/shorted operand or cascade bit makes the comparison itself
  // uncertain — coarse but sound, rather than confidently comparing off a
  // collapsed X.
  return [
    comb(inputs, m.gtOut, (l) => (anyX(l) ? X : decide(l).gt)),
    comb(inputs, m.eqOut, (l) => (anyX(l) ? X : decide(l).eq)),
    comb(inputs, m.ltOut, (l) => (anyX(l) ? X : decide(l).lt)),
  ];
}

/**
 * 4-bit Arithmetic Logic Unit (74181-style). `a`/`b` are the operand pins LSB
 * first, `s` the four function-select pins LSB first (S0..S3), `m` the mode
 * control (H = logic, L = arithmetic), `cin` the carry-in. Drives `f` (F0..F3,
 * LSB first), and optionally `cout` (Cn+4), `gN`/`pN` (carry generate /
 * propagate, for cascading ALUs through a lookahead unit — only meaningful in
 * arithmetic mode; carries are inhibited in logic mode so they read inactive
 * there), and `aeqb` (A=B — open-collector on the real part, wired-AND across
 * cascaded ALUs; modelled here as a plain output, the same simplification as
 * this catalog's other open-collector parts).
 *
 * Everything is stated in the datasheet's ACTIVE-HIGH-data convention, where
 * the CARRIES are active-LOW at both ends: Cn = L asserts a carry in, and
 * Cn+4 = L reports one out — so the Cn+4 of one ALU wires straight to the Cn of
 * the next, as the datasheet's ripple cascade does. G and P are active-low too.
 *
 * THE FUNCTIONS ARE DERIVED FROM THE CHIP'S OWN STRUCTURE, not transcribed
 * from its function table — a transcription took two rows from the active-LOW
 * column and read three "+"s (the table's OR) as "plus", and its tests were
 * written from the same misreading. Each bit forms an OR-term and an AND-term
 * from its operands under S (Fairchild DM74LS181 / TI SN74LS181 logic diagram):
 *
 *     X = A | (B & S0) | (~B & S1)        Y = (A & ~B & S2) | (A & B & S3)
 *
 * Logic mode drives ¬(X ⊕ Y); arithmetic mode drives X PLUS Y PLUS carry. Y is
 * never set where X is clear, so per bit X is the carry PROPAGATE and Y the
 * carry GENERATE: the group generates when X + Y alone carries out, and
 * propagates when every bit of X is set. `tests/chips-74ls.test.js` holds all
 * 32 functions to the datasheet's table, written out by name.
 * @param {{a:number[], b:number[], s:number[], m, cin, f:number[], cout?, gN?, pN?, aeqb?}} m_
 */
export function alu4Units(m_) {
  const inputs = [...m_.a, ...m_.b, ...m_.s, m_.m, m_.cin];
  const mask = 0xf;
  const compute = (levels) => {
    const byPin = new Map(inputs.map((p, i) => [p, levels[i]]));
    const a = readBus(m_.a, byPin);
    const b = readBus(m_.b, byPin);
    const sel = readBus(m_.s, byPin);
    const bit = (n) => ((sel >> n) & 1 ? mask : 0);
    const nb = ~b & mask;
    const x = a | (b & bit(0)) | (nb & bit(1));
    const y = (a & nb & bit(2)) | (a & b & bit(3));
    if (high(byPin.get(m_.m))) {
      const f = ~(x ^ y) & mask;
      return { f, total: 0, generate: false, propagate: false };
    }
    const cin = byPin.get(m_.cin) === L ? 1 : 0; // Cn is active-low.
    const total = x + y + cin;
    return {
      f: total & mask,
      total,
      // Neither depends on the carry-in (datasheet-stated).
      generate: x + y > mask,
      propagate: x === mask,
    };
  };
  // A contested/shorted operand, select, or control bit makes every ALU
  // output uncertain — coarse but sound, rather than confidently computing a
  // specific wrong result off a collapsed X.
  const units = m_.f.map((pin, i) =>
    comb(inputs, pin, (levels) =>
      anyX(levels) ? X : (compute(levels).f >> i) & 1 ? H : L,
    ),
  );
  if (m_.cout != null) {
    units.push(
      comb(inputs, m_.cout, (levels) =>
        anyX(levels) ? X : compute(levels).total > mask ? L : H,
      ),
    );
  }
  if (m_.gN != null) {
    units.push(
      comb(inputs, m_.gN, (levels) =>
        anyX(levels) ? X : compute(levels).generate ? L : H,
      ),
    );
  }
  if (m_.pN != null) {
    units.push(
      comb(inputs, m_.pN, (levels) =>
        anyX(levels) ? X : compute(levels).propagate ? L : H,
      ),
    );
  }
  if (m_.aeqb != null) {
    units.push(
      comb(inputs, m_.aeqb, (levels) =>
        anyX(levels) ? X : compute(levels).f === mask ? H : L,
      ),
    );
  }
  return units;
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
    const ei = byPin.get(m.eiN);
    if (ei === H) return { enabled: false, idx: -1 }; // confidently idle
    if (ei === X) return { unknown: true }; // unknown whether enabled at all
    // ei === L (enabled): scan from the highest index down. A definite L
    // dominates everything below it (real priority-encoder behaviour), so
    // only an X encountered BEFORE any definite L leaves the result unknown
    // — it might be the true (higher-priority) winner, or might not.
    for (let i = 7; i >= 0; i--) {
      const d = byPin.get(m.data[i]);
      if (d === L) return { enabled: true, idx: i };
      if (d === X) return { unknown: true };
    }
    return { enabled: true, idx: -1 };
  };
  const units = m.a.map((pin, k) =>
    comb(inputs, pin, (levels) => {
      const s = state(levels);
      if (s.unknown) return X;
      if (!s.enabled || s.idx < 0) return H; // idle → active-low outputs high
      return (s.idx >> k) & 1 ? L : H; // address, active-low
    }),
  );
  units.push(
    comb(inputs, m.gsN, (levels) => {
      const s = state(levels);
      if (s.unknown) return X;
      return s.enabled && s.idx >= 0 ? L : H;
    }),
  );
  units.push(
    comb(inputs, m.eoN, (levels) => {
      const s = state(levels);
      if (s.unknown) return X;
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
    if (byPin.get(m.ltN) === L) return [1, 1, 1, 1, 1, 1, 1]; // lamp test (dominant)
    // Neither dominant override applies — an unknown control or BCD bit now
    // genuinely makes the decode uncertain (null; the caller reads that as X
    // per segment), rather than silently reading it as a clean digit.
    if (
      byPin.get(m.biN) === X ||
      byPin.get(m.ltN) === X ||
      byPin.get(m.rbiN) === X ||
      m.bcd.some((p) => byPin.get(p) === X)
    ) {
      return null;
    }
    const v = readBus(m.bcd, byPin);
    if (byPin.get(m.rbiN) === L && v === 0) return [0, 0, 0, 0, 0, 0, 0]; // zero-blank
    return m.patterns[v];
  };
  return m.seg.map((pin, i) =>
    comb(inputs, pin, (levels) => {
      const d = decode(levels);
      return d ? (d[i] ? L : H) : X;
    }),
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

// ── CMOS counters (Feature 400) — unknown-aware, see the header ─────────────

/**
 * The async reset of a CMOS counter, read three ways: "on" (clean HIGH),
 * "off" (clean LOW), or "maybe" (X — a floating reset line).
 */
function resetLevel(ins, pin) {
  const lv = ins.get(pin);
  if (lv === X) return "maybe";
  return lv === H ? "on" : "off";
}

/**
 * Johnson counter with fully DECODED outputs (CD4017B-style; the CD4022B is
 * the same counter with `length: 8`). One decoded output per count is HIGH;
 * the count advances on the RISING edge of the GATED clock `CLOCK · ¬INHIBIT`
 * — which is the datasheet's two ways in one rule: a rising CLOCK while
 * CLOCK INHIBIT is LOW, or a falling CLOCK INHIBIT while CLOCK is HIGH (the
 * footnote's "pin 13 as the clock input, pin 14 tied high"). A HIGH RESET
 * clears to count 0, asynchronously. CARRY OUT is HIGH for the first half of
 * the cycle (counts 0…length/2−1) and LOW for the second, so it rises once per
 * `length` clocks — the edge that ripple-clocks the next counter.
 *
 * Unknown state: `n: null`. The ternary AND is what makes the gating honest —
 * a floating INHIBIT while CLOCK is LOW cannot clock anything, so only an X
 * on the gated clock itself puts the count in doubt.
 *
 * @param {{clk,inh,reset,outs:number[],carry,length?:number}} m - `outs` are
 *   the decoded output pins for counts 0…length−1, in count order.
 */
export function johnsonCounter(m) {
  const length = m.length ?? m.outs.length;
  const gated = (ins) => and(ins.get(m.clk), inv(ins.get(m.inh)));
  return {
    state0: () => ({ n: 0 }),
    step(s, ins, prev) {
      const reset = resetLevel(ins, m.reset);
      if (reset === "on") return { n: 0 };
      if (reset === "maybe") return { n: null };
      const edge = prev ? edgeOf(gated(prev), gated(ins), "rise") : "no";
      if (edge === "no" || s.n === null) return { n: s.n };
      if (edge === "yes") return { n: (s.n + 1) % length };
      return { n: null }; // "maybe": advanced or held — no longer known
    },
    outputs(s) {
      const out = new Map();
      m.outs.forEach((pin, i) => {
        out.set(pin, s.n === null ? X : s.n === i ? H : L);
      });
      out.set(m.carry, s.n === null ? X : s.n < length / 2 ? H : L);
      return out;
    },
  };
}

/**
 * N-stage binary counter (CD4040B-style: 12 stages; the CD4020B's 14 and the
 * CD4024B's 7 are the same builder with another `q` list). Advances one count
 * on the FALLING edge of its input pulse; a HIGH RESET clears every stage,
 * asynchronously. `q` lists the stage outputs Q1…Qn, LSB first.
 *
 * A real ripple counter's stages settle one after another, so its outputs
 * pass through intermediate codes; this engine has zero delay and Feature 220
 * completes a ripple inside one tick, so they cannot appear here, and the
 * whole count changes at once.
 *
 * A stage the package has no pin for is `null` in `q` — the CD4020B brings
 * out Q1 and Q4–Q14, so its Q2 and Q3 count but drive nothing.
 *
 * Unknown state: `n: null`.
 * @param {{clk,reset,q:Array<number|null>,edge?:"rise"|"fall"}} m
 */
export function binaryCounter(m) {
  const modulus = 2 ** m.q.length;
  return {
    state0: () => ({ n: 0 }),
    step(s, ins, prev) {
      const reset = resetLevel(ins, m.reset);
      if (reset === "on") return { n: 0 };
      if (reset === "maybe") return { n: null };
      const edge = prev
        ? edgeOf(prev.get(m.clk), ins.get(m.clk), m.edge ?? "fall")
        : "no";
      if (edge === "no" || s.n === null) return { n: s.n };
      if (edge === "yes") return { n: (s.n + 1) % modulus };
      return { n: null };
    },
    outputs(s) {
      const bits = s.n === null ? null : busBits(s.n, m.q.length);
      const out = new Map();
      m.q.forEach((pin, i) => {
        if (pin != null) out.set(pin, bits ? bits[i] : X);
      });
      return out;
    },
  };
}

// ── CMOS MSI (Feature 410) — unknown-aware, see the header ──────────────────

/**
 * 8-stage shift-and-store bus register (CD4094B). DATA shifts into stage 1 on
 * CLOCK's RISING edge. Each stage has a storage latch that follows it while
 * STROBE is HIGH (transparent) and holds while it is LOW; OUTPUT ENABLE HIGH
 * puts the stored byte on Q1…Q8, LOW floats them (`Z`). Two serial outputs,
 * neither ever floated: QS is the 8th shift stage itself (it changes on the
 * rising edge), and Q'S takes that bit on the NEXT FALLING edge — the cascade
 * output for a slow clock, half a cycle later.
 *
 * Unknown-aware: every shift bit, stored bit and Q'S may be X — an X DATA
 * shifts in as X, a "maybe" edge leaves each bit whatever both outcomes agree
 * on, and a floating STROBE or OUTPUT ENABLE might be either.
 * @param {{data, clk, strobe, oe, q:number[], qs, qsn}} m - `q` the parallel
 *   outputs Q1…Qn, stage order; `qsn` is Q'S.
 */
export function shiftStoreRegister(m) {
  const width = m.q.length;
  const last = width - 1;
  /** What the latches hold or show for a STROBE level, given the shift bits. */
  const latched = (store, shift, strobe) => {
    if (strobe === H) return shift.slice();
    if (strobe === X) return store.map((b, i) => merge(b, shift[i]));
    return store;
  };
  return {
    state0: () => ({
      shift: Array(width).fill(L),
      store: Array(width).fill(L),
      qsn: L,
    }),
    step(s, ins, prev) {
      const clk = (dir) =>
        prev ? edgeOf(prev.get(m.clk), ins.get(m.clk), dir) : "no";
      const rise = clk("rise");
      let shift = s.shift;
      if (rise !== "no") {
        const shifted = [bitX(ins.get(m.data)), ...s.shift.slice(0, last)];
        shift =
          rise === "yes"
            ? shifted
            : shifted.map((b, i) => merge(b, s.shift[i]));
      }
      let qsn = s.qsn;
      const fall = clk("fall");
      if (fall === "yes") qsn = shift[last];
      // A floating clock might have fallen either side of a shift it might
      // also have made — Q'S keeps only what every case agrees on.
      if (fall === "maybe") qsn = merge(merge(qsn, s.shift[last]), shift[last]);
      return { shift, store: latched(s.store, shift, ins.get(m.strobe)), qsn };
    },
    outputs(s, ins) {
      const shown = latched(s.store, s.shift, ins.get(m.strobe));
      const oe = ins.get(m.oe);
      const out = new Map(
        m.q.map((pin, i) => [pin, oe === H ? shown[i] : oe === L ? Z : X]),
      );
      out.set(m.qs, s.shift[last]);
      out.set(m.qsn, s.qsn);
      return out;
    },
  };
}

/**
 * BCD-to-decimal (1-of-10) decoder with active-HIGH outputs (CD4028B): output
 * k is HIGH while the code on `bcd` is k, and a code of 10–15 — not a BCD
 * digit — leaves all ten LOW. COMB units over the four inputs; an unknown
 * input bit spoils only the outputs it could select (`overUnknowns`).
 * @param {{bcd:number[], out:number[]}} m - `bcd` A…D, LSB first; `out` the
 *   pins of outputs 0…9 in order.
 */
export function bcdDecimalUnits(m) {
  return m.out.map((pin, digit) =>
    comb(m.bcd, pin, (levels) =>
      overUnknowns(levels, (bits) => (bitsValue(bits) === digit ? H : L)),
    ),
  );
}

/**
 * BCD-to-7-segment LATCH/decoder/driver (CD4511B), active-HIGH outputs that
 * source a common-cathode display. LE LOW makes the 4-bit latch transparent
 * (the display follows the inputs); LE HIGH holds the code it had as LE went
 * HIGH. LT̄ LOW lights every segment whatever else is happening (lamp test);
 * otherwise BL̄ LOW blanks them all. The latch sits BEFORE the decoder, so
 * both act on a held code as on a live one. `font` gives each of the 16 codes'
 * segment masks (a…g) as DATA — codes 10–15 are blank on this part.
 * @param {{bcd:number[], le, ltN, blN, seg:number[], font:number[][]}} m -
 *   `bcd` A…D LSB first, `seg` the a…g pins.
 */
export function bcd7segLatch(m) {
  const live = (ins) => m.bcd.map((p) => bitX(ins.get(p)));
  /** The code the decoder sees: live, held, or (LE unknown) either. */
  const codeOf = (s, ins) => {
    const le = ins.get(m.le);
    if (le === L) return live(ins);
    if (le === H) return s.code;
    return live(ins).map((b, i) => merge(b, s.code[i]));
  };
  return {
    state0: () => ({ code: [L, L, L, L] }),
    step: (s, ins) => ({ code: codeOf(s, ins) }),
    outputs(s, ins) {
      const code = codeOf(s, ins);
      const blN = ins.get(m.blN);
      const ltN = ins.get(m.ltN);
      return new Map(
        m.seg.map((pin, i) => {
          const lit = overUnknowns(code, (bits) =>
            m.font[bitsValue(bits)][i] ? H : L,
          );
          const shown = blN === L ? L : blN === X ? merge(L, lit) : lit;
          return [pin, ltN === L ? H : ltN === X ? merge(H, shown) : shown];
        }),
      );
    },
  };
}

/**
 * The CD4510B's BCD next state, for ALL SIXTEEN states — read off the gates of
 * its logic diagram (SCHS071B Fig. 3), because a code above 9 is reachable
 * (the preset loads any binary number) and the sheet only bounds what follows
 * it: "will count out of non-BCD counter states in a maximum of two clock
 * pulses in the up mode, and a maximum of four clock pulses in the down mode".
 * These equations do exactly that (up: 10→11→6, 12→13→4, 14→15→2; down:
 * 11→10→13→12→3, 15→14→1). Each stage is a T flip-flop; Q1 always toggles,
 * and `carry` is the diagram's XNOR of UP/DOWN with Q1.
 */
function bcdNext(n, up) {
  const [q1, q2, q3, q4] = [1, 2, 4, 8].map((b) => (n & b) !== 0);
  const dn = !up;
  const carry = up === q1;
  const t2 = carry && !(up && q4) && !(dn && !q2 && !q3 && !q4);
  const t3 = carry && ((dn && !q2 && q3) || (up && q2) || (dn && q4));
  const t4 =
    carry &&
    ((up && q2 && q3) || (up && q4) || (dn && !q2 && !q3) || (q3 && q4));
  return n ^ 1 ^ (t2 ? 2 : 0) ^ (t3 ? 4 : 0) ^ (t4 ? 8 : 0);
}

/** One count, binary or BCD. */
const countStep = (n, up, decade) =>
  decade ? bcdNext(n, up) : (n + (up ? 1 : 15)) & 15;

/**
 * Does the count sit at the terminal count CARRY OUT̄ flags? Binary: 15 up,
 * 0 down. BCD: the 4510 diagram's gate, Q1·Q4 up (9 — and 11, 13, 15, which
 * the counter leaves within a clock or two) and 0 down.
 */
const terminal = (n, up, decade) => {
  if (!up) return n === 0;
  return decade ? (n & 9) === 9 : n === 15;
};

/**
 * Presettable synchronous 4-bit up/down counter, binary or BCD (CD4029B,
 * CD4510B, CD4516B). It counts one on CLOCK's RISING edge while CARRY IN̄ and
 * PRESET ENABLE are both LOW — up while UP/DOWN is HIGH, down while it is LOW.
 * PRESET ENABLE HIGH loads the jam inputs asynchronously, and the count stays
 * there while it is held. The 4510/4516 also have an async active-HIGH RESET,
 * which beats the preset (their truth table: R=1 resets whatever PE is).
 * CARRY OUT̄ goes LOW at the terminal count while CARRY IN̄ is LOW, and it is
 * COMBINATIONAL — it follows UP/DOWN and CARRY IN̄ without a clock, which is
 * what lets carry-out → carry-in chain counters synchronously.
 *
 * BCD or binary is a pin on the 4029 (`bd`: HIGH binary, LOW decade) and
 * fixed on the others (`decade`).
 *
 * Unknown state: `n: null`. A floating jam bit loaded, a floating RESET, or a
 * clock/CARRY IN̄/direction in doubt whose outcomes disagree all leave the
 * count unknown until a clean reset or preset.
 * @param {{clk, ciN, pe, reset?, ud, bd?, decade?, jam:number[], q:number[], coN}} m -
 *   `jam` and `q` LSB first.
 */
export function presetUpDownCounter(m) {
  /** Every reading of a two-way control: H and L, or one of them. */
  const readings = (lv) => (lv === X ? [true, false] : [lv === H]);
  const ups = (ins) => readings(ins.get(m.ud));
  const decades = (ins) =>
    m.bd == null ? [m.decade === true] : readings(ins.get(m.bd)).map((b) => !b);
  /** What every candidate agrees on, or null. */
  const agree = (values) =>
    values.every((v) => v === values[0]) ? values[0] : null;
  /** The count with PRESET ENABLE LOW: a rising CLOCK while CARRY IN is LOW
      steps it. */
  const count = (s, ins, prev) => {
    const edge = prev ? edgeOf(prev.get(m.clk), ins.get(m.clk), "rise") : "no";
    const ciN = ins.get(m.ciN);
    if (edge === "no" || ciN === H || s.n === null) return s.n;
    const nexts = [];
    for (const up of ups(ins)) {
      for (const decade of decades(ins)) nexts.push(countStep(s.n, up, decade));
    }
    const next = agree(nexts);
    if (edge === "yes" && ciN === L) return next;
    return next === s.n ? s.n : null; // counted, or maybe not
  };
  return {
    state0: () => ({ n: 0 }),
    step(s, ins, prev) {
      if (m.reset != null) {
        const reset = resetLevel(ins, m.reset);
        if (reset === "on") return { n: 0 };
        if (reset === "maybe") return { n: null };
      }
      const pe = ins.get(m.pe);
      let loaded = null;
      if (pe !== L) {
        const jam = m.jam.map((p) => bitX(ins.get(p)));
        loaded = anyX(jam) ? null : bitsValue(jam);
        if (pe === H) return { n: loaded };
      }
      const counted = count(s, ins, prev);
      if (pe === L) return { n: counted };
      // A floating PE: loaded, or counted — known only where both agree (a
      // jam equal to the count is still lost to a clock edge).
      return { n: loaded === counted ? counted : null };
    },
    outputs(s, ins) {
      const out = new Map(
        m.q.map((pin, i) => [pin, s.n === null ? X : (s.n >> i) & 1 ? H : L]),
      );
      const ciN = ins.get(m.ciN);
      let co = H;
      if (ciN !== H) {
        const levels = [];
        for (const up of ups(ins)) {
          for (const decade of decades(ins)) {
            levels.push(s.n === null ? X : terminal(s.n, up, decade) ? L : H);
          }
        }
        co = levels.reduce(merge);
        if (ciN === X) co = merge(co, H);
      }
      out.set(m.coN, co);
      return out;
    },
  };
}
