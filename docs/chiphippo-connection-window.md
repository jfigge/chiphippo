# ChipHippo — Connection Window (Log + Trace)

Replaces §9 "Log window" of `chiphippo-serial-integration-spec.md`.

One floating window per named connection showing, in a single stream, both the device's log output **and** the protocol frames going back and forth. Putting them in one timeline means cause and effect are visible in order: a frame arrives, then the log line the device printed in response to it. No mentally interleaving two windows.

---

## 1. Window

- One window **per named connection** (including the built-in Mock). Title is the connection name. All elements on that connection share it.
- Floating, like the log window was specified: independent of the main window, movable, resizable. Position and size remembered per connection (by its id, so a rename keeps them; deleting the connection deletes them).
- Styling follows the app's existing dialogues and floating controls: same background, borders, fonts. Monospace for the stream.
- Contents clear at the start of each Run. After Stop, the window and its contents stay until closed or the next Run, so a failure can be read at leisure.
- The Mock connection's window adds a send panel at the bottom — see `chiphippo-mock-connection.md`.

## 2. Opening it

- **Lamps:** clicking the TX/RX/LG lamp pill opens a small menu listing the connections in use on this desktop; choose one to open its window. If only one connection is in use, clicking opens it directly.
- **Element:** an Output or Inbound element's context menu has *Open connection window*.
- **Integration tab:** each connection row has an *Open window* action.
- The Mock window opens automatically on Run (see mock spec). Real connection windows don't — the user opens them when they want them.

## 3. The stream

Every entry is one line. Three kinds, visually distinct by a fixed-width prefix column and colour:

| Kind | Prefix | Example | Colour |
|---|---|---|---|
| Log text from the device | *(none)* | `bus read ok` | normal text |
| Data frame to the device | `→` | `→ OUTPUT   Output 1  addr=0x3F` | TX lamp colour |
| Data frame from the device | `←` | `← INBOUND  Input 1  data=0x65` | RX lamp colour |
| Protocol | `·` | `· ← ACK seq 12` / `· → HELLO v1 sig 3A91C0F2 session 17` | dim |
| Protocol error | `!` | `! ← NAK — resending seq 12 (attempt 2/3)` | warning colour |

- Arrows are always from **ChipHippo's** point of view: `→` leaves ChipHippo, `←` arrives. (Including in the Mock window, for consistency; the mock is the device.)
- Data frames are decoded with element and field names, one `name=value` per field (protocol §4.2): a bit field as `0`/`1` (`rw=1 ce=0`), a byte or word field in hex (`addr=0x3F`). Hover a data line to see the raw bytes as they went on the wire.
- Log text: a `LOG` frame without a trailing newline stays on the current line; later `LOG` frames continue it. A data or protocol line arriving mid-line starts a new line (the partial log line isn't lost, it just ends there).
- Resends are shown as protocol-error lines, not as repeated data lines, so a retried frame appears once as data.
- Run-level events appear as protocol lines: port opened, handshake result, port closed, and the reason a run was stopped (in the error colour).

## 4. Filter

Three small toggles in the window's footer: **Log**, **Data**, **Protocol**.

- Defaults: Log on, Data on, Protocol off.
- **Protocol** hides ACKs, HELLOs and port open/close lines.
- **Protocol errors are always shown** regardless of the filter — NAKs, retries, timeouts, handshake failures and run-stopping failures. They're rare and they're exactly what you're looking for when something's wrong.
- Filtering is a view: hidden lines are still captured and reappear when the toggle is turned back on.

## 5. Timestamps

A small, discreet **Timestamps** checkbox in the same footer.

- Timestamps are always recorded; the checkbox only shows or hides them, live, including on lines already in the window.
- Format: time since the run started, milliseconds — `+  12.345` — in its own column to the left of the prefix. Elapsed time is what matters for correlating frames with log output; wall-clock time isn't.
- Per window, so one connection can show timestamps while another doesn't. Remembered per connection.

Footer layout, left to right, kept to a single thin row — the checkboxes together on the left, the buttons on the right:

```
[✓] Log  [✓] Data  [ ] Protocol  [ ] Timestamps              Clear  Save…
```

The footer sets the window's minimum width: the page measures its controls with the space between them closed up and tells main (`serial:log:min-width`), again whenever the text size changes, since the font size and the language both move it.

## 6. Other controls

- **Auto-scroll** follows new lines; scrolling up pauses it, scrolling back to the bottom resumes it (standard terminal behaviour, no control needed).
- **Clear** empties the window now.
- **Save…** writes the currently captured stream (all kinds, with timestamps, regardless of filter) to a text file.
- Buffer: the most recent 2,000 lines; older lines drop off the top.
- Text is selectable and copyable.

## 7. Relationship to the lamps

The lamps stay aggregate and honest: TX/RX for data frames, LG for log frames, never for protocol traffic. The window is where the detail lives, including everything the lamps deliberately hide.

## 8. Implementation order

1. Stream model: one ordered event list per connection, fed by the protocol layer (frame sent/received/resent/failed, log text, run events), with timestamps. Unit-testable without UI.
2. Window: rendering, prefixes, colours, decoding with element/pin names.
3. Filter and timestamp toggles, remembered per connection.
4. Opening paths: lamp pill menu, element context menu, Integration tab.
5. Clear, Save, buffer cap.

## 9. Implementation notes

What was built, and where it settles a detail this spec left open:

- **Stream model** — `src/app/serial/connection-stream.js`, one per connection, held by `serial-manager.js`.
  - Entries are facts: kind, event code, numbers, time. Every sentence is the renderer's (`src/web/scripts/model/connection-stream.js`), in the user's language. The protocol's notation (`OUTPUT`, `HELLO_ACK`, `seq`, `sig`, `v1`) is not translated.
  - The link reports what it does through `onTrace` (`link.js`): data frames with their SEQ and exact bytes, HELLO / HELLO_ACK / ACKs, resends with their cause and attempt, damaged frames and whether a NAK went back, failures, refused handshakes and restarts. The manager adds the port opening and closing, and a drop.
  - A protocol line carries its direction inside the text (`· → ACK`, `· ← ACK`), since an ACK goes both ways.
- **Clearing** — each Run clears the stream as it opens the connection, and `t0` (what timestamps count from) is that moment. After Stop the stream stays, and it survives the window being closed and reopened, until the next Run or a Clear.
- **A data or protocol line arriving mid-line** ends the partial log line: it is kept as a line of its own and the new entry follows.
- **The reason a run stopped** is the failure's own error line: a failed delivery, the drop, the restart, a refused handshake. A user's Stop shows as `Port closed`.
- **Remembered per connection** — the window's bounds, filters and Timestamps, in settings (`connectionWindows`, keyed by connection id; the built-in Mock is remembered too). Kept only while the connection exists: deleting one in Settings ▸ Integration deletes its window's state, and a window still open then saves nothing as it closes.
- **Footer** — exactly the row in §5. There is no Copy button: the text is selectable, and Save… writes all of it. Save… suggests `<connection> <date> <time>.txt`.
- **Opening** — every lamp in the pill is clickable. The element menu now opens while the circuit runs (its editing items disabled), since that is when the window is most wanted. Every connection card has **Open window…**.
- **Pushes to a window are batched per tick.** A busy run makes hundreds of entries a second, and the app window hears only of log text, which is all its LG lamp needs.
