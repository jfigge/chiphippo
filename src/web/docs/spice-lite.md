# Spice Lite

**Spice Lite** is a second, more electrical way of running a circuit. The
standard engine treats every wire as a perfect logic level that arrives
instantly. Spice Lite adds what a real bench has: **time**, **voltages that
charge and discharge**, **current limits** on chip outputs and power supplies,
and the **resistance of the jumper wires**. Wire something up wrong and it
fails the way the real circuit would, and you can watch a capacitor charge
until it crosses a gate's threshold.

It is called _Spice Lite_ because it is **not SPICE**: there is no circuit
matrix and no manufacturer models. A plain "74LS00" still needs no
manufacturer or part choosing. Everything comes from a few shared formulas
(the exponential charge curve, Ohm's law) and a short table of numbers per
logic family, taken from TI's datasheets. You can edit every one of them.

## Turning it on

Open **Settings ▸ Spice Lite** and set **Spice Lite** to **On**. The change
takes effect the **next time you press Run**: a circuit that is already running
keeps the engine it started with.

With it **Off**, nothing on this page applies: the standard engine runs
exactly as described in [Running a Simulation](simulation.md).

## Time and charging capacitors

In Spice Lite every settle pass takes one **gate delay**: about 10 ns for
74LS parts and about 125 ns for CD4000 parts at 5 V (faster at higher supply
voltages, following the datasheet's 5 / 10 / 15 V figures). On a desk that
mixes the two, the CMOS gates take their proper share longer to answer, and a
glitch shorter than a gate's delay never makes it through that gate, as on a
real chip.

A net with a **capacitor** on it, fed through **resistors** rather than
straight from an output, becomes an **analog node**. Its voltage follows the
real charge curve toward the voltage its resistors pull it to, at the rate
their resistance and the capacitance set (the RC time constant).

- **Each input reads the node through its own threshold**: a 74LS input at
  1.4 V, a CD4000 input at half its supply. An RC delay feeding both families
  switches the 74LS gate first and the CMOS gate later.
- **A crossing happens once.** When the voltage passes an input's threshold,
  that input sees one clean change. The voltage keeps climbing, but nothing
  happens again until it falls back through the threshold.
- **A Schmitt-trigger input has two thresholds.** The 74LS14, CD40106B and
  CD4093B switch HIGH at a higher voltage than they switch back LOW (the
  74LS14 at 1.6 V and 0.8 V). That gap is what makes the classic one-gate RC
  oscillator work: a resistor from the output back to the input and a
  capacitor from the input to ground swing between the two thresholds at a
  steady rate. Built round an ordinary inverter, the same circuit has
  nothing to swing between and is reported as oscillating.
- **A chip output charges a node toward its own supply.** On a desk with a
  5 V and a 12 V supply, a 74LS output (5 V) feeding an RC can only take the
  node to 5 V, so a CD4000 gate on 12 V, which switches at 6 V, never sees it
  change: the reason a 5 V part can't drive 12 V CMOS directly.
- **A node that will never get there is left alone.** If the resistors only
  pull the node to 0.9 V, a 1.4 V threshold is never crossed, and the circuit
  doesn't wait for it.
- **Power-up is real.** An empty capacitor from a node to ground starts that
  node at 0 V. A capacitor to the supply starts it at the supply, which is how
  a power-on reset works.
- **A capacitor keeps its charge.** If a switch or button ties a node
  straight to a rail and is then released, the node starts from the voltage
  the rail left on its capacitor and drains from there, as a debounce or
  hold-up circuit does.
- **A capacitor wired to nothing is ignored.** One whose other lead sits in
  an empty column, or off the board, holds no charge and does not slow the
  node down.
- **The probe shows the voltage.** Hovering an analog node with the
  [probe](probing.md) shows its voltage beside its level, for example
  `H · 3.27 V`.
- **So does the analyzer.** An analog node on a
  [logic analyzer](logic-analyzer.md) channel is drawn as its voltage, so a
  charging capacitor curves up toward its supply instead of stepping from LOW
  to HIGH, and the channel's value reads in volts.

Slow curves cost nothing to run: Spice Lite calculates _when_ a node will
cross a threshold rather than stepping toward it, so a 10-second RC delay
runs as cheaply as a microsecond one. If the app falls behind (a busy
computer, or its window in the background), it catches up on the crossings
it missed, in order, and only an oscillator genuinely faster than the desk
can show is reported as oscillating.

### Timers

A **555** in Spice Lite times itself by its capacitor's actual curve rather
than the datasheet's rounded constants. The familiar 0.693 is really ln 2, and
1.1 is really ln 3, so the numbers barely move. One thing the constants hide
does come back: the capacitor starts **empty**, so an astable 555's **first**
HIGH period is about 1.6 times as long as the rest. The probe shows the
capacitor's voltage running between ⅓ and ⅔ of the supply.

The CD4000 RC timers keep their datasheet timing.

A timer's own capacitor (on its timing pins) is the timer's business. A
capacitor on any of its other pins is an ordinary analog node, so a power-on
reset (a resistor to the supply and a capacitor to ground on a 555's RESET)
holds the timer off until the capacitor has charged.

## Current and fan-out

Every input wired to an output draws a little current from it: a 74LS input
draws 20 µA from a HIGH output and pushes 0.4 mA into a LOW one. Spice Lite
adds these up on every net and compares them with what the driving output is
rated for.

- **Over its rating:** a **Brownout** warning names the chip, the number of
  inputs, and the current against its rating.
- **At twice its rating or more:** **brown smoke**. The chip is drawn burnt with
  brown smoke rather than grey, drives nothing for the rest of the run, and a
  **Brown smoke!** notice says why. **Stop** restores it, just as it restores
  a chip killed by over-voltage.

A CD4000 output can sink only about 1 mA at 5 V, so it can hold just two 74LS
inputs LOW. Three is a brownout, and five lets out the smoke. This is why a
CD4049UB or CD4050B buffer belongs between the two families: their outputs
are rated at 3.3 mA, enough for eight. (The standard engine's own fan-out
warning goes by the datasheet's guaranteed minimum, which allows only one;
under Spice Lite the rating above replaces it.)

Parts built to drive more carry their own datasheet ratings instead of their
family's: the 74LS bus drivers and buffers (the 74LS240, 244 and 245, for
example) sink 24 mA, and so do the 74LS595's eight outputs, while its serial
output QH′ is rated for 16 mA. An output that is switched off (a tri-state
output not enabled) adds nothing to the rating of the one that is driving.

Memories, the processors and their peripherals are MOS parts: their inputs
draw only microamps, so they barely load what drives them.

Only inputs count against this rating. An LED hanging off an output through a
resistor counts against the power supply (below), not against the output's
rating.

## Power supplies

A **power supply** brick gains a **Current limit** in its Properties (100 mA
to 5 A; 1 A unless you change it). While Spice Lite is running, the brick
shows the **current being drawn** under its voltage.

- Below its limit, a supply holds its set voltage.
- **Past its limit, the voltage droops** in proportion. Asking 200 mA of a
  100 mA supply gives you about half the voltage. The readout turns amber and
  shows both the voltage and the current.
- **A chip whose supply droops below its rating is underpowered** (an amber
  dot; hover it for the voltage it sees), exactly as if you had set the supply
  too low. Its load still counts while it is: a chip whose own outputs drag
  its supply down stays down until you change something, rather than
  flickering on and off.

The supply's load is every chip's own supply current (1.6 mA for a 74LS part,
almost nothing for CD4000), plus the current through every resistor and every
LED (see [LEDs](#leds), below): a red LED behind a 330 Ω resistor on 5 V draws
about 9.4 mA, and one wired straight across the supply draws everything it can
until it burns. It counts whether the current comes from a rail, from a chip
output driving HIGH, or through a transistor or analog switch to the supply,
and it is routed back through the ground pin of a chip that sinks it.

## LEDs

With Spice Lite on, an LED carries the current its circuit really pushes
through it, worked out from its colour's datasheet, and what that current does
to it is what it would do on a bench. The standard engine only asks whether
something limits the current; Spice Lite asks how many milliamps.

| Colour | Datasheet              | Forward voltage | Rated | Burns at |
| ------ | ---------------------- | --------------- | ----- | -------- |
| Red    | Kingbright WP7113ID    | 1.9 V at 10 mA  | 30 mA | 71 mA    |
| Yellow | Kingbright WP7113YD    | 1.95 V at 10 mA | 30 mA | 60 mA    |
| Green  | Kingbright WP7113GD    | 2.0 V at 10 mA  | 25 mA | 54 mA    |
| Blue   | Kingbright WP7113QBC/D | 3.3 V at 20 mA  | 30 mA | 39 mA    |
| White  | Kingbright WP7113QWC/D | 3.3 V at 20 mA  | 30 mA | 41 mA    |

These are ordinary 5 mm LEDs. Every segment of a display and every bar of a
bar graph is taken as an LED of its colour.

- **Nothing flows below the knee.** A red LED starts conducting at about
  1.8 V, a blue or white one at about 2.8 V; above that the voltage climbs
  slowly with the current. A blue LED behind 100 Ω on a 3 V supply barely
  glows (1.6 mA); on 5 V it is bright (18 mA).
- **Brightness follows the current.** An LED is drawn at full brightness at
  the current its datasheet quotes its brightness at (10 mA, or 20 mA for blue
  and white), dimmer below it, and with a wider glow above it. Below 50 µA it
  is dark.
- **Past its rating it is overdriven.** It lights brightly and a warning
  names the current against its rating: a red LED behind 220 Ω on 9 V takes
  31 mA. A real one would dim and fail early.
- **Past its maximum junction temperature it burns.** The datasheet gives how
  hot the junction runs per watt; once the heat the current puts in would
  take the junction past its maximum, the LED burns out (a red cross and
  smoke) and stops conducting for the rest of the run. Segments sharing one
  resistor with it then share its current too. Stopping the simulation
  restores it. The package taking a few seconds to warm up is not modelled:
  it burns at once.
- **Backwards, it is rated for 5 V.** More than that across it the wrong way
  gives a warning.
- **The probe reads its current.** Point the [probe](probing.md) at an LED's
  leg — or at the resistor beside it, or the chip output driving it — to see
  the milliamps through that lead. No part shows a current on the desk; only a
  power supply shows its draw.

**A chip output is not a perfect source.** Each output is modelled as its
datasheet says it behaves:

- A **74LS** output driving HIGH is about 3.6 V behind 120 Ω, so an LED wired
  straight from it to ground lights at about 14 mA and survives. Driving LOW
  it has almost nothing in the way, so an LED from the supply straight into it
  takes over 80 mA and burns.
- A **CD4000** output is a small transistor that can only pass so much: about
  4 mA at 5 V, 16 mA at 10 V and 28 mA at 15 V. At 5 V that is a resistor in
  all but name.
- The **NE555**'s output is good for 200 mA, and burns an LED wired straight
  to it. The **CD4511B**'s segment outputs, and the **CD4049UB** and
  **CD4050B**'s sinks, are stronger than an ordinary CD4000 output, as their
  datasheets say.

## Wire resistance

Every jumper wire is treated as **24 AWG copper** at its real length, about
0.084 Ω per metre. Current from a supply is routed through the wiring to each
chip, and a chip loses the voltage dropped across the wires its current shares
with others. A chip at the end of a long chain of jumpers sees a little less
than the chip next to the supply.

The effect is honest but small: a 10 cm jumper is under 0.01 Ω, so it takes
a heavy load to see it. Drops under a millivolt are ignored.

## Decoupling capacitors

Each time a chip's output switches, it draws a brief extra spike of current
to charge what it drives. When many outputs switch at once, those spikes
add up, and on a supply that is already close to its limit they can tip it
over. Spice Lite warns with **Supply spike**.

A capacitor wired **across a chip's supply** (VCC to ground, the usual
100 nF beside every chip) supplies those spikes itself, and the supply never
sees them. Spice Lite does not know where along the rails a capacitor sits
or what its value is: one capacitor anywhere across the rails a chip's
supply pins are on decouples that chip. A capacitor from a signal net to
ground is a timing capacitor, not a decoupling one, and doesn't count.

## The Spice Lite settings

**Settings ▸ Spice Lite** holds:

- **Spice Lite**: On or Off.
- **Settle gap**: how close a voltage that no input is watching has to get to
  its final value before the probe and the analyzer stop redrawing it. 1 % is about five time
  constants. It never holds the circuit up.
- A **TTL | CMOS** strip showing the families your tray shows (and any family
  the open project uses). Under each are its datasheet source, a **Reset to
  defaults** button, and an **Advanced** section with every number Spice Lite
  uses for that family: gate delay, output source and sink current, input
  current HIGH and LOW, supply current per chip, the input LOW and HIGH
  thresholds, and the switching load. CMOS values are stated at 5 V: the
  gate delay and the input thresholds follow each chip's supply, and the
  currents and the switching load are used as their 5 V figures at any
  supply.

Every change, the numbers included, applies at the **next Run**: a circuit
that is running keeps the settings it started with. Your changes apply to
every project on this computer. A field that won't read (a negative number,
or a LOW threshold above the HIGH one) turns red and keeps the previous
value. A very short gate delay is taken as no more than about 64 times faster
than the slowest gate on the desk, so a run never crawls.

## What stays the same

- **Exports**: the KiCad and Digital exports ignore Spice Lite entirely and
  use your parts' real values.
- **The AI builder** and the **example circuits** are proven on the standard
  engine.
- **The standard engine** is untouched: with Spice Lite off, every circuit
  behaves exactly as before.

## What Spice Lite does not model

To keep it light, some things are left out deliberately:

- an output's voltage sagging under load as the inputs on it read it (a HIGH
  output still reads as its supply voltage; only an LED's current takes the
  output's real strength into account);
- current sharing across parallel wires, and the resistance of the
  breadboard's own contacts;
- inductors ramping their current (an inductor is still a wire);
- a resistor chain through an intermediate net;
- a step coupled through a capacitor: when the far side of a capacitor jumps,
  the node on this side doesn't jump with it, so an AC-coupled trigger (a
  capacitor feeding a 555's TRIG from a button) does nothing;
- a diode or Zener's own current, other than as a fixed 0.7 V drop;
- heat, beyond an LED's own junction; signal reflections on long wires; and
  crosstalk between wires.
