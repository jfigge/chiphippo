---
paths:
  - "src/app/serial/**"
  - "src/app/ipc/serial.js"
  - "src/web/scripts/model/integration*.js"
  - "src/web/scripts/model/serial-*.js"
  - "src/web/scripts/model/mock-connection.js"
  - "src/web/scripts/model/connection-stream.js"
  - "src/web/scripts/components/integration-*.js"
  - "src/web/scripts/components/serial-*.js"
  - "src/web/scripts/components/mock-panel.js"
  - "src/web/scripts/components/codegen-dialog.js"
  - "src/web/scripts/components/code-files-dialog.js"
  - "src/web/scripts/components/pin-fields-editor.js"
  - "src/web/scripts/components/protocol-doc-button.js"
  - "src/web/scripts/serial-log.js"
  - "src/web/serial-log.html"
  - "src/web/docs/serial-protocol.md"
  - "src/web/scripts/tests/integration-*.test.js"
  - "src/web/scripts/tests/serial-*.test.js"
  - "src/app/tests/serial-*.js"
  - "docs/examples/**"
  - "docs/chiphippo-serial-*.md"
  - "docs/chiphippo-mock-connection.md"
  - "docs/chiphippo-connection-window.md"
---

## Arduino serial integration

**The running circuit talks to a real Arduino over USB** (Feature 380, from
`docs/chiphippo-serial-integration-spec.md`; the wire is `src/web/docs/serial-protocol.md`,
protocol v1, which is NORMATIVE — and a user-guide page, so the app, the website and the PDF
all carry it). An **Output** samples its pins on its
trigger's edge and sends the value to a sketch; an **Input** puts a value the sketch sent
onto its pins. The sketch side is a GENERATED header. Main: `app/serial/{protocol,link,
ports,serial-manager}.js` + `app/ipc/serial.js`. Renderer: `model/{integration,
integration-runtime,integration-codegen,serial-connections,serial-wire}.js` +
`components/integration-{shell,controller,rail,layer,tools,lamps,settings}.js` +
`pin-fields-editor.js` + `codegen-dialog.js` + `serial-log-view.js` (`web/serial-log.html`).

- **An element is a signal's sibling, not a component** — the same argument as
  "External signals", one kind over. `doc.integrations` (schema **v14**, main migration
  v13 → v14, with `nextOutputId`/`nextInputId`) holds `{ id: "out<n>"|"in<n>", kind, color,
  connection, triggerEdge, triggerInit, fields: [{type, name}], name?, description?,
  tags?: {"1": {anchor, rot}, …, "T": {anchor, rot}}, parkedTrigger?: {anchor, rot} }`.
  `buildOccupancy` and the engine's
  `buildContext` each gained ONE more loop beside the signal one; the schematic draws no
  tags (out of scope). A tag is keyed by PIN NUMBER (`"T"` for the trigger), pin k is bit
  k−1, and a pin that is unplanted, floating or `X` reads **0** (`packValue`). The colour
  comes from the SAME cycle as signals (`nextSignalColor` over both), since both share the
  rail. At most `MAX_ELEMENTS` (16) per desk and `MAX_ELEMENT_PINS` (16) per element — the
  widest value is a `uint16_t` on the wire. A NEW element takes the connection the desk
  already uses, else the first non-Mock one (`#defaultConnection` — the Mock leads every
  list, so "the first" alone would never be the user's board), the Mock only with none.
- **Auto is a TRIGGER SETTING, not the absence of a tag** (`TRIGGER_EDGES`: `auto` ·
  `rising` · `falling` · `either`; `DEFAULT_TRIGGER_EDGE` is Rising for an Output, Auto for
  an Input). An element on Auto has NO trigger tag — `tagKeys`/`hasTagKey` leave `"T"` out,
  so the card offers no chip and planting one throws — and one on an edge MUST have it
  planted, or `preflight` refuses Run naming it (an Output with no line used to never fire,
  silently). Switching ONTO Auto parks the tag (`DeskDoc.updateIntegration` →
  `#parkTrigger`, `parkedTrigger`); switching off it restores the tag to that hole if the
  hole is still real and free, else it waits on the card (THE RULE). A parked trigger is a
  MEMORY, not a tag: it lives outside `tags`, so occupancy, the engine, the layer and the
  rail never see it, and it claims nothing — which is why the restore asks again. The
  loader keeps one only on Auto and only naming a real hole; board removal and Remove All
  Tags forget it. The Properties card greys "Trigger starts" on Auto through the dialog's
  generic `disabledWhen(values)` (a row that means nothing stays put rather than moving
  the rows under it). The trigger is host-only: not in the layout signature, not in the
  design hash.
- **Fields, not bits, are the pin model**: an element is an ordered list of Bit (1) /
  Byte (8) / Word (16) fields, each one PARAMETER of the Output function or one SETTER on
  the Input — which is what makes the generated C++ read like the design. The drop presets
  (1/2/4/8/16) are just initial field lists (`presetFields`); `setIntegrationFields`
  unplants any tag past the new last pin.
- **Tags follow THE RULE verbatim** (*a tag with nowhere to go stops existing; the element
  never does*): `normalizeDocument` is first-wins PINS → WIRES → FLAGS → TAGS, and
  `buildOccupancy` claims flags and tags FIRST for the reason it claims flags first.
  `removeBoard` sends a board's tags home (`#detachIntegrationTags`). ONE
  `drag-integration-tag` serves the card's waiting chip and a planted tag; `R` turns it,
  Delete unplugs a selected tag (the element stays).
- **Inputs ride the engine's signal path**: each planted Input PIN is pushed into
  `ctx.signals` as `<elementId>:<pin>` and driven through the shared `signalLevels` map at
  chip-output strength, so a conflict needs no new code. An Input drives **Z until its first
  value** — a sketch that has not spoken yet must not assert anything.
- **The timing model lives in ONE pure module** (`integration-runtime.js`, header comment):
  Chip Hippo looks only at SETTLE BOUNDARIES. An Output fires when its trigger's settled
  level differs from the previous boundary's in the configured direction
  (`triggerInit` stands in for "previous" at the first) — or, on Auto, when the value its
  pins settle to differs from the last one it SENT, and unconditionally at a run's first
  boundary (so the sketch learns the starting state); an Input's value is buffered
  (latest wins) and applied at a boundary — immediately if LIVE (on Auto), else on its
  trigger's edge — all at once, then the board settles again. A value arriving DURING a
  stall still counts for that boundary, which is what makes request/response work.
- **SimController grew a collaborator seam, not integration code**:
  `integration: {preflight, begin, settled, levels, end}`. `preflight` may refuse Run (sync
  `false` or a promise — every element assigned and, on an edge, its trigger planted;
  every connection known here, configured and its port present, each refusal offering the
  fix); `begin` opens the ports; after each
  tick `settled` may return `{again}` (re-settle with new Input levels, capped at
  `MAX_BOUNDARY_PASSES`) or a **Promise — the STALL**: while an Output is in flight the
  transport skips clock edges, and `wake()` resumes. `levels()` merges into the drive map.
  Stop ends it all and releases the stall. An ASYNC preflight (the live port scan) runs
  while the transport still reads stopped and the desk is unlocked, so `stop()` bumps the
  start token even when stopped (a tab switch / New / Open cancels it) and a desk edited
  meanwhile is preflighted again rather than run unchecked.
- **A run involves only the boards the breadboard REFERENCES** (`runElements` in
  `integration.js`): a connection takes part when at least one of its elements has a tag
  planted, and then with ALL its elements (the layout signature counts every one). An
  element with nothing on the breadboard reaches no net, so a board used only by such
  elements is not opened, not checked and not complained about — an unplugged Arduino,
  or one not set up on this computer, must not stop a circuit that does not use it. The
  same rule spares an idle element the trigger check; an UNASSIGNED element is refused
  only when it is planted.
- **Every protocol NUMBER lives in ONE module, `model/serial-wire.js`** — version, markers,
  frame types, payload sizes and limits, session/SEQ ranges, the never-NAKed types, CRC-16
  poly/init, the 250 ms / 5 s handshake, the 500 ms ACK timeout, the 3 sends — plus
  `crc16`/`crc32`. The protocol page's Constants table names these exports, and
  `serial-protocol-doc.test.js` reads the page back (its constants, frame types,
  signatures, and every hex frame and quoted CRC) against the code, so the spec and the
  implementation cannot drift. Dependency-free ESM, because BOTH sides read
  it: the generator imports it and WRITES the header's constants from it, and main's
  `protocol.js` `require()`s it (require(esm): Electron 42's Node 24 loads a dependency-free
  ES module synchronously, asar included — verified). So nothing is typed twice, including
  the version in the version-mismatch message and the count in the delivery one (both are
  `{placeholders}` fed from the constants). There is NO per-connection timeout: it is the
  protocol's, not a setting.
- **The link** (main, `protocol.js` bytes + `link.js` session/reliability): `0x7E TYPE SEQ
  LEN PAYLOAD CRC_LO CRC_HI`, CRC-16/CCITT-FALSE over the unescaped TYPE…PAYLOAD, every byte
  after START escaped (a `0x7D` followed by anything but `5E`/`5D` is damage). Types HELLO 01 ·
  HELLO_ACK 02 · ACK 06 · NAK 15 · OUTPUT 10 · INBOUND 11 · LOG 20; a data payload is always
  `[index][width][lo][hi]`. Stop-and-wait, SEQ 1…255 wrapping to 1 (non-zero ONLY in data
  frames and ACKs), duplicates judged against the last SEQ ACKNOWLEDGED (so an unusable
  frame counts: the device's `ack()` records it), a NAK (SEQ 0, "resend what you have") at
  once for a damaged frame — never for a damaged ACK/NAK/LOG/HELLO/HELLO_ACK, on BOTH sides
  (`NOT_NAKED`, which the generators write the device's check from). Receivers have a
  payload limit (host 255, a device `MAX_HOST_PAYLOAD` = 7): a LEN past it is damage the
  moment it is read, so a frame buffer is bounded by construction. The device
  ACKs an OUTPUT **after its handler returns** — that is what makes the stall mean "the
  device has reacted" — and so a resend arriving WHILE that handler runs (it pumps the port
  inside an Input's `send()`) is IGNORED, never re-ACKed early. LOG is **unacknowledged**
  (SEQ 0, ≤60-byte chunks from the header, never split inside a UTF-8 character; the host
  decodes it as a stream anyway). An intact but unusable data frame is ACKed and dropped.
- **The handshake is a SESSION.** Each run picks a fresh **16-bit** session (1–65535,
  process-wide counter from a random start — 8 bits gave a non-resetting board a 1-in-255
  chance per app restart of taking a new run for a late copy of the old one) and sends
  HELLO `[version][session ×2][signature ×4]` (SEQ 0) every 250 ms for up to 5 s; the device
  answers HELLO_ACK in the same layout with the SAME session and ITS version and
  signature. The host reads the version (payload byte 0, after the session in 1–2 matched)
  from a HELLO_ACK of ANY length and refuses a foreign one as `version`, never as silence;
  v1 promises nothing about a later version's payload beyond what it can read. The device
  remembers the LAST session a HELLO named (0 at start) and resets only when a HELLO names
  a different one — the host resends HELLO until it hears, and a late copy that reset the device would rewind its SEQs so its next
  Input looked like a duplicate and vanished. It JOINS that session only if the HELLO is
  byte-for-byte its own HELLO_ACK payload (v1, its layout): the header compares the two
  seven bytes, so a mismatch never runs `onConnect` or sends an Input into a refused run.
  A HELLO for session 0 is IGNORED (its answer would read as a restart). A HELLO_ACK for
  another session is stale. Session **0** is the device ANNOUNCING it is in NO session —
  the header's `begin()` sends one, and so does leaving a session (below): ignored during
  a handshake, but after it the link FAILS (`"restart"`, and `send()` answers that from
  then on — data goes only while ACTIVE, LOG is still shown) and main pushes
  `serial:restart` → the run STOPS ("left the run" — it restarted, or stopped hearing
  Chip Hippo). Version or signature mismatch REFUSES the run (`version` / `signature`
  codes, facts only). A send it never got acknowledged takes the device OUT of the session:
  it drops a held OUTPUT, never ACKs the running handler's (`busySeq_` zeroed), ANNOUNCES
  (so a host still listening stops — before, an Inputs-only run just froze), and stays
  OFFLINE keeping its last session, so only the NEXT run's HELLO brings it back — a
  sketch left running after Stop fails each `send()` at once instead of blocking 1.5 s;
  `ChipHippo.connected()` exposes it. A new session while a handler waits in `send()`
  abandons that Input (its `txSeq_` was reset — checked BEFORE acting on the answer, or a
  NAK right behind the HELLO would resend the old run's Input into the new one), never
  ACKs the handler's OUTPUT (`busySeq_` zeroed — SEQ 0 is never a data frame's, and a data
  frame CARRYING 0 is ignored everywhere), and REFUSES the rest of that handler's sends
  (`dispatching_ && !busySeq_`): a handler belongs to its OUTPUT's session. The
  RENDERER keeps an Input that arrives while the run is still OPENING
  (`IntegrationController`'s `#opening`): a device's `onConnect` sends its starting
  values the moment ITS handshake completes, main ACKs them at once, and `serial:open`
  resolves only after every connection's — dropped there, they never came again.
  `serial-conformance.test.js` feeds the Mock, the compiled header and the Python module
  (python3 + micropython) the SAME host bytes — corners a correct host never sends — and
  holds them to the same answers.
- **The built-in MOCK connection** (`docs/chiphippo-mock-connection.md`) is a device
  Chip Hippo plays itself, at the BYTE level: `app/serial/mock-device.js` is the protocol's
  device side in JS behind the same four-method port `adaptPort` gives a real one, so the
  host link cannot tell it from a cable — which makes it the host stack's best test
  (`serial-mock.test.js` runs every fault through the real `SerialLink`). Its identity is
  `model/mock-connection.js` (id `mock`, name `Mock` — reserved, NOT translated, it is a
  name), dependency-free and `require()`d by main for `serial-wire.js`'s reason. It is in
  NO list: `knownConnections` prepends it wherever a connection is chosen (so every
  consumer sees it first), `normalizeConnection` drops a stored user entry claiming its id,
  `projectConnections`/`mergeProjectConnections`/project-store never carry it,
  `connectionProblem` is null for it (no port), and `SerialManager.connection("mock")`
  answers a built-in record no settings entry can shadow and opens it with no port scan —
  handing `openPort({signature})` the run's layout signature, so the mock is a device
  built for the design on screen (its own layout, as a sketch has) rather than a mirror.
  Its connection window is everyone's (below) plus `components/mock-panel.js`, whose
  Input rows come from the LAYOUT its run brought (a row per Input, Send / Send all, Log, the four
  one-shot FAULTS — `drop-ack`, `corrupt` (the next ACK or INBOUND, never a LOG, which
  would just vanish), `ignore-hello`, `wrong-signature` — armed in main, outliving a run
  until spent), talking to main over `serial:mock:{send,log,fault}` and hearing the
  `serial:mock` push. A run using it opens that window IN THE BACKGROUND
  (`showInactive`, never stealing focus from the circuit). Generate gives it no row and
  no staleness dot.
- **THE RENDERER NAMES CONNECTIONS, NEVER DEVICES.** `serial:open` takes
  `[{id, signature}]` — connection IDS, plus the layout signature main cannot compute
  (it never sees the document);
  main reads the port from ITS settings (`serialConnections`, the allowlist) — the
  `knownPath` stance, for devices. Ports **open on Run, close on Stop** so the Arduino IDE
  can reflash between runs; the open is all-or-nothing, and SERIALIZED: a run's ports open
  only once every earlier open and close has let go (a port still closing, or one a
  stopped run is still acquiring, holds the exclusive lock and answers "busy"), and a
  superseded open re-checks its generation after every await and closes only the links
  it made. A port lost while the run is opening answers `dropped` (explained), never
  `closed` (a Stop — silent). The same race has two renderer-side halves: a CLOSED link
  hears nothing (`#receive` returns at once, so an Input or restart the port had already
  read never reaches the next run), and `IntegrationController#open` carries a run token
  (`#run`, bumped by `begin()` and `end()`), so an answer for an ended run touches
  nothing of the current one. Main pushes FACTS (codes, ids,
  timestamps); every sentence is the renderer's. `require("serialport")` is LAZY in
  `ports.js` (the updater's reason: `main.js` is READ by `node --test`); it ships N-API
  prebuilds, hence `npmRebuild: false`. It is the second runtime dependency. Those
  prebuilds cover every platform, so each desktop build excludes all but its own
  (`build.mac.files` — which mas/masDev inherit — `build.win.files`, `build.linux.files`;
  `packaging.test.js` fails on a platform a serialport update adds).
- **A device goes away in three shapes and the adapter hears all three** (`adaptPort`):
  `close` with a DisconnectedError (a USB pull: ENXIO), `error` (the same failed write,
  which UNLISTENED is an uncaught exception in main), and `end`. One does NOT surface: the
  macOS binding re-reads a zero-byte read, so a far end that merely shuts (a pty in testing)
  is silent until the next write fails. `#portClosed` also closes the port, since not every
  shape leaves it shut.
- **The link is BINARY, so two framing choices are not offered**: data bits are always 8
  (`DATA_BITS = [8]`; a CRC byte needs all eight) and flow control is never software
  (`FLOW_CONTROLS` is none/hardware; XON/XOFF swallows 0x11, the INBOUND type). A stored
  other value normalizes away, and main's `portOptions` forces both whatever raw
  settings.json says — main reads it unnormalized.
- **Connections are MACHINE truth with a portable shadow.** Settings hold them whole;
  the PROJECT file carries `connections` WITHOUT `port` (a device path means nothing on
  another machine) and, on open, any this machine lacks joins its settings flagged
  `needsConfig`. The project copy is DERIVED at every stash, so it is excluded from
  `projectSignature` (a Settings rename must not dirty a project); `codegen`
  (`{tabId: {connId: "0xHASH"}}`, recorded by Generate) is not. Settings ▸ Serial I/O
  (panel key `integration`) is the one Settings panel with **Apply** rather than
  live-apply: a connection's fields only mean something together, and Apply is where the
  port is checked against a live scan (a failed check turns the button into **Apply
  anyway**, which keeps one that is not plugged in yet). ONE dropdown picks the connection
  (+ adds, the bin removes on a second click) and ONE editor below edits it, built from the
  card's own `.settings-row--field` rows with no card around them, so it spaces and letters
  exactly as the other tabs do. Closed it fits the card at every shipped size and
  language; with Advanced open it scrolls. Each connection keeps its own draft while
  another is picked (a • in the list marks one), and an edit updates in place rather than
  rebuilding the editor.
- **The header** (`integration-codegen.js`): one per connection × desktop, a
  `ChipHippoLink : public Print` with `begin()`/`poll()`, one declared function per Output
  (fields → parameters) and one object per Input (setters + `send()`). **Identifiers
  read from the ARDUINO's side**: an Output ARRIVES at the sketch, so its function ends
  `In`, and an Input is SENT from it, so its member ends `Out` (`elementIdentifier`; not
  doubled when the name already ends so) — the element keeps the circuit's name, the code
  the board's, and the header's comment and the example bridge the two. The suffixes
  differ, which is load-bearing: an Output's function is CALLED from inside the class
  holding the Inputs, where an Input member of the same name would win and the header
  would not compile — so that is unrepresentable rather than renamed. An Output's
  PARAMETER spelled in capitals (`B0`, `HEX`, `SP`, `BIT0`) gains `_` and a `macro`
  warning (`CPP_NAMING.macroLike`): the cores define object-like macros under ordinary
  names, in capitals by convention, and no reserved list could hold them all — the
  convention is the rule, so `bit0` and `value` stay as they are. An Input's field is only
  ever part of a setter's name, so it is exempt. The stub `Arduino.h` in `serial-board.js`
  defines a few so a regression fails the compile test. **`onConnect(fn)`**
  is run from `poll()` whenever `onHello` sees a NEW session — the only signal a board that
  does not reset when the port opens (Leonardo, native USB) gets that a run began, since
  `connected()` stays true between two runs nobody sent in; it is where a sketch sends its
  Inputs' starting values (an Input drives Z until its first). It runs BEFORE any Output
  of its run: an OUTPUT read in the same pump as the joining HELLO is HELD
  (`connectPending_` / `_connect_pending`) for `poll()` to dispatch after it — dispatched
  at once, its ACK beat the starting values (the conformance script's `C` lines). TWO fingerprints,
  deliberately different: the **layout signature** (`integration.js`'s `layoutSignature`,
  the ONE function both the generator and the run's handshake call: CRC-32 of
  `O0:8+1,O1:1,I0:16` — per element its FIELD WIDTHS in order, since a `[bit, byte]`
  reordered to `[byte, bit]` keeps its width and misroutes every value; never names) is
  compiled in, sent in HELLO_ACK and REFUSES a mismatch; the **design hash** (FNV-1a over
  the connection's framing + its elements' names, field types/names and order, plus
  `HEADER_REVISION`, 1 until the first release and bumped only after one, when the
  generated code changes shape, so old headers read out of date — never positions, colours or descriptions) is only a comment and the Generate
  button's staleness dot, so a rename still runs. **Wire order is by the NUMBER in the id** (`elementsFor`
  sorts `out2` before `out10`) — one ordering for the header, the element index on the wire
  and the signature. Names become identifiers through `planIdentifiers`
  (reserved words and collisions renamed and REPORTED). `serial-arduino-header.test.js`
  compiles a generated header with the host `c++ -std=gnu++11 -Wall -Wextra -Werror`
  against a stub `Arduino.h` and runs it against the REAL `SerialLink` (skips with no
  compiler) — the only proof the two halves agree. A test may PATCH the header text
  before compiling (a v2 sketch, a 40 ms ACK timeout) to reach a case the generator never
  emits. The reserved-word list carries every member and constant of `ChipHippoLink`: an
  Output's function is CALLED from inside the class, where a member of the same name wins.
  **`generateExample`** writes an EXAMPLE sketch for a header (`ChipHippoExample.ino`)
  showing the three things a sketch does, each labelled RECEIVE / SEND / LOG where it
  happens: a logging function per Output; a `runStarted` `onConnect` that logs and sends
  every Input's starting value; and the first Input's first field counting up (a bit:
  toggling) every `SEND_EVERY_MS` from `loop()`, logged per send. A connection with no
  Outputs or no Inputs says where that code would go. Built from the SAME identifier
  plan (its own globals cannot collide: an Output's function always ends in `In`), the
  header's comment points at it, and the header test builds and RUNS it with the period
  patched down to 30 ms. `generatePythonExamples` is the same program, timed with the
  module's public `ticks_ms`/`ticks_diff` (its one clock that reads the same on every
  board), and runs under `python3` and `micropython` alike. **The Generate card has ONE button per connection**, picked by its
  status: never generated / out of date → **Generate**, which RECORDS the hash (that, not
  a save, is what makes a row current and takes the toolbar dot off) and opens the files;
  in sync → **View files…**, which only opens them. The files open in
  `components/code-files-dialog.js`, a tabbed TEXT VIEW (a gutter `<pre>` of line numbers
  beside ONE `<pre>` of the file, so a selection sweeps it like any text view; everything
  else on the card is `user-select: none`), which REPLACES the Generate card
  (PopupManager queues) and hands back to it on close. **Copy means the selection within
  the file on show, or the whole file** — the button, ⌘C/Ctrl+C and a menu Edit ▸ Copy
  (the `copy` event) alike; a selection of ALL of it copies the file's own text, final
  newline included. ⌘A/Ctrl+A (and the menu's `chiphippo:edit-select-all` push) select
  that file's text alone. Both keys are caught on the DOCUMENT in capture while the viewer
  is ON SCREEN (a click on the text can leave focus on `<body>`) and preventDefault'ed,
  which is what stops the native menu running after them. **Save As…** saves the file on
  show through `integration:save-file (id, scope, name, text)`, which opens where THAT file
  was last saved for that connection and DESIGN — `app/serial/saved-files.js`, main-owned
  in `settings.codegenSaves` (connection → scope → file name → path, the renderer's
  `scope` an opaque `<project path>|<desktop id>` key, never a path, and a remembered path
  only ever one a Save panel returned). Per design because one board serves many (a
  sketch folder per circuit), and a default carried from another design is an invitation
  to click Replace over the wrong file. Pruned with the connection windows when a
  connection is deleted (`forgetDeletedConnections`), 20 designs per connection.
  `docs/examples/SegmentDecoder/` is a fuller sketch, with real buttons.
- **A connection has a LANGUAGE** (`LANGUAGES`: `cpp` default | `python`; a segmented row
  in Settings ▸ Serial I/O, a draft like every field there). It is the BOARD's, so it
  travels with a project (`PORTABLE_KEYS`, project-store's sanitize) and enters the design
  hash only when not `cpp` (a C++ header's hash is what it was before languages).
  `model/integration-files.js`'s `connectionFiles` is the ONE place it is read: C++ →
  `ChipHippo.h` + `ChipHippoExample.ino`; Python → `chiphippo.py` + `main.py`
  (MicroPython) + `code.py` + `boot.py` (CircuitPython), `main` (the file the board's
  code imports) first. Save As…'s IPC accepts `.h`, `.ino` or `.py` names (a suggestion
  and the filter, never a path).
- **The Python module** (`integration-codegen-python.js`) is the header said again, line
  for line — same protocol numbers (from `serial-wire.js`), session rules, ACK-after-the-
  handler, log chunking — in ONE file for MicroPython AND CircuitPython, picking its port
  by `sys.implementation.name`: CircuitPython's second USB port (`usb_cdc.data`, which
  `boot.py` enables), MicroPython's REPL port via stdin/stdout with `kbd_intr(-1)`
  (a 0x03 in a frame is data), desktop Python's stdin/stdout (how it is tested), or any
  stream handed to `begin()`. Names come from the SAME `planIdentifiers` with
  `PY_NAMING` (snake_case, `_in`/`_out`, Python keywords reserved); an Output is
  registered by DECORATOR (`@link.digit_in`) and one left unregistered is ACKed and
  ignored; a handler that RAISES is caught, logged to the connection window and ACKed —
  on a board an uncaught exception ends the program where nobody can see it. No
  f-strings or typing: MicroPython and CircuitPython must both run it.
  **Ctrl-C is off only INSIDE a frame**: MicroPython's port is the REPL's and
  `kbd_intr(-1)` makes a 0x03 data, but the host sends nothing but whole frames, so a
  lone 0x03 BETWEEN frames can only be Thonny or `mpremote` stopping the program —
  `_Stdio.interrupt()` restores Ctrl-C and raises KeyboardInterrupt (and `read()` stops at a
  0x03, leaving what follows it for the REPL). "Between frames" means outside any frame's
  EXTENT: a DAMAGED frame is still read to the end its LEN gives it (`_bad`/`_got`, wire-
  identical to hunting), or a 0x03 in its tail — a later version's long HELLO, say — would
  kill the program. And a frame's extent can be MISREAD (a LEN damaged smaller, a lost
  START, a byte damaged into 0x7D), leaving the rest of it outside any frame: so any stray
  non-CR/LF byte, and any damaged frame, makes the next `_QUIET_MS` (= `ACK_TIMEOUT_MS`,
  since a program reading less often is failing the link anyway) SUSPECT, and a 0x03 then
  is noise (`_stray`); a tool's `\r\x03` after a clean frame, or after the quiet, still
  stops it. The generated `main.py` also calls `kbd_intr(-1)` BEFORE importing the module
  (guarded for desktop Python): compiling it takes a while on a board, and a board that
  boots mid-handshake would otherwise be stopped by a 0x03 in a HELLO before `begin()`
  runs. Without it all, a `main.py` running the link
  locked every tool out of the board. A Python connection off **115200 baud, 8N1**
  is warned about on the Generate card (`python-framing`): a USB-serial-chip board (a
  classic ESP32 DevKit) runs its REPL at exactly that, a native-USB one ignores it.
- **A board's several ports are told apart** (`portPositions` in serial-connections.js):
  ports sharing a serial number, else a USB location, are one board, numbered by USB
  interface where the OS says (Windows' `MI_xx`, Linux's `-ifxx` in `pnpId`, which
  `ports.js` now passes with `locationId`) else by path. The Port list shows "port n of
  m", and for a PYTHON connection on a two-port board names them — REPL, then
  CircuitPython data — relabelling in place when the Language is switched.
  `app/tests/serial-python-module.test.js` runs every protocol case under `python3` AND
  the real `micropython` (unix port, `brew install micropython`), each skipping when its
  interpreter is absent; `serial-board.js` is the board harness it shares with the C++
  header's test.
- **The CONNECTION WINDOW** (`docs/chiphippo-connection-window.md`; `web/serial-log.html`
  → `serial-log.js` → `components/serial-log-view.js`) shows ONE stream per connection:
  log text, every value that crossed (`→ OUTPUT`/`← INBOUND` — Chip Hippo's point of view
  in EVERY window), protocol traffic (`·`) and errors (`!`, never filtered). Main owns it:
  `app/serial/connection-stream.js` per connection (FACTS only — kind, event code, numbers,
  `t`; every sentence is `model/connection-stream.js`'s, the protocol's notation
  untranslated), capped at 2,000 (the window's row cap is the same number, held
  equal by a test), CLEARED when a run opens the connection (`t0` = then,
  what `+  12.345` counts from), kept after Stop. A non-text entry ends a partial log line
  as a line of its own. The link reports everything through `onTrace` (resends are ERROR
  lines, never a second data line; damage before the session is bootloader noise and not
  traced); the manager adds open/close/drop and SNAPSHOTS the element into each data entry
  from the LAYOUT every run's `serial:open` request now carries (`connectionLayout`, main
  never sees the document). Pushes are BATCHED per tick, and the app window hears only of
  TEXT (the LG lamp). Filters (Log · Data · Protocol) and Timestamps are CSS classes on the
  scroller, never a rebuild; they and the window's bounds are remembered per connection
  ID in `settings.connectionWindows` (main writes it: `trackWindowState` +
  `resolveWindowBounds`), so a rename keeps them — and ONLY for a connection that exists
  (or the Mock): writing `serialConnections` runs `forgetDeletedWindows`, and a window
  still open when its connection goes saves nothing as it closes. Save… writes EVERY line with its time via `serial:log:save`.
  There is no Copy button (the text is selectable). Opened from ANY lamp, an element's
  menu (**Open Connection Window** — that menu now opens while RUNNING, editing items
  disabled) and Settings ▸ Serial I/O's **Open window…**; not closed by `closeAuxWindows`,
  since a connection is not a project's — but closed WITH the app window
  (`closeWindows`), or one left on screen keeps `window-all-closed` from quitting.
- **Chrome**: cards sit in the signal rail's column under the buttons (`.signal-rail-list`
  keeps the buttons their own block); tags draw in `.layer-signals`; the **TX · RX · LG**
  lamps (all three buttons) sit left of the zoom cluster, which now publishes
  `--desk-zoom-width` beside `--desk-zoom-height`.
