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

// bus-layout.js — the pure geometry the bus tool (Feature 130) lays a run of
// wires with. Two gestures, both a first click on a START hole then a second:
//
//   • RUN mode  — second click on another bare hole: `width` wires march down
//     two parallel runs, bit i connecting (start + i) to (end + i) along each
//     run's own axis (grid column / rail index).
//   • TAP mode  — second click on a chip pin in a catalog `pinGroups` run: the
//     bus fans to that group in BIT order (member carrying bit b → the group's
//     pin for bit b), each wire landing in a FREE hole of that pin's node (you
//     never wire onto the pin's own hole — you share its 5-hole column).
//
// Both return an ordered `[{ from, to }]` of ADDRESS pairs (member 0 first), or
// null when the geometry doesn't fit (a run off a strip, a floating pin, no
// free tap hole, a width/run mismatch). Freeness of the pair endpoints is the
// caller's to confirm against occupancy — this module is DOM- and doc-mutation
// free, so a test builds a scene as data.

import {
  formatAddress,
  holeAlong,
  holesOfNode,
  nodeOf,
  parseAddress,
} from "./breadboard.js";
import { partPinAddresses } from "./occupancy.js";

/**
 * RUN mode: `width` `{ from, to }` pairs, bit i from `start` shifted i steps
 * along its run to `end` shifted i steps along its. Null if either run walks
 * off its strip before `width` holes, or an endpoint doesn't parse.
 *
 * @param {Array} boards
 * @param {string} start address of bit 0's source hole
 * @param {string} end   address of bit 0's destination hole
 * @param {number} width
 */
export function busRunAddresses(boards, start, end, width) {
  const ps = parseAddress(start);
  const pe = parseAddress(end);
  if (!ps || !pe || !Number.isInteger(width) || width < 1) return null;
  const bs = boards.find((b) => b.id === ps.boardId);
  const be = boards.find((b) => b.id === pe.boardId);
  if (!bs || !be) return null;
  const pairs = [];
  for (let i = 0; i < width; i += 1) {
    const fromHole = holeAlong(bs.type, ps.hole, i);
    const toHole = holeAlong(be.type, pe.hole, i);
    if (!fromHole || !toHole) return null; // ran off a strip
    pairs.push({
      from: formatAddress(ps.boardId, fromHole),
      to: formatAddress(pe.boardId, toHole),
    });
  }
  return pairs;
}

/**
 * TAP mode: fan a bus onto a chip's labelled pin group. Member i's source is
 * `start` shifted i along its run; its destination is a free hole in the node
 * of the group pin carrying that member's bit (`bits[i]`). Requires the run
 * width to match the group (`bits.length === group.pins.length`).
 *
 * @param {{ boards:Array, components:Array, wires:Array }} doc
 * @param {string} start address of bit 0's source hole
 * @param {object} comp  the chip component the group lives on
 * @param {{ name:string, pins:number[] }} group the catalog pin group
 * @param {number[]} bits bit number each ordered member carries (parseBusName)
 * @param {(address:string) => boolean} isFree real-and-unoccupied predicate
 */
export function busTapAddresses(doc, start, comp, group, bits, isFree) {
  const ps = parseAddress(start);
  if (!ps || !Array.isArray(bits) || bits.length < 1) return null;
  const startBoard = (doc.boards ?? []).find((b) => b.id === ps.boardId);
  if (!startBoard) return null;
  if (!group || !Array.isArray(group.pins)) return null;
  if (bits.length !== group.pins.length) return null; // width must match the run
  const pinAddr = partPinAddresses(doc, comp);
  if (!pinAddr) return null;
  const addressOfPin = new Map(pinAddr.map((p) => [p.pin, p.address]));
  const usedTap = new Set();
  const pairs = [];
  for (let i = 0; i < bits.length; i += 1) {
    const fromHole = holeAlong(startBoard.type, ps.hole, i);
    if (!fromHole) return null;
    const from = formatAddress(ps.boardId, fromHole);
    const pinAddress = addressOfPin.get(group.pins[bits[i]]);
    if (!pinAddress) return null; // pin not seated / floating
    const tap = freeHoleInNode(doc, pinAddress, isFree, usedTap);
    if (!tap) return null;
    usedTap.add(tap);
    pairs.push({ from, to: tap });
  }
  return pairs;
}

/**
 * A free hole electrically common with `pinAddress` (its 5-hole column node),
 * skipping any already claimed this fan. Null when the pin's own hole is the
 * only one or every sibling is taken — the tap can't land, so it's illegal.
 */
function freeHoleInNode(doc, pinAddress, isFree, used) {
  const p = parseAddress(pinAddress);
  const board = p && (doc.boards ?? []).find((b) => b.id === p.boardId);
  if (!board) return null;
  const node = nodeOf(board.type, p.hole);
  const holesInNode = node && holesOfNode(board.type, node);
  if (!holesInNode) return null;
  for (const hole of holesInNode) {
    const address = formatAddress(p.boardId, hole);
    if (!used.has(address) && isFree(address)) return address;
  }
  return null;
}
