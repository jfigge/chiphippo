# Arduino Integration

Chip Hippo can talk to a real **Arduino** over USB while the circuit runs. An
**Output** hands a value from the breadboard to a sketch — a number to show on
a real display, a bit to switch a real relay — and an **Input** hands a value
from the sketch back onto the breadboard: a sensor reading, a key press, the
answer to a question the circuit just asked.

The sketch side is written for you. Chip Hippo **generates a header file** for
each board, declaring one function per Output and one small object per Input;
you include it, call two functions from `setup()` and `loop()`, and fill in
what each Output should do. The link underneath — framing, checksums,
acknowledgements, retries — is the header's job and never yours.

No Arduino to hand? Every Chip Hippo has a built-in **Mock** connection that
plays the board's part itself (see [The Mock connection](#the-mock-connection)),
so you can build and try an integration before a wire is connected.

## What you need

- An Arduino (any board with a USB serial port — an Uno, a Nano, a Mega, a
  Leonardo…) and the Arduino IDE to upload sketches to it — or just the
  built-in Mock.
- A **connection** for it in Settings ▸ Serial I/O (below), naming it and
  saying which port it is plugged into.
- One or more **Outputs** or **Inputs** on the desk, each assigned to that
  connection.

Nothing here touches the network: a connection is a USB cable, and Chip Hippo
opens the port only while the circuit is running.

## Connections

A **connection** is a named Arduino: *Display board*, *Sensor Nano*. Open
Settings (`Cmd/Ctrl+,`) and choose the **Serial I/O** tab. **+** beside the
connection list creates one; give it a name and pick its **Port** from the list
of what is plugged in right now (**Re-scan** after plugging a board in). **Baud rate**
defaults to 115200, which suits every current board. **Advanced** holds the
rest of the serial framing — parity, stop bits and flow control. Leave those
alone unless you have a reason. (Data bits are always 8 and there is no
XON/XOFF flow control: the link carries binary frames, which need every bit of
every byte.)

**Apply** saves the connection. If the port isn't plugged in at that moment
you're told so, and the button becomes **Apply anyway**, which saves it
regardless — useful when you're setting up before the board arrives. **Open
window…** opens the connection's [window](#the-connection-window), and the
bin beside the list (click it twice) deletes the connection. An Output or
Input still using it keeps its assignment — its Properties show the connection
as *(not on this computer)* — and the circuit won't run until you choose
another one there.

A connection whose port is missing, or which still **Needs configuration**,
says so in the list, and its **Port** is marked in red.

The list always starts with the **Mock**, marked *Built-in*. It has nothing to
configure and can't be removed, and its name is reserved: a connection of your
own can't be called *Mock*.

### Connections travel with the project

The connection's **name** and serial settings are saved in the project file,
so a design opened on another computer still knows which board each Output
talks to. The **port** is not — `/dev/cu.usbmodem14101` on your Mac means
nothing on someone else's PC — so a connection that arrives in a project is
added to that computer's Settings marked **Needs configuration**, and the
circuit won't run until a port has been chosen for it.

## The Mock connection

The **Mock** is a pretend Arduino inside Chip Hippo. Choose it as an Output's or
Input's **Connection** like any other, and press **Run**. There is no port to
pick, no sketch to upload and no header to generate. It speaks the same
protocol a real board does, byte for byte, so what works with the Mock works
with a board.

When a run starts, the Mock's [connection window](#the-connection-window)
opens beside the desk (without taking focus from it), with a send panel under
its stream. You can also open it from Settings ▸ Serial I/O: pick **Mock** and
press **Open window…**. It shows:

- **What arrives.** Each value an Output sends appears as a line, named and
  split into its fields: `→ OUTPUT   Display  value=0x3F dp=1`. The Mock
  acknowledges it at once, so the circuit carries straight on.
- **What you send.** There is one row per Input on the Mock. A bit field is a
  toggle; a byte or a word is a row of bit toggles plus a hex field, and
  editing either updates the other. **Send** sends that Input's whole value,
  exactly as a sketch's `send()` would, and it lands on the board like one.
  **Send all** sends every row in turn. The rows appear once the circuit has
  run with the Mock, since that is when the window learns your design.
- **Log text.** Type a line and press **Log** (or Enter). It arrives in the
  log exactly as a sketch's `ChipHippo.println()` would.

**Faults**, folded away at the bottom, make the Mock misbehave once, on
purpose, so you can see how the link copes:

| Fault | What happens |
| --- | --- |
| **Drop next ACK** | The Mock swallows its acknowledgement of the next Output. Chip Hippo waits, sends it again, and the circuit carries on — the value still arrives only once. |
| **Corrupt next frame** | The next acknowledgement or Input the Mock sends is damaged in transit. Chip Hippo notices and asks for it again. |
| **Ignore handshake** | The Mock doesn't answer on the next Run, which stops with *No answer*. |
| **Wrong signature** | The Mock answers the next Run as a sketch built for a different design, which refuses to start. |

A fault stays armed (its button highlighted) until it has happened. Click it
again to disarm it. You can arm one while the circuit is stopped, ready for
the next Run. What each fault causes shows up in the stream as a warning line
(turn on **Protocol** to see the traffic around it too).

## Outputs and Inputs

Add either from the parts palette's **SIGNALS** section: pick **Output** or
**Input**, click anywhere on the desk, and choose how many **pins** it has —
1, 2, 4, 8 or 16. You can change that afterwards in its Properties.

Each one appears as a **card** on the right-hand edge of the desk, under the
signal buttons: its direction arrow (← Output, pointing out; → Input, pointing in), its colour, its name
and how many pins it has. Under the name sits a small numbered chip for every
pin that isn't on the board yet, plus one more — the **trigger**, marked with
an arrow — unless the element's trigger is **Auto**, which has no trigger tag
at all. **Drag a chip onto a breadboard hole** to plant that pin there as a
**tag**; drag a planted tag to move it, and press `R` while dragging (or with
the tag selected) to turn it. **Delete** unplugs a selected tag back onto its
card. The card's right-click menu offers **Properties…**, **Remove All Tags**
and **Delete Output** / **Delete Input**; a tag's own menu adds **Remove Tag**
and **Add to analyzer**.

A tag is plugged into its hole the way a wire end is — one hole, one lead —
and deleting the breadboard under a tag sends it back to the card; the Output
or Input itself is never lost with it.

### Pins and fields

An element's pins are grouped into **fields**, and each field becomes one
parameter of the Arduino function (for an Output) or one setter (for an
Input). A field is a **Bit** (1 pin, a `bool`), a **Byte** (8 pins, a
`uint8_t`) or a **Word** (16 pins, a `uint16_t`), up to 16 pins in all. The
Properties dialog lists them in pin order with a name each; **+ Bit**, **+
Byte** and **+ Word** add one, and the × removes one.

Pin 1 is the **least significant bit** of the element's value, pin 2 the next,
and so on. A pin whose tag isn't planted, or whose net is floating or unknown,
**reads as 0**.

### Properties

Right-click a card (or one of its tags) and choose **Properties…** to edit:

| Setting | What it does |
| --- | --- |
| **Name**, **Description** | The name is also the function (Output) or object (Input) name in the header, turned into a valid C++ identifier |
| **Color** | The card's dot and its tags — any of the seven signal colours |
| **Connection** | Which Arduino it talks to. A new Output or Input joins the connection the desktop already uses, or else your first Arduino — the Mock only when none is set up. The gear beside it opens Settings ▸ Serial I/O |
| **Trigger** | **Auto**, **Rising**, **Falling** or **Either**. Auto watches no line: an Output sends whenever its value changes, an Input puts each value on the board as it arrives. The others name which transition of the trigger line counts. A new Output starts on **Rising**, a new Input on **Auto** |
| **Trigger starts** | **Low** or **High** — what the trigger line is taken to have been before the run began, so a line that starts high can still fire (or not) on the first settle. Greyed out on Auto, which has no line |
| **Pins** | The fields, as above |

## How values move

Chip Hippo only ever looks at the board **between settles** — when every
chip's output has stopped changing. A glitch inside one settle is never sent
anywhere, and nothing from the Arduino ever lands on the board halfway through
a ripple.

### An Output fires on its trigger, or on a change

When an Output's trigger line makes the chosen transition, Chip Hippo samples
the Output's pins and **sends the value**. On **Auto** there is no trigger
line: after every settle Chip Hippo samples the pins and sends the value if it
differs from the last one it sent — and always at the very first settle of a
run, so the sketch learns where the circuit starts. **The circuit then waits** — no
clock edges, no further settles — until the Arduino's function has *returned*
and the board has acknowledged it. So whatever the sketch does in response has
already happened before the circuit moves on, and an Input the sketch sends
from inside that function lands in the same step: the request/response shape
(the circuit asks, the Arduino answers, the circuit carries on with the
answer) works with no timing of your own.

Auto sends **every** value the pins settle to, including the in-between ones:
flip two switches one after the other and the Arduino hears both steps. When
the pins only hold a meaningful value at one moment — a data bus, a latch
strobe — use an edge on that strobe instead.

An Output or Input waiting for an edge **won't run without its trigger tag on
the board**: pressing Run says which one is missing it, and offers its
Properties, where you can switch it to Auto instead.

### An Input is live or triggered

An Input drives its pins at the strength of a chip output — two things
disagreeing over one net is reported as a conflict, exactly as two chip
outputs would be — but **drives nothing at all** until the Arduino has sent it
a first value.

- On **Auto**, an Input is **live**: each value the Arduino sends is put on
  the board at the next opportunity between settles.
- On an edge, the latest value the Arduino sent **waits** and is put on the
  board only when the trigger line makes its transition — the way a latch
  loads on its clock. Earlier values the circuit never took are simply
  replaced.

Switching an element to Auto takes its trigger tag off the board, but Chip
Hippo remembers where it was: switch back to an edge and the tag returns to
the same hole — unless something else has been plugged in there meanwhile, in
which case it waits on the card.

## Generating the board's code

The **Generate** button in the desk tools pill opens a card listing every
connection this desktop's Outputs and Inputs use. Each has one button:
**Generate** while its code has never been generated or is out of date, which
generates it and opens the files, and **View files…** once it is up to date,
which just opens them. In the file viewer, **Save As…** saves the file on
show: save `ChipHippo.h` into that board's sketch folder and include it:

```cpp
#include "ChipHippo.h"

void setup() {
  ChipHippo.onConnect(sendInputs);  // optional — see below
  ChipHippo.begin();
}
void loop() { ChipHippo.poll(); }

// The Output "Display" arrives here: its name + In, its fields the parameters.
void DisplayIn(uint8_t value, bool dp) {
  ChipHippo.print("showing ");
  ChipHippo.println(value);
}

// The Input "Keypad" is sent from here: set its fields, then send it whole.
void keyPressed(uint8_t code) {
  ChipHippo.KeypadOut.setCode(code);
  ChipHippo.KeypadOut.setReady(true);
  ChipHippo.KeypadOut.send();
}

// Runs at the start of every run: give each Input its starting value.
void sendInputs() {
  ChipHippo.KeypadOut.setCode(0);
  ChipHippo.KeypadOut.setReady(false);
  ChipHippo.KeypadOut.send();
}
```

In the sketch, names read from the **Arduino's** side. An Output leaves the
circuit and *arrives* at the Arduino, so the Output called *Display* is the
function `DisplayIn()`; an Input is *sent* from the Arduino into the circuit,
so the Input called *Keypad* is `ChipHippo.KeypadOut`. The two different
endings also mean an Output and an Input can share a name. A name that
already ends that way isn't doubled (an Output called *DataIn* stays
`DataIn`). A name that can't be used as it is (two Outputs with the same
name, a field called `delay`) is changed, and the Generate card lists each
change under its connection. That includes an Output's field named in
capitals, such as `SP` or `HEX`, which becomes `SP_` or `HEX_`: the Arduino
cores use names in capitals for their macros, and a parameter spelled like one
won't compile.

The file viewer shows the header beside `ChipHippoExample.ino`, an example
sketch that uses it, each in its own tab, with line numbers. The example
shows the three things a sketch does, each labelled where it happens:
**receiving** (a function per Output that logs what arrived), **sending**
(every Input's starting value at the start of a run, then the first Input
counting up once a second from `loop()` — a stand-in for reading a switch or
a sensor) and **logging** (a line when a run starts, one per Output that
arrives, one per value sent). The Python programs do the same, timing the
loop with the module's own `ticks_ms()` and `ticks_diff()`, which read the
same on every board. Select part of a file and **Copy** (or ⌘C / Ctrl+C)
takes just that; with nothing selected it takes the whole file, and ⌘A /
Ctrl+A selects all of the file on show. **Save As…** opens where you last
saved that file for this board and desktop, so a new version goes over the
old one without hunting for the folder. Closing the viewer returns to the
Generate card. The header's own opening comment points at the example too.

An Input's `send()` returns `true` once Chip Hippo has the value. It returns
`false` when nobody is listening: at once before a run has greeted the sketch,
and after one has stopped (the first time, after a second and a half of
resends). `ChipHippo.connected()` says which state the link is in.

An Input puts nothing on its pins until its first value arrives, so a sketch
should say where its Inputs stand as soon as a run begins.
`ChipHippo.onConnect(fn)` is for exactly that: `poll()` runs `fn` at the start
of **every** run. That matters on boards that don't restart when Chip Hippo
opens the port — a Leonardo, a Micro, most boards with USB built into the
chip — where the sketch simply carries on from one run into the next and
`connected()` alone can't tell that a new one has begun.

The Mock needs no header. A desktop whose Outputs and Inputs are all on the
Mock is told so, and the Mock never marks the Generate button out of date.

The header never contains your code, so saving over it after a change to the
design is always safe. Three rules keep the link healthy:

- **Call `ChipHippo.poll()` often**, and keep Output functions short. The
  circuit is stood still while an Output is being handled; a `delay()` there is
  time it waits. Chip Hippo resends a value it hasn't had acknowledged after
  half a second, and stops the run after three tries.
- **Log with `ChipHippo.print()` / `println()`, never `Serial`.** Chip Hippo
  owns the port while the circuit runs; anything printed straight to `Serial`
  is noise on the link. What you print through `ChipHippo` appears in the
  [connection window](#the-connection-window).
- **One header per connection.** Two boards on one desktop get two headers,
  each declaring only its own Outputs and Inputs.

### Python boards (MicroPython and CircuitPython)

A board that runs Python — a Raspberry Pi Pico, an ESP32, an Arduino Nano
ESP32 or Nano RP2040 Connect, most Adafruit boards — can take part too. Set
its connection's **Language** to **Python** in
[Settings ▸ Serial I/O](settings.md#serial-io), and Generate writes
`chiphippo.py` instead of a header: one module that runs on MicroPython and
CircuitPython alike. (An Uno, Nano, Mega or Leonardo is too small for Python
and stays C++.)

```python
from chiphippo import link


@link.display_in  # the Output "Display" arrives here
def display_in(value, dp):
    link.print("showing", value)


@link.on_connect  # runs at the start of every run
def send_inputs():
    link.keypad_out.set_code(0)
    link.keypad_out.set_ready(False)
    link.keypad_out.send()


link.begin()
while True:
    link.poll()
```

It is the header said in Python: the same names in Python's own style
(`display_in`, `keypad_out.set_code`), an Output handled by decorating a
function with `@link.<its name>_in`, and `link.print()` for the log. The
file viewer shows the module beside `main.py` (MicroPython) and `code.py` with
`boot.py` (CircuitPython). Save `chiphippo.py` and the program for your board
onto it.

Where the link runs is the one real difference between the two:

- **MicroPython** uses the board's own USB serial port — the one its REPL uses
  — so point the connection at that port. Inside the link's data a `0x03` byte
  is just data, not Ctrl-C; between messages, Ctrl-C still stops the program,
  so Thonny and `mpremote` can always get in to replace its files. The
  example `main.py` switches Ctrl-C off on its first lines, before it imports
  `chiphippo`; if you write your own, start it the same way. A plain
  `print()` would land in the middle of the link, so log with `link.print()`.
  On a board whose USB is a separate serial chip (a classic ESP32 DevKit),
  MicroPython always talks at **115200 baud, 8N1**: leave the connection
  there — the Generate card warns if it isn't. A board with USB built in (a
  Pico, a Nano ESP32) ignores the rate.
- **CircuitPython** gives the link a second USB serial port of its own, which
  `boot.py` turns on (`usb_cdc.enable(console=True, data=True)`). After the
  board resets, a new port appears beside the REPL's. For a Python connection
  the **Port** list names the two — *port 1 of 2: REPL* and *port 2 of 2:
  CircuitPython data* — so choose the data port. (Any board with several ports
  shows which of them each one is.)

A function that raises an exception is reported in the connection window and
the circuit carries on — on a board there is nowhere else it could be seen.
Most Python boards don't restart when Chip Hippo opens the port, so give your
Inputs their starting values from an `@link.on_connect` function, as above.
`link.begin()` can also be handed a port you have opened yourself — a
`machine.UART` or `busio.UART` at the connection's baud rate.

### Keeping the header current

Every header carries a **design hash** of what it was generated from — the
connection's settings and the names, fields and order of its Outputs and
Inputs. Change any of those and the header is **out of date**: the Generate
button shows a dot, and on the Generate card that connection's button reads
**Generate** again. Positions of tags on the board, colours and descriptions
don't change the hash. A header generated by an older Chip Hippo whose
generated code has since changed shows as out of date too, so that generating
it again picks the change up.

Pressing **Generate** is what marks a header up to date — the hash is kept in
the project file — so save the new file over the old one (**Save As…** offers
the same place) before you rebuild the sketch.

A run checks something narrower: the **layout** the sketch was built for —
which Outputs and Inputs there are, in what order, and how each one's pins are
split into fields. Names aren't part of it, so a design you've only renamed
things in still runs while you get round to regenerating. But a sketch built
for a different layout would hand values to the wrong functions or parameters,
so that **stops the run** before it starts, asking you to generate the header
again and re-upload the sketch. A sketch built by a version of Chip Hippo that
speaks a different protocol is refused the same way.

## Running with an Arduino

Press **Run** as usual. Before anything simulates, Chip Hippo checks that every
Output and Input in use has a connection, that each connection is configured,
and that its port is plugged in — and if not, says which and offers to open the
right Properties or Settings. It then **opens each port and greets the
sketch**, asking again every quarter of a second for up to five seconds; many
boards reset when the port opens, so this is also the time a sketch has to
boot. A board that never answers stops the run with the port named, and so
does a sketch built for a different layout (above).

While it runs:

- **TX**, **RX** and **LG** lamps beside the zoom controls flash as values go
  to an Arduino, come back from one, and as log text arrives. Click any of
  them to open a [connection window](#the-connection-window) (a menu asks
  which, if there are several).
- A board that **restarts** mid-run (a reset button, a brown-out), one that is
  **unplugged**, one that fails to acknowledge a value after three attempts,
  and one whose sketch sends a value that Chip Hippo never acknowledges all
  **stop the run** with a message naming the connection. A sketch that has
  left the run has forgotten it, so press **Run** again to reconnect.

**Stop** closes every port, so the Arduino IDE can have it back to upload a
new sketch — there's no need to quit Chip Hippo between uploads.

### The connection window

Each connection has a window showing everything that happens on it, in one
stream: what its sketch printed through `ChipHippo`, and the values and
protocol frames going back and forth. Because it is one timeline, cause and
effect read in order — a value arrives, then the line the sketch printed in
response.

Open one by clicking the lamps, with **Open Connection Window** on an Output's
or Input's right-click menu (it works while the circuit runs), or by picking
the connection in Settings ▸ Serial I/O and pressing **Open window…**.

Every line starts with a mark saying what it is:

| Mark | Line | Example |
| --- | --- | --- |
| *(none)* | Text the sketch printed | `got 41` |
| `→` | A value sent to the board (an Output) | `→ OUTPUT   Display  value=0x3F dp=1` |
| `←` | A value from the board (an Input) | `← INBOUND  Keypad  code=0x07 ready=1` |
| `·` | Protocol traffic: the handshake, acknowledgements, the port opening and closing | `· ← ACK seq 12` |
| `!` | Something went wrong, and what the link did about it | `! No ACK for seq 12 — resending (attempt 2/3)` |

Arrows are always from Chip Hippo's side: `→` leaves Chip Hippo, `←` arrives.
Hover over a value's line to see the exact bytes it travelled as. A value
that had to be sent again appears once, with the resend as a warning line
beneath it.

The footer holds the controls:

- **Log**, **Data** and **Protocol** choose which lines to show — the first
  two on by default, Protocol off. Hidden lines are still recorded and come
  back when you turn them on again. **Warning lines are always shown.**
- **Timestamps** adds each line's time since the run started, to the
  millisecond (`+  12.345`) — the way to line a frame up with what the sketch
  printed.
- **Clear** empties the window. **Save…** writes the whole stream to a text
  file — every line, with its time, whatever the filters are showing.

A new Run starts the window afresh. After **Stop** everything stays, so a
failure can be read at leisure — even after closing and reopening the window.
It keeps the last 2,000 lines, follows new lines only while you're scrolled
to the bottom, and its text can be selected and copied. Each connection's
window remembers where it was and how it was set up.

## Under the hood

For the curious, or for anyone writing their own firmware: the link is a
small framed protocol over the serial port, **version 1**. Every frame is
`0x7E · TYPE · SEQ · LEN · PAYLOAD · CRC`, with `0x7E` and `0x7D` escaped
everywhere after the start byte and a CRC-16/CCITT-FALSE (polynomial
`0x1021`, initial value `0xFFFF`) over the unescaped `TYPE` to `PAYLOAD`. A
value's payload is the element's index, its width in bits, and the value as
two bytes, little-endian.

At the start of every run Chip Hippo sends a HELLO carrying the protocol
version, a fresh 16-bit session number and the layout signature (a CRC-32 of
the layout described above), and the sketch answers with its own version and
signature. Both sides take part in the run only if the two match. Outputs and
Inputs are then acknowledged and resent on a timeout or a NAK. A resend is recognised by its sequence number, so a function never runs
twice for one value, and an Output is acknowledged only once its function has
returned. Log text travels in unacknowledged chunks that never split a
character.

The whole protocol — every frame, rule and constant, with worked examples — is
on the [Serial Protocol](serial-protocol.md) page. The book icon at the top
right of Settings ▸ Serial I/O and of the Generate card opens it too.
