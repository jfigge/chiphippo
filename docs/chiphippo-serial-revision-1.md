# Serial Integration — Revision 1: Protocol

For Claude Code. Read alongside `chiphippo-serial-integration-spec.md` (the original spec) and `chiphippo-serial-protocol.md` (new).

## Context

The serial integration has **not been released**. Nobody has a sketch in the field built against it. So there is no backward-compatibility obligation of any kind: no migration, no compatibility shims, no "legacy" frame handling, no feature flags. Change whatever needs changing and delete what it replaces.

## What this revision does

1. **Makes `chiphippo-serial-protocol.md` the normative wire protocol.** It resolves the Open items in the original spec's §6.1 (start byte, escaping, checksum, LENGTH size) and §6.2 (timeout, whether the host acks inbound and log frames). Where the original spec and the protocol document disagree about bytes on the wire, the protocol document wins.
2. **Adds a protocol version** — `1` — exchanged in a `HELLO` / `HELLO_ACK` handshake at the start of every run.
3. **Adds a layout signature** to the handshake, so a sketch built for a different design is rejected with a clear message instead of misrouting data.
4. **Adds a sequence number** to every frame, so a resend after a lost ACK is recognised as a duplicate and never runs a user's handler twice.
5. **Defines when the device acks an OUTPUT** — after the user's handler returns — which is what guarantees the integration settle phase sees the device's reaction.

## Instructions

1. **Before changing anything**, compare what's already implemented (host framing, generated header, tests) against `chiphippo-serial-protocol.md` and give me a short list of differences. If you think any part of the protocol document is wrong, say so and why — don't silently deviate.
2. Once agreed, bring the host implementation and the generated C++ header into line with the protocol document. Replace, don't layer.
3. Put the protocol constants (version, byte values, timeouts, retry count) in **one** place on the host side, and have the code generator emit them into the header from there. The protocol version must never be typed twice.
4. The layout signature and element-index assignment (protocol §6) must be computed by one shared function used both by the run-time handshake and by the generator.
5. Update the original spec: replace the body of §6 with a pointer to `chiphippo-serial-protocol.md`, remove the resolved Open items from §6.1/§6.2 and from §11's closing line.
6. Tests, at minimum:
   - CRC-16 check value (`"123456789"` → `0x29B1`) and CRC-32 check value.
   - Escaping round-trip for payloads containing `0x7E` and `0x7D`, including in the CRC bytes.
   - Resync: garbage and a truncated frame followed by a good frame.
   - Duplicate `SEQ` is re-acked but not re-processed.
   - NAK → resend; three failures → run stops with the named-connection message.
   - Handshake: timeout, version mismatch, signature mismatch — each with its message.
   - Signature unaffected by renames; changed by adding/removing an element or changing a width.
7. Any existing test fixtures or sample headers built on the old framing: regenerate or delete them.

## Why this ordering matters

The built-in mock connection (`chiphippo-mock-connection.md`) implements the device side of this protocol in-process, and the connection window (`chiphippo-connection-window.md`) decodes it. Do this revision first so both are built on the final wire format.

## Going forward

After release, any change to the frame layout, frame types, CRC, or the meaning of a field increments the protocol version. Until release, keep it at 1 and change freely.

## Outcome (2026-09-25)

Done. The review of this revision found problems in the protocol document; by agreement, the review's recommendations superseded the document, and `chiphippo-serial-protocol.md` was rewritten to match. Its §10 lists what changed: the fields width model, field widths in the signature, the session number in HELLO / HELLO_ACK, the device's start-up announcement, the mid-handler duplicate rule, unacknowledged LOG, the device's offline rule, and the ACK timeout as a protocol constant with no per-connection setting. The constants live in `src/web/scripts/model/serial-wire.js`. The one signature and element-order function is `layoutSignature` / `elementsFor` in `src/web/scripts/model/integration.js`.
