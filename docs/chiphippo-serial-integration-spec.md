# ChipHippo — Arduino Serial Integration

Design spec for connecting a running ChipHippo simulation to one or more real Arduino boards over serial. The board can push values out to an Arduino, receive values back, and show the Arduino's log output.

This document records decisions already made. Every item once marked **Open** has since been settled; each section says where. The bytes on the wire are defined by `chiphippo-serial-protocol.md` (§6).

---

## 1. Goals and non-goals

**Goals**
- Let a simulated circuit drive real hardware and be driven by it, at runtime.
- Keep it simple to use: drop an element, name its pins, press Generate, include a header in a sketch.
- Keep the simulator's behaviour honest and deterministic: external data only enters or leaves the board at settle boundaries.

**Non-goals (explicitly out of scope for now)**
- Automatic runaway feedback-loop detection. The TX/RX/LG lamps are the diagnostic; revisit after testing.
- Any user-facing "bidirectional confirmation" option. Acknowledgement exists, but only as an invisible protocol layer (§6).
- Suggesting alternative serial ports when a configured one is missing.
- Merging the new inbound element with the existing Signals. Signals stay manual and human-driven.

---

## 2. Existing concepts to reuse

- **Signals** — input markers on the desktop background with a numbered, coloured flag dragged onto the breadboard. Properties: name, description, colour, type (momentary/toggle), default value (low/high). The new elements mirror this visual pattern.
- **Standard properties dialogue** — name, description, a dividing line, then element-specific fields beneath. Every new properties dialogue in this spec builds on it so the app stays consistent. If fields overflow, the dialogue scrolls.
- **Wires and buses** — buses are up to 16 wires wide.
- **Settle** — the simulator already propagates the board to a quiescent state. This spec relies on a clear internal "board has settled" notification (§5).
- **Conflict detection** — the simulator already detects shorts and two outputs driving one line. Not reused for integration, but don't break it.
- **Floating zoom control** — bottom-right of the desktop. The new lamps sit beside it (§8).

---

## 3. New elements

Two new element types, both separate objects from Signals and from each other.

### 3.1 Output (board → Arduino)

- Dropped on the desktop background, like a Signal. Default names **Output 1, Output 2, …**; renameable.
- **Width** chosen at drop time: **1, 2, 4, 8 or 16** (matches bus sizes). This is a preset: the element is really an ordered list of **fields**, each a bit, a byte or a word, 16 pins at most. The Properties card can mix them, e.g. one byte of data plus three strobes as one element, one frame and one generated call (see §3.2).
- One coloured, numbered tag per pin, matching the element's colour, dragged onto breadboard holes/pins exactly like Signal flags. The number on each tag identifies which pin it is.
- A separate **trigger tag** that the user attaches to a line on the board.
- Properties (on the standard properties dialogue, below the divider):
  - Colour
  - Connection — dropdown of named connections (§7)
  - Trigger condition — **rising edge / falling edge / either**
  - Trigger initial state — **low / high** (default low). Used as the "previous" value on the first settle.
  - Fields — each one's type (bit / byte / word) and name. These become the parameters of the generated Arduino function, in order.

### 3.2 Inbound (Arduino → board)

- Dropped the same way. Default names **Input 1, Input 2, …** (settled: the element is called an *Input* in the UI; the protocol's frame type keeps the name `INBOUND`).
- Width choices and per-pin tags as for Output.
- **Optional** trigger tag:
  - **Unattached → live mode.** A received value is held until the current settle completes, then injected.
  - **Attached → triggered mode.** A received value is held, and only released onto the board when the trigger line shows the configured edge (rising / falling / either) between settles.
- Properties: as Output — colour, connection, trigger condition, trigger initial state, fields.
- Inbound only has effect while the simulation is running. Nothing is applied to the board while stopped.

**Settled:** one model for both kinds. An element carries an ordered list of **fields** (bit = 1 pin, byte = 8, word = 16; 16 pins at most), packed into one value from bit 0 in order. So an element is any width from 1 to 16, sent as one frame and applied atomically. On the Output side it is one generated function with one parameter per field; on the Input side, one setter per field plus one `send()`.

---

## 4. Payload encoding

- The frame carries the width (1–16), so both sides know which bits are real. The exact payload is `chiphippo-serial-protocol.md` §3.2.
- Values are **right-aligned**: bit 0 is pin 1.
- Arduino-side types follow the **fields** (§3.2), in order:
  - **Bit** → `bool`.
  - **Byte** → `uint8_t`.
  - **Word** → `uint16_t`.
- The drop presets are field lists: widths 1, 2 and 4 are that many bits, 8 is one byte, 16 is one word.

---

## 5. Simulation timing

### 5.1 Output firing
1. Board settles electrically.
2. Each Output compares its trigger line's value now against its value at the previous settle (or the initial state on the first settle).
3. If the transition matches the configured condition, the payload is sampled and sent.
4. If the trigger didn't change, nothing is sent. Glitches within a single settle are never seen — this is intended.

### 5.2 Integration settle phase (stall)
After the electrical settle, any outbound frames are sent and the simulation **stalls** until every one is acknowledged (§6). Only then does the board advance. Think of it as a second, integration-level settle.

### 5.3 Inbound application
1. Received inbound frames are buffered; nothing is applied mid-propagation.
2. After the current settle completes, determine which buffered values are eligible (all live-mode ones; triggered ones whose edge condition is met).
3. Apply **all** eligible values atomically.
4. Run a single new settle pass.

---

## 6. Wire protocol

Defined by **`chiphippo-serial-protocol.md`** (protocol v1), which is normative: framing, escaping, CRC, frame types, the HELLO / HELLO_ACK handshake with its protocol version and layout signature, sequence numbers, acknowledgement, NAK and retry, and logging. Where this document and that one disagree about the wire, that one wins.

What this spec still decides about it:
- Every data frame is acknowledged, and a bad one is NAKed at once. Three failed sends of an Output **stop the run** with a message naming the connection, as a dropped port does (§7.4).
- ACK/NAK/retry traffic never lights the lamps (§8).
- The sketch logs with `ChipHippo.print()` / `ChipHippo.println()` instead of `Serial.print`, since Chip Hippo owns the port during a run. Log frames don't touch the board and never trigger a settle.

---

## 7. Connections and settings

### 7.1 Integration tab
- New **Integration** tab in the Settings dialogue (alongside Appearance, Data Sheets, AI, About).
- Holds a list of **named connections**. Each has serial settings modelled on CoolTerm:
  - Port (with **Re-scan** button), baud rate
  - Data bits, parity, stop bits, flow control (defaults 8 / None / 1 / none — keep these available for non-Nano boards, ideally in an advanced section)
- Each connection has its own **Apply** button so several can be confirmed in one visit without reopening the dialogue.

### 7.2 Storage
- Connections referenced by a project are stored **in the project file**.
- On opening a project, any referenced connection missing from the application's settings is added with defaults and flagged **needs configuration**.
- Pressing **Apply** on a connection clears its flag. On Apply, do a live port scan; if the selected port isn't present, warn, but let the user override (they may plug it in later).

### 7.3 Validation before running
- When Run is pressed, check every connection used by the desktop's elements. If any is flagged or its port is unavailable, show a "settings need to be verified" message and don't start.
- In the Integration tab, the problem connection shows red with simple field-level marking (red field or asterisk).
- The same path covers an imported project and a board that's switched off or unplugged on the same machine.
- Message wording: the specified port is unavailable. **Don't** suggest other ports.

### 7.4 Connection lifecycle
- Ports **open on Run and close on Stop**, so the user can reflash the Arduino between runs.
- If a port drops mid-run, **stop the simulation** and report that the serial connection to the named board was dropped. No pause/resume.

---

## 8. Activity lamps

- Three lamps: **TX** (board → Arduino data), **RX** (Arduino → board data), **LG** (log frames).
- Same pill shape as the floating zoom control, fixed immediately to its left. Not movable or hideable.
- Visible **only during a run**, and only when the desktop has at least one Output or Inbound element.
- Aggregated across all elements and connections — any Output flashes TX, any Inbound flashes RX, any log flashes LG.
- Protocol-only traffic (ACK, NAK, retries) never lights a lamp. The lamps must stay an honest indicator: with the clock paused, a flickering TX/RX means a feedback loop.

---

## 9. Log window

- One floating window **per named connection**, openable independently of the main window.
- Title is the connection name. All elements on the same connection share it.
- Settled by `chiphippo-connection-window.md`, which replaces this section: a **connection window** that holds the log and the protocol trace in one stream. It opens from the lamps, an element's context menu and the Integration tab, and is cleared at the start of each Run.

---

## 10. Code generation

### 10.1 Generate button
- New **Generate** button in the main toolbar. Generation is explicit — never automatic.
- Settled: **one header per connection per desktop**. Each Arduino sees only its own connection's elements, and only the desktop on screen runs.

### 10.2 Generated header
ChipHippo generates a **header file only**. The user's own sketch includes it and implements the bodies, so regenerating never overwrites their code.

The header contains:
- The device side of the protocol: framing, CRC, the handshake, ACK/NAK and retry handling. Its constants are written from the same module the host reads, so the two cannot drift.
- Setup and poll entry points the sketch calls from `setup()` / `loop()`
- **Outputs:** a declaration per Output element, named after the element, one parameter per field named after it (typed per §4). The user implements these.
- **Inputs:** a generated setter per field plus a send function per Input element. The Arduino keeps its own state; the user sets what changed, then sends the whole group.
- **Logging:** `ChipHippo.print()` / `println()`.
- The **layout signature** the handshake checks, and a comment containing the **design hash**.

Element and pin names must be turned into valid C identifiers; warn on collisions.

### 10.3 Staleness
- Hash the integration-relevant design: elements, fields, names, the connection's serial settings.
- Store the hash in the header comment **and** in the project file.
- When the current design's hash differs from the stored one, show an out-of-sync indicator (e.g. a dot on the Generate button).
- If the user removes an element, their implementation of it will no longer match the header — that's expected, and the staleness indicator is the warning.
- The design hash does not travel on the wire. What a run checks is the narrower **layout signature** (protocol §6): a rename leaves it alone, so a renamed design still runs until regenerated, while anything that would misroute data refuses the run.

---

## 11. Suggested implementation order

1. Settle-boundary notification in the simulator, with tests.
2. Output element: drop, width, pin tags, trigger tag, properties dialogue.
3. Inbound element: same, plus live/triggered buffering and atomic apply.
4. Integration tab, named connections, project storage, import flagging, Apply, Run-time validation.
5. Serial transport: open on Run, close on Stop, drop detection.
6. Protocol: framing, checksum, ACK/NAK/retry, stall.
7. Code generation, hash, staleness indicator.
8. Lamps.
9. Log window.

All **Open** items have been settled (§3.2, §9, §10.1 here; §6 by `chiphippo-serial-protocol.md`).
