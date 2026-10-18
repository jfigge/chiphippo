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

// spice/inductors.js — every inductor on a desk as Spice Lite carries it
// (features/done/spice-lite-3-plan.md, Phase 3). Pure and DOM-free.
//
// The capacitor's dual: its STATE is a current, which no event can change in
// an instant. In the voltage solve an inductor is a current source of that
// current, from its pin 1 to its pin 2 (spice/network.js "l"); between
// events it runs along L·di/dt = V(1) − V(2) − R·i, R its winding's
// resistance (catalog/discretes.js `inductorOhms`), solved with every
// capacitor and inductor it sees as one linear system (spice/dynamics.js).
//
// Only an inductor with an INDUCTANCE is one, and only on a netlist built
// with `inductors: "branch"` (sim/netlist.js) — Spice Lite's. Everywhere else
// (the digital engine, the exports, the schematic) it is the wire it is at
// DC, so nothing outside Spice Lite changed.
//
// A RELAY's coil is one too (`def.coil`: its two coil pins, its inductance
// and its winding from its params) — on every netlist, since its coil was
// never a bridge: to the digital engine its two legs are two inputs.
//
// A TRANSFORMER (catalog/ac-parts.js) is TWO, its windings — `<id>p` across
// P1–P2 and `<id>s` across S1–S2 — each carrying its partner and their
// MUTUAL inductance (`couple`), so the inductance matrix of the group they
// run in has M off its diagonal (spice/engine.js `runGroup`): L1·di1/dt +
// M·di2/dt = V(P1) − V(P2) − R1·i1, and the same the other way. Its terminals
// are a brick's, never bridged, so the logic engine sees two open windings.
// The windings are galvanically apart; their INSULATION is a resistance
// between them (`TRANSFORMER_INSULATION_OHMS`, P2 to S2), so a secondary
// left floating still has a voltage the solve can find, as a real one has
// through its insulation and its capacity to the primary. And each winding
// is SHUNTED (`TRANSFORMER_SHUNT_OHMS`), as a real one is by its own
// capacitance and its core's losses: a winding left open otherwise carries
// its current through nothing but the solve's 10¹² Ω floor, a system so
// stiff that its slow mode — the primary's magnetising current — is lost to
// rounding (an open secondary read half its voltage).

import { partDef } from "../../catalog/index.js";
import { inductorOhms } from "../../catalog/discretes.js";
import { transformerWindings } from "../../catalog/ac-parts.js";
import { formatAddress } from "../../model/breadboard.js";

/** A transformer's insulation between its windings, ohms: a gigohm, the
    order a small mains transformer's is tested to. */
export const TRANSFORMER_INSULATION_OHMS = 1e9;

/** What shunts each winding, ohms — microamps at any voltage a desk
    holds, so no reading moves (an assumption, standing in for the winding's
    capacitance and core loss). */
export const TRANSFORMER_SHUNT_OHMS = 10e6;

/** A transformer's windings, by the terminals each is across. */
const WINDINGS = Object.freeze([
  Object.freeze({ suffix: "p", a: "P1", b: "P2", side: "primary" }),
  Object.freeze({ suffix: "s", a: "S1", b: "S2", side: "secondary" }),
]);
import { partPinAddresses } from "../../model/occupancy.js";
import { isInductorBranch } from "../netlist.js";

/** Each netlist's inductors (`inductorTopology`), and the ones its wiring
    shorts (`shortedInductors`). */
const TOPOLOGY = new WeakMap();
const SHORTED = new WeakMap();

/** A part's coil, as a branch: `{a, b, henries, ohms}` — `a`/`b` its pins —
    or null. An inductor with an inductance; a relay's coil. */
export function coilOf(def, params) {
  if (def?.coil) {
    const { a, b } = def.coil;
    return { a, b, henries: def.coil.henries(params), ohms: def.coil.ohms(params) }; // prettier-ignore
  }
  if (!isInductorBranch(def, params)) return null;
  return { a: 1, b: 2, henries: Number(params.henries), ohms: inductorOhms(params) }; // prettier-ignore
}

/**
 * Every inductor that is a branch on this netlist: `[{id, a, b, aAt, bAt,
 * henries, ohms}]` — `a`/`b` its pin 1 and pin 2 nets (two different ones:
 * on a netlist that joined them it is a wire, and no branch), `aAt`/`bAt`
 * the holes its leads are in.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function inductorTopology(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const out = [];
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  for (const comp of doc.components ?? []) {
    if (comp.kind === "transformer") {
      // Each winding with both ends wired to two different nets — a winding
      // with an end in the air carries nothing, and couples nothing — and
      // its partner's coupling only while the partner is one too.
      const w = transformerWindings(comp.params);
      const wired = (net) => (netlist.nets?.get(net)?.points?.length ?? 2) > 1;
      const coils = WINDINGS.map((x) => {
        const aAt = formatAddress(comp.id, x.a);
        const bAt = formatAddress(comp.id, x.b);
        const [a, b] = [netOf(aAt), netOf(bAt)];
        if (!a || !b || a === b || !wired(a) || !wired(b)) return null;
        return { id: `${comp.id}${x.suffix}`, comp: comp.id, winding: x.side, a, b, aAt, bAt, ...w[x.side] }; // prettier-ignore
      });
      const [p, q] = coils;
      if (p && q) {
        p.couple = { id: q.id, henries: w.mutual };
        q.couple = { id: p.id, henries: w.mutual };
      }
      for (const l of coils) if (l) out.push(l);
      continue;
    }
    const coil = comp.board == null ? null : coilOf(partDef(comp.ref), comp.params); // prettier-ignore
    if (!coil) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = (pin) => pins.find((p) => p.pin === pin)?.address ?? null;
    const aAt = at(coil.a);
    const bAt = at(coil.b);
    const a = aAt ? (netlist.netOfPoint.get(aAt) ?? null) : null;
    const b = bAt ? (netlist.netOfPoint.get(bAt) ?? null) : null;
    if (!a || !b || a === b) continue;
    out.push({ id: comp.id, a, b, aAt, bAt, henries: coil.henries, ohms: coil.ohms }); // prettier-ignore
  }
  TOPOLOGY.set(netlist, out);
  return out;
}

/**
 * The inductors a netlist joins both ends of — a switch across a coil, closed
 * — by id: no branch (`inductorTopology`), but a loop its current still runs
 * round, through its own winding.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 * @returns {Set<string>}
 */
export function shortedInductors(doc, netlist) {
  const cached = SHORTED.get(netlist);
  if (cached) return cached;
  const out = new Set();
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  for (const comp of doc.components ?? []) {
    if (comp.kind === "transformer") {
      for (const x of WINDINGS) {
        const a = netOf(formatAddress(comp.id, x.a));
        if (a && a === netOf(formatAddress(comp.id, x.b))) out.add(`${comp.id}${x.suffix}`); // prettier-ignore
      }
      continue;
    }
    const coil = comp.board == null ? null : coilOf(partDef(comp.ref), comp.params); // prettier-ignore
    if (!coil) continue;
    const pins = partPinAddresses(doc, comp);
    const at = (pin) => pins?.find((p) => p.pin === pin)?.address ?? null;
    const a = at(coil.a) ? netlist.netOfPoint.get(at(coil.a)) : null;
    if (a && a === (at(coil.b) ? netlist.netOfPoint.get(at(coil.b)) : null))
      out.add(comp.id);
  }
  SHORTED.set(netlist, out);
  return out;
}

/**
 * What an inductor that is no branch any more (`away`: `{at, amps, tau}`, its
 * current and the moment it left) carries at `t`, amps: shorted, its current
 * dies away round the loop through its winding (tau = L/R; Infinity with
 * none); opened, it is gone at once.
 */
export function awayAmps(away, t) {
  if (!(away.tau > 0)) return 0;
  if (!Number.isFinite(away.tau)) return away.amps;
  return away.amps * Math.exp(-Math.max(0, t - away.at) / away.tau);
}

/**
 * Every transformer's own resistances, as resistors of the solve: each
 * winding's shunt across it, and the insulation between its windings'
 * second ends (P2 and S2) while both are branches (`inductorTopology`) —
 * `[{a, b, ohms, aAt, bAt}]`.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function transformerResistors(doc, netlist) {
  const coils = inductorTopology(doc, netlist);
  const byId = new Map(coils.map((l) => [l.id, l]));
  const out = [];
  for (const l of coils) {
    if (!l.winding) continue;
    out.push({ a: l.a, b: l.b, ohms: TRANSFORMER_SHUNT_OHMS, aAt: l.aAt, bAt: l.bAt }); // prettier-ignore
    if (!l.couple || l.winding !== "primary") continue;
    const s = byId.get(l.couple.id);
    if (!s || l.b === s.b) continue;
    out.push({ a: l.b, b: s.b, ohms: TRANSFORMER_INSULATION_OHMS, aAt: l.bAt, bAt: s.bAt }); // prettier-ignore
  }
  return out;
}
