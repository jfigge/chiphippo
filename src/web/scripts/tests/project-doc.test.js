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

// The open PROJECT as pure arithmetic: desktops are structure inside one
// document, so adding, renaming, duplicating and deleting one are ordinary
// edits — and the dirty test is a plain signature comparison over the whole
// thing, minus the two things that must never mark a design dirty (which
// desktop is on screen, and where the camera is).

import test from "node:test";
import assert from "node:assert/strict";

import {
  activeDesktop,
  addDesktop,
  duplicateDesktop,
  findDesktop,
  importDesktop,
  normalizeProject,
  projectForFile,
  putCustomChip,
  removeCustomChip,
  withPlacedChips,
  projectSignature,
  removeDesktop,
  setActiveDesktop,
  setDesktopDoc,
  setDesktopField,
  setProjectField,
  setProjectWheelLock,
  cpuBreakpointsOf,
  setCpuBreakpoints,
  PROJECT_VERSION,
} from "../model/project-doc.js";
import { newCustomChip } from "../model/custom-chip.js";

const doc = (n = 1) => ({ version: 9, boards: [], nextBoardId: n });

/** A project of `names.length` desktops, `t1`…`tN`, active on the first. */
function project(...names) {
  return normalizeProject({
    name: "Test",
    activeTab: "t1",
    nextIndex: names.length + 1,
    tabs: names.map((name, i) => ({ id: `t${i + 1}`, name, doc: doc(i + 1) })),
  });
}

const names = (meta) => meta.tabs.map((tab) => tab.name);

// ── Normalize ───────────────────────────────────────────────────────────────

test("normalize drops a tab with no id or no document", () => {
  const meta = normalizeProject({
    activeTab: "t1",
    tabs: [
      { id: "t1", name: "One", doc: doc() },
      { id: "t1", name: "Clash", doc: doc() },
      { id: "t2", name: "No doc" },
      { name: "No id", doc: doc() },
    ],
  });
  assert.deepEqual(
    meta.tabs.map((t) => t.id),
    ["t1"],
  );
  assert.equal(meta.version, PROJECT_VERSION);
});

test("normalize needs a desktop, and falls back to the first as active", () => {
  assert.equal(normalizeProject(null), null);
  assert.equal(normalizeProject({ tabs: [] }), null);
  const meta = normalizeProject({
    activeTab: "nope",
    tabs: [{ id: "t4", name: "Four", doc: doc() }],
  });
  assert.equal(meta.activeTab, "t4");
  assert.equal(meta.nextIndex, 5, "the counter clears what the ids claim");
  assert.equal(meta.location, null);
});

// ── Adding, copying, importing ──────────────────────────────────────────────

test("adding a desktop appends it and lands on it", () => {
  const { meta, tab } = addDesktop(project("Desktop 1"), doc(2));
  assert.deepEqual(names(meta), ["Desktop 1", "Desktop 2"]);
  assert.equal(meta.activeTab, tab.id);
  assert.equal(tab.id, "t2");
  assert.equal(meta.nextIndex, 3);
});

test("desktop numbers only ever count up, even after a delete", () => {
  let meta = project("Desktop 1");
  meta = addDesktop(meta, doc()).meta; // Desktop 2
  meta = addDesktop(meta, doc()).meta; // Desktop 3
  meta = removeDesktop(meta, "t2"); // delete Desktop 2
  meta = addDesktop(meta, doc()).meta;
  assert.deepEqual(names(meta), ["Desktop 1", "Desktop 3", "Desktop 4"]);
});

test("a duplicate lands right after its source, with a distinct name", () => {
  const before = project("Clock module", "Bench");
  const { meta, tab } = duplicateDesktop(before, "t1", doc(9));
  assert.deepEqual(names(meta), ["Clock module", "Clock module copy", "Bench"]);
  assert.equal(meta.activeTab, tab.id);
  assert.equal(
    tab.doc.nextBoardId,
    9,
    "the copy main reseated, not the source",
  );
  assert.equal(before.tabs.length, 2, "the source project is untouched");
  // A second copy cannot collide with the first.
  const twice = duplicateDesktop(meta, "t1", doc(9)).meta;
  assert.deepEqual(names(twice).slice(0, 3), [
    "Clock module",
    "Clock module copy 2",
    "Clock module copy",
  ]);
});

test("duplicating an unknown desktop is a no-op", () => {
  assert.equal(duplicateDesktop(project("One"), "t9", doc()), null);
});

test("an import keeps its snapshot's name and description", () => {
  const { meta, tab } = importDesktop(project("Desktop 1"), {
    name: "Clock module",
    description: "the divider",
    doc: doc(4),
  });
  assert.deepEqual(names(meta), ["Desktop 1", "Clock module"]);
  assert.equal(tab.description, "the divider");
  assert.equal(meta.activeTab, tab.id);
});

test("an import whose name is already taken gets its own", () => {
  const { meta } = importDesktop(project("Bench"), { name: "Bench", doc: doc() }); // prettier-ignore
  assert.deepEqual(names(meta), ["Bench", "Bench 2"]);
});

// ── Removing, selecting ─────────────────────────────────────────────────────

test("a project can never run out of desktops", () => {
  assert.equal(removeDesktop(project("Only"), "t1"), null);
  assert.equal(removeDesktop(project("A", "B"), "t9"), null);
});

test("removing the active desktop lands on its neighbour", () => {
  const meta = setActiveDesktop(project("A", "B", "C"), "t2");
  const next = removeDesktop(meta, "t2");
  assert.deepEqual(names(next), ["A", "C"]);
  assert.equal(next.activeTab, "t3", "the one that took its place");
  // Removing the LAST desktop steps back rather than off the end.
  assert.equal(removeDesktop(setActiveDesktop(meta, "t3"), "t3").activeTab, "t2"); // prettier-ignore
});

test("removing an inactive desktop leaves the desk alone", () => {
  const next = removeDesktop(project("A", "B"), "t2");
  assert.equal(next.activeTab, "t1");
});

test("selecting an unknown desktop changes nothing", () => {
  const meta = project("A", "B");
  assert.equal(setActiveDesktop(meta, "t9"), meta);
});

// ── Properties ──────────────────────────────────────────────────────────────

test("a desktop must keep a name; a blank description is dropped", () => {
  const meta = project("Bench");
  assert.equal(setDesktopField(meta, "t1", "name", "  "), null, "never blank");
  assert.equal(setDesktopField(meta, "t1", "name", "Bench"), null, "unchanged");
  assert.equal(findDesktop(setDesktopField(meta, "t1", "name", "Clock"), "t1").name, "Clock"); // prettier-ignore

  const described = setDesktopField(meta, "t1", "description", "the divider");
  assert.equal(findDesktop(described, "t1").description, "the divider");
  const cleared = setDesktopField(described, "t1", "description", "");
  assert.equal("description" in findDesktop(cleared, "t1"), false);
});

test("Location is read-only on both a desktop and the project", () => {
  const meta = project("A");
  assert.equal(setDesktopField(meta, "t1", "location", "/tmp/x"), null);
  assert.equal(setProjectField(meta, "location", "/tmp/x"), null);
});

test("a project's name may be blanked — an unnamed project is a real state", () => {
  const meta = project("A");
  assert.equal(setProjectField(meta, "name", "6502 SBC").name, "6502 SBC");
  assert.equal(setProjectField(meta, "name", "").name, "");
  assert.equal(setProjectField(meta, "name", "Test"), null, "unchanged");
});

// ── The file, and the one dirty test ────────────────────────────────────────

test("the file carries every desktop's document, and no location", () => {
  const meta = { ...project("A", "B"), location: "/home/x.chiphippo" };
  const file = projectForFile(meta);
  assert.equal(file.location, undefined, "the path is not a stored field");
  assert.deepEqual(
    file.tabs.map((t) => t.doc.nextBoardId),
    [1, 2],
  );
});

test("the signature ignores which desktop is on screen", () => {
  const meta = project("A", "B");
  assert.equal(
    projectSignature(meta),
    projectSignature(setActiveDesktop(meta, "t2")),
    "moving between tabs is not a change to keep or throw away",
  );
});

test("the signature covers every desktop's design, not just the active one", () => {
  const meta = project("A", "B");
  const edited = setDesktopDoc(meta, "t2", doc(99));
  assert.notEqual(projectSignature(meta), projectSignature(edited));
  // ...and renaming one, and adding one.
  assert.notEqual(
    projectSignature(meta),
    projectSignature(setDesktopField(meta, "t1", "name", "Renamed")),
  );
  assert.notEqual(
    projectSignature(meta),
    projectSignature(addDesktop(meta, doc()).meta),
  );
});

// ── The desk padlock ────────────────────────────────────────────────────────

test("the padlock is open unless the file says, exactly, that it is shut", () => {
  assert.equal(project("A").wheelLocked, false, "absent reads as open");
  const raw = { tabs: [{ id: "t1", name: "A", doc: doc() }] };
  assert.equal(
    normalizeProject({ ...raw, wheelLocked: true }).wheelLocked,
    true,
  );
  for (const junk of ["yes", 1, "true", null, {}]) {
    assert.equal(
      normalizeProject({ ...raw, wheelLocked: junk }).wheelLocked,
      false,
    );
  }
});

test("the file holds a SHUT padlock and says nothing about an open one", () => {
  const meta = project("A");
  assert.equal(
    "wheelLocked" in projectForFile(meta),
    false,
    "a project that never shut it writes the bytes it always did",
  );
  const shut = setProjectWheelLock(meta, true);
  assert.equal(projectForFile(shut).wheelLocked, true);
  assert.equal(
    "wheelLocked" in projectForFile(setProjectWheelLock(shut, false)),
    false,
  );
});

test("shutting the padlock is a change to the project", () => {
  const meta = project("A", "B");
  const shut = setProjectWheelLock(meta, true);
  assert.notEqual(projectSignature(meta), projectSignature(shut));
  assert.equal(
    projectSignature(meta),
    projectSignature(setProjectWheelLock(shut, false)),
    "and opening it again is back where it started",
  );
});

test("setting the padlock to what it already is changes nothing", () => {
  const meta = project("A");
  assert.equal(setProjectWheelLock(meta, false), null);
  assert.equal(
    setProjectWheelLock(setProjectWheelLock(meta, true), true),
    null,
  );
  assert.equal(meta.wheelLocked, false, "a new meta, never a mutation");
});

test("setDesktopDoc on an unknown desktop changes nothing", () => {
  const meta = project("A");
  assert.equal(setDesktopDoc(meta, "t9", doc(5)), meta);
  assert.equal(activeDesktop(meta).name, "A");
});

// ── Custom chips (the chip designer) ────────────────────────────────────────

test("a designed chip is a change to the project, and travels in its file", () => {
  const meta = project("A");
  const chip = newCustomChip([]);
  const added = putCustomChip(meta, chip);
  assert.deepEqual(
    added.customChips.map((c) => c.id),
    [chip.id],
  );
  assert.notEqual(projectSignature(added), projectSignature(meta));
  assert.deepEqual(projectForFile(added).customChips, added.customChips);
  assert.equal(meta.customChips.length, 0, "a new meta, never a mutation");
});

test("a project with no designed chips writes no customChips at all", () => {
  assert.equal("customChips" in projectForFile(project("A")), false);
});

test("changing a chip replaces it in place; the same chip changes nothing", () => {
  const chip = newCustomChip([]);
  const other = { ...newCustomChip([chip]), id: "custom-00000002" };
  const meta = putCustomChip(putCustomChip(project("A"), chip), other);
  assert.equal(putCustomChip(meta, chip), null);
  const renamed = putCustomChip(meta, { ...chip, name: "MYNAND" });
  assert.deepEqual(
    renamed.customChips.map((c) => [c.id, c.name]),
    [
      [chip.id, "MYNAND"],
      [other.id, other.name],
    ],
  );
});

test("a chip that is no chip is refused; removing one that isn't there is a no-op", () => {
  const meta = project("A");
  assert.equal(putCustomChip(meta, { id: "nope" }), null);
  assert.equal(removeCustomChip(meta, "custom-0000beef"), null);
  const chip = newCustomChip([]);
  const added = putCustomChip(meta, chip);
  assert.deepEqual(removeCustomChip(added, chip.id).customChips, []);
});

test("normalize keeps the chips a file carries, dropping what is not one", () => {
  const chip = newCustomChip([]);
  const meta = normalizeProject({
    activeTab: "t1",
    tabs: [{ id: "t1", name: "One", doc: doc() }],
    customChips: [chip, { id: "bad id" }, "junk"],
  });
  assert.deepEqual(
    meta.customChips.map((c) => c.id),
    [chip.id],
  );
});

test("a project's file carries exactly the chips its desktops place", () => {
  const placed = newCustomChip([]);
  const idle = { ...newCustomChip([placed]), id: "custom-0000000e" };
  const meta = normalizeProject({
    activeTab: "t1",
    tabs: [
      { id: "t1", name: "One", doc: doc() },
      {
        id: "t2",
        name: "Two",
        doc: { ...doc(), components: [{ id: "c1", kind: "chip", ref: placed.id }] }, // prettier-ignore
      },
    ],
    customChips: [idle],
  });
  const next = withPlacedChips(meta, [placed, idle]);
  assert.deepEqual(
    next.customChips.map((c) => c.id),
    [placed.id],
    "the placed one, from any desktop; the idle one lives in the library",
  );
  assert.equal(
    withPlacedChips(next, [placed, idle]),
    next,
    "unchanged → itself",
  );
});

// ── The CPU monitor's breakpoints ───────────────────────────────────────────

test("CPU breakpoints are kept per desktop, cleaned, and are an edit to the FILE", () => {
  const meta = project("One", "Two");
  assert.deepEqual(cpuBreakpointsOf(meta, "t1"), {});
  const set = setCpuBreakpoints(meta, "t1", { c3: [0x8021, 0x8008, 0x8008, 0x1_0000, 2.5], c4: [], x: [1] }); // prettier-ignore
  assert.deepEqual(cpuBreakpointsOf(set, "t1"), { c3: [0x8008, 0x8021] });
  assert.deepEqual(cpuBreakpointsOf(set, "t2"), {}, "another desktop's c3 is another chip"); // prettier-ignore
  assert.notEqual(projectSignature(set), projectSignature(meta), "a •");
  assert.deepEqual(projectForFile(set).cpuBreakpoints, { t1: { c3: [0x8008, 0x8021] } }); // prettier-ignore
  assert.equal(setCpuBreakpoints(set, "t1", { c3: [0x8021, 0x8008] }), null, "unchanged"); // prettier-ignore
  assert.equal(setCpuBreakpoints(set, "t9", { c3: [1] }), null, "no such desktop"); // prettier-ignore

  // Cleared: no key in the file at all, so it is the bytes it always was.
  const cleared = setCpuBreakpoints(set, "t1", {});
  assert.equal("cpuBreakpoints" in projectForFile(cleared), false);
  assert.equal(projectSignature(cleared), projectSignature(meta));

  // Read back from a file, and pruned to the desktops that exist.
  const read = normalizeProject({ ...projectForFile(set), cpuBreakpoints: { t1: { c3: [5] }, t7: { c3: [6] } } }); // prettier-ignore
  assert.deepEqual(read.cpuBreakpoints, { t1: { c3: [5] } });
  const gone = removeDesktop(set, "t1");
  assert.equal("cpuBreakpoints" in projectForFile(gone), false);
});

test("a duplicated desktop keeps its CPUs' breakpoints", () => {
  const meta = setCpuBreakpoints(project("One"), "t1", { c3: [0x8000] });
  const { meta: next, tab } = duplicateDesktop(meta, "t1", doc(5));
  assert.deepEqual(cpuBreakpointsOf(next, tab.id), { c3: [0x8000] });
  assert.deepEqual(cpuBreakpointsOf(next, "t1"), { c3: [0x8000] });
});
