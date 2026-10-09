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

// The 3D view's pure half (scene3d/): the maths, the shapes, the camera, the
// palette, and the scene every document becomes — including a model for every
// part the catalog offers, which is the ratchet that keeps a new part from
// silently going missing from the view.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cross,
  dot,
  identity,
  length,
  lookAt,
  multiply,
  normalize,
  perspective,
  project,
} from "../scene3d/mat4.js";
import { MeshBuilder, cubicPoints, roundedRect } from "../scene3d/mesh.js";
import {
  DISTANCE_MAX,
  DISTANCE_MIN,
  PITCH_MAX,
  PITCH_MIN,
  billboardAxes,
  eyeOf,
  fitBounds,
  normalizeCamera,
  orbitBy,
  panBy,
  viewProjection,
  wheelFactor,
  zoomBy,
} from "../scene3d/orbit-camera.js";
import { parseColor, readPalette, toHex } from "../scene3d/palette.js";
import { MODEL_KINDS, modelKind } from "../scene3d/part-models.js";
import {
  LIT_GLOW,
  buildScene,
  groundMesh,
  lampLevel,
  lampLook,
  lampState,
  plumeSmoke,
} from "../scene3d/scene.js";
import { PUFF_CYCLE_S, plumePuffs, puffOpacity } from "../scene3d/smoke.js";
import { endOf, archPoints } from "../scene3d/wire-model.js";
import { annotationLines } from "../scene3d/annotation-model.js";
import { DESK_Y } from "../scene3d/scene-builder.js";
import { PALETTE_DEFS } from "../catalog/index.js";
import { normalizeDocument } from "../model/desk-doc.js";
import { WIRE_COLORS } from "../model/wire-colors.js";
import { everyPartDesk, plainDoc } from "./scene3d-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMOS = path.join(here, "..", "..", "demos");
const palette = readPalette();

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Every desktop document every shipped example carries. */
function demoDocs() {
  const out = [];
  for (const file of fs.readdirSync(DEMOS).sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(DEMOS, file), "utf8"));
    const docs = raw.doc ? [raw.doc] : raw.desktops.map((d) => d.doc);
    docs.forEach((doc, i) =>
      out.push({ name: `${file}#${i}`, doc: normalizeDocument(doc) }),
    );
  }
  return out;
}

/** Every number in a built mesh is a real number. */
function assertFinite(mesh, what) {
  for (const key of ["positions", "normals", "colors"]) {
    for (const v of mesh[key]) {
      assert.ok(Number.isFinite(v), `${what}: a ${key} value is ${v}`);
    }
  }
}

// ── mat4 ────────────────────────────────────────────────────────────────────

test("mat4: identity is the multiplicative unit", () => {
  const p = perspective(1, 1.5, 0.1, 100);
  assert.deepEqual(Array.from(multiply(identity(), p)), Array.from(p));
  assert.deepEqual(Array.from(multiply(p, identity())), Array.from(p));
});

test("mat4: a camera looking at a point sees it dead centre", () => {
  const vp = multiply(
    perspective(0.8, 1.6, 0.1, 500),
    lookAt([10, 20, 30], [1, 2, 3]),
  );
  const [x, y, z] = project(vp, [1, 2, 3]);
  assert.ok(close(x, 0) && close(y, 0), `centre projects to ${x}, ${y}`);
  assert.ok(z > -1 && z < 1, "inside the depth range");
});

test("mat4: lookAt survives looking straight down the up axis", () => {
  const m = lookAt([0, 50, 0], [0, 0, 0]);
  assert.ok(Array.from(m).every(Number.isFinite));
});

test("mat4: normalize never returns NaN for a zero vector", () => {
  assert.deepEqual(normalize([0, 0, 0]), [0, 1, 0]);
  assert.ok(close(length(normalize([3, 4, 12])), 1));
  assert.deepEqual(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
});

// ── mesh ────────────────────────────────────────────────────────────────────

test("mesh: a box is twelve triangles with unit normals and its own bounds", () => {
  const m = new MeshBuilder().box([0, 0, 0], [2, 3, 4], [1, 0, 0]).build();
  assert.equal(m.count, 36);
  assert.deepEqual(m.bounds, { min: [0, 0, 0], max: [2, 3, 4] });
  for (let i = 0; i < m.normals.length; i += 3) {
    assert.ok(
      close(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]), 1),
    );
  }
});

test("mesh: a tube has a ring per point and keeps its thickness round a corner", () => {
  const sides = 6;
  const pts = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 0, 10],
  ];
  const m = new MeshBuilder().tube(pts, 0.5, [1, 1, 1], { sides }).build();
  assert.equal(m.count, (pts.length - 1) * sides * 6);
  assertFinite(m, "tube");
  // The mitred corner ring reaches FURTHER than the radius (it is stretched
  // across the bend), never less.
  let far = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    const d = Math.hypot(m.positions[i] - 10, m.positions[i + 2] - 0);
    if (d < 1) far = Math.max(far, d);
  }
  assert.ok(far >= 0.5 - 1e-6, `corner ring reaches ${far}`);
});

test("mesh: coincident tube points are skipped, not turned into NaN", () => {
  const m = new MeshBuilder()
    .tube(
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 5, 0],
        [0, 5, 0],
      ],
      0.1,
      [1, 1, 1],
    )
    .build();
  assertFinite(m, "dedupe");
  assert.ok(m.count > 0);
});

test("mesh: cylinders, domes, tori, discs and prisms build finite geometry", () => {
  const mb = new MeshBuilder();
  mb.cylinder([0, 0, 0], [1, 1, 0], 1, 3, [1, 0, 0]);
  mb.dome([0, 0, 0], [0, 1, 0], 1, [0, 1, 0]);
  mb.torus([0, 0, 0], [0, 0, 1], 2, 0.4, [0, 0, 1]);
  mb.disc([0, 0, 0], [0, 1, 0], 1, [1, 1, 1]);
  mb.extrude(roundedRect(0, 0, 4, 2, 0.5, 0), [0, 1, 0], {
    top: [1, 1, 1],
    side: [0, 0, 0],
  });
  const m = mb.build();
  assertFinite(m, "primitives");
  assert.ok(m.count > 0 && m.count % 3 === 0);
});

test("mesh: boundsSince boxes only what was added after the mark", () => {
  const mb = new MeshBuilder().box([0, 0, 0], [1, 1, 1], [1, 0, 0]);
  const mark = mb.vertexCount;
  assert.equal(mb.boundsSince(mark), null, "nothing added yet");
  mb.box([5, 2, 5], [6, 4, 7], [1, 0, 0]);
  assert.deepEqual(mb.boundsSince(mark), { min: [5, 2, 5], max: [6, 4, 7] });
  assert.deepEqual(mb.bounds, { min: [0, 0, 0], max: [6, 4, 7] });
});

test("mesh: cubicPoints starts and ends on its end points", () => {
  const pts = cubicPoints([0, 0, 0], [0, 5, 0], [9, 5, 0], [9, 0, 0], 8);
  assert.equal(pts.length, 9);
  assert.deepEqual(pts[0], [0, 0, 0]);
  assert.deepEqual(pts.at(-1), [9, 0, 0]);
});

// ── camera ──────────────────────────────────────────────────────────────────

test("camera: the eye sits `distance` from the target", () => {
  const cam = normalizeCamera({
    target: [5, 0, 5],
    yaw: 0.7,
    pitch: 0.6,
    distance: 42,
  });
  const eye = eyeOf(cam);
  assert.ok(close(Math.hypot(eye[0] - 5, eye[1], eye[2] - 5), 42));
});

test("camera: orbit clamps the pitch; zoom clamps the distance", () => {
  const base = normalizeCamera({});
  assert.equal(orbitBy(base, 0, 1e6).pitch, PITCH_MAX);
  assert.equal(orbitBy(base, 0, -1e6).pitch, PITCH_MIN);
  assert.equal(zoomBy(base, 1e-9).distance, DISTANCE_MIN);
  assert.equal(zoomBy(base, 1e9).distance, DISTANCE_MAX);
  assert.deepEqual(zoomBy(base, -1), base, "a nonsense factor changes nothing");
  assert.ok(wheelFactor(100) > 1 && wheelFactor(-100) < 1);
});

test("camera: panning slides the target along the desk, never off it", () => {
  const cam = normalizeCamera({
    target: [0, 0, 0],
    yaw: 0.3,
    pitch: 0.9,
    distance: 50,
  });
  const moved = panBy(cam, 120, -80, 800);
  assert.equal(moved.target[1], 0);
  assert.ok(Math.hypot(moved.target[0], moved.target[2]) > 0);
});

test("camera: a fit puts every corner of the bounds on screen", () => {
  const bounds = { min: [0, -3.35, 0], max: [64, 6, 21] };
  for (const aspect of [0.6, 1, 1.8]) {
    const cam = fitBounds(normalizeCamera({ yaw: 0.4 }), bounds, aspect);
    const vp = viewProjection(cam, aspect);
    for (const x of [bounds.min[0], bounds.max[0]]) {
      for (const y of [bounds.min[1], bounds.max[1]]) {
        for (const z of [bounds.min[2], bounds.max[2]]) {
          const [px, py] = project(vp, [x, y, z]);
          assert.ok(
            Math.abs(px) <= 1 && Math.abs(py) <= 1,
            `corner at ${px},${py}`,
          );
        }
      }
    }
    assert.ok(close(cam.yaw, 0.4), "a fit keeps the yaw");
  }
  assert.deepEqual(
    fitBounds(normalizeCamera({}), null, 1),
    normalizeCamera({}),
  );
});

// ── palette ─────────────────────────────────────────────────────────────────

test("camera: billboard axes are square to each other and to the line of sight", () => {
  for (const yaw of [0, 0.7, -2.1]) {
    for (const pitch of [PITCH_MIN, 0.9, PITCH_MAX]) {
      const cam = normalizeCamera({
        target: [3, 0, 4],
        yaw,
        pitch,
        distance: 50,
      });
      const { right, up } = billboardAxes(cam);
      const sight = normalize([
        cam.target[0] - eyeOf(cam)[0],
        cam.target[1] - eyeOf(cam)[1],
        cam.target[2] - eyeOf(cam)[2],
      ]);
      assert.ok(close(length(right), 1) && close(length(up), 1));
      assert.ok(close(dot(right, up), 0));
      assert.ok(close(dot(right, sight), 0) && close(dot(up, sight), 0));
      assert.ok(up[1] > 0, "up is up");
      assert.equal(right[1], 0, "right is level with the desk");
    }
  }
});

test("palette: colours parse in every form the stylesheet writes", () => {
  assert.deepEqual(parseColor("#fff"), [1, 1, 1]);
  assert.deepEqual(parseColor("#000000"), [0, 0, 0]);
  assert.deepEqual(parseColor("rgb(255, 0, 0)"), [1, 0, 0]);
  assert.equal(parseColor("var(--x)"), null);
  assert.equal(toHex([1, 0.5, 0]), "#ff8000");
});

test("palette: tokens are read, and fall back to the dark theme's values", () => {
  const p = readPalette((token) =>
    token === "--color-chip-body" ? "#102030" : "",
  );
  assert.deepEqual(p.chipBody, parseColor("#102030"));
  assert.deepEqual(p.boardBody, parseColor("#d9d5c9"));
  for (const name of WIRE_COLORS)
    assert.ok(p.wire[name], `wire colour ${name}`);
  const broken = readPalette(() => {
    throw new Error("no stylesheet");
  });
  assert.ok(broken.base, "a getter that throws still yields a palette");
});

// ── models ──────────────────────────────────────────────────────────────────

test("models: every part the catalog offers has a 3D model", () => {
  const missing = PALETTE_DEFS.filter((def) => !modelKind(def)).map(
    (d) => d.id,
  );
  assert.deepEqual(missing, [], "add a model in scene3d/part-models.js");
  const used = new Set(PALETTE_DEFS.map((def) => modelKind(def)));
  for (const kind of MODEL_KINDS)
    assert.ok(used.has(kind), `model ${kind} is never used`);
  for (const kind of used)
    assert.ok(MODEL_KINDS.includes(kind), `no builder for ${kind}`);
});

test("scene: one of every part builds, every part modelled, nothing NaN", () => {
  const { doc, placed } = everyPartDesk();
  const scene = buildScene(plainDoc(doc), palette);
  assert.deepEqual(scene.errors, []);
  assert.equal(scene.modelled.size, doc.components.length);
  assert.equal(placed.length, doc.components.length);
  assertFinite(scene.mesh, "every-part desk");
  for (const lamp of scene.lamps)
    assertFinite(lamp.mesh, `lamp ${lamp.compId}`);
  // Lamps: one per LED, one per display segment, one per clock and per
  // transistor and relay.
  const comps = doc.components;
  const expected =
    comps.filter((c) => c.ref === "led").length +
    comps.reduce(
      (n, c) =>
        n + (PALETTE_DEFS.find((d) => d.id === c.ref)?.segments?.length ?? 0),
      0,
    ) +
    comps.filter((c) => c.kind === "clock").length +
    comps.filter((c) => {
      const def = PALETTE_DEFS.find((d) => d.id === c.ref);
      return def?.transistor || def?.contacts;
    }).length;
  assert.equal(scene.lamps.length, expected);
  // Every chip prints its part number; every LCD has its glass.
  for (const c of comps.filter((c) => c.kind === "chip")) {
    assert.ok(
      scene.labels.some((l) => l.text === c.ref),
      `${c.ref} is labelled`,
    );
  }
  assert.equal(
    scene.screens.length,
    comps.filter(
      (c) => PALETTE_DEFS.find((d) => d.id === c.ref)?.characterDisplay,
    ).length,
  );
  // The desk stands below the boards and the parts above them.
  assert.ok(scene.bounds.min[1] < 0 && scene.bounds.max[1] > 0);
});

test("scene: every shipped example builds cleanly, every part modelled", () => {
  for (const { name, doc } of demoDocs()) {
    const scene = buildScene(doc, palette);
    assert.deepEqual(
      scene.errors.map((e) => `${e.id}: ${e.error.message}`),
      [],
      name,
    );
    const unmodelled = doc.components.filter((c) => !scene.modelled.has(c.id));
    assert.deepEqual(
      unmodelled.map((c) => c.ref),
      [],
      name,
    );
    assertFinite(scene.mesh, name);
  }
});

test("scene: an empty desk is an empty scene, and the ground still has a floor", () => {
  const scene = buildScene({ boards: [], components: [], wires: [] }, palette);
  assert.equal(scene.mesh.count, 0);
  assert.equal(scene.bounds, null);
  assert.equal(groundMesh(scene.bounds, palette).count, 6);
});

test("scene: a part that cannot resolve draws nothing and breaks nothing", () => {
  const scene = buildScene(
    {
      boards: [],
      components: [
        {
          id: "c1",
          kind: "chip",
          ref: "74LS00",
          board: "gone",
          anchor: "e3",
          params: {},
        },
        {
          id: "c2",
          kind: "discrete",
          ref: "no-such-part",
          board: "gone",
          anchor: "e3",
        },
      ],
      wires: [{ id: "w1", from: "gone.a1", to: "gone.a2", color: "red" }],
    },
    palette,
  );
  assert.deepEqual(scene.errors, []);
  assert.equal(scene.modelled.size, 0);
  assert.equal(scene.mesh.count, 0);
});

test("wires: an end resolves to its hole on the board, or the top of a post", () => {
  const { doc } = everyPartDesk();
  const view = plainDoc(doc);
  const board = doc.boards.find((b) => b.type === "pins-full");
  const hole = endOf(view, `${board.id}.a5`);
  assert.equal(hole.hole, true);
  assert.equal(hole.p[1], 0);
  const psu = doc.components.find((c) => c.ref === "psu");
  const post = endOf(view, `${psu.id}.+`);
  assert.equal(post.hole, false);
  assert.ok(post.p[1] > 0);
  assert.equal(endOf(view, "nowhere.a1"), null);
});

test("wires: a longer jumper arches higher", () => {
  const top = (pts) => Math.max(...pts.map((p) => p[1]));
  const short = archPoints([0, 0.3, 0], [2, 0.3, 0]);
  const long = archPoints([0, 0.3, 0], [30, 0.3, 0]);
  assert.ok(top(long) > top(short));
  assert.deepEqual(short[0], [0, 0.3, 0]);
  assert.deepEqual(long.at(-1), [30, 0.3, 0]);
});

test("scene: a bus member is drawn in its ribbon, never as a loose jumper too", () => {
  const { doc } = everyPartDesk();
  const view = plainDoc(doc);
  const withBus = buildScene(view, palette).mesh.count;
  const without = buildScene({ ...view, buses: [] }, palette).mesh.count;
  // The same four wires drawn either way: as a ribbon they are longer runs,
  // but they are drawn once — not ribbon + jumper.
  const bus = doc.buses[0];
  const loose = buildScene(
    {
      ...view,
      wires: view.wires.filter((w) => !bus.members.includes(w.id)),
      buses: [],
    },
    palette,
  ).mesh.count;
  assert.ok(withBus > loose && without > loose);
  assert.ok(withBus < loose + 2 * (without - loose), "not drawn twice");
});

// ── annotations ─────────────────────────────────────────────────────────────

test("annotations: a note wraps near the desk's width, a label never does", () => {
  const long = "word ".repeat(40).trim();
  const note = annotationLines(long, true);
  assert.ok(note.length > 1, "a long note wraps");
  assert.equal(note.join(" "), long, "without losing a word");
  assert.deepEqual(annotationLines(long, false), [long]);
  assert.deepEqual(annotationLines("a\nb", false), ["a", "b"]);
});

test("annotations: printed where they are, at the boards' top-face height", () => {
  const { doc } = everyPartDesk();
  const board = doc.boards[0];
  const view = {
    ...plainDoc(doc),
    annotations: [
      {
        id: "an1",
        kind: "label",
        x: board.x + 2,
        y: board.y + 1,
        text: "ON BOARD",
      },
      {
        id: "an2",
        kind: "note",
        x: -40,
        y: -40,
        text: "off the boards\nline two",
      },
      { id: "an3", kind: "note", x: 0, y: 0, text: "   " },
    ],
  };
  const scene = buildScene(view, palette);
  assert.deepEqual(scene.errors, []);
  const onBoard = scene.labels.find((l) => l.text === "ON BOARD");
  assert.equal(onBoard.align, "left");
  assert.ok(Math.abs(onBoard.center[0] - (board.x + 2)) < 1);
  const off = scene.labels.filter((l) => /boards|two/.test(l.text));
  assert.equal(off.length, 2);
  // Never down on the desk floor, where the board it captions would hide it.
  for (const l of [onBoard, ...off]) {
    assert.ok(l.center[1] > DESK_Y + 1 && l.center[1] < 0.1);
  }
  assert.ok(off[1].center[2] > off[0].center[2], "line two is below");
  assert.ok(
    !scene.labels.some((l) => l.text.trim() === ""),
    "blank notes print nothing",
  );
});

// ── live state ──────────────────────────────────────────────────────────────

test("lamps: lit from the desk's verdicts and the published sim-state only", () => {
  const led = { kind: "led", compId: "c1" };
  const seg = { kind: "segment", compId: "c2", seg: "a" };
  const clock = { kind: "clock", compId: "clk1" };
  const channel = { kind: "channel", compId: "c3" };
  const live = {
    running: true,
    ledOf: (id) => (id === "c1" ? { lit: true, burnt: false } : null),
    segmentOf: (id, s) =>
      id === "c2" && s === "a" ? { lit: false, burnt: true } : null,
    clockLevels: new Map([["clk1", "H"]]),
    channels: new Map([["c3", [{ on: "L" }]]]),
  };
  assert.equal(lampState(led, live), "on");
  assert.equal(lampState(seg, live), "burnt");
  assert.equal(lampState(clock, live), "on");
  assert.equal(lampState(channel, live), "off");
  // Stopped, everything is dark whatever the maps say.
  assert.equal(lampState(led, { ...live, running: false }), "off");
  assert.equal(lampState(clock, null), "off");
});

test("lamps: brightness follows the desk's level — dim, full, overdriven", () => {
  const led = { kind: "led", compId: "c1" };
  const seg = { kind: "segment", compId: "c2", seg: "a" };
  const clock = { kind: "clock", compId: "clk1" };
  const live = {
    running: true,
    ledOf: () => ({ lit: true, burnt: false, level: 0.4 }),
    segmentOf: () => ({ lit: true, burnt: false, level: null }),
  };
  assert.equal(lampLevel(led, live), 0.4);
  assert.equal(lampLevel(seg, live), null, "a replay pass has no level");
  assert.equal(lampLevel(clock, live), null, "a clock lamp is simply on");
  assert.equal(lampLevel(led, { ...live, running: false }), null);

  const lamp = {
    on: [1, 0, 0],
    off: [0.2, 0, 0],
    burnt: [0.3, 0.3, 0.3],
    halo: { center: [1, 2, 3], radius: 1.5 },
  };
  const dim = lampLook(lamp, "on", 0.25);
  const full = lampLook(lamp, "on", 1);
  const plain = lampLook(lamp, "on", null);
  const hot = lampLook(lamp, "on", 1.5);
  // The lens climbs from the unlit colour toward the lit one (the desk's
  // 0.3 + 0.7·level), and glows past the light as it does.
  assert.ok(dim.color[0] > lamp.off[0] && dim.color[0] < full.color[0]);
  assert.deepEqual(full.color, lamp.on);
  assert.deepEqual(plain, full, "no level is full brightness");
  assert.ok(dim.emissive < full.emissive);
  assert.equal(full.emissive, LIT_GLOW);
  // The halo widens with the level, uncapped at 1 — an overdriven LED blazes.
  assert.ok(dim.halo.radius < full.halo.radius);
  assert.ok(full.halo.radius < hot.halo.radius);
  assert.ok(dim.halo.alpha < full.halo.alpha);
  assert.deepEqual(full.halo.center, lamp.halo.center);
  // …and its lens washes toward white.
  assert.ok(hot.color[1] > 0 && hot.color[2] > 0);
  // Off is the unlit colour, burnt the smoke's, and neither throws a halo.
  assert.deepEqual(lampLook(lamp, "off", 1), { color: lamp.off, emissive: 0, halo: null }); // prettier-ignore
  assert.deepEqual(lampLook(lamp, "burnt", 1), { color: lamp.burnt, emissive: 0, halo: null }); // prettier-ignore
  // A run too fast to read a glow keeps the lens and drops the halo.
  const flat = lampLook(lamp, "on", 1, false);
  assert.equal(flat.halo, null);
  assert.deepEqual(flat.color, full.color);
  // A lamp with no halo of its own (a segment) never gets one.
  assert.equal(lampLook({ ...lamp, halo: null }, "on", 1).halo, null);
});

test("lamps: the round ones carry a halo; segments and bars do not", () => {
  const { doc } = everyPartDesk();
  const scene = buildScene(plainDoc(doc), palette);
  for (const lamp of scene.lamps) {
    const round = lamp.kind !== "segment";
    assert.equal(Boolean(lamp.halo), round, `${lamp.kind} ${lamp.compId}`);
    if (lamp.halo) {
      assert.ok(
        lamp.halo.radius > 0 && lamp.halo.center.every(Number.isFinite),
      );
    }
  }
});

test("smoke: every modelled part has a plume, on top of what was drawn for it", () => {
  const { doc } = everyPartDesk();
  const scene = buildScene(plainDoc(doc), palette);
  assert.equal(scene.plumes.length, scene.modelled.size);
  const ids = new Set(scene.plumes.map((p) => p.compId));
  for (const id of scene.modelled.keys()) assert.ok(ids.has(id), id);
  for (const plume of scene.plumes) {
    assert.ok(plume.base.every(Number.isFinite), plume.compId);
    assert.ok(plume.radius >= 0.3 && plume.radius <= 1, plume.compId);
    assert.ok(plume.base[1] > DESK_Y, `${plume.compId} smokes above the desk`);
  }
  // A chip's column is broader than an LED's, and rises off its body's top.
  const of = (ref) => {
    const comp = doc.components.find((c) => c.ref === ref);
    return scene.plumes.find((p) => p.compId === comp.id);
  };
  const chip = of(doc.components.find((c) => c.kind === "chip").ref);
  const led = of("led");
  assert.ok(chip.radius > led.radius);
  assert.ok(close(chip.base[1], 1.65, 0.05), `chip top at ${chip.base[1]}`);
  assert.ok(led.base[1] > 3.5, "an LED smokes from its dome");
});

test("smoke: a plume smokes only when the desk says so, in the desk's smoke", () => {
  const plume = { compId: "c1" };
  const live = {
    running: true,
    smokeOf: (id) => (id === "c1" ? "brown" : null),
  };
  assert.equal(plumeSmoke(plume, live), "brown");
  assert.equal(plumeSmoke({ compId: "c2" }, live), null);
  assert.equal(plumeSmoke(plume, { ...live, running: false }), null);
  assert.equal(plumeSmoke(plume, null), null);
  assert.equal(plumeSmoke(plume, { running: true }), null);
});

test("smoke: puffs follow the desk's keyframes, rising and swelling as they fade", () => {
  assert.equal(puffOpacity(0), 0);
  assert.ok(close(puffOpacity(0.18), 0.95));
  assert.ok(close(puffOpacity(0.45), 0.85));
  assert.equal(puffOpacity(1), 0);
  const plume = { base: [10, 1.65, 20], radius: 0.8 };
  const puffs = plumePuffs(plume, 0);
  assert.equal(puffs.length, 7);
  for (const p of puffs) {
    assert.ok(p.center.every(Number.isFinite));
    assert.ok(p.center[1] >= plume.base[1], "never below the part");
    assert.ok(p.alpha >= 0 && p.alpha <= 0.95);
  }
  // One puff, followed through its cycle: higher and bigger as it goes.
  const early = plumePuffs(plume, 0.1 * PUFF_CYCLE_S)[0];
  const late = plumePuffs(plume, 0.8 * PUFF_CYCLE_S)[0];
  assert.ok(late.center[1] > early.center[1]);
  assert.ok(late.radius > early.radius);
  // The cycle repeats.
  const again = plumePuffs(plume, 1.1 * PUFF_CYCLE_S)[0];
  assert.ok(close(again.center[1], early.center[1], 1e-9));
  // Reduced motion: a column that holds still.
  assert.deepEqual(
    plumePuffs(plume, 0, { still: true }),
    plumePuffs(plume, 7.3, { still: true }),
  );
  assert.ok(plumePuffs(plume, 0, { still: true }).every((p) => p.alpha > 0));
});
