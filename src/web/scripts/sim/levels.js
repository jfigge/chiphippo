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

// levels.js — the signal-level vocabulary and ternary gate primitives shared
// by the whole engine. Pure and DOM-free.
//
//   H  logic high        L  logic low
//   Z  high impedance / undriven (a floating node)
//   X  conflict / unknown
//
// TTL authenticity: a FLOATING TTL input reads HIGH — `asInput(Z) === H` — a
// deliberate, documented choice (real 74xx inputs pull themselves high). `X`
// propagates as `X` except where a dominant input forces the result (a NAND
// with any `L` is `H` regardless of an `X` on another pin — the standard
// ternary-logic shortcut).
//
// The primitives operate on driven levels (H/L/X); callers `asInput()` a pin
// first so `Z` never reaches a gate. Tri-state `buf3` may RETURN `Z`.

export const H = "H";
export const L = "L";
export const Z = "Z";
export const X = "X";

/**
 * Read a pin as a gate input: a floating pin (`Z`) pulls HIGH; H/L/X pass
 * through unchanged. This is the one place the "floating reads high" rule
 * lives.
 */
export function asInput(level) {
  return level === Z ? H : level;
}

const some = (arr, v) => arr.some((x) => x === v);

/** AND: any L → L; else any X → X; else H. */
export function and(...ins) {
  if (some(ins, L)) return L;
  if (some(ins, X)) return X;
  return H;
}

/** OR: any H → H; else any X → X; else L. */
export function or(...ins) {
  if (some(ins, H)) return H;
  if (some(ins, X)) return X;
  return L;
}

/** NAND: any L → H (dominant); else any X → X; else L. */
export function nand(...ins) {
  if (some(ins, L)) return H;
  if (some(ins, X)) return X;
  return L;
}

/** NOR: any H → L (dominant); else any X → X; else H. */
export function nor(...ins) {
  if (some(ins, H)) return L;
  if (some(ins, X)) return X;
  return H;
}

/** XOR: no dominant value — any X → X; else odd count of H → H. */
export function xor(...ins) {
  if (some(ins, X)) return X;
  return ins.filter((x) => x === H).length % 2 === 1 ? H : L;
}

/** INV: H↔L; X → X (Z is asInput'd to H before it reaches here). */
export function inv(a) {
  if (a === H) return L;
  if (a === L) return H;
  return X;
}

/**
 * Tri-state buffer with ACTIVE-LOW enable: drives `data` while `enable` is
 * L, floats (`Z`) while `enable` is H, and is unknown (`X`) when the enable
 * itself is unknown.
 */
export function buf3(data, enable) {
  if (enable === L) return data;
  if (enable === H) return Z;
  return X;
}
