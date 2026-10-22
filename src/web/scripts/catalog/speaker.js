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

// speaker.js — the speaker: a small PCB speaker on two legs, which plays the
// tone the circuit puts across it. Spice Lite's alone (`spiceOnly` — the tray
// shows it only while Spice Lite is on): its voice coil is a resistor in the
// solve, and the engine times the voltage across it (spice/measure.js
// `noteTone`) into a pitch and a loudness that components/speaker-audio.js
// plays. The logic engine has no voltages to time, so there it is silent.

/** The voice coils it may have, ohms — the small speakers' usual three. */
export const SPEAKER_OHMS = Object.freeze([8, 16, 32]);

/** Its loudness setting, percent, unless one is set. */
export const SPEAKER_VOLUME_DEFAULT = 50;

/** What a speaker plays at full loudness, watts: a pocket speaker's sound
    at arm's length (they are rated about 0.5 W, and a tone through one from
    a logic output is a few to a few tens of milliwatts). */
export const SPEAKER_FULL_W = 0.025;

/** The power its coil is rated for, watts: a small PCB speaker's usual
    0.5 W. Past it Spice Lite warns. */
export const SPEAKER_RATED_W = 0.5;

/** The power its coil burns open at, watts — twice its rating (Jason,
    2026-10-22: "release smoke on a speaker over power by 200%"). Its heat,
    not one instant's power, is what reaches it (spice/speakers.js). */
export const SPEAKER_SMOKE_W = 2 * SPEAKER_RATED_W;

/** A speaker's params: its coil's impedance, ohms (8 Ω unless set to
    another), and its loudness, a whole percent. */
export function speakerParams(raw) {
  const impedance = Number(raw?.impedance);
  const volume = Number(raw?.volume);
  return {
    impedance: SPEAKER_OHMS.includes(impedance) ? impedance : SPEAKER_OHMS[0],
    volume: Number.isFinite(volume)
      ? Math.min(100, Math.max(0, Math.round(volume)))
      : SPEAKER_VOLUME_DEFAULT,
    // A quarter turn about its + leg (`turns`), stored only when turned.
    ...([90, 180, 270].includes(raw?.rot) ? { rot: raw.rot } : {}),
  };
}

/**
 * How loud a tone plays, 0–1: the power it puts into the coil against
 * SPEAKER_FULL_W — as the ear hears it, the square root — times the
 * speaker's own Volume.
 * @param {number} watts
 * @param {number} volume - percent
 */
export function speakerLoudness(watts, volume) {
  if (!(watts > 0) || !(volume > 0)) return 0;
  return Math.min(1, Math.sqrt(watts / SPEAKER_FULL_W)) * (volume / 100);
}

export const SPEAKER_DEF = Object.freeze({
  id: "speaker",
  kind: "discrete",
  title: "Speaker",
  blurb:
    "A small PCB speaker, 12 mm across, its two legs 0.3 in apart. Put a " +
    "tone across it and you hear it: a 555 astable, a counter's output, a " +
    "clock brick — through a capacitor (100 µF) and a resistor that keeps " +
    "the current down (its coil is only 8 Ω), or from a transistor. It plays " +
    "the pitch it is driven at and as loud as the power in its coil, times " +
    "its Volume. Its coil is rated 0.5 W: past that it warns, and held past " +
    "1 W the coil burns open in smoke. Spice Lite only: the tray shows it " +
    "while Spice Lite is on, and the logic engine, which has no voltages, " +
    "leaves it silent.",
  group: "Audio",
  // Two legs on 0.3 in (KiCad's Buzzer_12x9.5RM7.6), the round body
  // standing back over the rows behind them as a relay's cube does.
  footprint: Object.freeze({ offsets: Object.freeze([0, 3]) }),
  // R turns it a quarter lap about its + leg (`params.rot`, occupancy.js
  // `partPinHoles`): its legs are 0.3 in apart, the channel's own width, so
  // turned on end it stands across the trench, one leg each side — the body
  // over the channel (Jason, 2026-10-14). A rigid body, so the - leg goes
  // where the turn puts it and nowhere else.
  turns: true,
  // The hook every consumer branches on — never an id.
  speaker: true,
  spiceOnly: true,
  pins: [
    { n: 1, name: "+", role: "lead" },
    { n: 2, name: "-", role: "lead" },
  ],
  properties: [
    {
      key: "impedance",
      label: "Impedance",
      type: "select",
      default: SPEAKER_OHMS[0],
      options: SPEAKER_OHMS.map((ohms) => ({
        value: ohms,
        label: `${ohms} Ω`,
      })),
    },
    {
      key: "volume",
      label: "Volume",
      type: "range",
      min: 0,
      max: 100,
      step: 1,
      default: SPEAKER_VOLUME_DEFAULT,
      valuePercent: true,
    },
  ],
  normalizeParams: speakerParams,
  // Its voice coil is no wire: the two legs stay apart…
  internalBridges() {
    return [];
  },
  // …and coupled through the coil's resistance, as a resistor's are (its
  // inductance — about 50 µH, a few ohms at an audio tone — is left out).
  weakBridges(params) {
    return [[1, 2, speakerParams(params).impedance]];
  },
});
