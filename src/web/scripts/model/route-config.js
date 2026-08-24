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

// route-config.js — every number the auto-router obeys, in one place, with the
// physical measurements it derives them from (Feature 360).
//
// The point of this file is that the router's PRIORITIES are legible without
// reading the router. Costs are stated in PITCH-EQUIVALENTS — one unit of cost
// is one pitch of extra wire — so `bendCost: 4` reads as "a bend is worth four
// pitches of detour to avoid", and the whole priority order the feature plan
// argues for can be checked by reading a column of numbers.
//
// Two things here are DERIVED and must never be typed in by hand:
//
//   · the clearance floor, from the wire's real diameter. 1.5 mm of wire plus
//     0.5 mm of air is 0.787 pitch — LESS THAN ONE PITCH — which is the fact
//     that makes the board's own hole lattice the finest legal routing grid.
//     Halve the grid and two parallel wires overlap; that is arithmetic, not a
//     preference, so `minSeparation` comes off the diameter every time.
//
//   · `minEdgeCostPerUnit`, from the two BONUSES. A bundle or corridor bonus is
//     a negative cost, and negative edge weights break A*'s admissibility. They
//     are therefore discounts against a baseline of 1.0, floored here, and
//     route-search.js scales its heuristic by this same floor. Type the floor in
//     by hand and a later bonus tweak silently costs the router its optimality —
//     it would still return routes, just not the best ones, which is the kind of
//     regression no test notices.

import { MM_PER_UNIT, PX_PER_UNIT } from "../desk/desk-geometry.js";

/** Millimetres → pitch units, on the 0.01 grid every stored coordinate uses. */
const u = (mm) => Math.round((mm / MM_PER_UNIT) * 100) / 100;

/**
 * The shipped routing configuration.
 *
 * Everything is overridable through `makeRouteConfig`, which re-derives the
 * dependent values — so a test can turn one knob without having to know which
 * other numbers move with it.
 */
export const ROUTE_DEFAULTS = Object.freeze({
  // ── Physical ────────────────────────────────────────────────────────────
  /** Insulated jumper diameter (mm). The one measurement everything geometric
      comes from. */
  wireDiameterMm: 1.5,
  /** Air between a wire and a PART (mm). It is what an obstacle is inflated by,
      together with half the wire, so the route clears the plastic rather than
      just missing its centreline. */
  clearanceMm: 0.5,
  /**
   * How far apart two wires' LANES must be to count as separate runs (mm).
   *
   * Deliberately NOT `wireDiameterMm + clearanceMm`. That figure describes two
   * wires lying in one plane, and wires on a board do not: they arch at
   * different heights, which is why a real bench runs them closer than their own
   * diameter all the time. Tying the two together forced every lane onto the
   * hole lattice — 2.54 mm apart, the coarsest grid there is — and with fewer
   * lanes than wires the surplus had nowhere to go but on top of each other.
   * At 0.85 mm there are THREE lanes to a pitch, which is what it takes to fit
   * two runs between a chip's upper legs and the wires leaving the row above —
   * a gap a real bench threads two wires through all the time.
   */
  laneSpacingMm: 0.85,
  /**
   * The RADIUS a lead turns through at a corner (mm) — so 0.75 is a **1.5 mm
   * turn diameter**, the tightest a 1.5 mm jumper can be folded to and the same
   * figure as the wire's own thickness.
   *
   * It must stay well under one pitch, and the reason is not aesthetic. A
   * tangent circle meets each leg `radius / tan(θ/2)` from the corner — at a
   * right angle, exactly the radius — so the fillet eats that much off BOTH
   * legs. At 2.5 mm that is 0.98 pitch a side, which consumes a one-pitch
   * segment entirely: a turn then occupies two pin spaces, adjacent runs bulge
   * into each other, and it stops being possible to see which wire turned away
   * and which carried on. At 0.75 mm the bite is 0.3 pitch, so even the
   * shortest jog keeps most of its straight.
   */
  bendRadiusMm: 0.75,

  // ── Grid ────────────────────────────────────────────────────────────────
  /** The widest gap (pitch) left between two adjacent tracks before filler is
      inserted — i.e. the routing grid's granularity, 0.85 mm. A wire may run
      BETWEEN two rows of holes and not only along them; the hole lattice on its
      own gives one lane per pitch, which is fewer lanes than a dense board has
      wires. Between two rows a pitch apart this yields TWO lanes, which is what
      lets two runs thread the gap between a chip's legs and the row above. */
  trackFillMax: 0.33,

  // ── Soft costs, in pitch-equivalents ────────────────────────────────────
  /** Per pitch of wire. The LOWEST priority — everything below outranks it. */
  lengthCost: 1.0,
  /** Per 90° turn. Above length, so a three-pitch detour that removes a bend is
      taken and a zig-zag never wins on length alone. */
  bendCost: 4.0,
  /** Per wire crossed. This single number is the whole "crossings are
      undesirable but not impossible" instruction: a detour longer than about
      twelve pitches loses to simply crossing. */
  crossWireCost: 12.0,
  /** Per pitch, per wire already on an edge (or on a track too close to it to
      clear). Two wires sharing a run read as ONE wire, which is worse than
      crossing — hence per-pitch rather than per-event, so a one-pitch touch is
      cheap and a ten-pitch shadow is not. At 25 a pitch of doubled-up wire is
      worth about six bends of detour, which is what it took across the demo
      corpus to drive overlap down to the level that is genuinely unavoidable
      (a dense channel with more signals than free rows). */
  overloadCost: 25.0,
  /** Per pitch, discounted when the neighbouring parallel track carries a wire
      over the same span. This is the whole "prefer clean parallel runs"
      requirement: it makes a corridor cheaper the more it is used, so wires
      collect into bundles instead of each taking a private optimum. */
  bundleBonus: 0.15,
  /** Per pitch, discounted on a track with no holes on it — the trench, the
      dovetail margins, the board's end plastic. A wire there covers no tie
      points, which is exactly why a bench routes in those lanes. Derived from
      the geometry (a track is a corridor when no hole sits on it), never a
      hand-kept list of y values. */
  corridorBonus: 0.1,
  /** Charged ONCE, on the edge that leaves the boards for a gap bridge. Soft by
      the requirement's own reckoning: crossing a gap when another legal route
      exists is a penalty, not a refusal. */
  gapCrossCost: 20.0,
  /** Charged per PITCH of run in the gap, on top of the entry above.
      Load-bearing: an entry-only charge makes the gap between two boards the
      cheapest real estate on the desk — no holes, so it draws the corridor
      bonus, and no parts, so nothing is in the way. Wires then dive off the
      board and use the gap as a highway, looping far out of their way to get
      back on. Crossing a gap should cost for as long as you are in it. */
  gapCostPerUnit: 4.0,
  /** What a component body costs once the escalation ladder has demoted it from
      a hard obstacle — reachable only when a wire has no legal path at all.
      Large enough that it is always the last resort, finite so that "boxed in"
      produces a reported route rather than a shrug. */
  overPartCost: 250.0,

  /**
   * How far (pitch) apart wires sharing one lane are drawn — the "own plane"
   * rule (see `separateLanes` in autoroute.js).
   *
   * The routing grid is the board's hole lattice, and its lanes are one pitch
   * apart because that is the finest spacing 1.5 mm wire can clear. On a dense
   * board there are fewer lanes than wires, so runs MUST share, and two runs
   * sharing a lane land on exactly the same line: they draw as one wire, and
   * where one turns off there is nothing to say which did. A real board never
   * has this problem, because real jumpers arch at different heights.
   *
   * So a shared lane is split: the runs on it are fanned out either side of the
   * lattice line, by less than half the spacing between lanes so a nudged run
   * can never be mistaken for one on the next lane along. It also stays inside
   * the 0.49 an obstacle was already inflated by, so it can never be pushed into
   * a part.
   */
  laneOffset: 0.14,
  /** The most (pitch) any one run may be nudged off its lane, however many wires
      are sharing it. Past this the fan-out would reach the neighbouring lane and
      start lying about which lane a wire is in. */
  laneOffsetMax: 0.14,

  // ── Negotiated congestion (PathFinder) ──────────────────────────────────
  /** Added to a contended edge's persistent history cost each round, per wire
      of overuse. History is what removes the first-mover advantage: an edge two
      wires both want grows more expensive for BOTH until the one with an
      alternative leaves. */
  historyIncrement: 0.5,
  /** Sweeps of the hardening pass — the one that lifts each wire out and offers
      it a route sharing no edge with anything. Repeated because freeing one
      wire's lane can be what lets the next off its neighbour; it exits early the
      moment a sweep changes nothing. */
  hardenPasses: 3,
  /** How much the present-congestion term grows per round. Round 1 routes as if
      the board were empty — which is how each wire finds the shape it actually
      wants — and the squeeze comes on afterwards. Enforcing it hard from the
      first round instead just freezes in whatever the first arrival did. */
  pressureRamp: 1.0,
  /** Rounds of rip-up and reroute. The loop exits early the moment a round
      finds no contention, so this is a ceiling and not a schedule — the demo
      corpus averages 3.6 rounds and the remainder are boards where some overlap
      is genuinely forced. */
  iterations: 8,

  // ── Behaviour ───────────────────────────────────────────────────────────
  /**
   * Before routing, move each POWER LEAD's rail end to a nearer free hole on
   * the same net (`model/rail-reseat.js`).
   *
   * This is the narrow, provable half of D11's end re-seating, and it is on
   * because it is the one case where the alternative is a wire nothing can
   * draw well. Move a part and its SIGNAL wires ride with it; its power leads
   * end on a rail hole belonging to no node the part occupies, so they stay
   * where they were and stretch across the desk. The router can only draw the
   * best path between two holes, and one of those holes is in the wrong place.
   *
   * The general case — any end, any node — stays out. A signal wire's node is
   * five holes and moving within it buys little; a rail's is the whole strip,
   * which is where the distance is, and its safety can be checked outright
   * (see rule 3 in rail-reseat.js) rather than argued.
   */
  reseatRailEnds: true,
  /**
   * The least a rail end must SAVE (pitch, Manhattan) before it is worth
   * moving. An address is what the build guide tells you to plug in, so a move
   * has a cost outside the drawing and a one-hole shuffle is not worth paying
   * it. Two pitch is about where a shortened lead becomes visible on the desk.
   */
  reseatMinGain: 2,
  /**
   * After routing, offer each wire the OTHER holes of its own tie-point strip
   * — the rest of its five-hole column-half — and keep the swap when the route
   * it buys is strictly better (`swapEnds` in autoroute.js).
   *
   * The safety argument is the shortest in this file: those five holes ARE one
   * node, so the netlist is not merely unchanged, it is the same object. There
   * is nothing to verify. What the swap buys is which ROW a lead leaves from,
   * and on a board where every hole is a hard obstacle that is the difference
   * between a run that threads past the neighbouring leads and one that has to
   * go round them.
   *
   * It is by a distance the largest single quality win in the feature. Over the
   * 52 shipped demos it takes CROSSINGS DOWN 78% (1 048 → 230, counted from
   * both sides), bends per wire from 1.98 to 1.41 and total run down 13%, for
   * 888 leads moved — and on a real four-board desk that had been edited for a
   * while, crossings 454 → 204 with 11% less wire.
   */
  swapNodeEnds: true,
  /** Sweeps of that pass. Each costs one routing attempt per free alternative
      per end, which makes it the most expensive knob here — the corpus takes
      18 s at zero, 30 s at one and 38 s at two. It buys that: crossings 1 048 /
      300 / 230 for the same three. A third sweep is 44 s for 230 → 208 and
      bends that stop falling, which is where the curve flattens. It exits early
      the moment a sweep changes nothing, so a simple board pays for one. */
  swapPasses: 2,
  /** Multiplier applied to `bendCost` when a route came back over the waypoint
      cap: buy a straighter, longer route rather than truncate a valid one into
      an invalid one. */
  bendBudgetRetryFactor: 8,
});

/**
 * A complete configuration: the defaults, `overrides` applied, and every
 * derived value recomputed from the result.
 *
 * @param {object} [overrides] any subset of ROUTE_DEFAULTS
 * @returns {object} frozen config with the derived fields below added
 */
export function makeRouteConfig(overrides = {}) {
  const c = { ...ROUTE_DEFAULTS, ...overrides };

  // How far an obstacle grows so a wire's BODY clears it, not just its
  // centreline: half the wire, plus the clearance. A chip's slab stops 0.45
  // pitch short of rows e and f, so at 0.492 the inflated body still leaves row
  // d free to route along and row e properly closed — which is the whole
  // difference between "beside the chip" and "over it".
  const inflation = u(c.wireDiameterMm / 2 + c.clearanceMm);

  // Centre-to-centre distance two parallel runs need to read as two runs. See
  // `laneSpacingMm` — this is NOT the wire's own width plus air, and the
  // difference between the two is what buys the half-pitch grid.
  const minSeparation = u(c.laneSpacingMm);

  // The cheapest an edge can ever be, per pitch, once both bonuses apply. The
  // A* heuristic multiplies its distance estimate by this, so it is the one
  // number keeping the search admissible.
  const minEdgeCostPerUnit = Math.max(
    0.01,
    c.lengthCost - c.bundleBonus - c.corridorBonus,
  );

  return Object.freeze({
    ...c,
    inflation,
    minSeparation,
    minEdgeCostPerUnit,
    bendRadius: u(c.bendRadiusMm),
  });
}

/** The shipped config, ready to use. */
export const ROUTE_CONFIG = makeRouteConfig();

/**
 * The corner radius (WORLD PX) every routed wire is drawn with — the one place
 * the millimetre measurement above meets the wire layer's pixel space.
 *
 * It lives here rather than in `desk/wire-path.js` because the radius is a
 * ROUTING decision (how tightly a real lead may be bent) and `desk/` may not
 * import `model/`. The path builders take it as an argument and stay pure.
 */
export const BEND_RADIUS_PX = ROUTE_CONFIG.bendRadius * PX_PER_UNIT;
