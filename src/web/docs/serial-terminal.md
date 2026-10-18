# Serial & the Terminal

A real bench talks to a computer through a **serial line**: one wire each way,
a byte at a time, as a train of bits. Chip Hippo has that line. Plug a
**USB-serial adapter** into the breadboard and its USB cable is a **Terminal**
window. Whatever the circuit sends shows on the screen, and whatever you type
goes down the wire to the circuit.

The line is real. A byte is a **start bit** (LOW), five to eight **data bits**
with the least significant first, an optional **parity** bit, and one or two
**stop bits** (HIGH). Each bit lasts exactly one bit time at the baud rate, in
simulated time. Nothing in between is a short cut: the wire carries levels, the
logic analyzer shows the frames, and anything that makes the right levels at
the right moments is understood. That can be a CPU toggling a VIA pin, a UART
you designed in the Chip Designer, or a handful of 74LS shift registers.

## The USB-serial adapter

It is under **COMPONENTS ▸ I/O**: an FTDI-style breakout with a six-pin
header, which plugs into six holes along one row. The board stands above the
row, so the holes below it stay free for wiring. The header is the FTDI
cable's order:

| Pin | Name | What it is |
| --- | --- | --- |
| 1 | GND | Ground, the line's reference. Join it to your circuit's − rail. |
| 2 | CTS# | Clear to send. With RTS/CTS flow control on, the adapter sends only while this is LOW. |
| 3 | VCC | USB's 5 V. **Not modelled**: power your board from a supply. |
| 4 | TXD | What the adapter **sends**. Wire it to your circuit's receive input. |
| 5 | RXD | What the adapter **listens to**. Wire your circuit's transmit output here. |
| 6 | RTS# | Request to send, held LOW: the terminal is always ready. |

The names are the adapter's own, so its TXD goes to your circuit's RxD and
your TxD to its RXD. Crossing them is the second most common serial mistake.
The first is a missing common ground: an adapter whose GND is not on the
circuit's ground is warned about (**No common ground**), because a line
with no shared reference carries nothing.

The adapter is a logic-level (TTL) port, idle HIGH. It needs no MAX232: that
chip turns these levels into RS-232's ±12 V for a cable to a PC's COM port,
and the adapter's USB does that job here. An RXD left unwired reads HIGH, as
the FT232R's own pull-up makes it, so an unplugged adapter hears nothing
rather than a stream of breaks.

### Its settings

Right-click the adapter ▸ **Properties…**:

- **Baud**: the usual rates from 50 to 115 200, or **Custom…** for any other.
- **Data bits**, **Parity** and **Stop bits**: the line's format. 8N1 (8
  bits, no parity, 1 stop bit) is the default and what almost everything uses.
- **Flow control**: *None*, or *RTS/CTS*, where the adapter holds off while
  its CTS# is HIGH. Use it when the circuit cannot keep up with a paste.
- **Enter sends**: CR, LF or CR LF. **Backspace sends**: BS (0x08) or DEL
  (0x7F). Old monitors and BASICs differ, so set what your program expects.
- **Received CR**: *CR* returns to the start of the line. *CR LF* also moves
  down a line, which suits a program that ends its lines with a CR alone
  (an Apple-1 style monitor).
- **Local echo**: shows what you type yourself, for a program that does not
  echo it back.
- **Columns**: 40, 80 or 132.

The settings belong to the part, so they are saved with the desk and travel
with a copy of it. Both ends of a line must agree: an adapter at 9600 baud
listening to a circuit sending 4800 shows **▒** where the frames break.

## The Terminal window

Right-click the adapter ▸ **Open Terminal…**. Each adapter has its own window,
named for it and its line (`Terminal — c9 · 300 8N1`).

- **While the circuit runs**, every key goes down the wire, Escape and
  Ctrl+letter included (Ctrl+C is 0x03). The ⌘ shortcuts stay the app's.
- **Paste** (⌘V) types the clipboard, a line at a time as the Enter key would.
  A long paste waits in the window and is fed as fast as the adapter can send
  it, and with RTS/CTS on, only as fast as the circuit says it is ready.
- **Stopped**, the screen stays as it was and typing does nothing. Run does not
  clear it, because a terminal does not forget when the far end goes quiet.
  **Clear** does.
- What arrives while the window is closed is still on the screen when you open
  it.

The screen is a **glass TTY**, the simplest terminal there is:

- Printable text appears at the cursor.
- **CR** returns to the start of the line, **LF** moves down one, **BS** steps
  back one column without erasing, and **TAB** goes to the next multiple of 8.
- **BEL** flashes the screen and **FF** clears it.
- Any other control byte shows as `^X`, so a stray byte is seen, not lost.
- A byte with bit 7 set shows as its low seven bits.
- A frame that arrived broken (a framing or parity error, or a break) shows as
  **▒**.

ANSI/VT100 escape sequences are not interpreted: ESC shows as `^[`.

## Baud rate and the clock

A bit time is real simulated time: at 9600 baud a bit lasts 104 µs. The
adapter times its own bits exactly, whatever the clock bricks on the desk are
doing. Each bit edge is its own simulation step, taken only while a byte is on
the wire, so an idle line costs nothing.

A circuit that makes its own bits, though, makes them at its clock's pace.
The adapter's example below shifts one bit per clock period, so a 300 Hz clock
is a 300-baud line. A CPU toggling a pin needs several clock cycles a bit.
Clock bricks run to 10 kHz, so a line a circuit drives by hand is a slow one:
110 to a few hundred baud, with the adapter set to match.

## The example: switches to the Terminal

The adapter's pin-assignments window has an **example circuit**: a serial
transmitter built from 74LS parts alone.

- **Eight DIP switches** over a resistor network set the byte. A closed switch
  reads 0 and an open one 1, so it starts as 'A'.
- **Two 74LS165s** make a sixteen-stage shift register. The first stage loads
  the **start bit**, the next eight the byte, and the rest are 1s: the stop bit,
  and the idle line after it.
- **A 74LS74 and a 74LS10** turn the button into a **load pulse** exactly half a
  bit long, starting on a clock edge. The registers load, the start bit appears
  on the line, and the next rising edge begins shifting the byte out, LSB
  first.
- **A 300 Hz clock** is the baud rate, and the adapter is set to 300 8N1.

Run it, open the Terminal, and press the button: an **A** appears. Change the
switches and press again. Put the line (the second 74LS165's QH) on the logic
analyzer and you can read the frame off the trace: start bit, 1000 0010, stop
bit.
