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
 * C++ header's tests (a compiled sketch), the Python module's (a script
 * under python3 or micropython) and the conformance suite, so all of them are
 * held to the host by the same harness — with the stub Arduino core a sketch
 * compiles against on the host. Not a test file itself.
 */

"use strict";

const { spawn } = require("child_process");

const { FrameDecoder, encodeFrame } = require("../serial/protocol");

/** Runs a sketch's setup() and loop() as a host program, until stdin closes. */
const HOST_MAIN = String.raw`
int main() {
  setup();
  while (!Serial.eof) {
    loop();
    usleep(200);
  }
  return 0;
}
`;

/** Just enough of the Arduino core for the generated header and a sketch. */
const ARDUINO_H = String.raw`
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>

typedef bool boolean;
typedef uint8_t byte;

static inline unsigned long millis() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (unsigned long)(ts.tv_sec * 1000UL + ts.tv_nsec / 1000000UL);
}

#define SERIAL_8N1 0x06
#define SERIAL_8E1 0x26

// Object-like macros the real cores define under ordinary names — binary.h's
// B0/B1, Print.h's HEX/DEC, an AVR register, an ESP32 bit — so a generated
// name spelled like one is caught here as it would be on the board.
#define B0 0
#define B1 1
#define HEX 16
#define DEC 10
#define SP (*(volatile uint16_t *)(0x5D))
#define BIT0 0x00000001

class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t) = 0;
  size_t write(const uint8_t* b, size_t n) {
    size_t k = 0;
    while (n--) k += write(*b++);
    return k;
  }
  size_t write(const char* s) { return write((const uint8_t*)s, strlen(s)); }
  size_t print(const char* s) { return write(s); }
  size_t print(long v) {
    char buf[24];
    snprintf(buf, sizeof buf, "%ld", v);
    return write(buf);
  }
  size_t print(int v) { return print((long)v); }
  size_t print(unsigned v) { return print((long)v); }
  size_t print(unsigned char v) { return print((long)v); }
  size_t println() { return write("\r\n"); }
  template <typename T> size_t println(T v) { size_t n = print(v); return n + println(); }
};

class Stream : public Print {
 public:
  virtual int available() = 0;
  virtual int read() = 0;
};

class HostSerial : public Stream {
 public:
  void begin(unsigned long) { fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK); }
  void begin(unsigned long b, int) { begin(b); }
  int available() {
    if (pos_ < len_) return (int)(len_ - pos_);
    ssize_t n = ::read(0, buf_, sizeof buf_);
    if (n == 0) eof = true;
    if (n <= 0) return 0;
    len_ = (size_t)n;
    pos_ = 0;
    return (int)len_;
  }
  int read() { return available() ? buf_[pos_++] : -1; }
  size_t write(uint8_t b) { return ::write(1, &b, 1) == 1 ? 1 : 0; }
  using Print::write;
  bool eof = false;
 private:
  uint8_t buf_[256];
  size_t len_ = 0, pos_ = 0;
};

extern HostSerial Serial;
`;

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

module.exports = { board, lastingBoard, ARDUINO_H, HOST_MAIN };
