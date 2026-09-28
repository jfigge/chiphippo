# Serial Protocol

**Chip Hippo serial protocol, version 1.** This page defines the bytes that
travel between Chip Hippo and a board at the other end of a [serial
connection](arduino.md). You never need it to use the Arduino integration —
the header and module Chip Hippo generates speak it for you — but it is the
whole contract. Anything that follows this page (a sketch in another language,
firmware in Rust, a test harness on a pseudo-terminal) can take the board's
place.

## 1. Conventions

- **Host**: Chip Hippo. **Device**: whatever is at the other end of the
  connection, usually an Arduino. **Circuit**: the simulated breadboard.
- **Output** and **Input** are named from the circuit's side: an Output's
  value leaves the circuit for the device; an Input's value comes from the
  device into the circuit.
- A **data frame** is an `OUTPUT` or an `INBOUND` — the only frames delivered
  reliably ([§6](#6-reliable-delivery)). A data frame is **outstanding** from
  its first transmission until it is acknowledged or its delivery fails.
- A **session** is one run's conversation on one connection, from the
  handshake ([§5.4](#54-the-handshake)) until the port closes.
- **MUST**, **MUST NOT**, **SHOULD** and **MAY** state requirements, as in
  RFC 2119. A paragraph marked *Note* explains a rule and adds none.
- Byte values are hexadecimal (`0x7E`). Multi-byte integers are
  **little-endian**. A frame is written as its bytes on the wire, in hex.

## 2. Transport

- A byte stream with no framing of its own: a UART, USB CDC, a
  pseudo-terminal. It MUST deliver bytes in order. It may lose or corrupt
  them; [§3.5](#35-receiving-a-frame) and [§6](#6-reliable-delivery) recover.
- The serial parameters — baud rate, parity, stop bits — come from the
  connection (Settings ▸ Serial I/O). Data bits are always **8**: frames are
  binary, and CRCs, signatures and values use every bit of a byte. The
  default, and the recommendation, is **115200 baud, 8-N-1, no flow control**.
- **No software flow control.** XON (`0x11`) and XOFF (`0x13`) are ordinary
  bytes here — `0x11` is the `INBOUND` type — and only `0x7E` and `0x7D` are
  escaped, so a link that swallows them loses frames. Chip Hippo never opens
  a port with XON/XOFF.
- One host and one device per connection. The device sees only the Outputs and
  Inputs assigned to its connection. A run may use several connections at
  once; each is an independent link with its own session.
- The host writes **nothing but whole frames**: no preamble, no line endings,
  no break. A device MAY rely on this (the MicroPython library does,
  [§13](#13-implementations)).
- The host opens the port when the circuit starts running and closes it when
  it stops. Opening the port resets many boards (a classic Arduino's
  auto-reset), and a bootloader may swallow bytes for a second or two. Many
  others — native-USB boards such as a Leonardo, and most Python boards — do
  **not** reset, and their program carries on from one run into the next. So a
  device learns that a run has begun from the handshake
  ([§5.4](#54-the-handshake)), never from its own start-up.

## 3. Frames

### 3.1 Frame format

```
START  TYPE  SEQ  LEN  PAYLOAD     CRC_LO  CRC_HI
0x7E   1     1    1    LEN bytes   1       1
```

| Field | Size | Meaning |
|---|---|---|
| `START` | 1 | Always `0x7E`, never escaped. Begins a frame. |
| `TYPE` | 1 | The frame type ([§4](#4-frame-types)). |
| `SEQ` | 1 | In `OUTPUT` and `INBOUND`: the frame's sequence number, 1–255 ([§6.1](#61-frame-identity-and-sequence-numbers)); one with SEQ 0 is ignored. In `ACK`: the sequence number acknowledged. In every other frame: 0, which the receiver MUST ignore. |
| `LEN` | 1 | The number of payload bytes, counted **before** escaping: 0–255. |
| `PAYLOAD` | `LEN` | Defined per type ([§4](#4-frame-types)). |
| `CRC` | 2 | CRC-16/CCITT-FALSE ([§3.3](#33-crc)) of the unescaped bytes `TYPE SEQ LEN PAYLOAD`, little-endian. |

A frame's **body** is everything after `START`, from `TYPE` to `CRC_HI`.

### 3.2 Size limits

| Quantity | Bytes |
|---|---|
| Payload | 0–255 |
| Body, unescaped: `TYPE` + `SEQ` + `LEN` + payload + CRC = 1 + 1 + 1 + 255 + 2 | at most 260 |
| Frame on the wire: `START` + every body byte escaped = 1 + 2 × 260 | at most 521 |

- A sender MUST NOT send a payload longer than 255 bytes: `LEN` could not say
  so.
- Every receiver has a **payload limit**, the longest payload it accepts. The
  host's is 255. A device's MAY be smaller, but MUST be at least 7 — the
  longest payload the host sends (`HELLO`).
- A receiver that reads a `LEN` greater than its payload limit MUST treat the
  frame as damaged at once ([§3.5](#35-receiving-a-frame)), without waiting
  for the rest of it.

*Note:* so a receiver never holds more than 3 + its limit + 2 bytes of a frame
— 260 for the host, 12 for a device with the smallest limit. Escaping needs no
buffer of its own: each escape pair is undone as it arrives.

### 3.3 CRC

CRC-16/CCITT-FALSE: polynomial `0x1021`, initial value `0xFFFF`, input and
output not reflected, no final XOR. The check value, for the ASCII bytes
`123456789`, is `0x29B1`.

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

### 3.4 Escaping

Every body byte that is `0x7E` or `0x7D` is sent as two bytes: `0x7D`, then
the byte XOR `0x20`. No other byte is escaped.

| Unescaped | On the wire |
|---|---|
| `0x7E` | `0x7D 0x5E` |
| `0x7D` | `0x7D 0x5D` |

Escaping applies to every body byte — `TYPE`, `SEQ`, `LEN`, the payload and
both CRC bytes — while `LEN` and the CRC are computed over the unescaped
bytes. So `0x7E` on the wire is **always** the start of a frame, which is how
a receiver finds the next frame after noise, a torn frame or a reset.

### 3.5 Receiving a frame

A receiver is either **hunting** (between frames) or **in a frame**.

1. While hunting, it discards every byte but `0x7E`, which begins a frame.
2. In a frame, a `0x7E` abandons the partial frame and begins a new one. A
   frame cut short this way is **torn**, not damaged: it is dropped without a
   word, and the sender's timer ([§6.4](#64-timeout-nak-and-retry)) covers it.
   Any other byte is unescaped ([§3.4](#34-escaping)) and read, in order, as
   `TYPE`, `SEQ`, `LEN`, `LEN` payload bytes and the two CRC bytes.
3. The frame is **damaged**, and the receiver goes back to hunting, when:
   - a `0x7D` is followed by anything but `0x5E` or `0x5D` — or `0x7E`, which
     tears the frame instead (step 2);
   - `LEN` is greater than the receiver's payload limit
     ([§3.2](#32-size-limits)) — known as soon as `LEN` is read; or
   - the CRC does not match — known when the second CRC byte is read.
4. A damaged frame is discarded. If the receiver is in a session (ACTIVE,
   [§5.2](#52-host-states) and [§5.3](#53-device-states)), it MUST then send a
   `NAK` ([§4.4](#44-nak)) at once — **unless** the damaged frame's `TYPE`, as
   received, is `HELLO`, `HELLO_ACK`, `ACK`, `NAK` or `LOG`: frames never
   resent in answer to a NAK. A frame damaged before its `TYPE` arrived is
   NAKed. A receiver not in a session MUST NOT send a `NAK`: before a
   handshake, damage is most likely a bootloader's noise.
5. An intact frame is dispatched by `TYPE`. A frame of a type the receiver
   does not know, or never receives (a device never receives `INBOUND`), MUST
   be ignored.

*Note:* a `LEN` damaged into a larger value is damage at once if it exceeds
the receiver's payload limit (step 3). Otherwise the receiver waits for bytes
that belong to the next frame, whose `0x7E` then tears it (step 2), and the
sender's timer ([§6.4](#64-timeout-nak-and-retry)) covers the loss. A `LEN`
damaged into a smaller value fails the CRC.

## 4. Frame types

| Value | Name | Sent by | `SEQ` | Payload | Delivery |
|---|---|---|---|---|---|
| `0x01` | `HELLO` | host | 0 | 7 bytes ([§4.1](#41-hello-and-hello_ack)) | resent until answered ([§5.4](#54-the-handshake)) |
| `0x02` | `HELLO_ACK` | device | 0 | 7 bytes ([§4.1](#41-hello-and-hello_ack)) | — |
| `0x06` | `ACK` | either | the `SEQ` acknowledged | none ([§4.3](#43-ack)) | — |
| `0x15` | `NAK` | either | 0 | none ([§4.4](#44-nak)) | — |
| `0x10` | `OUTPUT` | host | 1–255 | 4 bytes ([§4.2](#42-output-and-inbound)) | reliable ([§6](#6-reliable-delivery)) |
| `0x11` | `INBOUND` | device | 1–255 | 4 bytes ([§4.2](#42-output-and-inbound)) | reliable ([§6](#6-reliable-delivery)) |
| `0x20` | `LOG` | device | 0 | 1–255 bytes ([§4.5](#45-log)) | not acknowledged |

The values `0x00`, `0x7D`, `0x7E` and `0xFF` are never frame types. Every
other unassigned value is reserved for later versions ([§11](#11-versions)).

### 4.1 HELLO and HELLO_ACK

The payload of both (7 bytes):

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Protocol version: **1**. |
| 1 | 2 | Session ([§5.1](#51-session-numbers)), little-endian. |
| 3 | 4 | Layout signature ([§7.3](#73-the-signature)), little-endian. |

For protocol version 1, the first three payload bytes are the version and the
session. They are all a device needs to answer a `HELLO`, and all the host
needs to judge a `HELLO_ACK`'s version. A later version MAY change the `HELLO`
and `HELLO_ACK` payloads after establishing that it is speaking to a different
version ([§11](#11-versions)).

- The host sends `HELLO` with its version, the session it has chosen and the
  signature of the layout it expects.
- A device MUST answer every intact `HELLO` of at least 3 bytes, for any
  session but 0, with a `HELLO_ACK` carrying the `HELLO`'s session and **its
  own** version and signature — in any state, and even when they differ from
  the `HELLO`'s. Only the host has to explain a mismatch, so only the host
  needs to see one. (A `HELLO` longer than the device's payload limit is not
  intact: it is damaged, [§3.5](#35-receiving-a-frame).)
- A device MUST ignore a `HELLO` shorter than 3 bytes, or for session 0,
  without answering it.
- A `HELLO_ACK` for session 0 is the device's **announcement** that it is in
  no session ([§5.3](#53-device-states)) — sent when its program starts, and
  when it leaves a session after a failed delivery. It answers nothing.
- A host MUST ignore a `HELLO_ACK` shorter than 3 bytes. What it does with any
  other is in [§5.2](#52-host-states) and [§5.4](#54-the-handshake).

### 4.2 OUTPUT and INBOUND

`OUTPUT` carries an Output's value from the circuit to the device; `INBOUND`
carries an Input's value from the device to the circuit. The payload of both
(4 bytes):

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Element index ([§7.1](#71-element-indices)), within this connection and direction. |
| 1 | 1 | Width, **1–16**: the element's pin count. |
| 2 | 2 | Value, little-endian and right-aligned: bit 0 is the element's pin 1. |

- A sender MUST send every value bit at or above the width as 0. A receiver
  MUST ignore them.
- An element is an ordered list of **fields** — bit (1 pin), byte (8) or word
  (16), 16 pins in all at most — packed into the value in order from bit 0. A
  byte followed by a bit puts the byte in bits 0–7 and the bit in bit 8. The
  fields need no wire support of their own: they only say which bits the
  generated code hands to which parameter, which is why the layout signature
  covers them ([§7](#7-element-indices-and-the-layout-signature)).
- An `INBOUND` always carries the **whole** element — there are no partial
  updates. The device keeps its own copy of the state and sends all of it.
- A data frame is **unusable** when it is intact but its `LEN` is not 4, its
  width is not 1–16, its index names no element, its width is not that
  element's, or (at a device) the program has no handler for its Output. An
  unusable frame MUST be acknowledged like any other
  ([§6.2](#62-acknowledgement)) and then discarded: a resend would carry the
  same bytes.

### 4.3 ACK

`SEQ` is the sequence number of the data frame acknowledged. The payload is
empty, and a receiver MUST NOT examine it. When an `ACK` is sent, and what one
means, is [§6.2](#62-acknowledgement).

### 4.4 NAK

`SEQ` is 0 and the payload empty; a receiver MUST NOT examine either.

A `NAK` means: *a frame arrived damaged — if you have a data frame
outstanding, send it again now*. It names no frame, because the damaged
frame's `TYPE` and `SEQ` cannot be trusted; and it needs to name none, because
each side has at most one data frame outstanding ([§6](#6-reliable-delivery)).

- A side receiving a `NAK` with a data frame outstanding MUST retransmit that
  frame at once — the same bytes, the same `SEQ` — and MUST NOT advance its
  sequence counter. The retransmission is one of the frame's sends
  ([§6.4](#64-timeout-nak-and-retry)).
- A side receiving a `NAK` with nothing outstanding MUST ignore it.

A `NAK` is never acknowledged, never resent and never answered with a `NAK`,
so it can cause no more retransmissions than the send limit allows.

### 4.5 LOG

The payload is 1–255 bytes of UTF-8 text, with no terminator. A newline
(`0x0A`) ends a line; text without a trailing newline continues on the same
line when the next `LOG` arrives.

- A sender MUST NOT send an empty `LOG`, and SHOULD split longer text between
  characters, never inside a multi-byte UTF-8 sequence. A receiver MUST ignore
  an empty `LOG`, and SHOULD decode `LOG` text as one stream, so that a
  character split across frames still arrives whole.
- `LOG` is **not acknowledged**: its `SEQ` is 0, and it is never NAKed, resent
  or de-duplicated. Log text changes nothing on the circuit, so losing a line
  to a damaged frame is cheap, and blocking the device on every `print()` is
  not.
- A device MAY send `LOG` in any state, in a session or not. Text printed
  during start-up reaches a host that is listening, and costs nothing when
  none is.
- `LOG` never touches the circuit. The host shows the text in the connection's
  window.

## 5. Sessions

### 5.1 Session numbers

A session number is 16 bits, **1–65535**. **0** is reserved: it is never a
run's session, and a `HELLO_ACK` for session 0 is a device's announcement that
it is in no session.

- The host MUST NOT use the session of its previous handshake on the same
  connection again, and SHOULD make repeating any recent session unlikely.
  Chip Hippo counts upward, across all its connections, wrapping 65535 → 1,
  from a random starting point.
- *Note:* the session is what tells a device that did not reset between runs
  that a new run has begun, and what tells a late copy of this run's `HELLO`
  from the next run's. A host picking, by chance, the very session a device
  still remembers from before would be taken for a late copy: the device would
  keep the old run's sequence numbers and not see a new run begin. Sixteen
  bits make that a 1-in-65535 event on each restart of Chip Hippo.

### 5.2 Host states

| State | Accepts | Ignores | Moves on |
|---|---|---|---|
| **CLOSED** | — | — | Run opens the port → HANDSHAKE. |
| **HANDSHAKE** | `HELLO_ACK` for its session; `LOG` | Every other frame — including the announcement and a `HELLO_ACK` for any other session. Damage is not NAKed. | Its session is established → ACTIVE. A mismatch, no answer in 5 s, or the port lost → FAILED. |
| **ACTIVE** | `INBOUND`, `ACK`, `NAK`, `LOG`; the announcement | Every other `HELLO_ACK` (a late copy of its own, another session's); types it never receives | The announcement, a failed delivery ([§6.4](#64-timeout-nak-and-retry)), or the port lost → FAILED. Stop → CLOSED. |
| **FAILED** | `LOG` | Everything else. Damage is not NAKed. | The run stops and the port closes → CLOSED. |

- The host sends data frames only while ACTIVE: never during the handshake,
  and nothing at all once FAILED.
- **The announcement while ACTIVE** means the device is in no session: it has
  restarted, or it has left this session after one of its own deliveries
  failed ([§5.3](#53-device-states)). Either way it will ignore everything
  until greeted again, which only a new run does, so the host fails what it
  has outstanding and stops the run. Without the announcement, a device that
  had left on an Inputs-only design would simply fall silent.
- **The port lost** — a cable pulled, a board gone — stops the run the same
  way.
- **On FAILED** the host fails every Output waiting to be sent, stops the run
  and tells the user which connection failed and why: no answer, another
  protocol version, another layout, the device leaving the session, a failed
  delivery, or a dropped connection. It still shows log text until the port
  closes — often the device's own account of what happened.
- There is no goodbye frame. Stop closes the port, and a device learns of it
  only when a send of its own fails ([§5.3](#53-device-states)).

### 5.3 Device states

A device remembers the **last session** a `HELLO` named — 0 when its program
starts.

| State | Accepts | Ignores | Moves on |
|---|---|---|---|
| **WAITING** | `HELLO` | Every other frame. Damage is not NAKed, and no data frame is sent. | A `HELLO` for a new session that matches the device → ACTIVE. |
| **ACTIVE** | `HELLO`, `OUTPUT`, `ACK`, `NAK` | Types it never receives | A `HELLO` for a new session → ACTIVE if it matches, else WAITING. A failed delivery → WAITING, announced. |

- **Start.** A program starts WAITING, its last session 0, and MUST send the
  announcement once: a `HELLO_ACK` for session 0 carrying its version and
  signature.
- **A `HELLO` for the last session** — a late copy; the host resends until it
  hears — is answered and changes nothing else, in either state. In particular
  it MUST NOT reset the device's sequence numbers: rewound, its next `INBOUND`
  would look like a duplicate to the host and be dropped without a word.
- **A `HELLO` for a new session** is answered, and starts that session. The
  device MUST discard everything it held for the previous one: its sequence
  numbers ([§6.1](#61-frame-identity-and-sequence-numbers)), an `OUTPUT` held
  for later (dropped), an `OUTPUT` whose handler is running (never
  acknowledged — the run that sent it has gone) and an `INBOUND` waiting for
  its `ACK` (given up at once). It records the new session as its last, and
  becomes ACTIVE only if the `HELLO` **matches**: exactly 7 bytes, version 1,
  and the device's own layout signature. Otherwise it is WAITING.
- **A handler belongs to its OUTPUT's session.** If that session ends while
  the handler runs — a new `HELLO`, or a failed delivery — every send the
  handler makes afterwards MUST fail at once: its Inputs belong to a run that
  has gone, and must not reach the next one.
- **Becoming ACTIVE** is the moment for the device to send every Input its
  starting value: an Input drives nothing until its first `INBOUND`
  ([§8](#8-what-the-values-mean)). The generated libraries run the program's
  `onConnect` function (`on_connect` in Python) here — the only sign a board
  that did not reset gets that a new run has begun.
- **A failed delivery** ([§6.4](#64-timeout-nak-and-retry)) means nobody is
  listening: the device leaves the session. It MUST discard a held `OUTPUT`,
  MUST NOT acknowledge an `OUTPUT` whose handler is running, and MUST then
  send the announcement, so that a host still listening stops rather than wait
  on a device that no longer answers. It returns to WAITING — **offline** —
  and keeps its last session, so only the next run's `HELLO` brings it back.
  While offline, a send fails at once instead of waiting three times 500 ms,
  which keeps a program left running after Stop from crawling: there is no
  goodbye frame, and a board that resets on open does not reset on close. The
  generated libraries report the state as `connected()`.

*Note:* the byte stream keeps two sessions apart without a session number in
every frame. Whatever a device sent in an old session precedes its `HELLO_ACK`
for the new one, and the host accepts nothing but that `HELLO_ACK` until it
arrives; after it, the device sends nothing that belongs to the old session.
The same holds the other way round.

### 5.4 The handshake

1. **Open.** The host opens the port. On many boards this resets the device
   ([§2](#2-transport)).
2. **Greet.** The host chooses a session ([§5.1](#51-session-numbers)) and
   sends `HELLO` at once, then again every **250 ms** — the same session each
   time — until a `HELLO_ACK` for that session arrives, for up to **5 s**.
3. **Judge.** Of a `HELLO_ACK` for its session, the host:
   - refuses the run — **version mismatch** — if its version is not 1,
     whatever its length;
   - ignores it and keeps waiting if it is not exactly 7 bytes;
   - refuses the run — **layout mismatch** — if its signature is not the
     host's;
   - otherwise establishes the session and becomes ACTIVE.
4. **No answer** in 5 s refuses the run.

A run is all-or-nothing: if any of its connections fails to open, or fails its
handshake, every port the run opened is closed again.

*Note:* the device judges the `HELLO` as the host judges the `HELLO_ACK`
([§5.3](#53-device-states)), so after a mismatch neither side is in the
session. A device built for another design never runs `onConnect`, or sends an
Input, into a run that has refused it.

## 6. Reliable delivery

`OUTPUT` and `INBOUND` are delivered **stop-and-wait**. A side has at most one
data frame outstanding, and sends the next only when that one has been
acknowledged or its delivery has failed.

### 6.1 Frame identity and sequence numbers

- A data frame is identified by its **session, direction and `SEQ`**. The two
  directions number their frames independently: the host's `OUTPUT` 7 and the
  device's `INBOUND` 7 are different frames, and an `ACK` 7 acknowledges
  whichever of them its receiver sent.
- Each side has a send counter for the session, starting at 0. A new data
  frame takes the counter's next value, 1–255, wrapping 255 → 1: a session's
  first data frame in each direction is `SEQ` 1. `SEQ` 0 is never a data
  frame's: a receiver MUST ignore an `OUTPUT` or `INBOUND` carrying it —
  neither acknowledge nor process it.
- A retransmission, after a timeout or a `NAK`, is the same frame: the same
  bytes and the same `SEQ`. The counter advances only for a new frame.

### 6.2 Acknowledgement

In a session, a receiver acknowledges every intact data frame — at the time
the table below gives — with an `ACK` carrying its `SEQ`. A frame is
**delivered** when an intact `ACK` with its `SEQ` arrives while it is
outstanding. Any other `ACK` — another `SEQ`, or nothing outstanding — is
**stale**, and MUST be ignored.

| Receiver | Frame | The `ACK` is sent… |
|---|---|---|
| device | `OUTPUT` | **after** the Output's handler returns. |
| host | `INBOUND` | as soon as the frame arrives — even while the circuit is stalled. The value is applied at the next settle boundary ([§8](#8-what-the-values-mean)). |

Acknowledging an `OUTPUT` after its handler means everything the handler sent
— each `INBOUND`, delivered and acknowledged, and each `LOG` — reaches the
host **before** the `ACK`. The host stalls the circuit until every `OUTPUT` is
acknowledged, so it always sees the device's reaction before the circuit moves
on. That is what makes request and response deterministic
([§8](#8-what-the-values-mean)).

- A handler that fails still counts as returned: the Python library catches
  the exception, logs it, and acknowledges.
- A device MUST NOT run a handler from inside another handler, or while it
  waits for an `INBOUND`'s `ACK`. An `OUTPUT` arriving then is held — the host
  sends one at a time, so one slot is enough — run afterwards, and
  acknowledged when it has run.
- Handlers must return promptly: within 500 ms if possible, and certainly
  within the host's three sends, 1.5 s in all
  ([§6.4](#64-timeout-nak-and-retry)). Long work belongs in the program's main
  loop.

### 6.3 Duplicates

Each receiver remembers the `SEQ` of the last data frame it acknowledged in
the session — none, when the session begins.

- A data frame carrying that `SEQ` is a **duplicate**: its `ACK` was lost and
  the sender has resent it. The receiver MUST acknowledge it again and MUST
  NOT process it again. Without this, a lost `ACK` would call an Output's
  handler twice.
- **Exception:** a duplicate of the `OUTPUT` whose handler is still running,
  or which the device is holding to run next, MUST be ignored — not
  acknowledged. Its `ACK` follows when the handler returns. This happens
  whenever a handler sends an `INBOUND`: the device reads the port while it
  waits for that `ACK`, and the host's timer can resend the `OUTPUT` in the
  meantime. Acknowledging it then would let the circuit run on before the
  handler's `INBOUND` had been applied.

*Note:* because a sender never has two frames outstanding, a receiver only
ever sees the frame it last acknowledged again, or the next one. One
remembered `SEQ` is enough to tell them apart.

### 6.4 Timeout, NAK and retry

- **The timer.** Each transmission of a data frame — the first, or any
  retransmission — starts an ACK timer of **500 ms** when the frame has been
  written to the port.
- **Retransmit** the outstanding frame when its timer expires, or at once when
  a `NAK` arrives ([§4.4](#44-nak)). The retransmission restarts the timer.
- **The limit.** A frame is sent at most **3 times** in all, the first
  transmission included, whatever caused the resends. If the timer of the
  third transmission expires, or a `NAK` arrives after it, the delivery has
  **failed**:
  - the **host** stops the run (FAILED, [§5.2](#52-host-states)). Whatever was
    queued behind the frame fails with it.
  - the **device** drops the frame, reports the failure to its caller (the
    generated `send()` returns false), and leaves the session, saying so with
    the announcement ([§5.3](#53-device-states)) — which stops a host still
    listening.
- `ACK`s, `NAK`s and retransmissions are the protocol's own traffic, not the
  circuit's: they never light Chip Hippo's activity lamps. The connection
  window's protocol view shows them, a resend as a warning.

### 6.5 Ordering

Each direction's data frames are processed in the order they were sent, since
each waits for the one before. The two directions interleave freely. A side
waiting for an `ACK` MUST keep receiving meanwhile: it acknowledges the other
side's data frames, answers a `HELLO` and acts on a `NAK` as usual. `LOG`
frames sit in the byte stream in the order they were written, among the data
frames around them.

## 7. Element indices and the layout signature

Names never travel over the wire. Elements are identified by index, and the
layout signature makes sure both ends number them alike.

### 7.1 Element indices

- Indices are assigned **per connection, per direction**, from 0: Outputs 0 to
  n−1, Inputs 0 to m−1.
- The generated code, the element index in every data frame, and the layout
  string ([§7.2](#72-the-layout-string)) all use this one numbering.
- *Note:* Chip Hippo orders each direction by the number in the element's
  internal id (`out2` before `out10`). That number only ever counts up, so an
  element's index changes only when one before it, on the same connection and
  in the same direction, is added or removed.

### 7.2 The layout string

A connection's layout is written as an ASCII string, with no byte-order mark,
no NUL terminator, no newline and no spaces:

```
layout  = [ element *( "," element ) ]
element = kind index ":" width *( "+" width )
kind    = "O" / "I"
index   = "0" / ( %x31-39 *DIGIT )   ; decimal, no leading zeros
width   = "1" / "8" / "16"           ; one field: bit, byte or word
```

- Every Output comes first, in index order, then every Input, in index order.
- An element lists its fields' widths in field order, joined by `+`; they add
  up to the element's width, at most 16.
- A connection with no elements has the empty string as its layout.

For example, Outputs of fields `[byte, bit]` and `[bit]`, and an Input of one
word, are `O0:8+1,O1:1,I0:16`.

### 7.3 The signature

The **layout signature** is the CRC-32 (IEEE 802.3, also known as
CRC-32/ISO-HDLC) of the layout string's bytes: polynomial `0x04C11DB7`,
reflected (`0xEDB88320`), initial value `0xFFFFFFFF`, final XOR `0xFFFFFFFF`.
It travels little-endian. The check value, for the ASCII bytes `123456789`, is
`0xCBF43926`; the empty layout's signature is `0x00000000`.

| Layout string | Signature |
|---|---|
| `O0:8,O1:1,I0:16` | `0xF8ACB506` |
| `O0:8+1,O1:1,I0:16` | `0x7EF66B41` |
| `O0:1,I0:1+1+1+1` | `0x0EC32022` |
| `I0:16` | `0x43F1C7E9` |

The signature covers what decides which bits reach which parameter: the
elements, their order, and each one's field boundaries, not only its total
width. A `[bit, byte]` element reordered to `[byte, bit]` keeps its width of 9
but would hand every value to the wrong parameters, so it must be refused.

Everything else is the circuit's business and changes nothing on the wire:
names, colours, descriptions, where the tags are planted, and each element's
trigger. Renaming an element or a field changes the generated code's **design
hash** — a second fingerprint, written into the generated file as a comment
and compared by the Generate button — so the code reads as out of date, but a
run still works until it is regenerated. The design hash never travels on the
wire.

## 8. What the values mean

The protocol moves values; this is what Chip Hippo does with them, which a
device has to know to answer sensibly.

- **Pins and bits.** Pin *k* of an element is bit *k*−1 of its value. On the
  host, a pin whose tag isn't planted on the board, or whose net is floating
  or unknown, reads as **0**.
- **Chip Hippo looks only at settle boundaries** — the moments the circuit has
  stopped changing. A glitch inside one settle is never sent anywhere, and
  nothing from the device lands on the board halfway through a ripple.
- **When an `OUTPUT` is sent.** An Output with an **edge** trigger (rising,
  falling or either) is sent when its trigger line's settled level has made
  that transition since the previous boundary (its *Trigger starts* setting
  stands in for "previous" at the first). An Output on **Auto** has no trigger
  line: it is sent whenever the value its pins settle to differs from the last
  value it sent, **and always at the first boundary of a run**, so the device
  learns where the circuit starts.
- **The stall.** Once a boundary has sent its `OUTPUT`s, the circuit stands
  still — no clock edges, no settles — until every one is acknowledged, that
  is, until every handler has returned ([§6.2](#62-acknowledgement)).
- **When an `INBOUND` is applied.** A received value is held, and a newer one
  for the same Input replaces one not yet applied. An Input on **Auto** is
  *live*: its value goes on the board at the next boundary — at once, if the
  circuit is idle. An Input with an edge trigger releases its value only when
  its trigger line makes that transition, the way a latch loads on its clock.
  All the values eligible at a boundary are applied together, and the circuit
  settles again. A value that repeats what the Input already drives changes
  nothing.
- **Request and response.** An `INBOUND` that arrives while the circuit is
  stalled on an `OUTPUT` still counts for that boundary. So a handler that
  answers with an Input lands its answer before the circuit moves on.
- **Inputs start undriven.** An Input drives its pins at the strength of a
  chip output — two drivers disagreeing on one net are reported as a conflict
  — but drives **nothing at all** until its first `INBOUND` of the run. Send
  every Input its starting value when a session begins
  ([§5.3](#53-device-states)).

## 9. Invariants

The rules above, reduced to what must always hold:

1. `SEQ` is non-zero only in data frames and `ACK`s. `HELLO`, `HELLO_ACK`,
   `NAK` and `LOG` carry 0; a session travels in the `HELLO` payload; a data
   frame with `SEQ` 0 is ignored.
2. Each side has at most one data frame outstanding.
3. A retransmission is the same frame — the same bytes, the same `SEQ` — and a
   data frame is sent at most 3 times.
4. A data frame is identified by session, direction and `SEQ`. The two
   directions' counters are independent.
5. An `ACK` carries the `SEQ` of the frame it acknowledges, and only an `ACK`
   with the outstanding frame's `SEQ` delivers it.
6. A receiver processes each data frame at most once: a duplicate is
   acknowledged again, never processed again.
7. A device acknowledges an `OUTPUT` only after its handler has returned, and
   never one received in a session it has since left.
8. `HELLO`, `HELLO_ACK`, `ACK`, `NAK` and `LOG` consume no sequence numbers
   and are never acknowledged.
9. A `NAK` names no frame, and causes no more retransmissions than the send
   limit allows.
10. `LOG` is never acknowledged, resent or de-duplicated, and may be sent
    outside a session.
11. Session 0 is never a run's: a `HELLO_ACK` for session 0 is the device's
    announcement that it is in no session.
12. Only a `HELLO` for a new session resets a device's session state.
13. Neither side enters a session unless the versions and the layout
    signatures match.
14. A failed delivery ends the session on both sides: the host stops the run;
    the device leaves it and announces that, which stops a host still
    listening, and stays offline until the next session.
15. A device sends nothing that belongs to a session it has left — not an
    `ACK`, and not an `INBOUND` from a handler of that session.

## 10. Constants

| Constant | Value | Meaning |
|---|---|---|
| `PROTOCOL_VERSION` | 1 | This protocol's version. |
| `START` | `0x7E` | Begins a frame. |
| `ESC` | `0x7D` | Escapes the next byte. |
| `ESC_XOR` | `0x20` | XORed into an escaped byte. |
| `HEADER_BYTES` | 3 | `TYPE`, `SEQ`, `LEN`. |
| `CRC_BYTES` | 2 | The CRC. |
| `MAX_PAYLOAD` | 255 | The longest payload. |
| `MAX_FRAME_BODY` | 260 | The longest body, unescaped. |
| `MAX_WIRE_FRAME` | 521 | The longest frame on the wire. |
| `DATA_PAYLOAD` | 4 | An `OUTPUT` or `INBOUND` payload. |
| `HELLO_PAYLOAD` | 7 | A `HELLO` or `HELLO_ACK` payload. |
| `HELLO_PREFIX` | 3 | The shortest `HELLO` a device answers, and `HELLO_ACK` a host reads: version, session. |
| `MAX_HOST_PAYLOAD` | 7 | The longest payload the host sends: a device's smallest payload limit. |
| `ANNOUNCE_SESSION` | 0 | The session of the announcement: the device is in no session. |
| `MAX_SESSION` | 65535 | Sessions are 1 to this. |
| `MAX_SEQ` | 255 | Data `SEQ`s are 1 to this. |
| `MAX_WIDTH` | 16 | The widest element, in pins. |
| `CRC16_POLY` | `0x1021` | The frame CRC's polynomial. |
| `CRC16_INIT` | `0xFFFF` | The frame CRC's initial value. |
| `HELLO_INTERVAL_MS` | 250 | How often the host sends `HELLO` while it waits. |
| `HELLO_WINDOW_MS` | 5000 | How long the host waits for `HELLO_ACK`. |
| `ACK_TIMEOUT_MS` | 500 | The ACK timer. |
| `MAX_SENDS` | 3 | The most times a data frame is sent. |

These are protocol values, not settings: no connection overrides them. The
names are those of Chip Hippo's source ([§13](#13-implementations)).

## 11. Versions

- This page is version **1**. A host and a device talk only when their
  versions are equal.
- In version 1, the version is the first byte of the `HELLO` and `HELLO_ACK`
  payloads, and the session the next two ([§4.1](#41-hello-and-hello_ack)). A
  version-1 device answers a `HELLO` of any version with its own version, and
  joins only a version-1 `HELLO` ([§5.3](#53-device-states)). A version-1 host
  refuses a `HELLO_ACK` of any other version as a version mismatch, whatever
  its length ([§5.4](#54-the-handshake)).
- Any change to a frame's layout, the frame types, the CRC or the meaning of a
  field is a new version. A later version MAY change the `HELLO` and
  `HELLO_ACK` payloads after establishing that it is speaking to a different
  version.
- *Note:* a version-1 side answers or refuses another version, rather than
  falling silent, only when it can read the frame: framed as in
  [§3](#3-frames), the version first and the session next — and, sent to a
  version-1 device, no longer than 7 bytes ([§3.2](#32-size-limits)).
- Not part of version 1: a goodbye frame, a device-initiated handshake (the
  announcement tells the host something happened; it establishes nothing),
  windowed delivery, flow control and keep-alives.

## 12. Worked examples

These examples use the layout `O0:8,O1:1,I0:16` — signature `0xF8ACB506`, sent
as `06 B5 AC F8` — and session `0x1234`, sent as `34 12`. Each frame is
written as it is on the wire. They are test vectors: Chip Hippo's test suite
checks every frame on this page against its encoder.

### 12.1 The handshake

The host's `HELLO`: version 1, session `0x1234`, its signature (CRC `0x9C63`).

```
7E  01 00 07  01 34 12 06 B5 AC F8  63 9C
```

The device's answer, `HELLO_ACK`: the same session, with its own version and
signature (CRC `0x2DAC`).

```
7E  02 00 07  01 34 12 06 B5 AC F8  AC 2D
```

The same device announcing its start-up: a `HELLO_ACK` for session 0 (CRC
`0x4458`).

```
7E  02 00 07  01 00 00 06 B5 AC F8  58 44
```

Escaping reaches the session as well. Session `0x7D7E` is sent as `7E 7D`,
both of them markers, so a `HELLO` for it is (CRC `0x0C54`):

```
7E  01 00 07  01 7D 5E 7D 5D 06 B5 AC F8  54 0C
```

### 12.2 An OUTPUT and its ACK

The host sends `OUTPUT` `SEQ` 1: element 0, width 8, value `0x7E` —
deliberately a value that needs escaping.

- Unescaped: `TYPE=10 SEQ=01 LEN=04 PAYLOAD=00 08 7E 00`.
- CRC-16 of `10 01 04 00 08 7E 00` is `0x88E4`, sent as `E4 88`.

```
7E  10 01 04  00 08 7D 5E 00  E4 88
```

The device calls the handler for Output 0 with `0x7E`. The handler returns,
and the device sends `ACK` 1 (CRC `0x4D0D`):

```
7E  06 01 00  0D 4D
```

Escaping reaches the CRC too. `ACK` 16 has the CRC `0x7D4F`, and `ACK` 17
`0x4E7E`:

```
7E  06 10 00  4F 7D 5D
```

```
7E  06 11 00  7D 5E 4E
```

### 12.3 An INBOUND, a LOG and a NAK

The device sends `INBOUND` `SEQ` 1 — its own first data frame, since each
direction counts separately ([§6.1](#61-frame-identity-and-sequence-numbers)):
element 0, width 16, value `0xBEEF` (CRC `0xB788`).

```
7E  11 01 04  00 10 EF BE  88 B7
```

The host acknowledges it with the same bytes as the `ACK` in
[§12.2](#122-an-output-and-its-ack): `7E 06 01 00 0D 4D`. It is the device's
frame this `ACK` answers, because the device receives it.

The device logs `ok` and a newline, unacknowledged (CRC `0x6104`):

```
7E  20 00 03  6F 6B 0A  04 61
```

A `NAK`, from either side (CRC `0x640F`):

```
7E  15 00 00  0F 64
```

### 12.4 A retransmission

The host sends Output 1 (width 1) the value 1, as `SEQ` 2. The frame is
damaged on the way, and the device's `ACK` is later lost:

| Step | Direction | What happens | On the wire |
|---|---|---|---|
| 1 | host → device | `OUTPUT` `SEQ` 2, first send. It arrives damaged. | `7E 10 02 04 01 01 01 00 46 B6` |
| 2 | device → host | The damage is NAKed. | `7E 15 00 00 0F 64` |
| 3 | host → device | Second send, at once: the same bytes. | `7E 10 02 04 01 01 01 00 46 B6` |
| 4 | device → host | The handler runs; `ACK` 2. It is lost. | `7E 06 02 00 5E 18` |
| 5 | host → device | 500 ms after step 3, the third and last send. | `7E 10 02 04 01 01 01 00 46 B6` |
| 6 | device → host | A duplicate of the last frame acknowledged: `ACK` 2 again, the handler not run again. | `7E 06 02 00 5E 18` |

Had step 6 been lost too, the host would have stopped the run 500 ms after
step 5. At no point does the `SEQ` change, and the handler runs once.

## 13. Implementations

Four implementations speak this page, and each is tested against the others.

- **The host** — Chip Hippo's main process: the bytes in
  `src/app/serial/protocol.js`, the session and reliability rules in
  `src/app/serial/link.js`. Every number on this page lives in one module,
  `src/web/scripts/model/serial-wire.js` — the names in [§10](#10-constants)
  are its exports — which the host reads and the code generators write the
  devices' constants from, so the two ends cannot drift. The element order and
  the layout string are one function each (`elementsFor` and `layoutString` in
  `src/web/scripts/model/integration.js`), called by the generators and by the
  run-time handshake alike.
- **The C++ header** (`ChipHippo.h`, from Generate, for a connection whose
  Language is C++) — the device side for Arduino boards. Its payload limit is
  the smallest allowed, so it buffers 12 bytes of a frame; it computes the CRC
  a bit at a time (no table, so no flash spent on one); it decides whether a
  `HELLO` matches by comparing it, byte for byte, with the `HELLO_ACK` it
  answers with; and it sends log text in frames of up to 60 bytes — at every
  newline, at every `poll()`, and before every `INBOUND` and every `ACK` of an
  `OUTPUT`.
- **The Python module** (`chiphippo.py`, for a Language of Python) — the
  header said again, line for line, for MicroPython and CircuitPython. It
  picks its port by platform. On **MicroPython** it uses the REPL's own USB
  port, with Ctrl-C switched off inside a frame (where `0x03` is data); since
  the host never sends a byte outside a frame ([§2](#2-transport)), a lone
  `0x03` between frames can only be a tool such as Thonny or `mpremote`, and
  it stops the program as Ctrl-C would. (The module reads a damaged frame to
  the end its `LEN` gives it, so a `0x03` in the rest of one is still that
  frame's; and for a moment after line damage — a frame whose `START` was
  lost, or the rest of one whose `LEN` was misread — a stray `0x03` is taken
  as more of it, not as Ctrl-C. Its example `main.py` turns Ctrl-C off before
  it imports the module, so a board that starts during a handshake is not
  stopped by a `HELLO`.) On a board whose USB is a separate serial chip (a classic ESP32
  DevKit) that port always runs at 115200 baud, 8N1, so the connection must
  too. On **CircuitPython** it uses the second USB serial port, which its
  `boot.py` turns on. Any stream can be handed to `begin()` instead.
- **The Mock** — Chip Hippo's built-in pretend board
  (`src/app/serial/mock-device.js`): the device side in JavaScript, behind the
  same port interface as a USB cable, so the host cannot tell the two apart.
  Its one-shot faults — drop the next `ACK`, corrupt the next frame, ignore a
  handshake, answer with the wrong signature — exercise the recovery rules
  (see [The Mock connection](arduino.md#the-mock-connection)).

Chip Hippo's test suite checks this page's frames, constants and signatures
against the code, drives each device — a generated header compiled with the
host's C++ compiler, the Python module under Python and MicroPython, and the
Mock — with the real host link, and feeds all of them the same bytes to show
they answer alike.
