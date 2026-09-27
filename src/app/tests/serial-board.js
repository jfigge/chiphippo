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

/**
 * tests/serial-board.js — a generated device program run as a "BOARD": a
 * child process speaking the serial protocol over its stdin/stdout, behind
 * the four-method port object the real SerialLink drives. Shared by the
 * C++ header's tests (a compiled sketch) and the Python module's (a script
 * under python3 or micropython), so both are held to the host by the same
 * harness. Not a test file itself.
 */

"use strict";

const { spawn } = require("child_process");

const { FrameDecoder, encodeFrame } = require("../serial/protocol");

const spawnBoard = (
  command,
  { args = [], cwd, env, stderr = "inherit" } = {},
) =>
  spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", stderr],
    env: { ...process.env, ...env },
  });

/**
 * One board for one run. `mangle` edits (or holds back) what the host writes;
 * `filter` sees every whole FRAME the board sends and returns false to lose
 * it on the way; `stderr: "pipe"` keeps what the program says there (a
 * traceback) for the test rather than the runner's output.
 */
function board(command, { args, cwd, env, mangle, filter, stderr } = {}) {
  const child = spawnBoard(command, { args, cwd, env, stderr });
  const frames = []; // every frame the board sent
  const decoder = new FrameDecoder();
  let writes = 0;
  return {
    child,
    frames,
    port: {
      write(buf) {
        writes++;
        const out = mangle ? mangle(Buffer.from(buf), writes) : buf;
        if (out) child.stdin.write(out);
      },
      onData: (cb) =>
        child.stdout.on("data", (chunk) => {
          // Re-framed on the way, so a test can see (and lose) whole frames
          // however the pipe happened to chunk them.
          for (const f of decoder.push(chunk)) {
            if (!f.ok) continue;
            frames.push(f);
            if (!filter || filter(f)) cb(encodeFrame(f));
          }
        }),
      onClose: (cb) => child.on("exit", () => cb(null)),
      close() {
        child.stdin.end();
        return new Promise((r) => child.once("exit", r));
      },
    },
  };
}

/**
 * One board that outlives its runs: a program kept going while one
 * SerialLink after another is opened on it — a board that does NOT reset
 * when the port opens (a Leonardo, a Pico, most native-USB boards), where
 * every Run after the first finds the program already running and already
 * greeted.
 */
function lastingBoard(command, { args, cwd, env } = {}) {
  const child = spawnBoard(command, { args, cwd, env });
  const decoder = new FrameDecoder();
  let sink = null;
  child.stdout.on("data", (chunk) => {
    for (const f of decoder.push(chunk)) if (f.ok && sink) sink(encodeFrame(f));
  });
  return {
    child,
    port: () => ({
      write: (buf) => child.stdin.write(buf),
      onData: (cb) => {
        sink = cb;
      },
      onClose: () => {},
      close: async () => {
        sink = null; // the run ends; the board runs on
      },
    }),
  };
}

module.exports = { board, lastingBoard };
