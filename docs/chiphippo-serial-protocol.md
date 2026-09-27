# ChipHippo Serial Protocol — v1

This document defines the bytes that travel between Chip Hippo and a device on the other end of a serial connection. It is language-neutral: the C++ header Chip Hippo generates is one implementation of it, and anything else (MicroPython, Rust, a Python test harness on a pty) must be able to interoperate by following this document alone.

Terms: **host** = Chip Hippo. **device** = whatever is on the other end of the connection (usually an Arduino). **circuit** = the simulated breadboard. All multi-byte integers are **little-endian**.

On the host, every number in this document lives in one module, `src/web/scripts/model/serial-wire.js`. The host's framing (`src/app/serial/protocol.js`) reads it, and the generator writes the device's constants from it.

---

## 1. Transport assumptions

- A byte stream with no framing of its own (UART, USB CDC, pty).
- Serial parameters (baud, data bits, parity, stop bits, flow control) come from the named connection. Recommended: 115200 8-N-1, no flow control.
- One host and one device per connection. The device only ever sees the elements assigned to its connection.

---

## 2. Frame format

On the wire:

```
START  TYPE  SEQ  LEN  PAYLOAD[LEN]  CRC_LO  CRC_HI
0x7E   1B    1B   1B   0–255 bytes   2 bytes
```

| Field | Size | Meaning |
|---|---|---|
| `START` | 1 | Always `0x7E`. Never escaped. Marks the beginning of a frame. |
| `TYPE` | 1 | Frame type (§3). |
| `SEQ` | 1 | Data frames: sequence number (§5). `ACK`: the sequence number being acknowledged. `HELLO` / `HELLO_ACK`: the session (§3.1). Otherwise 0. |
| `LEN` | 1 | Number of payload bytes **before** escaping (0–255). |
| `PAYLOAD` | `LEN` | Type-specific (§3). |
| `CRC` | 2 | CRC-16/CCITT-FALSE over the **unescaped** bytes `TYPE SEQ LEN PAYLOAD`. Little-endian. |

### 2.1 CRC

CRC-16/CCITT-FALSE: polynomial `0x1021`, initial value `0xFFFF`, no reflection, no final XOR. Check value for ASCII `"123456789"` is `0x29B1`.

Reference (C):

```c
uint16_t crc16(const uint8_t *p, size_t n) {
  uint16_t crc = 0xFFFF;
  while (n--) {
    crc ^= (uint16_t)(*p++) << 8;
    for (uint8_t i = 0; i < 8; i++)
      crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : (crc << 1);
  }
  return crc;
}
```

### 2.2 Escaping

Every byte after `START` (i.e. `TYPE` through `CRC_HI`) is escaped:

| Unescaped | Sent as |
|---|---|
| `0x7E` | `0x7D 0x5E` |
| `0x7D` | `0x7D 0x5D` |

(Escape byte `0x7D` followed by the original XOR `0x20`.)

Consequences:
- `0x7E` on the wire is **always** a frame start. A receiver that sees `0x7E` mid-frame discards the partial frame and starts a new one. This is how both sides resynchronise after noise or a reset.
- `LEN` counts unescaped bytes, so the on-wire length varies. Worst case a frame is `1 + 2 × (3 + 255 + 2)` = 521 bytes.

### 2.3 Receiver rules

1. Wait for `0x7E`. Discard everything else while idle.
2. Read and unescape `TYPE`, `SEQ`, `LEN`, `LEN` payload bytes, and the two CRC bytes.
3. The frame is **damaged** if a `0x7D` is followed by anything other than `0x5E`/`0x5D`, if `LEN` is larger than the receiver can buffer (a receiver need only accept the longest frame its peer sends it), or if the CRC doesn't match.
4. A damaged frame is discarded. If the session is established (§4) and the damaged frame's `TYPE`, as received, is not `ACK`, `NAK`, `LOG`, `HELLO` or `HELLO_ACK`, the receiver sends a `NAK` (§5.3) at once. Those five are never resent in answer to a NAK, so a NAK for one would only cause noise.
5. Otherwise dispatch by `TYPE`. A frame with an unknown `TYPE` is ignored.

---

## 3. Frame types

| Value | Name | Direction | Acknowledged? |
|---|---|---|---|
| `0x01` | `HELLO` | host → device | Answered by `HELLO_ACK` |
| `0x02` | `HELLO_ACK` | device → host | No |
| `0x06` | `ACK` | either | No |
| `0x15` | `NAK` | either | No |
| `0x10` | `OUTPUT` | host → device | Yes |
| `0x11` | `INBOUND` | device → host | Yes |
| `0x20` | `LOG` | device → host | **No** |

Values `0x00`, `0x7D`, `0x7E` and `0xFF` are never used as types.

### 3.1 `HELLO` / `HELLO_ACK`

Payload, both directions (5 bytes):

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Protocol version. This document is **1**. |
| 1 | 4 | Layout signature (§6). |

`SEQ` carries the **session**:

- The host picks a session number, **1–255**, for each run. It must differ from the previous run's, because a device that didn't reset between runs still remembers the old session. Chip Hippo counts upward from a random start.
- The host sends it as `HELLO`'s `SEQ`. The device echoes it as `HELLO_ACK`'s `SEQ`.
- A `HELLO_ACK` with `SEQ` **0** is the device **announcing** that it has just started (§4.2). It is not an answer to anything.

The device always answers `HELLO` with a `HELLO_ACK` carrying **its own** version and signature, even if they differ from the host's. Only the host judges compatibility, so only the host has to produce the error message.

### 3.2 `OUTPUT` (circuit → device) and `INBOUND` (device → circuit)

Payload (4 bytes):

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Element index (§6) within this connection and direction. |
| 1 | 1 | Width: **1–16**, the element's total pin count. |
| 2 | 2 | Value, right-aligned: bit 0 is the element's pin 1. Bits at or above `width` must be 0 and are masked off by the receiver. |

An element is an ordered list of **fields** (bit = 1 pin, byte = 8, word = 16; 16 pins at most). The fields are packed into the value in order from bit 0. A byte followed by a bit, for example, puts the byte in bits 0–7 and the bit in bit 8. The fields are presentation, so they need no wire support: they only say which bits the generated code hands to which parameter. Because they decide that, the layout signature covers them (§6).

An `INBOUND` frame always carries the **whole** element — there are no partial updates. The device keeps its own copy of the state and sends all of it.

An intact data frame the receiver can't use is **ACKed and dropped**, since a resend would carry the same bytes. That covers a wrong `LEN` for its type, an element index the receiver doesn't have, and a width that doesn't match that element.

### 3.3 `LOG`

Payload: 1–255 bytes of UTF-8 text. No terminator. A newline (`0x0A`) inside the text ends a line; text without a trailing newline continues on the same line when the next `LOG` arrives. Longer output is split across frames by the sender, **never inside a multi-byte UTF-8 sequence**. A receiver should still decode `LOG` text as a stream, so a peer that gets this wrong costs nothing worse than a late character.

`LOG` is **not acknowledged**. It is sent with `SEQ` 0, never NAKed, never resent and not de-duplicated. Log text changes nothing on the circuit, so losing a line to a damaged frame is cheap, and blocking the sketch on every `print()` is not. The byte stream keeps it in order with the data frames around it.

A device may send `LOG` whether or not a session is established. Text printed during start-up reaches a host that is listening, and costs nothing when none is.

Log frames never touch the circuit and never cause a settle.

### 3.4 `ACK` / `NAK`

Payload empty (`LEN` = 0).
- `ACK`: `SEQ` = the sequence number of the data frame being acknowledged.
- `NAK`: `SEQ` = 0 and is ignored. Means "the last frame I received was damaged — resend whatever you have outstanding". A sender with nothing outstanding ignores it.

---

## 4. Session lifecycle

1. **Open.** The host opens the port when Run is pressed. On many Arduino boards this resets the device, and a bootloader may swallow bytes for 1–2 seconds.
2. **Announce.** When the device's library starts (the generated `begin()`), it sends one `HELLO_ACK` with `SEQ` 0. During a handshake the host ignores it: the reset it describes was expected. After a handshake it means the device has restarted and forgotten the session (step 6).
3. **Handshake.** The host picks a session (§3.1) and sends `HELLO` every **250 ms** until it receives a `HELLO_ACK` carrying that session, for up to **5 seconds**. A `HELLO_ACK` for any other session is stale and ignored. No answer → the run stops, naming the connection and its port.
4. **Check.** The host compares the `HELLO_ACK` with its own:
   - Version differs → the run stops: *"‹connection› speaks protocol v‹n›; Chip Hippo speaks v‹host›. Generate its header again and re-upload the sketch."* The host's version in the message comes from the same constant as the one on the wire.
   - Layout signature differs → the run stops: *"The sketch on ‹connection› was built for a different design. Generate its header again and re-upload the sketch."*

   (The renderer's language catalogs own the exact words.)
5. **Running.** Data frames flow per §5. The device ignores every frame except `HELLO` until it has answered one. It likewise sends no data frames until then; `LOG` is the exception (§3.3).
   - A `HELLO` carrying a **new** session resets the device's sequence state and anything it was holding for the old session.
   - A `HELLO` carrying the **current** session is a late copy (the host resends until it hears). It is answered and changes nothing. Resetting on it would rewind the device's SEQ counter, and its next `INBOUND` would look like a duplicate to the host and be dropped silently.
   - The host likewise ignores a repeated `HELLO_ACK` for the current session.
6. **Restart.** A `HELLO_ACK` with `SEQ` 0 after the handshake means the device restarted. It will ignore everything until greeted again, which only a new Run does, so the host fails whatever it has outstanding and stops the run: *"‹connection› restarted while the circuit was running, so the circuit has stopped."* Without the announcement, a restarted device on an Inputs-only design would simply fall silent.
7. **Close.** The host closes the port on Stop. There is no goodbye frame in v1. If the port drops mid-run, the host stops the simulation.

---

## 5. Reliable delivery

`OUTPUT` and `INBOUND` are data frames. Each direction is **stop-and-wait**: a sender has at most one unacknowledged data frame outstanding and doesn't send another until it's acked.

### 5.1 Sequence numbers

- Each side keeps its own send counter. The first data frame of a session is SEQ **1**; each new data frame increments it, wrapping 255 → 1. SEQ 0 is reserved for the handshake, `LOG` and `NAK`.
- A resend uses the **same** `SEQ` as the original.
- Each side remembers the `SEQ` of the last data frame it accepted from the other, starting at **0** (none) for each session. A data frame arriving with that same `SEQ` is a duplicate: **ACK it again, do not process it again.** This matters — without it, a lost ACK would call a user's output function twice.
- **Exception:** a duplicate of the `OUTPUT` whose handler is **still running**, or which the device is holding to run next, is ignored, not re-acked. Its ACK follows when the handler returns (§5.2). This happens whenever a handler sends an `INBOUND`: the device reads the port while it waits for that ACK, and the host's timeout can resend the `OUTPUT` in the meantime. Re-acking it then would let the circuit run on before the handler's `INBOUND` had been applied.

### 5.2 When to ACK

| Receiver | Frame | ACK is sent… |
|---|---|---|
| device | `OUTPUT` | **after** the user's handler for that element returns. |
| host | `INBOUND` | as soon as it is buffered (it is applied at the next settle boundary, not before), even while the circuit is stalled. |

Acking `OUTPUT` after the handler means any `INBOUND` the handler sends has been delivered and acknowledged, and any `LOG` it printed has been sent, **before** the ACK. The host's integration settle phase stalls until every `OUTPUT` is acked, so it always sees the device's reaction to that settle. That's the property that makes the two-phase settle deterministic.

A device never runs a handler from inside another handler or while it waits for an `INBOUND`'s ACK. An `OUTPUT` arriving then is held (the host sends one at a time, so one slot is enough) and run afterwards. It is acked when it has run.

Handlers must return promptly: within the host's timeout if possible, and certainly within its three sends (§5.3). Long work belongs in `loop()`.

### 5.3 Timeouts, NAK, retries

- After sending a data frame, wait **500 ms** for its `ACK`.
- `NAK` received, or timeout → resend the outstanding frame.
- A frame is sent at most **3 times** in total. If the third isn't acked:
  - **Host:** stop the run: *"Delivery to ‹connection› failed after 3 attempts, so the circuit has stopped."* The count in the message comes from the same constant as the rule.
  - **Device:** drop the frame, report the failure to the caller (the generated `send()` returns false), and **go offline**: behave as un-greeted until the next `HELLO`. While offline, a send fails at once instead of waiting 3 × 500 ms. That is what keeps a sketch left running after Stop from crawling: there is no goodbye frame, and a board that resets on open does not reset on close. The generated library exposes the state as `ChipHippo.connected()`.
- An `ACK` whose `SEQ` doesn't match the outstanding frame is stale — ignore it.
- `ACK`, `NAK` and resends never light the activity lamps. They are visible in the connection window's protocol view.

### 5.4 Ordering

Because each direction is stop-and-wait, data frames are processed in the order sent. Frames from the two directions may interleave freely. A receiver must keep acknowledging the other side's data frames while it waits for an ACK of its own. `LOG` frames sit in the byte stream in the order they were written.

---

## 6. Element indices and layout signature

Names never travel over the wire. Elements are identified by index.

- Indices are assigned **per connection, per direction**, starting at 0: Output elements 0…n, Input elements 0…m.
- Order is by the element's stable internal id, compared by its **number** (`out2` before `out10`). The number only counts up, so an element's index changes only when one before it on the same connection and direction is added or removed.
- The generated header, the element index in every data frame and the signature all use this one ordering. On the host it is one function (`elementsFor` in `integration.js`).
- The **layout signature** protects against a sketch built for a different design. For each connection, build this ASCII string:

  ```
  O0:8+1,O1:1,I0:16
  ```

  - Every Output is written as `O<index>:<widths>`, then every Input as `I<index>:<widths>`.
  - `<widths>` is the element's field widths in order, joined by `+`.
  - Each group is in index order, comma-separated, with no spaces.

  Signature = **CRC-32 (IEEE 802.3)** of that string, sent little-endian. An empty layout is the empty string (CRC-32 = `0x00000000`). On the host it is one function (`layoutSignature` in `integration.js`), called both by the generator and by the run-time handshake.

The signature covers what decides which bits reach which parameter: the elements, their order, and each one's field boundaries, not only its total width. A `[bit, byte]` element reordered to `[byte, bit]` keeps its width of 9 but hands every value to the wrong parameters, so it must be refused.

Renaming an element or a field changes nothing on the wire. It changes the design hash (and the Generate button's staleness dot) but not the signature, so a run still works until you regenerate.

Examples: `O0:8,O1:1,I0:16` → `0xF8ACB506`. CRC-32 of `"123456789"` is `0xCBF43926`.

---

## 7. Worked example

The host sends `OUTPUT`, element 0, width 8, value `0x7E` (deliberately a value that needs escaping), `SEQ` 1.

Unescaped: `TYPE=10 SEQ=01 LEN=04 PAYLOAD=00 08 7E 00`
CRC-16 over `10 01 04 00 08 7E 00` = `0x88E4`, sent as `E4 88`.

On the wire:

```
7E  10 01 04  00 08 7D 5E 00  E4 88
```

The device calls the handler for Output 0 with `0x7E`. The handler returns, and the device sends (CRC `0x4D0D`):

```
7E  06 01 00  0D 4D
```

Escaping reaches the CRC bytes too. `ACK` for `SEQ` 16 has CRC `0x7D4F`, and `ACK` for `SEQ` 17 has CRC `0x4E7E`:

```
7E  06 10 00  4F 7D 5D
7E  06 11 00  7D 5E 4E
```

---

## 8. Constants

| Constant | Value |
|---|---|
| Protocol version | 1 |
| `START` / `ESC` / XOR | `0x7E` / `0x7D` / `0x20` |
| CRC-16 polynomial / initial value | `0x1021` / `0xFFFF` |
| Handshake interval / window | 250 ms / 5 s |
| Session numbers | 1–255 (0 = the device's start-up announcement) |
| ACK timeout | 500 ms |
| Max sends per frame | 3 |
| Max payload | 255 bytes |
| Max element width | 16 |

These are protocol values, not settings. No connection overrides them.

Any change to the frame layout, types, CRC or the meaning of a field requires incrementing the protocol version.

## 9. Not in v1

- Goodbye/stop notification to the device.
- Device-initiated handshake. The start-up announcement (§4.2) tells a host something happened; it does not establish a session.
- Windowed (non-stop-and-wait) delivery.

## 10. Changes from the first draft

The review in Revision 1 changed the following. The earlier text is superseded.

- Width is 1–16 (the fields model), not only 1/2/4/8/16. Mixed-width elements needed no new payload layout.
- The signature lists each element's field widths (`O0:8+1`), not only its total.
- `HELLO` / `HELLO_ACK` carry a session number in `SEQ`. A repeated `HELLO` of the current session no longer resets the device's sequence state.
- The device announces a start with `HELLO_ACK` `SEQ` 0, so the host can stop a run whose device restarted.
- A duplicate of an `OUTPUT` whose handler is still running is ignored, not re-acked.
- `LOG` is not acknowledged.
- A device goes offline after a failed delivery, until the next `HELLO`.
- An intact but unusable data frame is ACKed and dropped. An unknown type is ignored. A NAK with nothing outstanding is ignored.
- The ACK timeout is a protocol constant. The per-connection setting is gone.
