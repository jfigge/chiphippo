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

// gl-renderer.js — the 3D view's WebGL, and the only file that touches it.
// It draws what scene3d/scene.js built and nothing else: it knows no parts,
// no document and no simulation — a scene in, pixels out — so everything a
// test can check is decided before it gets here.
//
// Deliberately small and dependency-free (the app has no bundler and takes
// no framework): two shader programs, plain non-indexed triangle buffers, and
// canvas-drawn textures for printed text and LCD glass.
//
//   · The STATIC mesh — boards, bodies, legs, wires — is one buffer, one draw.
//   · Each LAMP is a small buffer of its own drawn with a uniform colour, so a
//     sim-state recolours lamps without touching the big buffer.
//   · Each LABEL is a textured quad; a texture is drawn once per distinct
//     text/colour/font and shared.
//   · Each SCREEN is a textured quad whose canvas is repainted when its
//     module's framebuffer changes.
//
// Lighting is a fixed sun from up and to the left of the default view plus a
// sky/ground ambient, and every face is lit from the side the camera sees
// (both faces are drawn; see scene3d/mesh.js on why winding does not matter).

import { glyphRows } from "../sim/hd44780-cgrom.js";
import { normalize } from "../scene3d/mat4.js";
import { toHex } from "../scene3d/palette.js";

const LIT_VS = `
attribute vec3 a_pos;
attribute vec3 a_normal;
attribute vec3 a_color;
uniform mat4 u_vp;
uniform float u_useTint;
uniform vec3 u_tint;
varying vec3 v_color;
varying vec3 v_normal;
varying vec3 v_pos;
void main() {
  v_color = mix(a_color, u_tint, u_useTint);
  v_normal = a_normal;
  v_pos = a_pos;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

const LIT_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 v_color;
varying vec3 v_normal;
varying vec3 v_pos;
uniform vec3 u_eye;
uniform vec3 u_light;
uniform float u_emissive;
void main() {
  vec3 n = normalize(v_normal);
  vec3 v = normalize(u_eye - v_pos);
  if (dot(n, v) < 0.0) n = -n;
  float diffuse = max(dot(n, u_light), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 h = normalize(u_light + v);
  float spec = pow(max(dot(n, h), 0.0), 40.0) * 0.16;
  vec3 c = v_color * (0.30 + 0.24 * sky + 0.58 * diffuse) + vec3(spec);
  gl_FragColor = vec4(mix(c, v_color, u_emissive), 1.0);
}`;

const TEX_VS = `
attribute vec3 a_pos;
attribute vec2 a_uv;
uniform mat4 u_vp;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

const TEX_FS = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}`;

/** The sun: up, and toward the viewer's left of the default camera. */
const LIGHT = normalize([-0.45, 1, 0.55]);

/** The px height label text is drawn at on its canvas — enough to stay crisp
    up close without a texture per zoom level. */
const LABEL_PX = 64;

/** An LCD cell is 5 × 8 dots with a one-dot gap; each dot this many px. */
const DOT_PX = 4;

export class GlRenderer {
  #canvas;
  #gl = null;
  #lit = null;
  #tex = null;
  #static = null;
  #ground = null;
  #lamps = [];
  #labels = [];
  #screens = [];
  #labelTextures = new Map(); // key → { texture, aspect }
  #fonts = { sans: "sans-serif", mono: "monospace" };
  #scene = null; // kept so a lost context can be rebuilt
  #lost = false;
  #onRestored = null;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{fonts?: {sans: string, mono: string}, onRestored?: () => void}} [opts]
   *   onRestored: a lost context is back and the scene re-uploaded — the
   *   owner should draw again (nothing else would ask it to)
   */
  constructor(canvas, { fonts, onRestored } = {}) {
    this.#canvas = canvas;
    this.#onRestored = onRestored ?? null;
    if (fonts) this.#fonts = { ...this.#fonts, ...fonts };
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // ask for it back
      this.#lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.#lost = false;
      this.#init();
      if (this.#scene) this.setScene(this.#scene.scene, this.#scene.ground);
      this.#onRestored?.();
    });
    this.#init();
  }

  /** Whether this machine gave us WebGL at all. */
  get supported() {
    return this.#gl !== null;
  }

  /** Get a context and build the programs — or, if either fails, become a
      renderer that is simply not `supported`. Never throws: a GPU that
      refuses (or resets mid-compile) costs the 3D view, not the app. */
  #init() {
    this.#gl = null;
    this.#labelTextures.clear();
    try {
      this.#build();
    } catch (err) {
      console.error("[renderer] 3D view: WebGL unavailable:", err);
      this.#gl = null;
    }
  }

  #build() {
    const attrs = {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: false,
    };
    const gl =
      this.#canvas.getContext("webgl2", attrs) ??
      this.#canvas.getContext("webgl", attrs);
    if (!gl) return;
    this.#lit = program(
      gl,
      LIT_VS,
      LIT_FS,
      ["a_pos", "a_normal", "a_color"],
      ["u_vp", "u_eye", "u_light", "u_emissive", "u_useTint", "u_tint"],
    );
    this.#tex = program(
      gl,
      TEX_VS,
      TEX_FS,
      ["a_pos", "a_uv"],
      ["u_vp", "u_tex"],
    );
    this.#gl = gl;
  }

  /**
   * Upload a whole scene (scene3d/scene.js's buildScene) and its ground,
   * replacing the last one.
   */
  setScene(scene, ground) {
    this.#scene = { scene, ground };
    const gl = this.#gl;
    if (!gl || this.#lost) return;
    this.#releaseScene();
    this.#static = meshBuffers(gl, scene.mesh);
    this.#ground = ground ? meshBuffers(gl, ground) : null;
    this.#lamps = scene.lamps.map((lamp) => ({
      buffers: meshBuffers(gl, lamp.mesh),
      color: lamp.off,
      emissive: 0,
    }));
    const used = new Set();
    this.#labels = scene.labels
      .map((label) => this.#labelQuad(label, used))
      .filter(Boolean);
    // A text no label shows any more gives its texture back — otherwise every
    // value ever typed and every annotation ever edited would hold one.
    for (const [key, { texture }] of this.#labelTextures) {
      if (used.has(key)) continue;
      gl.deleteTexture(texture);
      this.#labelTextures.delete(key);
    }
    this.#screens = scene.screens.map((s) => this.#screenQuad(s));
  }

  /** Recolour lamp `i` (scene order) — `emissive` 0 is lit like any surface,
      1 glows at its own colour whatever the light. */
  setLamp(i, color, emissive) {
    const lamp = this.#lamps[i];
    if (!lamp) return;
    lamp.color = color;
    lamp.emissive = emissive;
  }

  /**
   * Repaint screen `i`'s glass from an HD44780 framebuffer (`{chars, cols,
   * rows, cgram, cursor, displayOn}`), or blank it to the backlit field
   * (`null`: not running, or the display switched off).
   */
  paintScreen(i, fb) {
    const s = this.#screens[i];
    if (s) this.#paint(s, fb);
  }

  #paint(s, fb) {
    const gl = this.#gl;
    if (!gl) return;
    const ctx = s.canvas.getContext("2d");
    if (!ctx) return;
    const { cols, rows } = s.spec;
    const W = s.canvas.width;
    const H = s.canvas.height;
    ctx.fillStyle = toHex(s.spec.screen);
    ctx.fillRect(0, 0, W, H);
    if (fb && fb.displayOn) {
      const cellW = 6 * DOT_PX;
      const cellH = 9 * DOT_PX;
      const ox = (W - (cols * cellW - DOT_PX)) / 2;
      const oy = (H - (rows * cellH - DOT_PX)) / 2;
      ctx.fillStyle = toHex(s.spec.dot);
      const shownCols = Math.min(cols, fb.cols);
      const shownRows = Math.min(rows, fb.rows);
      for (let r = 0; r < shownRows; r++) {
        for (let c = 0; c < shownCols; c++) {
          const bits = glyphRows(fb.chars[r * fb.cols + c], fb.cgram);
          for (let gy = 0; gy < 8; gy++) {
            for (let gx = 0; gx < 5; gx++) {
              if (bits[gy] & (1 << (4 - gx))) {
                ctx.fillRect(
                  ox + c * cellW + gx * DOT_PX,
                  oy + r * cellH + gy * DOT_PX,
                  DOT_PX,
                  DOT_PX,
                );
              }
            }
          }
        }
      }
      if (
        fb.cursor?.on &&
        fb.cursor.row < shownRows &&
        fb.cursor.col < shownCols
      ) {
        ctx.fillRect(
          ox + fb.cursor.col * cellW,
          oy + fb.cursor.row * cellH + 7 * DOT_PX,
          5 * DOT_PX,
          DOT_PX,
        );
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, s.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      s.canvas,
    );
  }

  /** Size the drawing buffer to the canvas's CSS size × the pixel ratio. */
  resize(width, height, dpr = 1) {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.#canvas.width !== w) this.#canvas.width = w;
    if (this.#canvas.height !== h) this.#canvas.height = h;
  }

  /**
   * Draw one frame.
   * @param {Float32Array} vp - the view-projection matrix
   * @param {number[]} eye - the camera's position (for the highlights)
   * @param {number[]} clear - the background `[r, g, b]`
   */
  render(vp, eye, clear) {
    const gl = this.#gl;
    if (!gl || this.#lost || gl.isContextLost()) return;
    gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    const lit = this.#lit;
    gl.useProgram(lit.program);
    gl.uniformMatrix4fv(lit.u.u_vp, false, vp);
    gl.uniform3fv(lit.u.u_eye, eye);
    gl.uniform3fv(lit.u.u_light, LIGHT);
    gl.uniform1f(lit.u.u_useTint, 0);
    gl.uniform1f(lit.u.u_emissive, 0);
    if (this.#ground) drawMesh(gl, lit, this.#ground);
    if (this.#static) drawMesh(gl, lit, this.#static);
    gl.uniform1f(lit.u.u_useTint, 1);
    for (const lamp of this.#lamps) {
      gl.uniform3fv(lit.u.u_tint, lamp.color);
      gl.uniform1f(lit.u.u_emissive, lamp.emissive);
      drawMesh(gl, lit, lamp.buffers);
    }

    // Printing and glass: textured, over the surfaces they sit a hair above.
    const tex = this.#tex;
    gl.useProgram(tex.program);
    gl.uniformMatrix4fv(tex.u.u_vp, false, vp);
    gl.uniform1i(tex.u.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -2);
    for (const s of this.#screens) {
      gl.bindTexture(gl.TEXTURE_2D, s.texture);
      drawTextured(gl, tex, s.buffers);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    // Text is single-sided: seen from behind it would read backwards.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    for (const label of this.#labels) {
      gl.bindTexture(gl.TEXTURE_2D, label.texture);
      drawTextured(gl, tex, label.buffers);
    }
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /** Release every GPU resource. */
  dispose() {
    this.#releaseScene();
    const gl = this.#gl;
    if (!gl) return;
    for (const { texture } of this.#labelTextures.values())
      gl.deleteTexture(texture);
    this.#labelTextures.clear();
    if (this.#lit) gl.deleteProgram(this.#lit.program);
    if (this.#tex) gl.deleteProgram(this.#tex.program);
    this.#scene = null;
  }

  #releaseScene() {
    const gl = this.#gl;
    if (!gl) return;
    const drop = (b) => b && b.list.forEach((buf) => gl.deleteBuffer(buf));
    drop(this.#static);
    drop(this.#ground);
    for (const lamp of this.#lamps) drop(lamp.buffers);
    for (const label of this.#labels) drop(label.buffers);
    for (const s of this.#screens) {
      drop(s.buffers);
      gl.deleteTexture(s.texture);
    }
    this.#static = null;
    this.#ground = null;
    this.#lamps = [];
    this.#labels = [];
    this.#screens = [];
  }

  /** A label's quad, sized to its text, or null for text that will not draw. */
  #labelQuad(label, used) {
    const tex = this.#labelTexture(label, used);
    if (!tex) return null;
    let h = label.height;
    let w = h * tex.aspect;
    if (w > label.maxWidth) {
      h *= label.maxWidth / w;
      w = label.maxWidth;
    }
    const r = label.right;
    const u = label.up;
    // Left-aligned text is placed by the middle of its left edge.
    const shift = label.align === "left" ? w / 2 : 0;
    const c = label.center.map((v, i) => v + r[i] * shift);
    const corner = (sx, sy) => [
      c[0] + (r[0] * w * sx) / 2 + (u[0] * h * sy) / 2,
      c[1] + (r[1] * w * sx) / 2 + (u[1] * h * sy) / 2,
      c[2] + (r[2] * w * sx) / 2 + (u[2] * h * sy) / 2,
    ];
    const quad = [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
    return { texture: tex.texture, buffers: quadBuffers(this.#gl, quad) };
  }

  /** The texture for a label's text, drawn once per text/colour/font. */
  #labelTexture(label, used) {
    const weight = label.weight ?? 600;
    const key = `${label.font}|${weight}|${label.color.join(",")}|${label.text}`;
    used?.add(key);
    const cached = this.#labelTextures.get(key);
    if (cached) return cached;
    const doc = this.#canvas.ownerDocument;
    const canvas = doc.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const font = `${weight} ${LABEL_PX}px ${label.font === "mono" ? this.#fonts.mono : this.#fonts.sans}`;
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(label.text).width) + LABEL_PX / 4;
    if (!(width > 0)) return null;
    canvas.width = width;
    canvas.height = Math.round(LABEL_PX * 1.25);
    ctx.font = font; // a resize resets the context
    ctx.fillStyle = toHex(label.color);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      label.text,
      canvas.width / 2,
      canvas.height / 2 + LABEL_PX * 0.04,
    );
    const gl = this.#gl;
    const texture = canvasTexture(gl, canvas);
    const entry = { texture, aspect: canvas.width / canvas.height };
    this.#labelTextures.set(key, entry);
    return entry;
  }

  /** A screen's glass quad and the canvas its characters are painted on. */
  #screenQuad(spec) {
    const doc = this.#canvas.ownerDocument;
    const canvas = doc.createElement("canvas");
    canvas.width = spec.cols * 6 * DOT_PX + 4 * DOT_PX;
    canvas.height = spec.rows * 9 * DOT_PX + 4 * DOT_PX;
    const gl = this.#gl;
    const screen = {
      spec,
      canvas,
      texture: canvasTexture(gl, canvas),
      buffers: quadBuffers(gl, spec.corners),
    };
    this.#paint(screen, null);
    return screen;
  }
}

// ── WebGL plumbing ────────────────────────────────────────────────────────

function shader(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`3D view shader: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}

function program(gl, vs, fs, attributes, uniforms) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`3D view program: ${gl.getProgramInfoLog(p)}`);
  }
  return {
    program: p,
    a: Object.fromEntries(
      attributes.map((n) => [n, gl.getAttribLocation(p, n)]),
    ),
    u: Object.fromEntries(
      uniforms.map((n) => [n, gl.getUniformLocation(p, n)]),
    ),
  };
}

function buffer(gl, data) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return b;
}

/** A built mesh's three attribute buffers. */
function meshBuffers(gl, mesh) {
  const pos = buffer(gl, mesh.positions);
  const nrm = buffer(gl, mesh.normals);
  const col = buffer(gl, mesh.colors);
  return { pos, nrm, col, count: mesh.count, list: [pos, nrm, col] };
}

/** A quad (four corners, in order round it) as two triangles with uvs —
    corner 0 is the texture's top-left. */
function quadBuffers(gl, corners) {
  const [tl, tr, br, bl] = corners;
  const pos = new Float32Array([...tl, ...bl, ...br, ...tl, ...br, ...tr]);
  const uv = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
  const p = buffer(gl, pos);
  const t = buffer(gl, uv);
  return { pos: p, uv: t, count: 6, list: [p, t] };
}

function attrib(gl, location, buf, size) {
  if (location < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

function drawMesh(gl, prog, b) {
  if (!b.count) return;
  attrib(gl, prog.a.a_pos, b.pos, 3);
  attrib(gl, prog.a.a_normal, b.nrm, 3);
  attrib(gl, prog.a.a_color, b.col, 3);
  gl.drawArrays(gl.TRIANGLES, 0, b.count);
}

function drawTextured(gl, prog, b) {
  attrib(gl, prog.a.a_pos, b.pos, 3);
  attrib(gl, prog.a.a_uv, b.uv, 2);
  gl.drawArrays(gl.TRIANGLES, 0, b.count);
}

function canvasTexture(gl, canvas) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
