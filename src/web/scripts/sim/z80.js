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

// z80.js — the Zilog Z80 as a PURE, DOM-free state machine behind the STANDARD
// sequential contract ({ state0, step, outputs }). sim/z80-ops.js is the
// instruction set; this file is the part that turns its bus calls into real
// M-cycles on real pins.
//
// ── Why this models T-STATES where sim/w65c02.js does not ────────────────────
// The 65xx core collapses to one bus access per PHI2 cycle because a 6502 IS one
// access per cycle — nothing is lost. A Z80 is not: an opcode fetch is four
// T-states with a REFRESH cycle glued to its back half, a memory read is three,
// an I/O cycle is four with a wait state built in. Collapse that and /M1 becomes
// the only thing telling a fetch from a read, /RFSH and the R register become
// decoration, and /WAIT cannot be implemented in its actual form.
//
// And the fidelity is nearly free, because two facts line up. The transport
// ticks the engine once per clock EDGE (sim-controller.js: `1000 / (2 * hz *
// speed)`), which is HALF-T resolution — exactly the resolution the Z80's own
// timing diagrams are drawn at, since every control line transitions on a clock
// edge. And `outputs` may read the LIVE clock level off its input pins, so the
// state only has to carry WHICH T-state we are in; `outputs` derives the half.
// That removes half the state machine: `step` advances one T per RISING edge,
// and SIGNALS is the datasheet's timing diagram transcribed as data.
//
// ── How it stays plain data (no generators) ──────────────────────────────────
// The engine threads sequential state as an opaque value, compares it
// STRUCTURALLY, and calls `outputs` many times per settle — so the state must be
// plain data and `outputs` must be pure. A cycle-stepped CPU has to suspend
// mid-instruction on every access, so instead of a generator the state carries a
// small `log` of the results already returned for THIS instruction's accesses.
// Each M-cycle a clean synchronous interpreter re-runs from the COMMITTED
// registers, replaying `log` and throwing at the first new access; that throw
// names the M-cycle to run next. Re-execution is deterministic and cheap.
//
// ── Where the data byte is read, and why it differs from the 65xx ────────────
// sim/w65c02.js latches its byte from `prev` — the bus as it stood while PHI2
// was still HIGH — because a 65xx peripheral gates its bus drivers on PHI2, an
// INPUT that has already flipped by the time the falling-edge settle runs. The
// Z80 is the opposite case and so reads from `ins`: it enables the device with
// /MREQ + /RD, which are its OWN OUTPUTS and are still asserted in the picture
// the pre-settle produced. Same reasoning, opposite answer, for a stated reason.
//
// ── Scope ────────────────────────────────────────────────────────────────────
// The M-cycle SEQUENCE is exact: every access, in order, at the right address,
// with the right control lines in the right half-cycles. Purely-internal
// T-states come from the interpreter's own `bus.internal(n)` calls at the
// documented points, so common instructions total correctly; a few rare ones may
// run a T or two short. See z80-ops.js for the instruction-set scope.

import { H, L, Z } from "./levels.js";
import {
  execInstruction,
  doNmi,
  doInt,
  initialRegs,
  regsOf,
} from "./z80-ops.js";

/** The suspend sentinel: thrown by the replay bus at the first new access. */
const SUSPEND = Symbol("z80-suspend");

/**
 * The M-cycle vocabulary. `t` is the T-state count, `sample` the T at whose
 * RISING edge the CPU latches the data bus (null if it never reads), and
 * `drives` whether the CPU is driving D0-D7 for the cycle.
 */
const MCYCLES = {
  M1: { t: 4, sample: 3, drives: false }, // fetch in T1-T3, refresh in T3-T4
  READ: { t: 3, sample: 3, drives: false },
  WRITE: { t: 3, sample: null, drives: true },
  IN: { t: 4, sample: 4, drives: false }, // T1 T2 TW T3
  OUT: { t: 4, sample: null, drives: true },
  INTACK: { t: 6, sample: 5, drives: false }, // T1 T2 TW TW T3 T4: vector at T3↑
  INTERNAL: { t: 1, sample: null, drives: false }, // `t` overridden per cycle
  RESET: { t: 1, sample: null, drives: false },
  BUSACK: { t: 1, sample: null, drives: false },
};

/** The T at whose FALLING edge /WAIT is sampled, per cycle kind. */
const WAIT_T = { M1: 2, READ: 2, WRITE: 2, IN: 3, OUT: 3, INTACK: 4 };

/** How many T-states this state's current M-cycle runs for. */
const cycleLen = (s) => (s.mk === "INTERNAL" ? s.itc : MCYCLES[s.mk].t);

/**
 * The timing diagram, as data: for an M-cycle kind, a T-state and a clock half,
 * which control lines are ASSERTED and what the address bus carries.
 *
 * `addr` is "bus" (the M-cycle's own address), "rfsh" (the refresh address
 * I:R), or null (high-Z). The flags are true when the line is asserted, i.e.
 * driven LOW — every one of the Z80's control outputs is active low.
 */
function signalsAt(mk, t, high) {
  const off = {
    addr: "bus",
    m1: false,
    mreq: false,
    iorq: false,
    rd: false,
    wr: false,
    rfsh: false,
  };

  switch (mk) {
    case "M1":
      // /M1 and the address from T1↑; /MREQ + /RD from T1↓ to T3↑; the byte is
      // latched at T3↑, where the address becomes I:R and /RFSH asserts; the
      // refresh /MREQ then pulses from T3↓ to T4↓.
      if (t <= 2) {
        return {
          ...off,
          m1: true,
          mreq: !(t === 1 && high),
          rd: !(t === 1 && high),
        };
      }
      return {
        ...off,
        addr: "rfsh",
        rfsh: true,
        mreq: (t === 3 && !high) || (t === 4 && high),
      };

    case "READ":
      // Address from T1↑; /MREQ + /RD from T1↓; released at T3↓.
      return {
        ...off,
        mreq: !(t === 1 && high) && !(t === 3 && !high),
        rd: !(t === 1 && high) && !(t === 3 && !high),
      };

    case "WRITE":
      // /MREQ from T1↓, /WR from T2↓; both released at T3↓. D is driven from
      // T1↓ right through, which is why `drives` is a property of the cycle.
      return {
        ...off,
        mreq: !(t === 1 && high) && !(t === 3 && !high),
        wr: (t === 2 && !high) || (t === 3 && high),
      };

    case "IN":
      // The I/O difference: /IORQ + /RD assert a full cycle later, at T2↓, and
      // the automatic wait state sits between T2 and the final T.
      return {
        ...off,
        iorq: t >= 3 || (t === 2 && !high),
        rd: t >= 3 || (t === 2 && !high),
      };

    case "OUT":
      return {
        ...off,
        iorq: t >= 3 || (t === 2 && !high),
        wr: t >= 3 || (t === 2 && !high),
      };

    case "INTACK":
      // T1 T2 TW TW T3 T4 (Zilog UM0080, Interrupt Request/Acknowledge Cycle).
      // /M1 from T1↑ and HELD through both automatic waits; /IORQ — in place
      // of the fetch's /MREQ + /RD — from the first wait's falling edge. The
      // device reads /M1·/IORQ as "acknowledge, put your vector up", and the
      // vector is taken at T3↑, where both release and the refresh runs in
      // T3–T4 exactly as it does behind an ordinary fetch. (/M1 used to drop
      // after T2 and /IORQ to rise only in T3: never low together, so a
      // device decoding the acknowledge never answered, and the bus read $FF.)
      if (t <= 4) return { ...off, m1: true, iorq: t === 4 || (t === 3 && !high) }; // prettier-ignore
      return {
        ...off,
        addr: "rfsh",
        rfsh: true,
        mreq: (t === 5 && !high) || (t === 6 && high),
      };

    case "INTERNAL":
      // No bus activity at all; the address bus holds what it last carried.
      return { ...off };

    case "BUSACK":
      // The buses belong to somebody else — everything floats, including the
      // control lines. This is why a CPU cannot declare an `outputEnable`.
      return { ...off, addr: null };

    default: // RESET
      return { ...off, addr: null };
  }
}

// ── The replay bus ───────────────────────────────────────────────────────────

/**
 * A bus over `log`: an access already served returns its recorded result, and
 * the first NEW access records what it wants and throws. Every call names the
 * M-cycle it needs, which is what lets the scheduler run the right waveform.
 */
function makeBus(log) {
  let i = 0;
  const bus = {
    pending: null,
    suspend(kind, addr, dout = 0, itc = 1) {
      bus.pending = { kind, addr: addr & 0xffff, dout: dout & 0xff, itc };
      throw SUSPEND;
    },
    fetch(addr) {
      if (i < log.length) return log[i++];
      return bus.suspend("M1", addr);
    },
    read(addr) {
      if (i < log.length) return log[i++];
      return bus.suspend("READ", addr);
    },
    write(addr, v) {
      if (i < log.length) {
        i++;
        return;
      }
      return bus.suspend("WRITE", addr, v);
    },
    in(port) {
      if (i < log.length) return log[i++];
      return bus.suspend("IN", port);
    },
    out(port, v) {
      if (i < log.length) {
        i++;
        return;
      }
      return bus.suspend("OUT", port, v);
    },
    intAck(addr) {
      if (i < log.length) return log[i++];
      return bus.suspend("INTACK", addr);
    },
    internal(n) {
      if (i < log.length) {
        i++;
        return;
      }
      return bus.suspend("INTERNAL", bus.lastAddr ?? 0, 0, n);
    },
  };
  return bus;
}

/** Run whichever operation is in flight — an instruction, an NMI, or an INT. */
function runOp(cur, cpu, bus) {
  if (cur === "nmi") doNmi(cpu, bus);
  else if (cur === "int") doInt(cpu, bus);
  else execInstruction(cpu, bus);
}

// ── State ────────────────────────────────────────────────────────────────────

/** Fresh power-on state: already IN reset, driving nothing. */
export function initialZ80() {
  return resetHold({ nmi: false });
}

/** The held reset state — registers cleared, buses floating, PC at $0000. */
function resetHold(ctl) {
  return {
    ...initialRegs(),
    cur: "instr",
    log: [],
    mk: "RESET",
    t: 1,
    itc: 1,
    wait: false,
    addr: 0,
    dout: 0,
    din: 0xff,
    rfsh: 0,
    nmiPrev: Boolean(ctl.nmi),
    nmiPending: false,
    held: null,
  };
}

/** Is this state already a clean held reset? (Keeps `step` at a fixpoint.) */
const inReset = (s) => s.mk === "RESET";

/**
 * Begin the next operation from committed registers, and schedule its first
 * M-cycle. An NMI beats a maskable interrupt; both are refused for one
 * instruction after an EI, which is what `eiPending` records.
 */
function beginNextOp(committed, base) {
  const cpu = regsOf(committed);
  let cur = "instr";
  let clearNmi = false;
  if (base.nmiPending) {
    cur = "nmi";
    clearNmi = true;
  } else if (base.int && cpu.iff1 && !cpu.eiPending) {
    cur = "int";
  }
  // An interrupt is taken instead of the next instruction, so the EI shadow is
  // spent either way.
  cpu.eiPending = false;
  return issue(cpu, cur, [], {
    ...base,
    nmiPending: clearNmi ? false : base.nmiPending,
  });
}

/** Run `cur` with `log` replayed and turn its next access into an M-cycle. */
function issue(cpu, cur, log, base) {
  const bus = makeBus(log);
  bus.lastAddr = base.lastAddr ?? 0;
  try {
    runOp(cur, cpu, bus);
  } catch (ex) {
    if (ex !== SUSPEND) throw ex;
    const p = bus.pending;
    return {
      ...cpu,
      ...stripBase(base),
      cur,
      log,
      mk: p.kind,
      t: 1,
      itc: p.itc,
      wait: false,
      addr: p.kind === "INTERNAL" ? (base.lastAddr ?? 0) : p.addr,
      dout: p.dout,
      din: 0xff,
      rfsh:
        p.kind === "M1" || p.kind === "INTACK"
          ? (cpu.i << 8) | cpu.r
          : (base.rfsh ?? 0),
      held: null,
    };
  }
  // The operation completed without a further access — only possible for an
  // instruction that is pure register work, which still owes its own M1 fetch.
  // (Every path through the interpreter begins with one, so this is a guard.)
  throw new Error("Z80: operation produced no bus access");
}

/** The bookkeeping fields that ride from one M-cycle to the next. */
const stripBase = (base) => ({
  nmiPrev: base.nmiPrev,
  nmiPending: base.nmiPending,
});

/**
 * One M-cycle has finished: log its result, re-run the operation, and schedule
 * whatever it asks for next. When the operation runs to completion, commit the
 * registers and begin the next one.
 */
function completeMCycle(state, ctl) {
  const kind = state.mk;
  const result =
    kind === "M1" || kind === "READ" || kind === "IN" || kind === "INTACK"
      ? state.din & 0xff
      : 0;
  const log = [...state.log, result];
  const cpu = regsOf(state);
  const bus = makeBus(log);
  bus.lastAddr = state.addr;
  const base = {
    nmiPrev: Boolean(ctl.nmi),
    nmiPending: state.nmiPending,
    int: ctl.int,
    lastAddr: state.addr,
    rfsh: state.rfsh,
  };

  try {
    runOp(state.cur, cpu, bus);
  } catch (ex) {
    if (ex !== SUSPEND) throw ex;
    const p = bus.pending;
    return {
      // Mid-operation: keep the COMMITTED registers, not the partial scratch
      // copy — the next M-cycle replays from the operation's start.
      ...regsOf(state),
      ...stripBase(base),
      cur: state.cur,
      log,
      mk: p.kind,
      t: 1,
      itc: p.itc,
      wait: false,
      addr: p.kind === "INTERNAL" ? state.addr : p.addr,
      dout: p.dout,
      din: 0xff,
      rfsh:
        p.kind === "M1" || p.kind === "INTACK"
          ? (cpu.i << 8) | cpu.r
          : state.rfsh,
      held: null,
    };
  }
  // The operation is complete: commit and begin the next.
  return beginNextOp(cpu, base);
}

/**
 * Advance the CPU one T-state (called on the clock's RISING edge). `ctl` carries
 * the control-line levels as asserted booleans plus the sampled data byte.
 * Pure — returns the next state.
 */
export function z80Tick(state, ctl) {
  if (ctl.reset) return inReset(state) ? state : resetHold(ctl);

  const nmiPending = state.nmiPending;

  // Reset has just been released: start fetching from wherever PC points.
  if (inReset(state)) {
    return beginNextOp(regsOf(state), {
      nmiPrev: Boolean(ctl.nmi),
      nmiPending,
      int: ctl.int,
      lastAddr: 0,
      rfsh: 0,
    });
  }

  // The bus belongs to somebody else until /BUSRQ is released; then the
  // interrupted M-cycle picks up exactly where it left off.
  if (state.mk === "BUSACK") {
    if (ctl.busrq) return state;
    return { ...state, ...state.held, held: null };
  }
  if (ctl.busrq && state.t === 1) {
    // A bus request is honoured at an M-cycle boundary, never mid-cycle.
    const { mk, t, itc, addr, dout, din, wait } = state;
    return {
      ...state,
      mk: "BUSACK",
      t: 1,
      wait: false,
      held: { mk, t, itc, addr, dout, din, wait },
    };
  }

  // A wait state: /WAIT was low at the sampling edge, so this T repeats.
  if (state.wait) return { ...state, wait: false };

  // Latch the data bus at the sampling edge, then step the T-state on.
  //
  // `sample` is the T-state at whose RISING edge the datasheet says the byte is
  // taken — so the test is `t + 1 === sample`: this edge is the one ENTERING
  // that T-state, and the picture it latches from is the one the pre-settle
  // just rendered for the T-state we are still in. That is the correct bus,
  // and the distinction is not academic. An M1 releases /MREQ and /RD at T3's
  // rising edge and puts the REFRESH address up in their place, so a byte read
  // once `t` had already reached 3 would be read from a deselected memory —
  // i.e. from a floating bus, which is $FF, every single fetch.
  const len = cycleLen(state);
  const sample = state.mk === "INTERNAL" ? null : MCYCLES[state.mk].sample;
  const din = state.t + 1 === sample ? ctl.data : state.din;
  if (state.t < len) return { ...state, t: state.t + 1, din, nmiPending };
  return completeMCycle({ ...state, din, nmiPending }, ctl);
}

/**
 * The falling-edge half: latch /NMI's own edge and sample /WAIT. Both are
 * datasheet falling-edge events, and neither advances the T-state.
 */
export function z80Fall(state, ctl) {
  if (inReset(state)) {
    const nmiPrev = Boolean(ctl.nmi);
    return nmiPrev === state.nmiPrev ? state : { ...state, nmiPrev };
  }
  const nmiPending = state.nmiPending || (!state.nmiPrev && Boolean(ctl.nmi));
  const nmiPrev = Boolean(ctl.nmi);
  const waitT = WAIT_T[state.mk];
  const wait =
    waitT !== undefined && state.t === waitT ? Boolean(ctl.wait) : state.wait;
  if (
    nmiPending === state.nmiPending &&
    nmiPrev === state.nmiPrev &&
    wait === state.wait
  ) {
    return state;
  }
  return { ...state, nmiPending, nmiPrev, wait };
}

// ── The engine unit ──────────────────────────────────────────────────────────

/**
 * The Z80 as an engine sequential unit. Pin params are catalog pin numbers;
 * `addr` is [A0…A15] and `data` is [D0…D7], both LSB first.
 * @returns {{ state0: Function, step: Function, outputs: Function }}
 */
export function z80Unit(pins) {
  const {
    addr,
    data,
    clk,
    m1,
    mreq,
    iorq,
    rd,
    wr,
    rfsh,
    halt,
    busak,
    int,
    nmi,
    wait,
    busrq,
    reset,
  } = pins;

  const readData = (ins) =>
    data.reduce((n, pin, i) => n | ((ins.get(pin) === H ? 1 : 0) << i), 0);

  const control = (ins, extra) => ({
    reset: ins.get(reset) === L,
    int: ins.get(int) === L,
    nmi: ins.get(nmi) === L,
    wait: ins.get(wait) === L,
    busrq: ins.get(busrq) === L,
    ...extra,
  });

  return {
    state0: initialZ80,

    step(state, ins, prev) {
      if (!prev) return state;
      const now = ins.get(clk);
      const was = prev.get(clk);
      // The whole state machine is edge-gated: an unchanged clock must return
      // the state VERBATIM, or the engine's step fixpoint never settles and the
      // tick is reported as an oscillation.
      if (was === L && now === H) {
        return z80Tick(state, control(ins, { data: readData(ins) }));
      }
      if (was === H && now === L) return z80Fall(state, control(ins));
      return state;
    },

    outputs(state, ins) {
      const out = new Map();
      const high = ins.get(clk) !== L;
      const sig = signalsAt(state.mk, state.t, high);
      const bus =
        sig.addr === "rfsh"
          ? state.rfsh
          : sig.addr === "bus"
            ? state.addr
            : null;

      addr.forEach((pin, i) =>
        out.set(pin, bus == null ? Z : (bus >> i) & 1 ? H : L),
      );

      const drives =
        state.mk !== "BUSACK" &&
        state.mk !== "RESET" &&
        MCYCLES[state.mk]?.drives;
      data.forEach((pin, i) =>
        out.set(pin, drives ? ((state.dout >> i) & 1 ? H : L) : Z),
      );

      // Every control output is active LOW; in RESET and BUSACK they float.
      const floating = state.mk === "BUSACK" || state.mk === "RESET";
      const line = (asserted) => (floating ? Z : asserted ? L : H);
      out.set(m1, line(sig.m1));
      out.set(mreq, line(sig.mreq));
      out.set(iorq, line(sig.iorq));
      out.set(rd, line(sig.rd));
      out.set(wr, line(sig.wr));
      out.set(rfsh, line(sig.rfsh));

      // /HALT and /BUSACK are not part of a bus cycle and never float.
      out.set(halt, state.halted ? L : H);
      out.set(busak, state.mk === "BUSACK" ? L : H);
      return out;
    },
  };
}
