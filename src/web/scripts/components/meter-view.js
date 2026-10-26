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

// meter-view.js — the multimeter brick on the desk (.layer-parts), drawn at
// the BM235's true size in its holster: its LCD, its SELECT / RANGE / REC /
// HOLD / Hz buttons, its dial and its four jacks — or folded down to its
// screen and the two jacks in use (`params.size`). The layout and the
// behaviour are the BM235's; the name on it the app's own, Volt Hippo, or —
// the EEVBlog look (`params.skin`) — the BM235's EEVblog edition's.
//
// The controls are the controller's presses (DeskController
// `#onMeterControl`), told apart by the `data-meter-*` attribute of what was
// pressed: a dial stop turns the dial, a button presses it, a red jack takes
// the red lead's plug. The PROBES and their leads are not drawn here — they
// reach across the desk, over the boards and wires (meter-probe-layer.js).
//
// What the LCD shows is `model/meter-display.js`'s, from what it is told:
// the run's window of readings (`setLive`, from `chiphippo:sim-state` —
// sim/meter-average.js), or a stopped bench's (`setOffline`, from
// components/meter-bench.js). RANGE, HOLD, REC (MAX/MIN/AVG), Relative
// Zero (HOLD held a second), Hz and the backlight (SELECT held a second) are
// the display's own, as on the real meter: they live here, never in the
// document, and a turn of the dial clears them (the backlight aside). Hz
// shows the run's count on the trigger band picked (sim/meter-average.js) —
// on the V position the range it was pressed on, RANGE stepping it.

import { t } from "../i18n.js";
import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import {
  METER_COMPACT,
  METER_ELEMENTS,
  METER_POSITIONS,
  METER_SIZE,
  hzBands,
  isCompact,
  isSourceFunction,
  meterSetup,
  selectionAt,
} from "../catalog/meter.js";
import {
  JACK_LAYOUTS,
  METER_BODY,
  bodyOutline,
  redJack,
} from "../model/meter-probes.js";
import {
  manualRanging,
  meterDisplay,
  rangesFor,
} from "../model/meter-display.js";
import { BrickView } from "./brick-view.js";

/** The backlight goes out by itself after this long, ms (the manual's
    10 minutes). */
const BACKLIGHT_MS = 10 * 60 * 1000;

/** REC's display, in the order a press steps it: every flag lit over the
    present reading, then the MAX, the MIN and the AVG it has kept. */
const REC_SHOWS = Object.freeze(["now", "max", "min", "avg"]);

/** One of the full body's waisted shapes (model/meter-probes.js
    `bodyOutline`) as an SVG path. */
function bodyPath(cls, shape) {
  const d = bodyOutline(shape).map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(3)} ${y.toFixed(3)}`).join(" "); // prettier-ignore
  return svgEl("path", { class: cls, d: `${d} Z` });
}

/** One text line (SVG user units = pitch). */
function label(cls, x, y, text, anchor = "middle") {
  const node = svgEl("text", { class: cls, x, y, "text-anchor": anchor });
  node.textContent = text;
  return node;
}

/** The LCD's minus sign: a bar in its own place left of the digits (as a
    real LCD has it), lit by `part-meter--negative` — so a negative reading
    keeps the digits where a positive one has them, inside the glass. */
function signBar(x, y, width, height) {
  return svgEl("rect", { class: "part-meter-sign", x, y, width, height });
}

/**
 * Build a meter's SVG from its params — in its look (`params.skin`: the Volt
 * Hippo, or the EEVBlog edition of the BM235), full or folded down
 * (`params.size`). Pure DOM construction (unit-testable under jsdom); the
 * LCD's live text is written by `MeterView#render`. Both sizes carry the same
 * classes and `data-meter-*` hooks, so the display and the controller's
 * presses never know which is drawn.
 */
export function buildMeterSvg(params = {}) {
  return isCompact(params) ? buildCompact(params) : buildBody(params);
}

/** The BM235's dial, from its photograph: the centre, the knob's radius,
    each stop's angle (degrees clockwise from straight up — AutoV low on the
    left round to µA on the right) and the legends' radius. */
const BM235_DIAL = Object.freeze({
  cx: 15.9,
  cy: 35.8,
  knob: 7.3,
  legends: 9.4,
  angle: Object.freeze({ autov: -88, off: -66, v: -44, ohm: -21, mv: 0, diode: 20, ma: 43, ua: 64 }), // prettier-ignore
});

/** Its stops' legends (VFD and temperature are not modelled, so not drawn;
    the diode position carries capacitance's symbol too). */
const BM235_STOPS = Object.freeze({
  autov: ["Auto V", "LoZ"],
  off: ["OFF"],
  v: ["V", "⎓∿"],
  ohm: ["·)))", "Ω"],
  mv: ["⎓∿", "mV"],
  diode: ["⊣⊢", "→|"],
  ma: ["A", "mA⎓∿"],
  ua: ["µA⎓∿"],
});

/** Its four pill buttons, and the legend above each (the second job a
    one-second hold does), then its two round ones. */
const BM235_BUTTONS = Object.freeze([
  { id: "select", label: "SELECT", x: 7.95, over: "☼" },
  { id: "range", label: "RANGE", x: 13.25, over: "(Level)" },
  { id: "rec", label: "REC", x: 18.5, over: "" },
  { id: "hold", label: "HOLD", x: 23.85, over: "Δ" },
]);
const BM235_PILL = Object.freeze({ y: 22.05, width: 4.1, height: 1.9 });

/** What each jack says above it. */
const BM235_JACK_LABELS = Object.freeze({ a: "A", ma: "mA µA", com: "COM", v: "ΩV⊣⊢" }); // prettier-ignore

/** The EEVBlog look's name band: the EEVblog edition's own print of it —
    the maker's boxed name, "EEVBlog", the model — an arched black band
    (src/web/images/bm235-title.png, 685 × 118, the white round it clear),
    nearly the band's width and standing on its foot, in place of the band's
    own rect (clear under it, app.css). It is the title too. */
function bm235Band() {
  return [
    svgEl("image", { class: "part-meter-bm-title", href: "images/bm235-title.png", x: 5.5, y: 3.8, width: 21, height: 3.62, "data-meter-title": "" }), // prettier-ignore
  ];
}

/** The Volt Hippo's name band: the Chip Hippo icon, "VoltHippo" — "Volt"
    silver, "Hippo" white, the two shades the EEVBlog look writes its name
    in — and the meter's kind. The icon is the app's
    (src/web/chiphippo-icon.svg — the header's, beside index.html). */
function voltHippoBand(text) {
  return [
    svgEl("image", { class: "part-meter-bm-logo", href: "chiphippo-icon.svg", x: 5.8, y: 4.6, width: 2.5, height: 2.5, "data-meter-title": "" }), // prettier-ignore
    text("part-meter-bm-name part-meter-bm-volt", 14.1, 6.55, "Volt", "end"),
    text(
      "part-meter-bm-name part-meter-bm-hippo",
      14.1,
      6.55,
      "Hippo",
      "start",
    ),
    text("part-meter-bm-kind", 23.3, 5.65, "True"),
    text("part-meter-bm-kind", 23.3, 6.8, "RMS DMM"),
  ];
}

/** Each look's name band. */
const BANDS = Object.freeze({ volthippo: voltHippoBand, bm235: bm235Band });

/** The look a meter is drawn in (catalog/meter.js `METER_LOOKS`). */
const lookOf = (params) => (params?.skin === "bm235" ? "bm235" : "volthippo");

/** The name band and the LCD — the bezel and glass, then the annunciators
    and the reading — in the full body's frame: what the folded-down meter
    keeps, its glass `glass` tall (pitch) — the reading kept the same
    distance off its foot. The band is the meter's TITLE: a click on it
    (`data-meter-title`) folds the meter down to its screen or opens it out
    again (DeskController `#onMeterPointerDown`). */
function meterScreen(params, text, glass = 12) {
  return [
    svgEl("rect", { class: "part-meter-bm-band", x: 5.3, y: 4.3, width: 21.4, height: 3.1, rx: 0.4, "data-meter-title": "" }), // prettier-ignore
    ...BANDS[lookOf(params)](text),
    svgEl("rect", { class: "part-meter-bm-bezel", x: 5.3, y: 7.6, width: 21.4, height: glass + 0.7, rx: 0.5 }), // prettier-ignore
    svgEl("rect", { class: "part-meter-lcd", x: 5.7, y: 7.95, width: 20.6, height: glass, rx: 0.2 }), // prettier-ignore
    label("part-meter-flag part-meter-flag--auto", 6.2, 9.5, "AUTO", "start"),
    label("part-meter-flag part-meter-flag--mode", 10.3, 9.5, "", "start"),
    label("part-meter-flag part-meter-flag--hold", 13.6, 9.5, "HOLD", "start"),
    label("part-meter-flag part-meter-flag--loz", 17.6, 9.5, "LoZ", "start"),
    label("part-meter-flag part-meter-flag--fn", 25.8, 9.5, "", "end"),
    label("part-meter-flag part-meter-flag--max", 6.2, 11.1, "MAX", "start"),
    label("part-meter-flag part-meter-flag--min", 9.2, 11.1, "MIN", "start"),
    label("part-meter-flag part-meter-flag--avg", 12.2, 11.1, "AVG", "start"),
    label("part-meter-flag part-meter-flag--rel", 15.4, 11.1, "Δ", "start"),
    label("part-meter-digits", 23.9, 7.95 + glass - 1.75, "", "end"),
    signBar(6.0, 7.95 + glass - 1.75 - 2.05, 1.15, 0.45),
    label("part-meter-unit", 26.0, 7.95 + glass - 0.55, "", "end"),
  ];
}

/** The text helper the body's legends use. */
const bmText = (cls, x, y, value, anchor = "middle") => label(`part-meter-bm-text ${cls}`, x, y, value, anchor); // prettier-ignore

/** The folded-down meter's glass, pitch: just tall enough for its two
    rows of flags and the reading under them. */
const COMPACT_GLASS = 9;

/**
 * The meter folded down (`params.size` "compact"): its boot, half the width
 * of the full body's, round the name band and a shorter LCD, and its jacks
 * in a row under them — no buttons, no dial. With no dial to turn there is
 * no lead to re-plug either, so only the two jacks in use are drawn (COM and
 * the red lead's), each in its own place, and neither is a press. Drawn in
 * the full body's frame and shown through a viewBox from
 * `METER_COMPACT.origin`, so the screen is the same drawing either way.
 */
function buildCompact(params) {
  const { origin, width, height } = METER_COMPACT;
  const svg = svgEl("svg", {
    class: "part-meter-svg part-meter-svg--compact",
    viewBox: `${origin.x} ${origin.y} ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });
  const boot = 1.6;
  svg.append(
    svgEl("rect", { class: "part-meter-holster", x: origin.x + 0.1, y: origin.y + 0.1, width: width - 0.2, height: height - 0.2, rx: 2.2 }), // prettier-ignore
    svgEl("rect", { class: "part-meter-face", x: origin.x + boot, y: origin.y + boot, width: width - 2 * boot, height: height - 2 * boot, rx: 1.2 }), // prettier-ignore
    ...meterScreen(params, bmText, COMPACT_GLASS),
  );
  const red = redJack(params);
  for (const jack of ["com", red]) {
    const local = JACK_LAYOUTS.compact[jack];
    const x = origin.x + local.dx;
    const y = origin.y + local.dy;
    const g = svgEl("g", { class: `part-meter-jack part-meter-jack--${jack === "com" ? "com" : "red"}` }); // prettier-ignore
    g.append(
      svgEl("circle", { class: "part-meter-jack-ring", cx: x, cy: y, r: 1.25 }), // prettier-ignore
      bmText("part-meter-bm-small", x, y + 2.35, COMPACT_JACK_LABELS[jack]),
      svgEl("circle", { class: `part-meter-plug part-meter-plug--${jack === "com" ? "black" : "red"}`, cx: x, cy: y, r: 0.82 }), // prettier-ignore
    );
    svg.append(g);
  }
  const mark = svgEl("g", { class: "part-meter-mark" });
  const markY = origin.y + JACK_LAYOUTS.compact.com.dy;
  mark.append(
    svgEl("title"),
    svgEl("circle", { class: "part-meter-mark-disc", cx: 26.3, cy: markY, r: 0.75 }), // prettier-ignore
    label("part-meter-mark-glyph", 26.3, markY + 0.4, "i"),
  );
  svg.append(mark);
  return svg;
}

/** What each jack says under it, folded down. */
const COMPACT_JACK_LABELS = Object.freeze({ a: "A", ma: "mA µA", com: "COM", v: "ΩV" }); // prettier-ignore

/**
 * The full body — the EEVblog edition of the Brymen BM235 as its manual's
 * photograph shows it (BM235-Manual-EEVblog.pdf, its cover): a boot, a
 * charcoal face, a name band over the LCD (per look), four pill buttons and
 * the round Hz and EF ones, the knob's grip bar, and the jacks in two tiers
 * with their fuse and category legends. The "bm235" look (EEVBlog) is a
 * MOCK-UP — its maker is being asked whether the app may show it — and the
 * "volthippo" look the same body in the app's orange under its own name. EF
 * does nothing (not modelled), so only the EEVBlog look, the real meter's
 * panel, draws it.
 */
function buildBody(params) {
  const { width, height } = METER_SIZE;
  const svg = svgEl("svg", {
    class: "part-meter-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });
  const setup = meterSetup(params);
  const text = bmText;
  svg.append(
    // The boot and face drawing in a little below the middle, as the BM235's
    // holster does.
    bodyPath("part-meter-holster", METER_BODY.boot),
    bodyPath("part-meter-face", METER_BODY.face),
    ...meterScreen(params, text),
  );

  // The pill buttons, each with its second job above it.
  for (const b of BM235_BUTTONS) {
    const g = svgEl("g", { class: `part-meter-btn part-meter-btn--${b.id}`, "data-meter-button": b.id }); // prettier-ignore
    g.append(
      svgEl("rect", { class: "part-meter-btn-cap", x: b.x - BM235_PILL.width / 2, y: BM235_PILL.y, width: BM235_PILL.width, height: BM235_PILL.height, rx: BM235_PILL.height / 2 }), // prettier-ignore
      label("part-meter-btn-label", b.x, BM235_PILL.y + 1.3, b.label),
    );
    svg.append(g);
    if (b.over) svg.append(text("part-meter-bm-over", b.x, BM235_PILL.y - 0.45, b.over)); // prettier-ignore
  }
  // The round buttons: Hz, and — on the EEVBlog look only — EF (drawn, not
  // modelled).
  const round = (id, x, legend) => {
    const g = svgEl("g", id ? { class: `part-meter-btn part-meter-btn--${id}`, "data-meter-button": id } : { class: "part-meter-bm-inert" }); // prettier-ignore
    g.append(svgEl("circle", { class: "part-meter-btn-cap", cx: x, cy: 26.8, r: 1.15 })); // prettier-ignore
    svg.append(g, text("part-meter-bm-over", x, 25.15, legend));
  };
  round("hz", 7.95, "Hz");
  if (lookOf(params) === "bm235") round(null, 23.85, "EF");

  // The dial: a stop per position — its legend and hit disc — round the
  // knob, and the knob's grip bar turned to the one it is on.
  const { cx, cy } = BM235_DIAL;
  const toward = (deg, r) => {
    const a = (deg * Math.PI) / 180;
    return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
  };
  for (const position of METER_POSITIONS) {
    const at = toward(BM235_DIAL.angle[position], BM235_DIAL.legends);
    const g = svgEl("g", { class: "part-meter-stop", "data-meter-position": position }); // prettier-ignore
    if (position === setup.position) g.classList.add("part-meter-stop--on");
    g.append(svgEl("circle", { class: "part-meter-stop-hit", cx: at.x, cy: at.y, r: 1.7 })); // prettier-ignore
    const lines = BM235_STOPS[position];
    lines.forEach((line, i) => {
      g.append(label("part-meter-stop-label", at.x, at.y + 0.45 + (i - (lines.length - 1) / 2) * 1.25, line)); // prettier-ignore
    });
    svg.append(g);
  }
  const grip = svgEl("g", { transform: `rotate(${BM235_DIAL.angle[setup.position]} ${cx} ${cy})` }); // prettier-ignore
  grip.append(
    svgEl("rect", { class: "part-meter-bm-grip", x: cx - 1.5, y: cy - BM235_DIAL.knob - 0.4, width: 3, height: 2 * BM235_DIAL.knob + 0.8, rx: 1.5 }), // prettier-ignore
    svgEl("line", { class: "part-meter-pointer", x1: cx, y1: cy - BM235_DIAL.knob + 0.3, x2: cx, y2: cy - BM235_DIAL.knob + 2.2 }), // prettier-ignore
  );
  svg.append(
    svgEl("circle", { class: "part-meter-knob", cx, cy, r: BM235_DIAL.knob }),
    grip,
  );

  // The jacks in their two tiers, each with its plug when a lead is in it,
  // and the legends and brackets under them.
  const red = redJack(params);
  for (const [jack, at] of Object.entries(JACK_LAYOUTS.full)) {
    const g = svgEl("g", { class: `part-meter-jack part-meter-jack--${jack === "com" ? "com" : "red"}` }); // prettier-ignore
    if (jack !== "com") g.setAttribute("data-meter-jack", jack);
    g.append(
      label("part-meter-jack-label", at.dx, at.dy - 2.15, BM235_JACK_LABELS[jack]), // prettier-ignore
      svgEl("circle", { class: "part-meter-jack-ring", cx: at.dx, cy: at.dy, r: 1.6 }), // prettier-ignore
    );
    if (jack === "com" || jack === red) {
      g.append(svgEl("circle", { class: `part-meter-plug part-meter-plug--${jack === "com" ? "black" : "red"}`, cx: at.dx, cy: at.dy, r: 1.05 })); // prettier-ignore
    }
    svg.append(g);
  }
  const jacks = JACK_LAYOUTS.full;
  for (const jack of ["a", "ma"]) {
    const at = jacks[jack];
    svg.append(svgEl("rect", { class: "part-meter-bm-jackbadge", x: at.dx - 1.25, y: at.dy - 4.35, width: 2.5, height: 1.05, rx: 0.2 })); // prettier-ignore
    svg.append(text("part-meter-bm-small", at.dx, at.dy - 3.55, "JACK"));
  }
  svg.append(
    text("part-meter-bm-over", jacks.v.dx, jacks.v.dy - 3.45, "→|  ⊣⊢"),
    text("part-meter-bm-over", jacks.com.dx, jacks.com.dy - 3.45, "⊥"),
    svgEl("path", { class: "part-meter-bm-bracket", d: `M${jacks.a.dx} ${jacks.a.dy + 1.9} V52.1 H11.4 M${jacks.ma.dx - 1.6} 52.1 H${jacks.com.dx - 0.6} M${jacks.ma.dx} ${jacks.ma.dy + 1.9} V52.1 M${jacks.com.dx} ${jacks.com.dy + 1.9} V52.1 H${jacks.v.dx} V${jacks.v.dy + 1.9}` }), // prettier-ignore
    text("part-meter-bm-small", 7.9, 53.6, "MAX 10A"),
    text("part-meter-bm-small", 7.9, 54.55, "HBC FUSED"),
    text("part-meter-bm-small", 14.6, 53.6, "MAX 600mA"),
    text("part-meter-bm-small", 14.6, 54.55, "HBC FUSED"),
    text("part-meter-bm-small", 22.9, 53.6, "300V CAT IV"),
    text("part-meter-bm-small", 22.9, 54.55, "600V CAT III"),
    text("part-meter-bm-small", 22.9, 55.5, "1kV CAT II"),
    text("part-meter-bm-over", 22.6, 51.5, "⚠"),
  );

  // The red (i), beside the HOLD button.
  const mark = svgEl("g", { class: "part-meter-mark" });
  mark.append(
    svgEl("title"),
    svgEl("circle", { class: "part-meter-mark-disc", cx: 27.3, cy: 27.1, r: 1 }), // prettier-ignore
    label("part-meter-mark-glyph", 27.3, 27.62, "i"),
  );
  svg.append(mark);
  return svg;
}

export class MeterView extends BrickView {
  #params = {};
  #setup = null;
  #spiceLite = false;
  #mode = "stopped"; // the transport: stopped | running | paused
  #live = null; // the run's window (sim/meter-average.js), or null
  #offline = null; // a stopped bench's reading ({volts} / {farads}), or null
  #range = null; // the range the display is on
  #manual = false; // RANGE has held it there
  #held = null; // HOLD's frozen display, or null
  #hz = false; // the Hz function
  #trigger = 0; // Hz's trigger band (catalog/meter.js `hzBands`)
  #rec = null; // REC: {show, max, min, sum, n, seen}, or null
  #relative = null; // Relative Zero's reference, or null
  #backlight = false;
  #backlightTimer = null;
  #lastDisplay = null; // what the display last read (what HOLD freezes)
  #shown = null;
  #onBeep;
  #onChirp;

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} meter
   * @param {object} [callbacks] - BrickView's, and `onBeep(id, on)`: the
   *   meter's beeper (continuity, Beep-Jack) is on or off; `onChirp(id)`: a
   *   short beep (REC's new MAX or MIN)
   * @param {{spiceLite?: boolean}} [opts]
   */
  constructor(layer, meter, callbacks = {}, { spiceLite = false } = {}) {
    super(layer, meter, "part-meter", callbacks);
    this.#onBeep = callbacks.onBeep ?? null;
    this.#onChirp = callbacks.onChirp ?? null;
    this.#spiceLite = spiceLite;
    this.updateParams(meter.params);
  }

  /** Rebuild the SVG; a turn of the dial (or SELECT) clears RANGE, HOLD,
      REC, Relative Zero and Hz. */
  updateParams(params) {
    const was = this.#setup;
    this.#params = params ?? {};
    this.#setup = meterSetup(this.#params);
    if (was && (was.fn !== this.#setup.fn || was.scale !== this.#setup.scale)) {
      this.#range = null;
      this.#manual = false;
      this.#held = null;
      this.#hz = false;
      this.#trigger = 0;
      this.#rec = null;
      this.#relative = null;
    }
    this.element.querySelector("svg")?.remove();
    this.element.prepend(buildMeterSvg(this.#params));
    // Each look its own boot (`--meter-boot`).
    this.element.classList.toggle("part-meter--bm235", lookOf(this.#params) === "bm235"); // prettier-ignore
    this.#shown = null;
    this.#render();
  }

  /** Whether Spice Lite is on (the meter reads only under it). */
  setSpiceLite(on) {
    this.#spiceLite = on === true;
    this.#render();
  }

  /** The transport's mode, and the run's window of readings (or null). */
  setLive(mode, reading) {
    this.#mode = mode;
    this.#live = reading ?? null;
    this.#render();
  }

  /** A stopped bench's reading (Ω, continuity, diode, capacitance), or
      null. */
  setOffline(reading) {
    this.#offline = reading ?? null;
    this.#render();
  }

  /** Whether the display is lit (Hz, REC, Relative Zero work only then). */
  get #working() {
    return this.#spiceLite && this.#setup.fn !== "off" && !this.#setup.inErr;
  }

  /** RANGE: a press holds the range it is on, or steps to the next; held a
      second (`long`), back to auto. Not on AutoV or capacitance (the
      manual's note); in Hz on the V position it steps the trigger range. */
  pressRange(long = false) {
    if (this.#hz) {
      const bands = hzBands(this.#setup).length;
      if (!long && this.#setup.position === "v" && bands > 1) this.#trigger = (this.#trigger + 1) % bands; // prettier-ignore
    } else if (!manualRanging(this.#setup.fn)) {
      return;
    } else if (long) {
      this.#manual = false;
    } else if (!this.#manual) {
      this.#manual = true;
    } else {
      const ranges = rangesFor(this.#setup.fn, this.#setup.scale) ?? [];
      this.#range = ranges.length ? ((this.#range ?? 0) + 1) % ranges.length : null; // prettier-ignore
    }
    this.#shown = null;
    this.#render();
  }

  /** HOLD: freeze the display, or let it go; held a second (`long`),
      Relative Zero — the reading shown becomes the reference, or the
      reference is let go. Relative Zero is not on AutoV. */
  pressHold(long = false) {
    if (this.#setup.fn === "off") return;
    if (long) {
      if (this.#setup.fn === "autov" || !this.#working) return;
      if (this.#relative != null) this.#relative = null;
      else if (Number.isFinite(this.#lastDisplay?.value)) this.#relative = this.#lastDisplay.value; // prettier-ignore
      this.#range = null;
    } else {
      this.#held = this.#held ? null : (this.#lastDisplay ?? null);
    }
    this.#shown = null;
    this.#render();
  }

  /** REC: start recording MAX/MIN/AVG; each press then shows the next of
      them (and the present reading again); held a second (`long`), stop.
      Not on AutoV (the manual's note). */
  pressRec(long = false) {
    if (this.#setup.fn === "autov" || !this.#working) return;
    if (long) {
      this.#rec = null;
    } else if (!this.#rec) {
      this.#rec = { show: "now", max: null, min: null, sum: 0, n: 0, seen: null }; // prettier-ignore
    } else {
      this.#rec.show = REC_SHOWS[(REC_SHOWS.indexOf(this.#rec.show) + 1) % REC_SHOWS.length]; // prettier-ignore
    }
    this.#shown = null;
    this.#render();
  }

  /** Hz: the frequency of what the function reads, or back to it. Only on
      a voltage or a current; triggered on the range the display is on. */
  pressHz() {
    if (!this.#working) return;
    const bands = hzBands(this.#setup);
    if (!bands.length && !this.#hz) return;
    this.#hz = !this.#hz;
    this.#trigger = this.#hz ? Math.min(bands.length - 1, Math.max(0, this.#range ?? 0)) : 0; // prettier-ignore
    this.#range = null;
    this.#manual = false;
    this.#rec = null;
    this.#relative = null;
    this.#shown = null;
    this.#render();
  }

  /** SELECT held a second: the LCD's backlight on or off — out by itself
      after `BACKLIGHT_MS`. */
  toggleBacklight() {
    if (this.#setup.fn === "off") return;
    this.#backlight = !this.#backlight;
    clearTimeout(this.#backlightTimer);
    this.#backlightTimer = this.#backlight
      ? setTimeout(() => {
          this.#backlight = false;
          this.#shown = null;
          this.#render();
        }, BACKLIGHT_MS)
      : null;
    this.#shown = null;
    this.#render();
  }

  /** The figures the display reads now. */
  #reading() {
    const fn = this.#setup.fn;
    const source = isSourceFunction(fn);
    const zero = { mean: 0, rms: 0, min: 0, max: 0, hz: [] };
    if (!this.#setup.reads) return fn === "cap" ? { farads: 0 } : zero;
    if (fn === "cap") {
      // Stopped, what the bench measured (`farads` null while it times
      // one; nothing to touch, nothing to read). Running, the circuit's own
      // voltages swamp the test: the swing never finishes — OL.
      if (this.#mode !== "stopped") return { farads: Infinity };
      return this.#offline ?? { farads: 0 };
    }
    // Nothing on the input: an ohms or diode test reads its own source's
    // whole voltage (OL); everything else 0.
    const open = { ...zero, mean: source ? METER_ELEMENTS[fn === "diode" ? "diode" : "ohms"].volts : 0 }; // prettier-ignore
    if (this.#mode === "stopped") {
      // The bench is off: only a test source reads anything.
      if (!source) return zero;
      const v = this.#offline?.volts;
      return Number.isFinite(v) ? { ...zero, mean: v, min: v, max: v } : open;
    }
    return this.#live ?? open;
  }

  /** Book a new reading's value on REC, and beep a new MAX or MIN. */
  #record(reading, value) {
    const rec = this.#rec;
    if (!rec || rec.seen === reading || !Number.isFinite(value)) return;
    rec.seen = reading;
    const first = rec.n === 0;
    const higher = rec.max == null || value > rec.max;
    const lower = rec.min == null || value < rec.min;
    if (higher) rec.max = value;
    if (lower) rec.min = value;
    rec.sum += value;
    rec.n++;
    if (!first && (higher || lower)) this.#onChirp?.(this.id);
  }

  #render() {
    const svg = this.element.querySelector("svg");
    if (!svg) return;
    const setup = this.#setup;
    const off = setup.fn === "off";
    // No Spice Lite: no voltages to read — the display stays dark and the
    // red (i) says why. A blown fuse says so the same way.
    const blown = ["fuseF1", "fuseF2"].filter((k) => this.#params[k] === true);
    const dark = off || !this.#spiceLite;
    const rec = this.#rec;
    let display;
    if (dark) {
      display = { text: "", unit: "", mode: null, range: null, ol: false, beep: false, blank: true }; // prettier-ignore
    } else {
      const raw = this.#reading();
      const reading = this.#hz ? { ...raw, hz: raw.hz?.[this.#trigger] ?? 0 } : raw; // prettier-ignore
      const opts = { ...setup, reading, hz: this.#hz, range: this.#range, manual: this.#manual, relative: this.#relative }; // prettier-ignore
      const now = meterDisplay(opts);
      this.#record(raw, now.value);
      display = now;
      if (rec && rec.show !== "now" && rec.n > 0) {
        const value = rec.show === "max" ? rec.max : rec.show === "min" ? rec.min : rec.sum / rec.n; // prettier-ignore
        display = meterDisplay({ ...opts, value });
      }
      if (display.range != null) this.#range = display.range;
      this.#lastDisplay = display;
      if (this.#held) display = { ...this.#held, beep: false };
    }
    const mark = !this.#spiceLite ? t("desk.meter.needsSpice") : blown.length ? t("desk.meter.fuseBlown", { fuse: blown.map((k) => k.slice(-2)).join(", ") }) : ""; // prettier-ignore
    const key = `${display.text}|${display.unit}|${display.mode}|${display.beep}|${this.#manual}|${Boolean(this.#held)}|${rec?.show ?? ""}|${this.#relative != null}|${this.#backlight}|${mark}|${dark}`; // prettier-ignore
    if (key === this.#shown) return;
    this.#shown = key;
    const set = (sel, text) => {
      const node = svg.querySelector(sel);
      if (node) node.textContent = text;
    };
    // The sign is the LCD's own bar, not a character (signBar).
    const negative = /^-/.test(display.text);
    set(".part-meter-digits", negative ? display.text.slice(1) : display.text);
    this.element.classList.toggle("part-meter--negative", negative);
    set(".part-meter-unit", display.unit);
    set(".part-meter-flag--mode", display.mode === "ac" ? "AC" : display.mode === "dc" ? "DC" : ""); // prettier-ignore
    set(".part-meter-flag--fn", setup.fn === "cont" ? "·)))" : setup.fn === "diode" ? "→|" : ""); // prettier-ignore
    const lit = (sel, on) => svg.querySelector(sel)?.classList.toggle("part-meter-flag--lit", on); // prettier-ignore
    lit(".part-meter-flag--auto", !dark && !this.#manual && setup.fn !== "diode" && setup.fn !== "cont"); // prettier-ignore
    lit(".part-meter-flag--hold", !dark && Boolean(this.#held));
    lit(".part-meter-flag--loz", !dark && setup.fn === "autov");
    lit(".part-meter-flag--mode", !dark && display.mode != null);
    lit(".part-meter-flag--fn", !dark);
    for (const which of ["max", "min", "avg"]) {
      lit(`.part-meter-flag--${which}`, !dark && Boolean(rec) && (rec.show === "now" || rec.show === which)); // prettier-ignore
    }
    lit(".part-meter-flag--rel", !dark && this.#relative != null);
    this.element.classList.toggle("part-meter--dark", dark);
    this.element.classList.toggle("part-meter--beep", !dark && display.beep);
    this.element.classList.toggle("part-meter--backlit", !dark && this.#backlight); // prettier-ignore
    this.element.classList.toggle("part-meter--marked", mark !== "");
    const title = svg.querySelector(".part-meter-mark > title");
    if (title) title.textContent = mark;
    this.#onBeep?.(this.id, !dark && display.beep);
  }

  /** The SELECT choice at the dial's position, for the controller. */
  get selection() {
    return selectionAt(this.#params, this.#setup.position);
  }

  remove() {
    clearTimeout(this.#backlightTimer);
    super.remove();
  }
}
