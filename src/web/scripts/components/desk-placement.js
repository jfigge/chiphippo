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

// desk-placement.js — everything BETWEEN picking something and it being on the
// desk: the ghost that follows the cursor, whether it may land, and the drop.
//
// Six things arm one: a breadboard KIT from the Add-board menu, a CHIP or a
// DISCRETE or a BRICK from the palette, a ⌘V of one part, of a CLUSTER, or of a
// whole DESIGN — and a design the AI builder generated, which is deliberately
// the same clip a copy produces so it rides the same atomic drop. Each is a
// `#mode` of its own kind, each with a ghost element the overlay holds, and the
// viewport's one pointer dispatcher feeds them all through `track()`.
//
// TWO GHOSTS, TWO STRATEGIES, and the difference is what the drop is allowed to
// do. A CLUSTER ghost re-seats each member against whatever it lands over, so
// every member is resolved and tinted on every move and the drop keeps the
// legal ones and discards the rest. A DESIGN ghost is RIGID by construction —
// it brings its own boards — so it is drawn ONCE in the clip's own coordinates
// and thereafter merely TRANSLATED (a pointermove writes two style properties,
// not one per board, part and wire), and its drop is ALL-OR-NOTHING, because
// half a design would silently cut the wires that crossed to the board left
// behind.
//
// Pulled out of DeskController on the WireTools / BusTools arrangement: the
// shared `#mode` and the surface come from the host, so nothing about how modes
// arbitrate changed. The controller keeps `armPlacement` / `armPartPlacement` /
// `armChipPlacement` / `cancelPlacement` / `copySelectedComponent` /
// `pasteComponent` / `armGeneratedDesign` / `applyGeneratedDesign` as its public
// surface and delegates each one here.

import { el, clear, svgEl } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { wirePath, polylinePath } from "../desk/wire-path.js";
import { holePosition } from "../model/breadboard.js";
import { DeskDoc } from "../model/desk-doc.js";
import { partDef } from "../catalog/index.js";
import { addressWorld } from "../model/part-geometry.js";
import { nearestLegalOffset } from "../model/nearest-legal.js";
import {
  captureCluster,
  memberForm,
  memberAnchorWorld,
  resolveCluster,
} from "../model/paste-cluster.js";
import { captureDesign, clipScene, resolveDesign, shiftFor } from "../model/design-clip.js"; // prettier-ignore
import { buildPsuSvg } from "./psu-view.js";
import { buildClockSvg } from "./clock-view.js";
import { buildBoardSvg, applyBoardRotation } from "./breadboard-view.js";
import { buildChipSvg, chipBox } from "./chip-view.js";
import { buildDiscreteSvg, buildSpanSvg, discreteBox, spanPad } from "./discrete-view.js"; // prettier-ignore

/**
 * The end-to-end vector of a rotatable part's ghost after `turns` quarter
 * turns: 0 is the horizontal footprint, 1–3 swing it a quarter lap each. Pure,
 * and exported because R rotates a PLACED part through the same table.
 */
/** The static SVG for a desk brick (PSU / clock) by kind. Exported because a
    brick is DRAWN in three places — its ghost here, its seated view, and a
    cluster member — and all three must show the same object. */
export function brickSvg(kind, params) {
  return kind === "psu" ? buildPsuSvg(params) : buildClockSvg(params);
}

export function ghostOrient(ref, turns) {
  const offsets = partDef(ref).footprint.offsets;
  const span = offsets[offsets.length - 1];
  const table = [
    { dx: span, dy: 0 },
    { dx: 0, dy: span },
    { dx: -span, dy: 0 },
    { dx: 0, dy: -span },
  ];
  return table[turns % 4];
}

export class DeskPlacement {
  #host;
  #overlay;
  /** The last ⌘C, in the three shapes a paste can take. A design outranks a
      cluster, which outranks one part — set together, so exactly one is live.
      The DESIGN buffer deliberately OUTLIVES loadDocument, so a sub-assembly
      copied on one desktop pastes onto another (Feature 240). */
  #copyBuffer = null; // { ref, params }
  #clusterBuffer = null; // a captured multi-selection
  #designBuffer = null; // boards + what is on them + the wiring

  /**
   * @param {object} host - the controller: `doc`, the mutable `mode`,
   *   `deskView`, `viewport`, `ring`, `editingLocked`, `selection`, and the
   *   coordination hooks (`hideHover`, `emitDocChanged`, `mountBoard`,
   *   `mountPart`, `provisionMemory`, `mateStrips`, `partSeatAt`,
   *   `holeAtWorld`, `trackAnnotationGhost`, `disarm*`, `deselect`).
   * @param {HTMLElement} overlay - the overlay layer every ghost lives in.
   */
  constructor(host, overlay) {
    this.#host = host;
    this.#overlay = overlay;
  }

  /** Whether a placement ghost is in hand right now. */
  get armed() {
    return Boolean(this.#host.mode?.kind?.startsWith("place"));
  }

  /** Whether a ⌘V would place anything. */
  get hasBuffer() {
    return Boolean(this.#copyBuffer || this.#clusterBuffer || this.#designBuffer); // prettier-ignore
  }

  enter(mode) {
    if (this.#host.editingLocked) return; // topology is frozen while running
    this.cancelPlacement();
    this.#host.disarmWireTool();
    this.#host.disarmBusTool();
    this.#host.disarmProbe();
    this.#host.deselect();
    this.#host.hideHover();
    this.#host.mode = mode;
    this.#overlay.append(mode.ghost);
    this.#host.viewport.classList.add("desk-viewport--placing");
  }

  /**
   * Arm breadboard placement: a translucent ghost of the whole kit — every
   * strip at its preset offset — tracks the cursor.
   */
  armPlacement(kit) {
    // Throws INVALID_TYPE on junk, before any state is touched.
    DeskDoc.kitPlacements(kit, 0, 0);
    const mode = {
      kind: "place",
      kit,
      ghost: el("div", { class: "board-ghost", hidden: true }),
      pos: null,
      legal: false,
      rot: 0,
      flipRails: false,
    };
    this.renderBoardGhost(mode);
    this.enter(mode);
  }

  /**
   * (Re)build the kit ghost at its current rotation — one strip element per
   * strip, each turned exactly as the placed view will be, so what the user
   * sees before the click is what lands after it.
   */
  renderBoardGhost(m) {
    clear(m.ghost);
    const outline = DeskDoc.kitOutline(m.kit, m.rot);
    // Absolutely positioned strips collapse the box, so size it explicitly —
    // the legal/illegal outline and tint are drawn on this element.
    m.ghost.style.width = `${outline.width * PX_PER_UNIT}px`;
    m.ghost.style.height = `${outline.height * PX_PER_UNIT}px`;
    for (const p of DeskDoc.kitPlacements(m.kit, 0, 0, m.rot, m.flipRails)) {
      const strip = el("div", { class: "board-ghost-strip" });
      strip.style.left = `${p.x * PX_PER_UNIT}px`;
      strip.style.top = `${p.y * PX_PER_UNIT}px`;
      strip.append(buildBoardSvg(p.type));
      applyBoardRotation(strip, p.type, p.rot);
      m.ghost.append(strip);
    }
  }

  /**
   * Arm placement for ANY palette pick: chips seat across a trench,
   * discretes along any grid row, PSU bricks on the open desk.
   */
  armPartPlacement(ref, params = {}) {
    const def = partDef(ref);
    if (!def) {
      const err = new Error(`unknown catalog ref: ${ref}`);
      err.code = "INVALID_REF";
      throw err;
    }
    // Only true chips render + flip as a slab; a display that happens to seat in
    // a DIP footprint (the isolated bar array) still places as a discrete — its
    // trench-straddling geometry comes from `def.package` in seating/occupancy.
    if (def.kind === "chip") {
      this.armChipPlacement(ref, params);
      return;
    }
    const normalized = def.normalizeParams ? def.normalizeParams(params) : {};
    const ghost = el("div", { class: "part-ghost", hidden: true });
    if (def.kind === "psu" || def.kind === "clock") {
      ghost.append(brickSvg(def.kind, normalized));
      this.enter({
        kind: "place-brick",
        ref,
        params: normalized,
        ghost,
        pos: null,
        legal: false,
      });
    } else {
      ghost.append(buildDiscreteSvg(ref, normalized));
      this.enter({
        kind: "place-part",
        ref,
        params: normalized,
        ghost,
        board: null,
        anchor: null,
        legal: false,
      });
    }
  }

  /**
   * Arm chip placement (palette or a Cmd+V duplicate): ghost seats across a
   * trench. `params` carries the copied chip's orientation so a pasted chip
   * lands flipped exactly as its source; the palette passes none.
   */
  armChipPlacement(ref, params = {}) {
    const def = partDef(ref);
    if (!def?.package) {
      const err = new Error(`unknown chip ref: ${ref}`);
      err.code = "INVALID_REF";
      throw err;
    }
    const ghost = el("div", { class: "part-ghost", hidden: true });
    ghost.append(buildChipSvg(ref, params));
    this.enter({
      kind: "place-chip",
      ref,
      params,
      ghost,
      board: null,
      anchor: null,
      legal: false,
    });
  }

  cancelPlacement() {
    if (!this.armed) return;
    this.#host.mode.ghost.remove();
    this.#host.mode = null;
    this.#host.viewport.classList.remove("desk-viewport--placing");
    // The two-click resistor uses the hover ring — clear it too (no-op else).
    this.#host.ring.hidden = true;
    this.#host.ring.classList.remove("hole-ring--illegal");
  }

  /**
   * Cmd+C: remember what's selected so Cmd+V can drop a fresh duplicate.
   *
   * A marquee MULTI-selection copies as a rigid CLUSTER — every selected part
   * and brick, in the exact arrangement of the source; wires are never part of
   * a paste. A single selected part keeps the simpler one-off buffer. Either
   * way the copy is a brand-new part (its arrangement, none of its run-state) —
   * see captureCluster / pasteComponent. A board, a wire, or nothing selected
   * is ignored (returns false, so the native Edit-menu copy still serves text
   * fields). The buffer deep-copies params, so later edits to the source never
   * bleed in.
   */
  copySelectedComponent() {
    // A marquee that took in BOARDS is a whole design (Feature 240): the
    // boards, everything seated on them, and all the wiring between them
    // travel together — including to another desktop. Boards first, because a
    // design that also caught loose parts is still a design.
    if (this.#host.selection.boards.size > 0) {
      const clip = captureDesign(
        {
          boards: this.#host.doc.boards,
          components: this.#host.doc.components,
          wires: this.#host.doc.wires,
          buses: this.#host.doc.buses,
          netNames: this.#host.doc.netNames,
          annotations: this.#host.doc.annotations,
        },
        {
          boardIds: [...this.#host.selection.boards],
          componentIds: [...this.#host.selection.parts],
        },
      );
      if (!clip) return false;
      this.#designBuffer = clip;
      this.#clusterBuffer = null; // the design wins the next paste
      this.#copyBuffer = null;
      return true;
    }
    if (this.#host.selection.parts.size > 0) {
      const comps = [...this.#host.selection.parts]
        .map((id) => this.#host.doc.getComponent(id))
        .filter(Boolean);
      const cluster = captureCluster(this.#host.doc.boards, comps);
      if (!cluster) return false;
      this.#clusterBuffer = cluster;
      this.#copyBuffer = null; // the cluster wins the next paste
      this.#designBuffer = null;
      return true;
    }
    if (this.#host.selection.single?.kind !== "part") return false;
    const comp = this.#host.doc.getComponent(this.#host.selection.single.id);
    if (!comp) return false;
    this.#copyBuffer = {
      ref: comp.ref,
      params: comp.params ? JSON.parse(JSON.stringify(comp.params)) : {},
    };
    this.#clusterBuffer = null;
    this.#designBuffer = null;
    return true;
  }

  /**
   * Cmd+V: arm a placement ghost for a duplicate of the copied component so the
   * user just clicks to drop it. The buffer persists, so repeated Cmd+V stamps
   * more copies. Returns false when nothing has been copied. Orientation carries
   * over: a flipped chip pastes flipped, and a rotatable part (LED / resistor)
   * copied in its turned two-free-ends form re-arms turned the same CARDINAL way
   * (R still re-spins it). The bend is NORMALISED back to the clean footprint
   * span — never the source's verbatim lead vector: that vector may have been
   * stretched to reach a power rail (whose holes sit on a non-uniform lattice),
   * and re-injecting it would pin the drop to that exact grid→rail geometry, so
   * the paste would refuse most rail positions. A footprint-span bend re-fits
   * freely, exactly like a fresh turned part — drag an end onto a rail after.
   */
  pasteComponent() {
    if (this.#designBuffer) {
      this.armDesign(this.#designBuffer);
      return true;
    }
    if (this.#clusterBuffer) {
      this.armCluster(this.#clusterBuffer);
      return true;
    }
    const buf = this.#copyBuffer;
    if (!buf) return false;
    // A fresh duplicate starts pristine — never inherit run-state (12 V) damage.
    const params = { ...buf.params };
    delete params.damaged;
    const def = partDef(buf.ref);
    // Arm rotatable parts in the footprint form first (a safe ghost build); the
    // turned geometry is a live two-free-ends ghost, seeded below.
    const turned = def?.rotatable && buf.params?.rot === 90 && buf.params.end;
    if (def?.rotatable) {
      params.rot = 0;
      params.end = null;
    }
    this.armPartPlacement(buf.ref, params);
    if (turned && this.#host.mode?.kind === "place-part") {
      this.#host.mode.turns = 1; // truthy → the turned two-free-ends tracking
      // Keep the source's cardinal direction, but snap the magnitude back to a
      // clean footprint-span bend so the drop re-fits anywhere (see the method
      // doc). A raw rail-reaching vector would only re-validate where the exact
      // grid→rail displacement recurs.
      const { dx, dy } = buf.params.end;
      const turns =
        Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : dy >= 0 ? 1 : 3;
      this.#host.mode.orient = ghostOrient(buf.ref, turns);
    }
    return true;
  }

  /**
   * Arm a CLUSTER paste: one translucent ghost per copied member, wrapped in a
   * single container element (so `#enterPlacement`/`cancelPlacement` treat it
   * like any other placement ghost). The arrangement translates rigidly with
   * the cursor; each member is tinted green/red by whether it seats legally,
   * re-evaluated on every move. The buffer persists, so repeated Cmd+V stamps
   * the arrangement again.
   */
  armCluster(cluster) {
    const box = el("div", { class: "part-ghost-cluster", hidden: true });
    const ghosts = cluster.members.map((m) => {
      const g = el("div", { class: "part-ghost" });
      g.append(this.#buildMemberGhostSvg(m));
      box.append(g);
      return g;
    });
    this.enter({
      kind: "place-cluster",
      cluster,
      ghost: box,
      ghosts,
      results: [],
      legalCount: 0,
    });
  }

  /** The drawn SVG for one cluster member, by its placement form. A
      DIP-packaged discrete (bar8iso, a DIP switch bank) SEATS like a chip
      (memberForm says "chip"), but it isn't one — buildChipSvg only knows
      CHIP_DEFS, so it's drawn via the discrete path like every other part. */
  #buildMemberGhostSvg(m) {
    const def = partDef(m.ref);
    if (def?.kind === "chip") return buildChipSvg(m.ref, m.params);
    switch (memberForm(m.ref, m.params)) {
      case "turned":
        return buildSpanSvg(m.ref, m.params.end.dx, m.params.end.dy, m.params);
      case "brick":
        return brickSvg(def.kind, m.params);
      default:
        return buildDiscreteSvg(m.ref, m.params);
    }
  }

  trackClusterGhost(e) {
    const m = this.#host.mode;
    const w = this.#host.deskView.worldFromEvent(e);
    // A rigid, integer-pitch shift keeps the arrangement exact and lets every
    // hole-anchored member land squarely on a hole (or over nothing → red).
    const shift = {
      dx: Math.round(w.x - m.cluster.center.x),
      dy: Math.round(w.y - m.cluster.center.y),
    };
    const results = resolveCluster(
      {
        boards: this.#host.doc.boards,
        components: this.#host.doc.components,
        wires: this.#host.doc.wires,
      },
      m.cluster.members,
      shift,
      (ref, x, y) => this.#host.doc.canPlaceBrick(ref, x, y),
    );
    m.results = results;
    m.shift = shift;
    m.legalCount = results.reduce((n, r) => n + (r.legal ? 1 : 0), 0);
    m.ghost.hidden = false;
    results.forEach((r, i) => {
      const g = m.ghosts[i];
      const tl = this.#memberGhostTopLeft(r, shift);
      g.style.left = `${tl.x * PX_PER_UNIT}px`;
      g.style.top = `${tl.y * PX_PER_UNIT}px`;
      g.classList.toggle("part-ghost--legal", r.legal);
      g.classList.toggle("part-ghost--illegal", !r.legal);
    });
  }

  /** Top-left (pitch units) of a member's ghost after the rigid shift — the
      same box maths the seated views use, translated by `shift`. */
  #memberGhostTopLeft(member, shift) {
    const ax = member.anchorWorld.x + shift.dx;
    const ay = member.anchorWorld.y + shift.dy;
    const def = partDef(member.ref);
    if (def?.kind === "chip") {
      const box = chipBox(def.package);
      return { x: ax + box.minX, y: ay + box.minY };
    }
    switch (member.form ?? memberForm(member.ref, member.params)) {
      case "turned": {
        const pad = spanPad(member.ref);
        const { dx, dy } = member.params.end;
        return { x: ax + Math.min(0, dx) - pad, y: ay + Math.min(0, dy) - pad };
      }
      case "brick":
        return { x: ax, y: ay };
      default: {
        const box = discreteBox(member.ref, member.params?.rot);
        return { x: ax + box.minX, y: ay + box.minY };
      }
    }
  }

  /**
   * Drop a cluster paste: seat every member with a legal placement and DISCARD
   * the rest (a red member simply isn't part of the paste). One doc-changed for
   * the whole batch; the freshly-pasted set becomes the new marquee selection so
   * it can be nudged, deleted, or copied again as a unit.
   */
  commitClusterPaste() {
    const results = this.#host.mode.results;
    this.cancelPlacement(); // removes the ghost box, clears #mode
    const newIds = [];
    for (const r of results) {
      if (!r.legal) continue;
      try {
        const comp =
          r.form === "brick"
            ? this.#host.doc.addBrick(r.ref, r.seat.x, r.seat.y, r.params)
            : this.#host.doc.addComponent({
                kind: partDef(r.ref).kind,
                ref: r.ref,
                board: r.seat.board,
                anchor: r.seat.anchor,
                params: r.params,
              });
        this.#host.provisionMemory(comp); // a pasted ROM gets its OWN fresh file
        this.#host.mountPart(comp);
        newIds.push(comp.id);
      } catch {
        /* validated already — skip a stray failure rather than abort the batch */
      }
    }
    if (newIds.length === 0) return;
    this.#host.emitDocChanged("paste");
    this.#host.selection.setMulti(newIds);
  }

  // ── Design paste (Feature 240) ──────────────────────────────────────────
  // A whole sub-assembly — its boards, what is seated on them, and the wiring
  // between them — armed as ONE placement ghost. It is rigid by construction,
  // so unlike the cluster ghost (which re-seats each member against whatever
  // it lands over) this is drawn ONCE in the clip's own coordinates and then
  // simply TRANSLATED: a pointermove writes two style properties, not one per
  // board, part, and wire. Legality is per-board, and the drop is all-or-
  // nothing — see model/design-clip.js.

  /**
   * Arm a design paste: strips, parts, and wiring ghosted together, tracking
   * the cursor until a click drops them (or Esc throws them away). The buffer
   * persists, so repeated Cmd+V stamps the design again.
   */
  armDesign(clip) {
    const scene = clipScene(clip);
    const ghost = el("div", { class: "design-ghost", hidden: true });
    // The boards, each drawn (and turned) exactly as its placed view will be.
    const strips = new Map();
    for (const b of clip.boards) {
      const strip = el("div", { class: "board-ghost-strip" });
      strip.style.left = `${b.x * PX_PER_UNIT}px`;
      strip.style.top = `${b.y * PX_PER_UNIT}px`;
      strip.append(buildBoardSvg(b.type));
      applyBoardRotation(strip, b.type, b.rot);
      ghost.append(strip);
      strips.set(b.key, strip);
    }
    // The parts and bricks, through the cluster ghost's own member drawing.
    for (const comp of scene.components) {
      const anchorWorld = memberAnchorWorld(scene.boards, comp);
      if (!anchorWorld) continue;
      const member = {
        ref: comp.ref,
        params: comp.params,
        anchorWorld,
        form: memberForm(comp.ref, comp.params),
      };
      const g = el("div", { class: "part-ghost" });
      g.append(this.#buildMemberGhostSvg(member));
      const tl = this.#memberGhostTopLeft(member, { dx: 0, dy: 0 });
      g.style.left = `${tl.x * PX_PER_UNIT}px`;
      g.style.top = `${tl.y * PX_PER_UNIT}px`;
      ghost.append(g);
    }
    // The wiring, sagging exactly as WireLayer draws it (same classes, same
    // path maths) — a design without its wires wouldn't read as one.
    const svg = svgEl("svg", {
      class: "design-ghost-wires",
      width: 1,
      height: 1,
    });
    for (const w of scene.wires) {
      const a = addressWorld(scene.boards, scene.components, w.from);
      const b = addressWorld(scene.boards, scene.components, w.to);
      if (!a || !b) continue;
      const ends = [
        { x: a.x * PX_PER_UNIT, y: a.y * PX_PER_UNIT },
        { x: b.x * PX_PER_UNIT, y: b.y * PX_PER_UNIT },
      ];
      // A routed wire ghosts along its own waypoints — a design that dodges a
      // board must not straighten out while it is being positioned.
      const d =
        w.layout === "routed"
          ? polylinePath([
              ends[0],
              ...(w.points ?? []).map((p) => ({
                x: p.x * PX_PER_UNIT,
                y: p.y * PX_PER_UNIT,
              })),
              ends[1],
            ])
          : wirePath(ends[0], ends[1]);
      const group = svgEl("g", { class: "wire" }, [
        svgEl("path", { class: "wire-outline", d }),
        svgEl("path", { class: "wire-core", d }),
      ]);
      group.style.setProperty("--wire-color", `var(--color-wire-${w.color})`);
      svg.append(group);
    }
    if (scene.wires.length > 0) ghost.append(svg);
    this.enter({
      kind: "place-design",
      clip,
      ghost,
      strips,
      shift: { dx: 0, dy: 0 },
      legal: false,
    });
  }

  trackDesignGhost(e) {
    const m = this.#host.mode;
    const world = this.#host.deskView.worldFromEvent(e);
    let shift = shiftFor(m.clip, world);
    // Magnetic mate, on the same terms as a board drag or a kit ghost: pull
    // flush onto a board already on the desk, but only when the pulled
    // position is still legal — a magnet must never turn a legal drop into an
    // illegal one.
    const pull = this.#host.doc.snapDesignAt(m.clip, shift);
    if (pull.dx !== 0 || pull.dy !== 0) {
      const snapped = { dx: shift.dx + pull.dx, dy: shift.dy + pull.dy };
      if (this.#resolveDesignAt(m.clip, snapped).legal) shift = snapped;
    }
    const resolved = this.#resolveDesignAt(m.clip, shift);
    m.shift = shift;
    m.legal = resolved.legal;
    m.ghost.hidden = false;
    m.ghost.style.left = `${shift.dx * PX_PER_UNIT}px`;
    m.ghost.style.top = `${shift.dy * PX_PER_UNIT}px`;
    for (const b of resolved.boards) {
      const strip = m.strips.get(b.key);
      strip?.classList.toggle("board-ghost-strip--legal", b.legal);
      strip?.classList.toggle("board-ghost-strip--illegal", !b.legal);
    }
  }

  /** Where a clip would land at `shift`, and whether it may (all-or-nothing). */
  #resolveDesignAt(clip, shift) {
    return resolveDesign(clip, shift, {
      canPlaceBoard: (type, x, y, rot) => this.#host.doc.canPlace(type, x, y, { rot }), // prettier-ignore
      canPlaceBrick: (ref, x, y) => this.#host.doc.canPlaceBrick(ref, x, y),
    });
  }

  /**
   * Drop a design paste: the document stamps the whole clip in one atomic
   * mutation (and rolls itself back if any part of it is refused), then the
   * new strips are offered to the mating rule exactly as a placed kit's are,
   * so a design dropped flush against an existing board joins its group. The
   * fresh design becomes the selection, ready to be nudged or copied again.
   */
  commitDesignPaste() {
    const { clip, shift } = this.#host.mode;
    this.cancelPlacement(); // removes the ghost, clears #mode
    this.#dropDesign(clip, shift);
  }

  /**
   * Stamp a clip at `shift` and bring the result onto the desk.
   *
   * This is the whole transaction: `pasteDesign` snapshots, replays through the
   * ordinary add* methods — each of which THROWS on an illegal placement — and
   * restores wholesale if any of them refuses, so a design can never land half
   * applied. One `#emitDocChanged` follows, so the entire arrangement is a
   * single undo step however many boards, parts and wires it carries.
   *
   * Shared by the paste ghost and by a generated design, which is the point:
   * there is exactly one way a multi-part arrangement reaches the desk.
   *
   * @param {object} clip
   * @param {{dx:number, dy:number}} shift
   * @param {{label?:string, notify?:boolean}} [opts]
   * @returns {object|null} what landed, or null when the document refused
   */
  #dropDesign(clip, shift, { label = "paste design", notify = true } = {}) {
    let pasted;
    try {
      pasted = this.#host.doc.pasteDesign(clip, shift);
    } catch (err) {
      // The document is already back as it was — say why nothing landed
      // rather than leaving the click looking ignored.
      if (notify) {
        PopupManager.notify({
          title: t("desk.paste.failTitle"),
          message:
            err?.code === "OVERLAP"
              ? t("desk.paste.overlap")
              : t("desk.paste.noRoom"),
        });
      }
      return null;
    }
    for (const board of pasted.boards) this.#host.mountBoard(board);
    for (const comp of pasted.components) {
      this.#host.provisionMemory(comp); // a pasted ROM gets its OWN fresh file
      this.#host.mountPart(comp);
    }
    this.#host.mateStrips(pasted.boards.map((b) => b.id));
    this.#host.emitDocChanged(label);
    this.#host.selection.setMulti(
      pasted.components.map((c) => c.id),
      pasted.wires.map((w) => w.id),
      pasted.boards.map((b) => b.id),
    );
    return pasted;
  }

  // ── Generated designs (Feature 260) ─────────────────────────────────────
  // A circuit the app built from a netlist rather than one the user copied.
  // It arrives as the same design clip a copy produces, so it rides the same
  // atomic drop — no second transaction path, and no second thing to keep in
  // lockstep with undo/redo and ROM provisioning.

  /**
   * Arm a generated design as a cursor-following ghost: the user positions it,
   * sees it mate magnetically with what is already on the desk and redden where
   * it will not fit, and clicks to drop. Preferred over dropping it outright —
   * a circuit that simply appears is harder to trust than one you placed.
   *
   * @returns {boolean} false when the clip carries nothing to place
   */
  armGeneratedDesign(clip) {
    if (!clip?.boards?.length) return false;
    this.cancelPlacement();
    this.armDesign(clip);
    return true;
  }

  /**
   * Drop a generated design straight onto the desk, at `at` or at the nearest
   * spot that clears whatever is already there. Same single transaction, same
   * single undo step.
   *
   * @param {object} clip
   * @param {{at?:{dx:number,dy:number}}} [opts]
   * @returns {object|null} what landed, or null when nothing on the desk fits it
   */
  applyGeneratedDesign(clip, { at = null } = {}) {
    if (!clip?.boards?.length) return null;
    this.cancelPlacement();
    const shift = at ?? this.#findFreeShiftFor(clip);
    if (!shift) return null;
    return this.#dropDesign(clip, shift, {
      label: "add generated design",
      notify: false,
    });
  }

  /** The nearest whole-pitch offset at which a clip clears the desk. */
  #findFreeShiftFor(clip) {
    return nearestLegalOffset(
      (dx, dy) => this.#resolveDesignAt(clip, { dx, dy }).legal,
    );
  }

  track(e) {
    const kind = this.#host.mode.kind;
    if (kind === "place") this.trackBoardGhost(e);
    else if (kind === "place-brick") this.#trackBrickGhost(e);
    else if (kind === "place-annotation") this.#host.trackAnnotationGhost(e);
    else if (kind === "place-cluster") this.trackClusterGhost(e);
    else if (kind === "place-design") this.trackDesignGhost(e);
    else this.#trackSeatedGhost(e);
  }

  trackBoardGhost(e) {
    const m = this.#host.mode;
    m.lastEvent = e; // R re-tracks from here, so the ghost spins in place
    const { width, height } = DeskDoc.kitOutline(m.kit, m.rot);
    const w = this.#host.deskView.worldFromEvent(e);
    // Ghost centered on the cursor, snapped to the integer pitch lattice and
    // then pulled flush onto any board it can dovetail with — so the ghost
    // shows the mate BEFORE the click, not as a surprise after it.
    const { x, y } = this.#pullGhostToMate(
      m.kit,
      Math.round(w.x - width / 2),
      Math.round(w.y - height / 2),
      m.rot,
    );
    m.pos = { x, y };
    m.legal = this.#host.doc.canPlaceKit(m.kit, x, y, m.rot, m.flipRails);
    m.ghost.hidden = false;
    m.ghost.style.left = `${x * PX_PER_UNIT}px`;
    m.ghost.style.top = `${y * PX_PER_UNIT}px`;
    m.ghost.classList.toggle("board-ghost--legal", m.legal);
    m.ghost.classList.toggle("board-ghost--illegal", !m.legal);
  }

  /** `#pullToMate` for a kit that is not on the desk yet. */
  #pullGhostToMate(kit, x, y, rot = 0) {
    const pull = this.#host.doc.snapKitAt(kit, x, y, rot);
    if (pull.dx === 0 && pull.dy === 0) return { x, y };
    const snapped = { x: x + pull.dx, y: y + pull.dy };
    return this.#host.doc.canPlaceKit(kit, snapped.x, snapped.y, rot)
      ? snapped
      : { x, y };
  }

  #trackBrickGhost(e) {
    const m = this.#host.mode;
    const { width, height } = partDef(m.ref).size;
    const w = this.#host.deskView.worldFromEvent(e);
    const x = Math.round(w.x - width / 2);
    const y = Math.round(w.y - height / 2);
    m.pos = { x, y };
    m.legal = this.#host.doc.canPlaceBrick(m.ref, x, y);
    m.ghost.hidden = false;
    m.ghost.style.left = `${x * PX_PER_UNIT}px`;
    m.ghost.style.top = `${y * PX_PER_UNIT}px`;
    m.ghost.classList.toggle("part-ghost--legal", m.legal);
    m.ghost.classList.toggle("part-ghost--illegal", !m.legal);
  }

  /** Chip + discrete ghosts: seat under the cursor or float, tinted. */
  #trackSeatedGhost(e) {
    this.trackSeatedGhostAt(this.#host.deskView.worldFromEvent(e));
  }

  /** As above but from a world point, so R can redraw at the last cursor spot. */
  trackSeatedGhostAt(w) {
    const m = this.#host.mode;
    m.lastWorld = w;
    // A rotatable part turned off its footprint places by two derived ends.
    if (m.turns) {
      this.#trackTurnedGhost(w);
      return;
    }
    const box =
      m.kind === "place-chip"
        ? chipBox(partDef(m.ref).package)
        : discreteBox(m.ref, m.params?.rot);
    const seat = this.#host.partSeatAt(w, m.ref, 0, m.params);
    m.ghost.hidden = false;
    if (seat) {
      const board = this.#host.doc.getBoard(seat.board);
      const pos = holePosition(board.type, seat.anchor);
      m.board = seat.board;
      m.anchor = seat.anchor;
      m.legal = this.#host.doc.canPlacePart(m.ref, seat.board, seat.anchor, {
        params: m.params,
      });
      m.ghost.style.left = `${(board.x + pos.x + box.minX) * PX_PER_UNIT}px`;
      m.ghost.style.top = `${(board.y + pos.y + box.minY) * PX_PER_UNIT}px`;
    } else {
      // Off-board / off-row: the ghost floats on the cursor, illegal.
      m.board = null;
      m.anchor = null;
      m.legal = false;
      m.ghost.style.left = `${(w.x - box.width / 2) * PX_PER_UNIT}px`;
      m.ghost.style.top = `${(w.y - box.height / 2) * PX_PER_UNIT}px`;
    }
    m.ghost.classList.toggle("part-ghost--legal", m.legal);
    m.ghost.classList.toggle("part-ghost--illegal", !m.legal);
  }

  /**
   * Ghost for a rotatable part turned off its footprint: pin 1 rides the hole
   * under the cursor and pin 2's lead bends one orientation vector away, so it
   * places in the same two-free-ends form a drag would produce. The bend is an
   * offset, so the ghost may reach a neighbouring strip's rail.
   */
  #trackTurnedGhost(w) {
    const m = this.#host.mode;
    // A Cmd+V paste re-arms in the copied lead vector exactly (`m.orient`); a
    // palette pick spun with R rides the four cardinal turns instead.
    const orient = m.orient ?? ghostOrient(m.ref, m.turns);
    const hit = this.#host.holeAtWorld(w);
    const p1 = hit ? { x: hit.x, y: hit.y } : w;
    const end = { dx: orient.dx, dy: orient.dy };
    m.board = hit ? hit.board.id : null;
    m.anchor = hit ? hit.hole : null;
    m.end = end;
    m.legal =
      Boolean(hit) &&
      this.#host.doc.canPlacePart(m.ref, hit.board.id, hit.hole, {
        params: { ...m.params, rot: 90, end },
      });

    m.ghost.querySelector("svg")?.remove();
    m.ghost.append(buildSpanSvg(m.ref, orient.dx, orient.dy, m.params));
    const pad = spanPad(m.ref);
    m.ghost.style.left = `${(p1.x + Math.min(0, orient.dx) - pad) * PX_PER_UNIT}px`;
    m.ghost.style.top = `${(p1.y + Math.min(0, orient.dy) - pad) * PX_PER_UNIT}px`;
    m.ghost.hidden = false;
    m.ghost.classList.toggle("part-ghost--legal", m.legal);
    m.ghost.classList.toggle("part-ghost--illegal", !m.legal);
  }
}
