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

// path.js — Node's `path`, POSIX flavour, for the web build of main.
//
// Main's code runs unchanged in the browser (.claude/rules/web.md), and every
// path it handles there is a path in the virtual filesystem (vfs.js): absolute,
// `/`-separated, whatever the visitor's OS. So this is always the POSIX module —
// even for a Windows visitor, whose `process.platform` is still "win32" so the
// keyboard labels read Ctrl.

const CWD = "/";

/** Collapse `.`, `..` and repeated separators; keep a leading `/`. */
function normalizeSegments(parts, absolute) {
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  return out;
}

export function normalize(p) {
  const s = String(p);
  if (s === "") return ".";
  const absolute = s.startsWith("/");
  const trailing = s.endsWith("/");
  const joined = normalizeSegments(s.split("/"), absolute).join("/");
  if (absolute) return `/${joined}${trailing && joined ? "/" : ""}`;
  return (joined || ".") + (trailing && joined ? "/" : "");
}

export function isAbsolute(p) {
  return String(p).startsWith("/");
}

export function join(...parts) {
  const filtered = parts.map(String).filter((s) => s !== "");
  return filtered.length ? normalize(filtered.join("/")) : ".";
}

export function resolve(...parts) {
  let resolved = "";
  for (let i = parts.length - 1; i >= 0 && !resolved.startsWith("/"); i--) {
    const part = String(parts[i]);
    if (!part) continue;
    resolved = resolved ? `${part}/${resolved}` : part;
  }
  if (!resolved.startsWith("/")) resolved = `${CWD}${resolved}`;
  const segs = normalizeSegments(resolved.split("/"), true);
  return `/${segs.join("/")}`;
}

export function dirname(p) {
  const s = String(p);
  if (!s) return ".";
  const trimmed = s.length > 1 ? s.replace(/\/+$/, "") : s;
  const i = trimmed.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return trimmed.slice(0, i);
}

export function basename(p, ext) {
  const s = String(p);
  const trimmed = s.length > 1 ? s.replace(/\/+$/, "") : s;
  let base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (ext && base.endsWith(ext) && base !== ext) {
    base = base.slice(0, -ext.length);
  }
  return base;
}

export function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

export function relative(from, to) {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

export function parse(p) {
  const s = String(p);
  const root = s.startsWith("/") ? "/" : "";
  const base = basename(s);
  const ext = extname(s);
  const dir = dirname(s);
  return {
    root,
    dir: dir === "." && !s.includes("/") ? "" : dir,
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
}

export function format({ dir, root, base, name, ext } = {}) {
  const file = base ?? `${name ?? ""}${ext ?? ""}`;
  const head = dir ?? root ?? "";
  if (!head) return file;
  return head.endsWith("/") ? `${head}${file}` : `${head}/${file}`;
}

export const sep = "/";
export const delimiter = ":";

const posix = {
  normalize,
  isAbsolute,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  parse,
  format,
  sep,
  delimiter,
};
posix.posix = posix;
export { posix };
export default posix;
