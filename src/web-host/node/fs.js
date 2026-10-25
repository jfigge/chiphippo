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

// fs.js — Node's `fs` for the web build of main: the calls main makes, each
// answered by the ONE in-memory filesystem (vfs.js) that storage and the
// visitor's own files are mirrored into. See vfs.js for why it is in memory.

import { Vfs } from "../vfs.js";

/** The filesystem every bundled module of main sees. */
export const vfs = new Vfs();

export const constants = Object.freeze({
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0o100,
  O_TRUNC: 0o1000,
  O_NONBLOCK: 0o4000,
});

export const existsSync = (p) => vfs.existsSync(p);
export const statSync = (p, opts) => vfs.statSync(p, opts);
export const lstatSync = (p, opts) => vfs.lstatSync(p, opts);
export const realpathSync = (p) => vfs.realpathSync(p);
export const mkdirSync = (p, opts) => vfs.mkdirSync(p, opts);
export const readdirSync = (p, opts) => vfs.readdirSync(p, opts);
export const readFileSync = (p, opts) => vfs.readFileSync(p, opts);
export const writeFileSync = (p, data, opts) =>
  vfs.writeFileSync(p, data, opts);
export const openSync = (p, flags, mode) => vfs.openSync(p, flags, mode);
export const closeSync = (fd) => vfs.closeSync(fd);
export const fsyncSync = (fd) => vfs.fsyncSync(fd);
export const fchmodSync = (fd, mode) => vfs.fchmodSync(fd, mode);
export const fstatSync = (fd) => vfs.fstatSync(fd);
export const readSync = (fd, buf, off, len, pos) =>
  vfs.readSync(fd, buf, off, len, pos);
export const renameSync = (a, b) => vfs.renameSync(a, b);
export const unlinkSync = (p) => vfs.unlinkSync(p);
export const rmdirSync = (p) => vfs.rmdirSync(p);

export function accessSync(p) {
  vfs.statSync(p);
}

/** No watching here — main asks only under `--hot-reload`, and catches. */
export function watch() {
  throw new Error("fs.watch is not available in the web build");
}

export const promises = {
  readFile: (p, opts) => vfs.readFile(p, opts),
  writeFile: async (p, data, opts) => vfs.writeFileSync(p, data, opts),
  stat: async (p) => vfs.statSync(p),
  access: async (p) => {
    vfs.statSync(p);
  },
  mkdir: async (p, opts) => vfs.mkdirSync(p, opts),
  readdir: async (p, opts) => vfs.readdirSync(p, opts),
  rename: async (a, b) => vfs.renameSync(a, b),
  unlink: async (p) => vfs.unlinkSync(p),
};

export default {
  vfs,
  constants,
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  fchmodSync,
  fstatSync,
  readSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  accessSync,
  watch,
  promises,
};
