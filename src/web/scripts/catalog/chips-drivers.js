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

// chips-drivers.js — the interface parts between logic and a load: the
// ULN2003A Darlington array and the optocouplers. Chips (DIPs, seated and
// exported like one) but in no logic family, so FAMILY-LESS, shelved under
// CHIPS ▸ Interface beside the 65xx peripherals. None has a supply pin: each
// is transistors on a die, powered by what drives them, so the engine treats
// it as it treats a discrete transistor — always "ok" (`supplyless`).
//
// The logic engine runs each as the switch it is in a logic circuit: a
// channel between its switched pins (sim/analog-switch.js), closed by its
// input read as a plain level. Under Spice Lite each is its devices
// (spice/voltages.js): the ULN2003A's seven Darlingtons with their base
// resistors and clamp diodes, an optocoupler's LED and phototransistor.

import { input, io, nc, passive } from "./pin-builders.js";
import { H, L } from "../sim/levels.js";

/** The ULN2003A's channel n (1–7): input pin n, output pin 17 − n. */
const ULN_CHANNELS = Object.freeze(
  Array.from({ length: 7 }, (_, i) => ({ input: i + 1, output: 16 - i })),
);
const ULN_E = 8;
const ULN_COM = 9;

/** The CTRs an optocoupler's Properties offer, percent: the PC817's rank
    bins span 50–600 % (A 80–160, B 130–260, C 200–400, D 300–600). */
const CTR_CHOICES = Object.freeze([50, 100, 200, 300, 600]);

/** An optocoupler's CTR field (Spice Lite only — the logic engine has no
    currents): `default` its sheet's typical. */
const ctrField = (ctr) =>
  Object.freeze({
    key: "ctr",
    label: "Current transfer ratio",
    type: "select",
    spiceOnly: true,
    default: ctr,
    options: CTR_CHOICES.map((v) => ({ value: v, label: `${v} %` })),
  });

/** An optocoupler's CTR as stored: one of the choices, and only off its
    default. */
const ctrParams = (ctr) => (raw) => {
  const v = Number(raw?.ctr);
  return CTR_CHOICES.includes(v) && v !== ctr ? { ctr: v } : {};
};

/** An optocoupler's channel, the switch its phototransistor is to the logic
    engine: closed while its LED is lit — anode HIGH, cathode LOW — and open
    otherwise, an LED nothing drives included. */
const optoChannel = ({ a, k, c, e }) =>
  Object.freeze({
    a: c,
    b: e,
    inputs: [a, k],
    on: ([anode, cathode]) => (anode === H && cathode === L ? H : L),
  });

/** What every optocoupler's blurb says about its two engines. */
const OPTO_NOTE =
  "The logic engine closes C–E while the LED's anode is HIGH and its " +
  "cathode LOW. Under Spice Lite the LED is an infrared LED (about 1.2 V; " +
  "give it a series resistor like any LED) and the phototransistor carries " +
  "the LED's current times its CTR, never more than the circuit lets " +
  "through — set the CTR in Properties. The two sides share nothing, so " +
  "each may run from its own supply.";

export const CHIPS_DRIVERS = Object.freeze([
  {
    // SLRS027R (ULN2002A/ULN2003A/ULN2004A), §5 pin functions (N package):
    // 1B–7B inputs on 1–7, E (the emitters) on 8, COM (the clamp diodes'
    // common) on 9, 7C–1C on 10–16.
    id: "ULN2003A",
    title: "Darlington array (7×)",
    blurb:
      "Seven Darlington drivers with clamp diodes — the standard way to " +
      "drive a relay, a motor, a solenoid or a lamp from a logic output. " +
      "Each input (1–7) switches the output opposite it (16–10) to E (8): " +
      "HIGH sinks the load's current, LOW (or nothing) leaves the output " +
      "open, so the load goes from its supply to the output. Tie E to GND. " +
      "Tie COM (9) to the LOAD's supply and each output's diode catches the " +
      "kick a coil throws when it is switched off. Inputs take 5 V logic " +
      "through a 2.7 kΩ resistor; an output sinks up to 500 mA, about 1 V " +
      "above E when on. Needs no supply of its own. Under Spice Lite each " +
      "channel is its Darlington and diode; the logic engine runs it as a " +
      "switch.",
    group: "Interface",
    package: "DIP-16",
    supplyless: true,
    // An input nothing drives passes no base current: off, as a discrete
    // transistor's floating base is (catalog/families.js `floatsUnknown`).
    floating: "unknown",
    // Spice Lite: each channel a Darlington of this array's own figures
    // (spice/transistors.js ARRAY_MODELS), its base behind 2.7 kΩ.
    bipolarArray: "uln2003a",
    pins: [
      ...ULN_CHANNELS.map((ch, i) => input(ch.input, `${i + 1}B`)),
      io(ULN_E, "E"),
      passive(ULN_COM, "COM"),
      ...ULN_CHANNELS.map((ch, i) => io(ch.output, `${i + 1}C`)),
    ],
    logic: {
      // A Darlington follows its base and remembers nothing: HIGH joins
      // its output to E; LOW, or a base nothing drives, leaves it open
      // (sim/analog-switch.js `transistorSwitch`).
      channels: ULN_CHANNELS.map((ch, i) => ({
        a: ch.output,
        b: ULN_E,
        inputs: [ch.input],
        on: ([level]) => (level === H ? H : L),
        base: `b${i + 1}`,
      })),
      // Inside the package (spice/voltages.js `internals`): each base behind
      // its 2.7 kΩ, and each output's clamp diode to COM.
      internals: {
        nets: ULN_CHANNELS.map((_, i) => `b${i + 1}`),
        resistors: ULN_CHANNELS.map((ch, i) => ({
          a: ch.input,
          b: `b${i + 1}`,
          ohms: 2700,
        })),
        junctions: ULN_CHANNELS.map((ch) => ({
          anode: ch.output,
          cathode: ULN_COM,
        })),
      },
      // Each output's own rating (spice/params.js `limitsAt`): 500 mA
      // continuous per channel (SLRS027R §6.1), warned past it.
      limits: Object.fromEntries(
        ULN_CHANNELS.map((ch) => [ch.output, { warnMa: 500, smokeMa: 1500 }]),
      ),
    },
  },
  {
    // Vishay 4N35 (doc. 81181): 1 A, 2 C (the LED's cathode, K here), 3 NC,
    // 4 E, 5 C, 6 B. CTR 100 % min at IF 10 mA, VCE 10 V.
    id: "4N35",
    title: "Optocoupler (phototransistor, with base)",
    blurb:
      "An LED and a phototransistor in one package, sharing no connection: " +
      "light from the LED (1 → 2) turns on the transistor (5 → 4), so a " +
      "logic signal can switch a circuit on another supply. The base (6) is " +
      "brought out, and not modelled — leave it open. " +
      OPTO_NOTE,
    group: "Interface",
    package: "DIP-6",
    supplyless: true,
    optocoupler: Object.freeze({ a: 1, k: 2, c: 5, e: 4, ctr: 100 }),
    properties: [ctrField(100)],
    extraParams: ctrParams(100),
    pins: [
      input(1, "A"),
      input(2, "K"),
      nc(3),
      io(4, "E"),
      io(5, "C"),
      passive(6, "B"),
    ],
    logic: { channels: [optoChannel({ a: 1, k: 2, c: 5, e: 4 })] },
  },
  {
    // Sharp PC817 (PC817X series): 1 anode, 2 cathode, 3 emitter,
    // 4 collector. CTR 50–600 % at IF 5 mA, VCE 5 V; 100 % taken as typical.
    id: "PC817",
    title: "Optocoupler (phototransistor)",
    blurb:
      "The everyday 4-pin optocoupler: an LED (1 → 2) and a phototransistor " +
      "(4 → 3) in one package, sharing no connection, so a logic signal can " +
      "switch a circuit on another supply. " +
      OPTO_NOTE,
    group: "Interface",
    package: "DIP-4",
    supplyless: true,
    optocoupler: Object.freeze({ a: 1, k: 2, c: 4, e: 3, ctr: 100 }),
    properties: [ctrField(100)],
    extraParams: ctrParams(100),
    pins: [input(1, "A"), input(2, "K"), io(3, "E"), io(4, "C")],
    logic: { channels: [optoChannel({ a: 1, k: 2, c: 4, e: 3 })] },
  },
]);
