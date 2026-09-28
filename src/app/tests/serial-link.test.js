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
 * tests/serial-link.test.js — the host half of the serial protocol v1 against
 * a scripted device: the HELLO / HELLO_ACK handshake (its timeout, and its
 * version and signature refusals), the 16-bit session number that keeps a
 * repeated HELLO from rewinding SEQs, stop-and-wait delivery with
 * ACK/NAK/retry and the three-strikes give-up, de-duplicating a resent Input,
 * the two directions' independent SEQs, log text, a device announcing a
 * restart, and a port that vanishes mid-run.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FRAME,
  PROTOCOL_VERSION,
  encodeFrame,
  FrameDecoder,
  encodeData,
  decodeData,
  encodeHello,
  decodeHello,
} = require("../serial/protocol");
const { SerialLink, followingSession } = require("../serial/link");

const SIGNATURE = 0x12345678;

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A scripted device on the far end of a fake port — the generated header's
 * rules in JavaScript. Everything the link writes reaches `onFrame`; `send`
 * puts a frame on the wire towards the link.
 */
function makeDevice(script = {}) {
  const decoder = new FrameDecoder();
  const frames = []; // every frame the device received (decoded)
  let dataCb = null;
  let closeCb = null;
  const device = {
    frames,
    handled: [], // Output frames the device acted on
    session: null,
    txSeq: 0,
    rxSeq: 0,
    version: script.version ?? PROTOCOL_VERSION,
    signature: script.signature ?? SIGNATURE,
    emit(buf) {
      setImmediate(() => dataCb?.(buf));
    },
    send(frame) {
      device.emit(encodeFrame(frame));
    },
    helloAck(session) {
      device.send({
        type: FRAME.HELLO_ACK,
        payload: encodeHello({ ...device, session }),
      });
    },
    sendIn(index, width, value, seq) {
      if (seq === undefined) seq = device.txSeq = (device.txSeq % 255) + 1;
      device.send({
        type: FRAME.INBOUND,
        seq,
        payload: encodeData(index, width, value),
      });
      return seq;
    },
    unplug(err = new Error("device disconnected")) {
      closeCb?.(err);
    },
    port: {
      writes: 0,
      write(buf) {
        device.port.writes++;
        for (const f of decoder.push(buf)) {
          frames.push(f);
          (script.onFrame ?? device.defaultReply)(f, device);
        }
      },
      onData: (cb) => (dataCb = cb),
      onClose: (cb) => (closeCb = cb),
      close() {
        device.port.closed = true;
      },
    },
    // What the generated header does: a NEW session resets the SEQs, every
    // HELLO is answered; an Output is acted on once per SEQ and ACKed after.
    defaultReply(f, d) {
      if (!f.ok) return;
      if (f.type === FRAME.HELLO) {
        const { session } = decodeHello(f.payload);
        if (session !== d.session) {
          d.session = session;
          d.txSeq = 0;
          d.rxSeq = 0;
        }
        d.helloAck(session);
      } else if (f.type === FRAME.OUTPUT) {
        if (f.seq !== d.rxSeq) {
          d.rxSeq = f.seq;
          d.handled.push(decodeData(f.payload));
        }
        d.send({ type: FRAME.ACK, seq: f.seq });
      }
    },
  };
  return device;
}

function linkTo(device, opts = {}) {
  const events = { inbound: [], logs: [], restarts: 0, closed: [], trace: [] };
  const link = new SerialLink({
    port: device.port,
    timeoutMs: 25,
    helloTimeoutMs: 200,
    helloIntervalMs: 30,
    onInbound: (d) => events.inbound.push(d),
    onLog: (t) => events.logs.push(t),
    onRestart: () => events.restarts++,
    onClosed: (info) => events.closed.push(info),
    onTrace: (entry) => events.trace.push(entry),
    ...opts,
  });
  return { link, events };
}

/** A link already greeted by its device. */
async function greeted(device = makeDevice(), opts) {
  const { link, events } = linkTo(device, opts);
  const r = await link.handshake(SIGNATURE);
  assert.equal(r.ok, true);
  return { device, link, events };
}

// ── The handshake ───────────────────────────────────────────────────────────

test("the handshake sends HELLO with the version and signature, and accepts a match", async () => {
  const device = makeDevice();
  const { link } = linkTo(device);
  const r = await link.handshake(SIGNATURE);
  assert.deepEqual(r, {
    ok: true,
    device: { version: PROTOCOL_VERSION, signature: SIGNATURE },
  });
  const hello = device.frames.find((f) => f.type === FRAME.HELLO);
  const { session, ...rest } = decodeHello(hello.payload);
  assert.deepEqual(rest, { version: PROTOCOL_VERSION, signature: SIGNATURE });
  assert.ok(
    session >= 1 && session <= 0xffff,
    "the payload carries the session",
  );
  assert.equal(hello.seq, 0, "HELLO's SEQ is 0: it is no data frame");
  assert.equal(hello.payload.length, 7);
});

test("a device that never answers is 'no-response' — after asking repeatedly", async () => {
  const device = makeDevice({ onFrame: () => {} });
  const { link } = linkTo(device);
  const r = await link.handshake(SIGNATURE);
  assert.deepEqual(r, { ok: false, code: "no-response" });
  assert.ok(
    device.frames.filter((f) => f.type === FRAME.HELLO).length > 1,
    "it keeps asking — a bootloader may have swallowed the first ones",
  );
});

test("another protocol version is refused, saying which", async () => {
  const device = makeDevice({ version: 2 });
  const { link } = linkTo(device);
  const r = await link.handshake(SIGNATURE);
  assert.equal(r.ok, false);
  assert.equal(r.code, "version");
  assert.equal(r.device.version, 2);
});

test("another layout signature is refused", async () => {
  const device = makeDevice({ signature: 0xdeadbeef });
  const { link } = linkTo(device);
  const r = await link.handshake(SIGNATURE);
  assert.equal(r.ok, false);
  assert.equal(r.code, "signature");
});

test("a HELLO_ACK for another session, or the start-up announcement, is not an answer", async () => {
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type !== FRAME.HELLO) return;
      const { session } = decodeHello(f.payload);
      d.helloAck(0); // "I have just started"
      d.helloAck(followingSession(session)); // a stale session
      d.helloAck(session & 0xff); // the right session's low byte alone
      d.helloAck((session << 8) & 0xffff); // …or swapped end for end
      if (d.frames.filter((x) => x.type === FRAME.HELLO).length >= 3) {
        d.helloAck(session);
      }
    },
  });
  // A session whose bytes differ, so a half-read one could not pass.
  const { link, events } = linkTo(device, { sessions: () => 0x1234 });
  const r = await link.handshake(SIGNATURE);
  assert.equal(r.ok, true);
  assert.equal(
    device.frames.filter((f) => f.type === FRAME.HELLO).length,
    3,
    "only the third answer was for this session",
  );
  assert.equal(
    events.restarts,
    0,
    "an announcement DURING the handshake is expected",
  );
});

// ── Sessions ────────────────────────────────────────────────────────────────

test("sessions are 16 bits: 1…65535, wrapping to 1 — never 0, the announcement's", () => {
  assert.equal(followingSession(1), 2);
  assert.equal(followingSession(255), 256, "past a byte, unlike a SEQ");
  assert.equal(followingSession(256), 257);
  assert.equal(followingSession(65534), 65535);
  assert.equal(followingSession(65535), 1, "wraps to 1, never to 0");
  assert.equal(followingSession(0), 1);
});

test("every session width travels whole in HELLO, and only its own echo answers it", async () => {
  // 0x7D7E puts an ESC and a START in the payload, escaped on the wire.
  for (const session of [1, 255, 256, 0x7d7e, 65535]) {
    const device = makeDevice();
    const { link } = linkTo(device, { sessions: () => session });
    const r = await link.handshake(SIGNATURE);
    assert.equal(r.ok, true, `session ${session}`);
    const hello = device.frames.find((f) => f.type === FRAME.HELLO);
    assert.equal(decodeHello(hello.payload).session, session);
    assert.deepEqual(
      [...hello.payload.subarray(1, 3)],
      [session & 0xff, session >> 8],
      "little-endian",
    );
  }
});

test("a v1 HELLO_ACK that is not seven bytes is no answer; another version's is judged by its version", async () => {
  const short = makeDevice({
    onFrame(f, d) {
      if (f.type !== FRAME.HELLO) return;
      const payload = encodeHello({
        ...d,
        session: decodeHello(f.payload).session,
      });
      d.send({ type: FRAME.HELLO_ACK, payload: payload.slice(0, 6) });
    },
  });
  assert.deepEqual(await linkTo(short).link.handshake(SIGNATURE), {
    ok: false,
    code: "no-response",
  });
  // Another version's longer answer: its version and session are enough to
  // name it, so the run is refused as a version, not silence.
  const later = makeDevice({
    onFrame(f, d) {
      if (f.type !== FRAME.HELLO) return;
      const { session } = decodeHello(f.payload);
      d.send({
        type: FRAME.HELLO_ACK,
        payload: [2, session & 0xff, session >> 8, 9, 9, 9, 9, 9, 9, 9, 9],
      });
    },
  });
  assert.deepEqual(await linkTo(later).link.handshake(SIGNATURE), {
    ok: false,
    code: "version",
    device: { version: 2, signature: null },
  });
});

test("every handshake uses a new session, so a device that did not reset starts over", async () => {
  const device = makeDevice();
  const a = linkTo(device);
  await a.link.handshake(SIGNATURE);
  const first = device.session;
  const b = linkTo(device);
  await b.link.handshake(SIGNATURE);
  assert.notEqual(device.session, first);
});

// ── Delivering Outputs ──────────────────────────────────────────────────────

test("an Output is delivered, acted on once, and resolves on its ACK", async () => {
  const { device, link } = await greeted();
  assert.deepEqual(await link.send(1, 10, 0x2a5), { ok: true });
  assert.deepEqual(device.handled, [{ index: 1, width: 10, value: 0x2a5 }]);
});

test("frames queue one at a time, in order, SEQ counting from 1", async () => {
  const { device, link } = await greeted();
  const all = await Promise.all([
    link.send(0, 8, 1),
    link.send(0, 8, 2),
    link.send(1, 1, 1),
  ]);
  assert.ok(all.every((r) => r.ok));
  assert.deepEqual(
    device.handled.map((h) => h.value),
    [1, 2, 1],
  );
  assert.deepEqual(
    device.frames.filter((f) => f.type === FRAME.OUTPUT).map((f) => f.seq),
    [1, 2, 3],
  );
});

test("SEQ wraps 255 → 1, never to 0", async () => {
  const { device, link } = await greeted();
  for (let i = 0; i < 256; i++) await link.send(0, 1, i & 1);
  const seqs = device.frames
    .filter((f) => f.type === FRAME.OUTPUT)
    .map((f) => f.seq);
  assert.equal(seqs[254], 255);
  assert.equal(seqs[255], 1);
  assert.ok(!seqs.includes(0));
});

test("a lost ACK is covered by a resend, and the device does not act twice", async () => {
  let swallowed = false;
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.OUTPUT && !swallowed) {
        swallowed = true;
        d.rxSeq = f.seq;
        d.handled.push(decodeData(f.payload));
        return; // acted on it, but the ACK never reached the host
      }
      d.defaultReply(f, d);
    },
  });
  const { link } = await greeted(device);
  assert.deepEqual(await link.send(0, 8, 7), { ok: true });
  assert.equal(device.handled.length, 1, "the resend is re-ACKed only");
  assert.equal(device.frames.filter((f) => f.type === FRAME.OUTPUT).length, 2);
});

test("a NAK makes the host resend at once, not after the timeout", async () => {
  let naked = false;
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.OUTPUT && !naked) {
        naked = true;
        d.send({ type: FRAME.NAK });
        return;
      }
      d.defaultReply(f, d);
    },
  });
  const { link } = await greeted(device, { timeoutMs: 5000 });
  const started = Date.now();
  assert.deepEqual(await link.send(0, 4, 3), { ok: true });
  assert.ok(Date.now() - started < 1000, "the NAK short-circuited the wait");
});

test("a NAK with nothing outstanding is ignored", async () => {
  const { device, link, events } = await greeted();
  device.send({ type: FRAME.NAK });
  await sleep(10);
  assert.deepEqual(events.trace.at(-1), { kind: "proto", event: "nak-idle" });
  assert.equal(device.frames.filter((f) => f.type === FRAME.OUTPUT).length, 0);
  assert.deepEqual(
    await link.send(0, 1, 1),
    { ok: true },
    "and changes nothing",
  );
});

test("NAKs never send a frame more than three times: one after the third ends it at once", async () => {
  // A device that NAKs every Output: three sends, then the NAK of the third
  // fails the delivery without waiting out a timeout.
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.OUTPUT) d.send({ type: FRAME.NAK });
      else d.defaultReply(f, d);
    },
  });
  const { link } = await greeted(device, { timeoutMs: 5000 });
  const started = Date.now();
  assert.deepEqual(await link.send(0, 8, 1), { ok: false, code: "delivery" });
  assert.ok(Date.now() - started < 1000, "no timeout was waited for");
  const sent = device.frames.filter((f) => f.type === FRAME.OUTPUT);
  assert.equal(sent.length, 3);
  assert.ok(
    sent.every((f) => f.seq === 1 && f.payload.equals(sent[0].payload)),
    "every resend is the same frame, SEQ and all",
  );
});

test("a stale ACK is ignored", async () => {
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.OUTPUT) d.send({ type: FRAME.ACK, seq: 99 });
      else d.defaultReply(f, d);
    },
  });
  const { link } = await greeted(device);
  assert.deepEqual(await link.send(0, 8, 1), { ok: false, code: "delivery" });
});

test("three sends unanswered give up with 'delivery', and fail the queue behind", async () => {
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.HELLO) d.defaultReply(f, d);
    },
  });
  const { link } = await greeted(device);
  const [a, b] = await Promise.all([link.send(0, 8, 1), link.send(0, 8, 2)]);
  assert.deepEqual(a, { ok: false, code: "delivery" });
  assert.deepEqual(b, { ok: false, code: "delivery" });
  assert.equal(
    device.frames.filter((f) => f.type === FRAME.OUTPUT).length,
    3,
    "exactly three sends of the first frame, none of the second",
  );
});

// ── Receiving ───────────────────────────────────────────────────────────────

test("an Input is ACKed and delivered; a resend of the same SEQ is re-ACKed, not re-delivered", async () => {
  const { device, events } = await greeted();
  const seq = device.sendIn(0, 8, 0x55);
  device.sendIn(0, 8, 0x55, seq); // the device missed our ACK and resent
  device.sendIn(0, 8, 0x66);
  await sleep(20);
  assert.deepEqual(events.inbound, [
    { index: 0, width: 8, value: 0x55 },
    { index: 0, width: 8, value: 0x66 },
  ]);
  const acks = device.frames.filter((f) => f.type === FRAME.ACK);
  assert.deepEqual(
    acks.map((f) => f.seq),
    [seq, seq, seq + 1],
    "every copy is ACKed, so the device stops resending",
  );
});

test("an intact Input the host cannot use is ACKed and dropped — and its resend is a duplicate", async () => {
  const { device, events } = await greeted();
  device.send({ type: FRAME.INBOUND, seq: 1, payload: [0, 17, 1, 0] }); // width 17
  device.send({ type: FRAME.INBOUND, seq: 1, payload: [0, 17, 1, 0] });
  device.send({ type: FRAME.INBOUND, seq: 2, payload: [0, 8, 1] }); // short
  device.sendIn(0, 8, 5, 3);
  await sleep(20);
  assert.deepEqual(events.inbound, [{ index: 0, width: 8, value: 5 }]);
  assert.deepEqual(
    device.frames.filter((f) => f.type === FRAME.ACK).map((f) => f.seq),
    [1, 1, 2, 3],
  );
  assert.deepEqual(
    events.trace.filter((e) => e.kind === "error").map((e) => e.event),
    ["unusable", "duplicate", "unusable"],
  );
});

test("each direction counts its own SEQs, and the host ACKs Inputs while its Output waits", async () => {
  // The device holds its ACK of Output SEQ 1 until it has sent Input SEQ 1
  // and heard the host acknowledge it: the same number, two frames.
  let heldSeq = null;
  const device = makeDevice({
    onFrame(f, d) {
      if (f.ok && f.type === FRAME.OUTPUT && heldSeq === null) {
        heldSeq = f.seq;
        d.rxSeq = f.seq;
        d.handled.push(decodeData(f.payload));
        d.sendIn(0, 8, 0x42); // INBOUND SEQ 1, while OUTPUT SEQ 1 waits
        return;
      }
      if (f.ok && f.type === FRAME.ACK && heldSeq !== null) {
        d.send({ type: FRAME.ACK, seq: heldSeq }); // now the Output's ACK
        return;
      }
      d.defaultReply(f, d);
    },
  });
  const { link, events } = await greeted(device, { timeoutMs: 5000 });
  assert.deepEqual(await link.send(0, 8, 7), { ok: true });
  assert.equal(heldSeq, 1);
  assert.deepEqual(events.inbound, [{ index: 0, width: 8, value: 0x42 }]);
  assert.deepEqual(
    device.frames.filter((f) => f.type === FRAME.ACK).map((f) => f.seq),
    [1],
    "the host's ACK of INBOUND 1 — not taken for the device's ACK of OUTPUT 1",
  );
  // And the next of each is 2, independently.
  assert.deepEqual(await link.send(0, 8, 8), { ok: true });
  device.sendIn(0, 8, 0x43);
  await sleep(10);
  assert.deepEqual(
    device.frames.filter((f) => f.type === FRAME.OUTPUT).map((f) => f.seq),
    [1, 2],
  );
  assert.deepEqual(
    events.inbound.map((d) => d.value),
    [0x42, 0x43],
  );
});

test("a repeated HELLO_ACK for this session changes nothing the host remembers", async () => {
  // The host resends HELLO until it hears, so a second HELLO_ACK for the SAME
  // session can arrive after the device has started talking. Were it taken as
  // a fresh start, the host would forget the Input SEQ it last accepted — and
  // the resend of that Input (our ACK lost) would be delivered twice.
  const { device, events } = await greeted();
  const seq = device.sendIn(0, 8, 1);
  await sleep(5);
  device.helloAck(device.session);
  device.sendIn(0, 8, 1, seq);
  await sleep(10);
  assert.deepEqual(
    events.inbound.map((d) => d.value),
    [1],
  );
  assert.equal(events.restarts, 0);
});

test("a damaged Input is NAKed; a damaged ACK or LOG is dropped without a word", async () => {
  const { device, events } = await greeted();
  const damage = (frame) => {
    const buf = Buffer.from(encodeFrame(frame));
    buf[buf.length - 1] ^= 0x01;
    return buf;
  };
  device.emit(
    damage({ type: FRAME.INBOUND, seq: 4, payload: encodeData(0, 8, 1) }),
  );
  device.emit(damage({ type: FRAME.ACK, seq: 1 }));
  device.emit(damage({ type: FRAME.LOG, payload: [...Buffer.from("x")] }));
  await tick();
  await tick();
  assert.equal(events.inbound.length, 0);
  assert.equal(events.logs.length, 0);
  const naks = device.frames.filter((f) => f.type === FRAME.NAK);
  assert.equal(naks.length, 1);
  assert.equal(naks[0].seq, 0, "a NAK's SEQ is always 0");
});

test("log text is passed on as it arrives, never acknowledged", async () => {
  const { device, events } = await greeted();
  device.send({ type: FRAME.LOG, payload: [...Buffer.from("temp=21")] });
  device.send({ type: FRAME.LOG, payload: [...Buffer.from("\r\n")] });
  await sleep(10);
  assert.deepEqual(events.logs, ["temp=21", "\r\n"]);
  assert.equal(device.frames.filter((f) => f.type === FRAME.ACK).length, 0);
});

test("a character split across LOG frames still arrives whole", async () => {
  const { device, events } = await greeted();
  const bytes = Buffer.from("é", "utf8");
  device.send({ type: FRAME.LOG, payload: [0x61, bytes[0]] });
  device.send({ type: FRAME.LOG, payload: [bytes[1], 0x62] });
  await sleep(10);
  assert.equal(events.logs.join(""), "aéb");
});

test("the device announcing a start AFTER the handshake is a restart, and fails what waits", async () => {
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.HELLO) d.defaultReply(f, d);
    },
  });
  const { link, events } = await greeted(device, { timeoutMs: 5000 });
  const pending = link.send(0, 8, 1);
  device.helloAck(0);
  assert.deepEqual(await pending, { ok: false, code: "restart" });
  assert.equal(events.restarts, 1);
  // …and it has forgotten the session: nothing it sends counts until a new
  // one, and FAILED, the host NAKs no damage.
  device.sendIn(0, 8, 9);
  const bad = Buffer.from(
    encodeFrame({ type: FRAME.INBOUND, seq: 2, payload: encodeData(0, 8, 1) }),
  );
  bad[bad.length - 1] ^= 0x01;
  device.emit(bad);
  await sleep(10);
  assert.equal(events.inbound.length, 0);
  assert.equal(device.frames.filter((f) => f.type === FRAME.NAK).length, 0);
});

test("a stale HELLO_ACK after the handshake — another session's, or this one's again — changes nothing", async () => {
  const { device, link, events } = await greeted(undefined, {
    sessions: () => 0x0300,
  });
  device.helloAck(0x02ff); // the session before
  device.helloAck(0x0300); // this one, late
  await sleep(10);
  assert.equal(events.restarts, 0);
  assert.deepEqual(await link.send(0, 8, 1), { ok: true }, "the run goes on");
});

test("data frames go only while ACTIVE: none before the handshake, and a failure answers again after it", async () => {
  const quiet = makeDevice();
  const early = linkTo(quiet).link;
  assert.deepEqual(await early.send(0, 8, 1), { ok: false, code: "closed" });
  assert.equal(quiet.frames.length, 0, "nothing was written");

  // After a delivery fails the session is over: the next send is refused at
  // once, an Input is no longer taken — but log text still is.
  const deaf = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.HELLO) d.defaultReply(f, d);
    },
  });
  const { link, events } = await greeted(deaf);
  assert.deepEqual(await link.send(0, 8, 1), { ok: false, code: "delivery" });
  const sent = deaf.frames.length;
  assert.deepEqual(await link.send(0, 8, 2), { ok: false, code: "delivery" });
  assert.equal(deaf.frames.length, sent, "and nothing more was written");
  deaf.sendIn(0, 8, 9);
  deaf.send({ type: FRAME.LOG, payload: [...Buffer.from("still here")] });
  await sleep(10);
  assert.deepEqual(events.inbound, []);
  assert.deepEqual(events.logs, ["still here"]);
  assert.equal(deaf.frames.filter((f) => f.type === FRAME.ACK).length, 0);

  // After a restart, likewise.
  const { device: d2, link: l2 } = await greeted();
  d2.helloAck(0);
  await sleep(10);
  assert.deepEqual(await l2.send(0, 8, 1), { ok: false, code: "restart" });
});

test("an INBOUND with SEQ 0 is no data frame: not ACKed, not delivered", async () => {
  const { device, events } = await greeted();
  device.send({ type: FRAME.INBOUND, seq: 0, payload: encodeData(0, 8, 1) });
  device.sendIn(0, 8, 2);
  await sleep(10);
  assert.deepEqual(
    events.inbound.map((d) => d.value),
    [2],
  );
  assert.deepEqual(
    device.frames.filter((f) => f.type === FRAME.ACK).map((f) => f.seq),
    [1],
  );
});

test("a frame of a type the host never receives, or does not know, is ignored", async () => {
  const { device, link, events } = await greeted();
  device.send({ type: 0x33, payload: [1, 2, 3] });
  device.send({ type: FRAME.OUTPUT, seq: 1, payload: encodeData(0, 8, 9) });
  device.send({
    type: FRAME.HELLO,
    payload: encodeHello({ ...device, session: 7 }),
  });
  device.sendIn(0, 8, 2);
  await sleep(10);
  assert.deepEqual(
    events.inbound.map((d) => d.value),
    [2],
  );
  assert.deepEqual(
    device.frames
      .filter((f) => f.type !== FRAME.HELLO)
      .map((f) => [f.type, f.seq]),
    [[FRAME.ACK, 1]],
    "the Input's ACK and nothing else: no NAK, no answer",
  );
  assert.deepEqual(await link.send(0, 8, 1), { ok: true });
});

test("nothing but LOG and the handshake counts before the device is greeted", async () => {
  const device = makeDevice();
  const { events } = linkTo(device);
  device.sendIn(0, 8, 1);
  device.helloAck(0);
  device.send({ type: FRAME.LOG, payload: [...Buffer.from("boot")] });
  const bad = Buffer.from(
    encodeFrame({ type: FRAME.INBOUND, seq: 2, payload: encodeData(0, 8, 1) }),
  );
  bad[bad.length - 1] ^= 0x01; // damage owed a NAK — in a session
  device.emit(bad);
  await sleep(10);
  assert.equal(events.inbound.length, 0);
  assert.equal(events.restarts, 0);
  assert.deepEqual(events.logs, ["boot"]);
  assert.equal(device.frames.length, 0, "and nothing was ACKed or NAKed");
});

// ── The port ────────────────────────────────────────────────────────────────

test("a port that vanishes fails what is waiting and reports it once", async () => {
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.HELLO) d.defaultReply(f, d);
    },
  });
  const { link, events } = await greeted(device, { timeoutMs: 5000 });
  const pending = link.send(0, 8, 1);
  device.unplug();
  assert.deepEqual(await pending, { ok: false, code: "closed" });
  assert.equal(events.closed.length, 1);
  assert.equal(events.closed[0].unexpected, true);
  assert.deepEqual(await link.send(0, 8, 2), { ok: false, code: "closed" });
});

test("closing the link ourselves is not reported as a drop", async () => {
  const device = makeDevice();
  const { link, events } = linkTo(device);
  await link.close();
  device.unplug();
  assert.equal(events.closed.length, 0);
  assert.equal(device.port.closed, true);
});

// ── The trace (what a connection window shows) ──────────────────────────────

const traced = (events) => events.trace.map((e) => e.event ?? `${e.kind}:${e.dir}`); // prettier-ignore

test("trace: a handshake is HELLO, HELLO_ACK and its verdict", async () => {
  const { events } = await greeted();
  assert.deepEqual(traced(events).slice(0, 3), ["hello", "hello-ack", "handshake"]); // prettier-ignore
  const [hello, ack] = events.trace;
  assert.equal(hello.signature, SIGNATURE);
  assert.equal(ack.session, hello.session);
  const refused = linkTo(makeDevice({ signature: 1 }));
  await refused.link.handshake(SIGNATURE);
  const err = refused.events.trace.find((e) => e.kind === "error");
  assert.deepEqual(
    { event: err.event, signature: err.signature, expected: err.expected },
    { event: "signature", signature: 1, expected: SIGNATURE },
  );
});

test("trace: an Output is ONE data line with its bytes, then the device's ACK", async () => {
  const { link, events } = await greeted();
  events.trace.length = 0;
  await link.send(2, 9, 0x1a5);
  const [data, ack] = events.trace;
  assert.deepEqual(
    { kind: data.kind, dir: data.dir, seq: data.seq, index: data.index, width: data.width, value: data.value }, // prettier-ignore
    { kind: "data", dir: "out", seq: 1, index: 2, width: 9, value: 0x1a5 },
  );
  assert.deepEqual(data.raw, [...encodeFrame({ type: FRAME.OUTPUT, seq: 1, payload: encodeData(2, 9, 0x1a5) })]); // prettier-ignore
  assert.deepEqual(ack, { kind: "proto", event: "ack-in", seq: 1 });
});

test("trace: resends are error lines — why, and which attempt — and never a second data line", async () => {
  let n = 0;
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.OUTPUT && n++ === 0) {
        d.send({ type: FRAME.NAK }); // the first arrived damaged
        return;
      }
      if (f.type === FRAME.OUTPUT && n === 2) return; // the second is lost
      d.defaultReply(f, d);
    },
  });
  const { link, events } = await greeted(device);
  events.trace.length = 0;
  assert.deepEqual(await link.send(0, 1, 1), { ok: true });
  const resends = events.trace.filter((e) => e.event === "resend");
  assert.deepEqual(
    resends.map(({ cause, attempt, max }) => ({ cause, attempt, max })),
    [
      { cause: "nak", attempt: 2, max: 3 },
      { cause: "timeout", attempt: 3, max: 3 },
    ],
  );
  assert.equal(events.trace.filter((e) => e.kind === "data").length, 1);
});

test("trace: a delivery that fails says so, after its three sends", async () => {
  const device = makeDevice({
    onFrame(f, d) {
      if (f.type === FRAME.HELLO) d.defaultReply(f, d);
    },
  });
  const { link, events } = await greeted(device);
  await link.send(0, 1, 1);
  assert.deepEqual(events.trace.at(-1), {
    kind: "error",
    event: "failed",
    seq: 1,
    attempts: 3,
  });
});

test("trace: an Input is a data line and our ACK; its resend is an error line", async () => {
  const { device, events } = await greeted();
  events.trace.length = 0;
  const seq = device.sendIn(1, 8, 0x42);
  device.sendIn(1, 8, 0x42, seq);
  await sleep(10);
  assert.deepEqual(traced(events), ["data:in", "ack-out", "duplicate", "ack-out"]); // prettier-ignore
  assert.equal(events.trace[0].value, 0x42);
  assert.equal(events.trace[0].raw[0], 0x7e);
});

test("trace: a damaged frame says what it was and whether a NAK went back", async () => {
  const { device, events } = await greeted();
  events.trace.length = 0;
  const bad = Buffer.from(
    encodeFrame({ type: FRAME.INBOUND, seq: 4, payload: encodeData(0, 8, 1) }),
  );
  bad[bad.length - 1] ^= 0x01;
  const badAck = Buffer.from(encodeFrame({ type: FRAME.ACK, seq: 1 }));
  badAck[badAck.length - 1] ^= 0x01;
  device.emit(bad);
  device.emit(badAck);
  await tick();
  await tick();
  assert.deepEqual(
    events.trace.map(({ event, type, error, nak }) => ({ event, type, error, nak })), // prettier-ignore
    [
      { event: "damaged", type: FRAME.INBOUND, error: "crc", nak: true },
      { event: "damaged", type: FRAME.ACK, error: "crc", nak: false },
    ],
  );
});
