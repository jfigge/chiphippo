# ChipHippo — Built-in Mock Connection

A connection that is always present and needs no hardware. It plays the device side of the serial protocol inside ChipHippo and shows what it receives on screen, with controls to send inbound values and log lines back. It lets anyone build and test an integration — and lets us develop and test the whole feature — before a single wire is connected.

Depends on: `src/web/docs/serial-protocol.md` (and Revision 1), `chiphippo-connection-window.md`.

---

## 1. Principles

- **Always there.** Every installation has exactly one connection called **Mock**. It can't be deleted, renamed or duplicated.
- **Same code path as a real board.** The mock replaces the serial port at the **byte-stream** level, not above it. Frames are built, escaped, CRC'd, parsed, acked and retried exactly as they are for a real board. The only thing missing is the UART. If the mock works, the protocol stack works.
- **Looks like everything else.** Its window is the standard connection window with a send panel added — not a separate UI.

---

## 2. Integration tab

- **Mock** appears first in the connection list, with a small "built-in" badge.
- It has no serial settings (no port, baud, parity…), no Apply and no Remove. The settings area shows one line of explanation: *"Simulates a device on this connection. Nothing is sent to hardware."* Its one action is **Open window…**.
- It is never flagged **needs configuration** and always passes Run-time validation.
- It appears in every Output/Inbound element's Connection dropdown, alongside the user's named connections.

## 3. Project files

- Elements on the mock store a reserved connection id (e.g. `mock`), not a copy of connection settings.
- Importing a project that uses the mock needs nothing — it already exists everywhere.
- The name "Mock" is reserved; creating a user connection with that name is refused.

## 4. Behaviour during a run

The mock is a virtual device holding the state a generated sketch would hold.

- **Handshake:** answers `HELLO` (echoing its session) with protocol version 1 and the layout signature of the **current** design — the run hands it over as it opens the port, computed by the same `layoutSignature` the generator uses — so it is always in sync and never needs regenerating. It follows the device's session rules (protocol §5.3): a new session resets its sequence state and is joined only if the `HELLO` matches its version and layout; a repeat of the last session changes nothing.
- **Start-up:** opening its port (Run) is the device resetting: it forgets any old session and announces the start (a `HELLO_ACK` for session 0), as a generated sketch's `begin()` does.
- **OUTPUT received:** decodes it, writes it to the window, and acks it (it has no handler, so it acks immediately). A resend of the last one is re-acked and not written twice.
- **Inbound:** holds a current value for every Inbound element on the mock connection (starting at 0). The user edits values in the send panel and presses **Send**, which sends one `INBOUND` frame for that element — the whole value, exactly as the generated setters + send function would. It is sent stop-and-wait with the protocol's resends; a value never acknowledged takes the mock out of the session — it announces that (a `HELLO_ACK` for session 0), which stops the run — and it stays offline until the next session, as the header's rule is.
- **Log:** a text field in the send panel sends its contents as `LOG` frames, so the log path can be tested too.
- **Lamps:** TX, RX and LG behave exactly as for a real board.
- Port lifecycle: "opens" on Run, "closes" on Stop, like any connection.

## 5. The mock window

The standard connection window (see `chiphippo-connection-window.md`) for the connection named Mock, with a **send panel** docked at the bottom. It opens automatically on Run when any element on the desktop uses the mock (the mock is useless unseen). It opens **in the background**: it doesn't take focus from the circuit, and a window already on screen is left where it is.

The stream above the panel is the connection window's, as for any connection: data lines for every value that crosses, protocol lines, and a warning line for whatever a fault causes. Main learns the design's elements only when a run opens a connection (the run's open request carries each connection's layout: each element's name and fields), so the Input rows appear after the first Run. Before that the panel says to run the circuit.

The send panel has one row per Inbound element on the mock connection:

```
Input 1   data    [0][1][1][0] [0][1][0][1]   0x65          [Send]
          ready   [1]
Status    addr    [0][0][0][1] [0][0][1][0]   0x12A5        [Send]
                  [1][0][1][0] [0][1][0][1]
```

- One line per **field**, in order (an element is a list of bit / byte / word fields, protocol §4.2), under its name:
  - A bit field: one toggle.
  - A byte or word field: bit toggles, MSB first, plus an editable hex field; editing either updates the other. A word stacks its high byte over its low one, so the bits column is always one byte wide.
- The rows share one set of columns, so field names, bits, hex fields and Send buttons line up down the panel. A window too narrow for that puts each element's name on a line of its own, beside its Send, with its fields beneath.
- A caret before each element's name folds its row down to the name and **Send**, as the Faults disclosure folds (Send still sends the value the hidden fields hold). A row stays folded across runs that bring the same element back.
- **Send** sends that element; beside it, "Sent" for a second, or why it failed until the next send. A **Send all** button sends every row in order, on the same line as the Faults disclosure (§6); it shows only when there are two or more rows, since with one it would be a second Send.
- Below them: a single-line log field and a **Log** button, shown only while the window's **Log** filter is on. With it off the field goes and the stream above takes the room.

OUTPUT frames the mock receives, and the INBOUND values it sends, appear in the window's stream decoded with element and field names:

```
→ OUTPUT   Output 1  addr=0x3F
→ OUTPUT   Control   rw=1 ce=0 oe=1
← INBOUND  Input 1   data=0x65
```

Arrows are Chip Hippo's point of view, as the connection window spec fixes for every window: `→` leaves Chip Hippo and `←` arrives, even though the mock is the device. The frame names are the protocol's own and aren't translated.

## 6. Fault injection

Small, collapsed by default under a "Faults" disclosure on the send panel's Send all line; opened, its buttons take the panel's full width beneath it. One-shot buttons, each affecting the next applicable frame only:

- **Drop next ACK** — the mock swallows its ACK for the next OUTPUT. Exercises timeout and resend.
- **Corrupt next frame** — flips a bit in the CRC of the next **ACK or INBOUND** the mock sends. Those are the frames whose damage the protocol recovers from: a damaged INBOUND is NAKed and resent; a damaged ACK is dropped, and Chip Hippo's timeout resends the OUTPUT. A damaged `LOG` would simply vanish, so it is never the target.
- **Ignore handshake** — the mock doesn't answer `HELLO` on the next Run. Exercises the no-response message.
- **Wrong signature** — answers the next `HELLO` with a mismatched signature. Exercises the regenerate message.

These exist because the reliability paths are otherwise almost impossible to test by hand. They're also a good teaching aid. Each button shows armed until its fault has fired, and clicking an armed one disarms it. Faults can be armed while stopped: they outlive a run until they fire.

## 7. Not generated

**Generate** produces no header for the Mock connection. If only the mock is in use, Generate has nothing to do and says so. The Mock never lights the Generate button's staleness dot either: it is built from the design on screen at every run, so it cannot fall out of date.

## 8. Not in this version

- Scripted or replayed responses (a file of timed inbound frames). A natural follow-up — worth keeping in mind so the send panel's "send one frame" is a function a script could call later.
- Echo/loopback modes.
- More than one mock.

## 9. Implementation order

1. Transport abstraction: one interface for "byte stream", with the serial port and the mock as two implementations. Confirm the protocol layer can't tell them apart.
2. Mock device core: handshake, ack, inbound state, send. Unit tests drive the host against the mock with no UI.
3. Reserved connection in the Integration tab, element dropdowns and project storage.
4. Send panel in the connection window.
5. Fault injection.

## 10. Implementation notes

- **Main** — `src/app/serial/mock-device.js` is the device: the protocol's device side in JavaScript, behind the same four-method port a serial port is adapted to. `serial-manager.js` owns the one instance, answers `connection("mock")` with a built-in record no settings entry can shadow, opens it without a port scan, and records its data lines. IPC: `serial:mock:send`, `serial:mock:log` and `serial:mock:fault`, plus the `serial:mock` push to its window.
- **Shared** — `src/web/scripts/model/mock-connection.js` holds the id (`mock`) and the name (`Mock`, reserved and deliberately not translated), read by both processes as `serial-wire.js` is.
- **Renderer** —
  - `serial-connections.js`'s `knownConnections` puts the mock first wherever a connection is chosen.
  - `integration-controller.js` sends its layout with a run and opens its window.
  - `components/mock-panel.js` is the send panel.
  - `serial-log-view.js` draws data lines.
- **Tests** — `app/tests/serial-mock.test.js` drives the real host link against the mock, including every fault. `web/scripts/tests/mock-panel.test.js` covers the panel.
