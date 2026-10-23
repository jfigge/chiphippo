# Spice Lite

**Spice Lite** is a second, more electrical way of running a circuit. The
standard engine treats every wire as a perfect logic level that arrives
instantly. Spice Lite gives **every wire a voltage** and every input reads the
voltage on its own pin, and it adds what a real bench has: **time**, **voltages
that charge and discharge**, **currents** through every part and the limits
of the outputs and power supplies that deliver them, and the **resistance of
the jumper wires**. Wire something up wrong and it fails the way the real
circuit would, and you can watch a capacitor charge until it crosses a gate's
threshold.

![An LM7805 under load in Spice Lite: the 9 V supply reads 311 mA, the electronic load reads 5.00 V, 300 mA and 1.50 W, and a warning says the regulator is burning 1.27 W and wants a heatsink](images/spice-lite.png)

It is called _Spice Lite_ because it is **not SPICE**: there is no
circuit-wide matrix and no manufacturer models. A plain "74LS00" still needs
no manufacturer or part choosing. Everything comes from a few shared formulas
(Ohm's law, the exponential charge curve) and a short table of numbers per
logic family, taken from TI's datasheets, and one common set for the diodes
and transistors.

## Turning it on and off

Spice Lite is **On** by default. To use the standard engine instead, open
**Settings ▸ Spice Lite** and set **Spice Lite** to **Off**. The change
takes effect the **next time you press Run**: a circuit that is already running
keeps the engine it started with.

With it **Off**, nothing on this page applies: the standard engine runs
exactly as described in [Running a Simulation](simulation.md).

## Every wire is a voltage

Each time the circuit settles, Spice Lite works out the **voltage on every
wire** from what is on it: each chip output as the circuit it really is, each
input's own current, and every resistor, LED, diode, transistor and switch
between them. Then **every input reads the voltage on its own pin**:

- At or above its **HIGH threshold** (2 V for 74LS, 3.5 V for CD4000 at 5 V)
  it reads HIGH; at or below its **LOW threshold** (0.8 V and 1.5 V) it reads
  LOW. **In between it is undefined**, and the gate's output with it. A
  Schmitt-trigger input (74LS14, CD40106B, CD4093B) keeps what it last read
  until the voltage leaves its hysteresis.
- **The level a wire shows** is what the inputs on it read. Most of the time
  that is exactly what the standard engine shows; where the voltage says
  otherwise, the voltage wins.

What that changes:

- **A divider reads its voltage.** 10 kΩ to the supply and 1 kΩ to ground
  makes about 0.6 V at a 74LS input — LOW. The standard engine, with two
  resistors pulling against each other, can only say undefined. A
  [potentiometer](components.md#potentiometers)'s wiper reads where you set it.
- **A diode has a drop.** A diode-AND (inputs on the cathodes, a pull-up on
  the joined anodes) gives a diode's drop, about 0.6 V, above a LOW output, which reads
  LOW. An LED or a diode in a chip's supply drops its voltage too.
- **A 74LS input pushes current out of its pin** while it is held LOW:
  about 0.23 mA at 0 V, less and less as the pin rises, down to 0.11 mA at
  1.08 V, where the gate switches and lets go. Pulled down through **1 kΩ** it
  sits at about 0.21 V, a good LOW, and through **4.7 kΩ** at 0.7 V, still
  LOW; through **10 kΩ** it sits at the gate's switch, 1.09 V, in its
  undefined band — the reason a 74LS input is never pulled down through more
  than a few kilohms on a real bench. A CD4000 input draws nothing, so
  10 kΩ is fine there. The example circuits pull 74LS inputs down through
  1 kΩ for this reason.
- **A 74LS HIGH is about 4.3–4.5 V**, unloaded, and falls fast under a load:
  3.6 V by 0.2 mA, 3.4 V at 4 mA. That is plenty for another 74LS input,
  and only just enough for a CD4000 input on 5 V once anything else hangs on
  the wire; on 12 V it is no HIGH at all. (The higher figure is a gate whose
  input is grounded; one whose input is held LOW by another 74LS output sits
  lower, because that input's 0.2 V leaves its output transistor a little
  on.)
- **A loaded output sags.** A CD4000 output at 5 V lighting an LED through
  330 Ω sags to about 3.2 V — under its own family's HIGH threshold, so a
  CD4000 input on the same wire reads it as undefined. Through 1 kΩ it stays
  at 4.1 V. The CD4000 example circuits use 1 kΩ for their LEDs for this
  reason.
- **Two outputs fighting** meet where their strengths put them: a 74LS LOW
  gives out at about 18.5 mA, all its drive allows, so a 74LS HIGH lifts the
  wire to about 1.5 V — undefined to the inputs on it. The conflict is
  reported, and both outputs carry the current (below).
- **Open-collector outputs** (74LS01, 74LS03, 74LS05, 74LS47, and the
  74LS181's A=B) never drive HIGH: wired together with a pull-up they make a
  wired-AND, in both engines.
- **A wire nothing holds** — inputs alone, or a lead to an LED that is off — is
  floating, and reads as each family reads a floating input: HIGH for 74LS,
  undefined for CD4000. A diode or LED that is conducting holds the wire it
  feeds, so a rectifier's output has a voltage while current flows through it.

The [probe](probing.md) shows the voltage of every wire that has one beside
its level (`H · 3.60 V`), and the current through the lead in the hole it is
on. A floating wire shows its level alone.

## Time and charging capacitors

In Spice Lite every settle pass takes one **gate delay**: about 10 ns for
74LS parts and about 125 ns for CD4000 parts at 5 V (faster at higher supply
voltages, following the datasheet's 5 / 10 / 15 V figures). On a desk that
mixes the two, the CMOS gates take their proper share longer to answer, and a
glitch shorter than a gate's delay never makes it through that gate, as on a
real chip. A circuit on its own boards and its own supply keeps its own pace:
a CD4000 oscillator beside a 74LS board steps at its own gates' delay, not the
74LS parts', and keeps time as it would on a desk of its own.

A net with a **capacitor** on it becomes an **analog node**. Its voltage
follows the real charge curve toward the voltage the circuit round it pulls it
to, at the rate the circuit's resistance and the capacitance set (the RC time
constant). The whole circuit round it counts: a chain of resistors, a switch
or transistor, the resistance inside the chip output driving it, and the
current an input on it draws. A CD4000 output charging a capacitor straight
can only deliver its limited current (about 4 mA at 5 V), so the capacitor
first charges in a **straight line** and then curves the rest of the way.

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
- **A 74LS input on a node pushes its own current into it** below 1.1 V, so
  an RC into a 74LS input starts faster than its R·C alone, and a 74LS14
  oscillator needs a resistor of a kilohm or so to swing at all (through
  10 kΩ its own input holds the capacitor above its lower threshold).
- **A chip output charges a node only as far as its HIGH.** A 74LS output
  takes it to about 4.5 V, the last of it slowly; on a desk with a 12 V supply, a CD4000 gate on
  12 V, which switches at 6 V, never sees it change: the reason a 5 V part
  can't drive 12 V CMOS directly.
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
- **A step carries through a capacitor.** A capacitor's charge can't change
  in an instant, so when the far side of one jumps, the node on this side
  jumps with it and then settles back through its resistors. A button
  feeding a 555's TRIG through a capacitor triggers it, and the two-inverter
  RC oscillators (the CD4060B's and CD4541B's) work the way their datasheets
  draw them, the junction kicked past the supply each time.
- **Capacitors that see each other move together.** Two or more capacitors
  joined through resistors (an RC ladder, a filter) or a capacitor between two
  charging nodes are worked out as one circuit, exactly: a high-pass passes
  its pulse, a ladder's last node lags its first by the right amount, and the
  answer is the same however often the desk is redrawn.
- **The analyzer draws voltages.** A channel on a
  [logic analyzer](logic-analyzer.md) is drawn as its wire's voltage, so a
  charging capacitor curves up toward its supply instead of stepping from LOW
  to HIGH, and a 74LS signal swings between about 0.2 V and 4.4 V. The
  channel's value reads in volts. In the analyzer's Transitions view a
  voltage counts as changed once it moves 1 % of the lane's full scale.

Slow curves cost nothing to run: Spice Lite calculates _when_ a node will
cross a threshold rather than stepping toward it, so a 10-second RC delay
runs as cheaply as a microsecond one. If the app falls behind (a busy
computer, or its window in the background), it catches up on the crossings
it missed, in order.

**An oscillation faster than the desk can show** (anything above 1 kHz,
the fastest clock on offer) is recognised once it has gone round twice the
same way. From then on it is drawn at 1 kHz with its duty cycle kept, as
the standard engine draws a fast 555, while time itself runs at its true
rate: a timer's readout shows the **true** frequency, and a CD4060B or
CD4541B counting its own oscillator counts every real cycle. Anything that
changes the circuit (a reset, an edited value, a supply moving) ends the
fast drawing, and the oscillator is worked out afresh. An RC round an
ordinary (non-Schmitt) inverter has no second threshold to swing to: it
chatters at its one threshold and is reported as oscillating.

### Timers

In Spice Lite a timer is the circuit inside it, not a formula. Each one is
built from its datasheet's own block diagram: comparators reading the
voltages on its pins against their references, the package's own resistors,
a discharge transistor, and the flip-flops behind them. Nothing in it
computes a period. The period is whatever your resistor and capacitor
actually do, so the circuits the formulas never covered work too.

- **The 555**: three 5 kΩ resistors from VCC to ground inside it set its two
  trip points at ⅔ and ⅓ of the supply (CONT is the top tap), the threshold
  and trigger comparators set and reset its latch, and DISCH is a real
  open-collector transistor. The familiar 0.693 is really ln 2 and 1.1 is ln 3,
  so the usual circuits run within a percent or two of the formula; the
  capacitor starts **empty**, so an astable's **first** HIGH is about 1.6
  times as long as the rest. A voltage on CONT moves both trip points, RA
  built from two resistors in series works, a trigger through a capacitor
  fires it, RESET reads its own 0.7 V threshold, and a DISCH asked to sink
  more than its 200 mA rating says so.
- **The CD4047B**: R and C are driven in opposition from its oscillator's
  input on RC COMMON, which switches at half the supply, exactly the swing
  its datasheet's own design formulas describe: 4.40·RC astable, 2.48·RC for
  a one-shot, a retrigger running it on by whole 2.2·RC periods.
- **The CD4098B, CD4528B and CD4538B**: a trigger turns on the transistor
  that empties Cx, and the pulse ends when Rx has charged it back up to the
  upper reference. Their datasheets give only the formula (½·RC, 0.2·RC·ln
  VDD, RC), so the references are worked back from it (the lower at 5 % of
  the supply), and at 100 kΩ and 100 nF every width comes out within about a
  percent of the sheet (a CD4528B at 5 V runs 1.2 % long). A small Rx with a
  large Cx strays further, because the discharge transistor's own resistance
  starts to count: a CD4538B at 10 kΩ and 1 µF runs 2.3 % long. A retrigger
  empties the capacitor again, and RESET holds it empty. The discharge
  transistor is held to its datasheet's **least Rx** — 5 kΩ for the
  CD4098B, 4 kΩ for the CD4538B (the CD14538B sheet), and 5 kΩ for the
  CD4528B (the smallest its sheet tests at; it states no minimum). What it
  carries while it **holds** the capacitor — RESET LOW against Rx — is
  checked against what that least Rx would let through (the transistor's own
  resistance included, so an Rx exactly at the minimum is fine): a smaller Rx gives a
  **Timing resistor too small** warning, and past 100 mW in the transistor
  the brown smoke. The burst of current as it empties Cx at a trigger is
  not checked: real silicon does the same, and the datasheets bound it by
  the largest Cx instead (100 µF for the CD4098B and CD4538B, which a larger
  capacitor is warned about).
- **The CD4060B and CD4541B**: Rx, Cx and Rs on one junction, as in their
  datasheets. The junction is kicked past the supply each time an output
  switches, and Rs keeps the input's protection diodes off it, which is why
  the datasheets ask for it: leave Rs out and the period is visibly shorter.
  Both run at about 2.23·Rx·Cx with Rs at twice Rx, the 4060's 2.2 and the
  4541's 2.3 on their sheets (so the 4060 runs about 1.5 % slow of its
  formula and the 4541 about 3 % fast of its own). A CD4541B with AUTO
  RESET enabled (pin 5 wired LOW) draws the extra supply current its
  datasheet gives for it — 7 µA at 5 V, 30 µA at 10 V, 80 µA at 15 V. The
  formula leaves out
  the chip's own outputs, each about 400 Ω at 5 V (and more as they carry
  more), which sit in series with Rx and Cx: harmless with Rx at 10 kΩ and
  up, but at Rx = 1 kΩ a CD4060B's period comes out about 29 % longer than
  2.2·Rx·Cx.

A running timer's readout shows what it **measured**: the frequency between
its last two rising edges, or the length of its last pulse. The Properties
card's Timing row still gives the datasheet's figure, worked out from the
values you set. Under Spice Lite a timer never complains that it doesn't
recognise its wiring: it does whatever its pins make it do. It still says
when a pin it needs is left unwired, or a terminal that must be grounded
isn't (a CD4528B's T1): it cannot time at all then. The probe shows
the real voltage on every timing pin (THRES and TRIG, CONT, RX CX, RC
COMMON, an oscillator's junction).

The CD4000 timers' outputs, and the 555's, are as strong as their
datasheets say, and are judged by the same current limits as any other
output.

## Current and fan-out

Every input wired to an output draws a little current, as its own circuit
does: a 74LS input pushes about 0.2 mA out of a pin held LOW (it is a
resistor and a diode to its supply inside), and nothing once its pin is past
about 1.1 V; a CMOS input, or a memory's or processor's, draws nothing at
all. So an output with many inputs on it is pulled away from its level by
them, and the voltage it ends up at is the one every input on it reads.

- **A Brownout warning** names an output whose load holds its net where an
  input on it no longer reads the level the output is driving — though it
  would at the output's own unloaded voltage. It says the pin, the level and
  the voltage the net is held at. Too many inputs is one cause; a resistor to
  ground that is too small for a HIGH (a 74LS HIGH into 100 Ω sits at about
  1.8 V) is another. A brownout never damages anything: it is a circuit that
  does not work, not a part in danger.
- An output that never reaches an input's threshold even unloaded — a 74LS
  HIGH's 4.5 V into a CMOS input on 12 V — is a level mismatch, not a
  brownout: that input simply reads it as unknown.

A CD4000 output at 5 V holds one 74LS input LOW at about 0.1 V, two at 0.2 V,
five at 0.4 V and six at 0.45 V — all LOW to them, typically, though the datasheet
guarantees only one (which is what the standard engine's fan-out warning goes
by; under Spice Lite the voltage replaces it). The CD4049UB and CD4050B
buffers, whose LOW is about five times stronger, are what belongs between the
families in a design that has to work with every part off the shelf.

Every part of a family shares that family's numbers: a 74LS244 bus driver
drives as every other 74LS output does, so a circuit behaves the same
whichever maker's 74LS parts you picture on the bench. An output that is
switched off (a tri-state output not enabled) drives nothing and is no part of
a brownout.

### Shorts and overloaded pins

What damages an output is the current through it, which Spice Lite knows for
every output pin, whatever it is driving, and holds each to what its family is
made for:

| Family                    | Warning                    | Brown smoke |
| ------------------------- | -------------------------- | ----------- |
| 74LS (and memories, CPUs) | over 20 mA through the pin | over 100 mA |
| CD4000                    | over 50 mW in its output   | over 100 mW |

Past the smoke limit the chip is drawn burnt with brown smoke rather than
grey, drives nothing for the rest of the run, and a **Brown smoke!** notice
says why.

A 74LS HIGH shorted to ground carries about 32 mA (a warning); a LOW shorted
to the supply about 150 mA (brown smoke). Two 74LS outputs fighting each other
carry about 19.5 mA, just under the warning. An ordinary CD4000 output at 5 V cannot pass enough current
to hurt itself; at 15 V a short lets out the smoke. The CMOS parts built to
drive more — the CD4049UB/CD4050B buffers' LOW, the CD4511B's segment drivers
— are held to the same 100 mW per output transistor their datasheets give
every B-series output, so a buffer's LOW shorted to a 15 V supply smokes too.
The NE555's output is held to its own sheet's 200 mA.

An **analog switch** channel (CD4066B, CD4051B/52B/53B) is rated for 10 mA:
past it a **Switch overloaded** warning, and past 25 mA brown smoke. A
CD4066B channel switched on straight across a 5 V supply carries 10.6 mA.

A **transistor** is held to the common limits of its kind:

| Transistor        | Warning                | Smoke                  |
| ----------------- | ---------------------- | ---------------------- |
| NPN / PNP (TO-92) | over 200 mA, or 312 mW | over 600 mA, or 625 mW |
| MOSFET, TO-92     | over 200 mW            | over 400 mW            |
| MOSFET, TO-220    | over 1 W (no heatsink) | over 2 W               |

A transistor past its smoke limit is said with a warning that a real one
would have failed, but it carries on conducting: it has no supply pins, so
nothing on the desk can be switched off for it.

Inputs have limits too:

- **A 74LS input over 7 V** lets out the smoke — a CD4000 output on 12 V wired
  into one, for instance.
- **A CD4000 input held beyond its own supply** (more than 0.5 V above its VDD,
  or below ground) conducts through its protection diode, which is warned
  about, and lets out the smoke past 10 mA. The CD4049UB and CD4050B have no
  diode to their supply, which is what lets them take a higher voltage than
  they run on: they are the level shifters. A **memory's, processor's or
  peripheral's** input has the same two diodes and the same limits, and so
  does an analog switch's control pin and a CD4007UB's gate.
- **A CD4000 input left in its undefined band** draws about 0.5 mA from its
  own supply while it is there, as both of its input transistors are part-way
  on. (A CD4007UB's gate is a bare transistor's, and draws nothing of its own:
  what its pair conducts is the current.)

A **short through a transistor or an analog switch** — one switched on with
its two ends on opposite supplies — is reported as a **Short circuit** only
when the current really flowing through it is 100 mA or more, or the supply
it is on has hit its current limit. The standard engine reports every such
join; under Spice Lite a transistor whose base is fed through 10 MΩ, passing
microamps, is no short. A short with no part in it (two supplies wired
together) is always reported.

**Stop** restores every chip that let out its smoke.

## Power supplies

A **power supply** brick gains a **Current limit** in its Properties (100 mA
to 5 A; 1 A unless you change it). While Spice Lite is running, the brick
shows the **current being drawn** under its voltage.

- Below its limit, a supply holds its set voltage.
- **Past its limit, the voltage droops** in proportion. Asking 200 mA of a
  100 mA supply gives you about half the voltage. The readout turns amber and
  shows both the voltage and the current.
- **A supply has its own output capacitor** (470 µF), as a bench supply
  does. A load that asks for more than the limit for a moment gets the rest
  out of that capacitor, and the voltage sags only as fast as it drains: a
  motor switched by a 555's PWM draws its 2 A peaks from a 1 A supply while
  the supply dips under a volt and the 555 keeps its rate. An overload that
  lasts takes the supply down to its droop over a few milliseconds, and it
  comes back up as the capacitor recharges at the limit. A supply already
  overloaded when you press Run starts at its droop.
- **A supply feeding only regulators and analog parts** (no chip or clock
  brick powered straight from it) works like a bench supply in
  **constant-current** mode instead. It delivers exactly its limit, at
  whatever voltage that takes, until the load asks for less, then holds its
  set voltage again. A 7805 charging a big output capacitor from a 1 A
  supply charges it at a steady 1 A, with the supply sitting a dropout above
  the rising output.
- **A supply shorted + to −** (its + wired to a ground) is held at its limit
  and droops to a fraction of a volt, with a **Short circuit** notice; every
  chip on it is underpowered.
- **A chip whose supply droops below its rating is underpowered** (an amber
  dot; hover it for the voltage it sees), exactly as if you had set the supply
  too low. Its load still counts while it is: a chip whose own outputs drag
  its supply down stays down until you change something, rather than
  flickering on and off. For the first **half second** after Run the
  dot is all it gets: a supply still coming up (a regulator behind a
  rectifier's reservoir capacitor passes 2 V on its way to 5 V) is not
  a fault, so the **Underpowered** notice waits, and appears only if the
  chip is still short of its rating after that.

The supply's load is every chip's own supply current (1.6 mA for a 74LS part,
almost nothing for CD4000), plus everything the voltages make flow: the
current through every resistor, LED, diode, transistor and switch from the
supply, and out of every chip output into whatever it drives (see
[LEDs](#leds), below): a red LED behind a 330 Ω resistor on 5 V draws about
9.4 mA, and one wired straight across the supply draws everything it can
until it burns. Current a chip sinks is routed back through its own ground
pin.

## AC supplies and transformers

Three bricks in **COMPONENTS ▸ Power** appear only while Spice Lite is on,
because the standard engine has no voltage below 0 V and nothing that
alternates: to it, each one is nothing at all. Each has its job. For
low-voltage AC on the board, use the **AC adapter**. To look inside a linear
power supply, use **mains** and a **transformer** together. Every time an AC
wave crosses a logic input's threshold is an edge, ticked at its own moment
as a clock's edge is.

- **Mains** is the wall socket. It puts a sine on its **L** (line) terminal
  about its **N** (neutral) terminal. N is earthed, like the neutral of real
  mains, so it is a ground, like a power supply's −. Its **Output** is
  **100 V~**, **120 V~**, **230 V~** or **240 V~** and its **Frequency**
  **50 Hz** or **60 Hz**; a new one starts at your country's mains (120 V~
  at 60 Hz in North America, 100 V~ in Japan, 230 V~ at 50 Hz in most of the
  rest of the world). Those are RMS figures, as AC is labelled, so 120 V~
  swings to ±170 V. Mains is for a transformer's primary, not for the
  breadboard.

Every one of these sines starts at its centre on its way up when you press
Run, and runs on simulated time alone, so it ticks the desk only where
something it feeds changes. Change a Frequency while it runs and the sine
carries on from where it stood, at the new rate. With N (or COM) unwired a
source drives nothing: there is no return for its current.

- **The AC adapter** is a wall transformer, already plugged into the wall:
  you wire only its output, **S1** and **S2**, to the board. Its **Output**
  is **9**, **12**, **16**, **18** or **24 V~**, or Custom…, and its
  **Frequency** is **50 Hz** or **60 Hz**; a new one starts at your country's
  (60 Hz in North America, 50 Hz in most of the rest of the world), and the
  brick shows it under its output. Change it while the circuit runs and the
  sine carries on from where it stood, as the mains' does. Its output is
  **isolated** from the mains, as a real adapter's is: nothing ties it to
  earth, so it floats with whatever the circuit connects it to (the brick
  shows a pair of nested squares). It is rated 1 A and sags 10 % at that. To
  work from the mains itself, use a mains brick and a transformer.
- **The transformer** has two windings on one core: the primary across
  **P1–P2** and the secondary across **S1–S2**, isolated from each other,
  with P1 and S1 the dotted ends that move together. Its **Rating** is a
  small bench transformer: **120 V → 12 V**, **9 V** or **5 V**, or
  **230 V → 12 V** or **5 V**. Choose **Custom…** to set the **turns ratio**,
  the primary's **inductance**, each winding's **resistance** and the
  **coupling** between them (0.5–0.999; no real core is perfect). It is
  solved as two coupled coils, not as an ideal ratio. Its secondary sags under
  load, and its primary draws a magnetising current with nothing on the
  secondary. A secondary shorted end to end loads the primary as hard as a
  real one would. DC across a winding is a short through its resistance.

**AC wired straight into a logic input burns it.** A 74LS input has a clamp
diode to ground, which carries whatever a source below 0 V can push: past
18 mA it warns, and past 50 mA the chip lets its smoke out. Above 7 V the
input is past its absolute maximum, as with any supply. A CD4000 input's
protection diodes conduct past either rail and smoke past 10 mA. The moment
a wire puts the mains' L, an adapter's output or either end of a transformer
winding on a logic input, an **AC on a logic input** notice says so, before
anything runs. Feed it through a resistor and clamp it instead, with a diode
or a Zener to ground, or rectify it first with the **Bridge rectifier**
(COMPONENTS ▸ Diodes). A resistor, diode or capacitor in the way silences
the notice, and so does an op-amp's input, which is made to take an analog
voltage.

### Where a floating circuit's ground is

**A voltage is always measured between two points.** Every voltage Spice
Lite shows is read against ground: a power supply's − or the mains' N. An
AC adapter's circuit is not joined to either, so Spice Lite gives it a
ground where you would clip a meter's black lead on the bench. It looks
through the circuit the adapter feeds, and takes the first of these it finds
there:

1. the **analyzer's ground lead**, if you have put it on that circuit
   (below);
2. a breadboard **− rail** strip;
3. a **bridge rectifier's −**, where the AC becomes DC;
4. a **regulator's GND**;
5. the adapter's own **S2**.

A circuit that a power supply's − (or anything else with a ground) reaches
keeps that ground instead. So the usual supply reads the way it should: an
adapter into a bridge rectifier, the bridge's − on the ground rail, a
reservoir capacitor, and a 7805 with its GND on the rail reads a flat 5 V on
its output.

**Do not feed a bridge rectifier straight from mains.** Mains' N is ground,
so the bridge's − swings against it, down to the negative peak every other
half-cycle. A 5 V regulator after it reads 5 V above its own GND, but
anywhere from about +5 V to −165 V against ground. Tie the bridge's − to
ground and one of its diodes sits straight across the mains every other
half-cycle, and it burns. Use an AC adapter instead, or put a transformer
between the mains and the bridge, as every real supply does. Leave both AC pins of the
bridge off the ground rail: grounding one of them as well shorts a diode in
the same way, as it would on the bench. With a **transformer** instead of an
adapter, put a **reservoir capacitor** (a few thousand µF) from the bridge's +
to ground ahead of the regulator. Without it, nothing takes the current the
transformer's leakage keeps pushing when the regulator stops charging its
output, and the regulator's input spikes to thousands of volts.

### The analyzer's ground lead

The **logic analyzer** reads every voltage lane against ground. To read them
against a net of your own, as a scope does with its ground clip on that net,
turn the probe on (**I**), right-click the hole or wire, and choose **Use as
analyzer ground**. A small ground clip marks the hole, and the analyzer's
header shows the net it is on. One lead serves every lane, as a scope's
channels share one ground. On an AC adapter's floating circuit the lead is
also that circuit's ground (rule 1 above), so the probe reads from it too. To
take it off, choose **Remove analyzer ground** on that net, or click the ×
beside it in the analyzer's header.

The **logic analyzer** draws a channel that goes below 0 V (or above the
supply) on a lane widened to take it in, at a round figure: 12 V~ draws
from −20 V to +20 V, with a dashed line at 0 V.

The AC adapter's **pin-assignments window** has an example of three
desktops: **Clipping** (a mains timebase: a 12 V~ adapter, 10 kΩ and a
4.7 V Zener into a 74LS14, counted down to 1 Hz), **Zero crossing** (an
LM358 comparator on the adapter's output, flipping at each crossing) and
**Schmitt trigger** (the same with positive feedback, so it flips a little
after each crossing and no noise near one can flip it back). The mains' and the
transformer's windows share **Step-down**: 120 V~ to ±17 V, and the sag
when a switch adds a second load.

## Chips powered off the rails

A chip whose supply pins are not wired straight to the rails — fed through a
resistor, a diode, a transistor, or from another chip's output — runs at the
**voltage that actually reaches its pins**. Its own supply current is a load
on whatever feeds it, and so is everything its outputs drive: an LED lit from
one of its outputs is fed through its VCC pin, so a 74LS04 fed through 47 Ω
sags to about 4.6 V lighting one — underpowered, and still lighting it. A 74LS
chip fed through a diode gets about 4.4 V and is underpowered (it needs
4.75 V); a CD4000 chip, which runs from 3 V, works on the same feed, and its
HIGH outputs are the 4.4 V it is running on. Its outputs and inputs are
measured from its own pins: a chip whose ground is raised drives its LOW at
that ground, and a chip across two supplies' rails (VDD on 12 V, VSS on the
5 V rail) runs on the 7 V between them, its LOW at 5 V and its HIGH at 12 V.
The standard engine sees only a supply pin that is not on a supply.

## Diodes and transistors

A diode and a transistor are each the **Grade** their **Properties…** card
picks — a card that offers it only while Spice Lite is on. A diode's part
number does not change it (a bridge rectifier's four are one kind of their
own, below):

| Type             | Grades (the part each one simulates as)                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| NPN              | **Small signal** (2N3904) · **General purpose** (2N2222A) · **Darlington** (TIP120) · **Power** (TIP31C) |
| PNP              | **Small signal** (2N3906) · **General purpose** (2N2907A) · **Darlington** (TIP125) · **Power** (TIP32C) |
| N-channel MOSFET | **Logic level** (2N7000) · **Logic-level power** (IRLZ44N) · **Power** (IRF540N)                         |
| P-channel MOSFET | **Logic level** (BS250) · **Power** (IRF9540N)                                                           |

A transistor in a **TO-92** defaults to the first of its type's grades, one
in a **TO-220** to **Power**, until you pick one; picking a part from its
part-number list picks its grade too. A grade you have picked stays when you
change the package. Each grade is that one part's datasheet figures.

The last entry in the list is **Custom…**. It opens the grade's figures under
the list, filled in from the grade that was showing — a bipolar transistor's
**gain hFE** and **base turn-on VBE** (both at a tenth of its rated current,
VCE 5 V), its **breakdown VCEO** and its **max current IC**; a MOSFET's
**threshold VGS(th)**, its **on-resistance RDS(on)** (at VGS 10 V), its
**breakdown V(BR)DSS** and its **max current ID**. Type any of them the way
any value is typed (`1A5`, `300m`, `2.2`); the transistor then simulates as
the grade it started from with those figures put back exactly. A P-type's
figures are the same magnitudes. Picking a grade again puts its own figures
back. A set of figures that are a grade's own simply _is_ that grade, so a
card reopened on one shows the grade's name, never Custom….

- A **diode**'s Grade is one of four, each one common part's curve:
  - **Small signal** (the 1N4148, the default): about 0.5 V at 0.1 mA,
    0.62 V at 1 mA, 0.75 V at 10 mA and 0.87 V at 50 mA. It burns past about
    a third of an amp, so it is no rectifier: charging a big capacitor
    through one burns it.
  - **Rectifier** (1N4001–1N4007, 1 A): the curve a bridge rectifier's
    diodes follow (below) — about 0.77 V at 100 mA and 0.91 V at 1 A — and
    it burns only past its 30 A surge rating.
  - **Power** (1N5400–1N5408, 3 A): about 0.64 V at 100 mA and 0.89 V at
    3 A; it burns past its 200 A surge rating.
  - **Schottky** (1N5817–1N5819, 1 A): the lowest drop — about 0.26 V at
    100 mA and 0.39 V at 1 A — burning past its 25 A surge rating. Its
    reverse leakage and its 40 V breakdown are not modelled.

  A **Zener** is always the small-signal kind, and also conducts backwards
  at its Zener voltage, so it clamps and regulates. One that carries more
  than its junction can take burns, like an LED. The bill of materials
  names a graded diode's parts (`1N4001–1N4007`) when it has no part number
  of its own.
- A **bridge rectifier**'s four diodes follow a 1 A rectifier's curve (the
  1N4007's, the die a DB-1 bridge holds): about 0.55 V at 1 mA, 0.77 V at
  100 mA and 0.86 V at half an amp. Every bridge is that one kind, whatever
  its part number. A bridge's diodes follow a simpler form of that curve
  than a Rectifier-grade diode does, within 10 mV of it from 0.1 mA up. A
  bridge switches on and off twice every cycle, and the simpler curve runs
  it about twice as fast. Against SPICE's own 1N4007, a bridge supply's
  output stays within half a percent. Two of them conduct at a time, so the DC out is the AC's
  peak less two drops. The first charging pulse into a big reservoir
  capacitor can be many amps, which a real bridge is rated to take, so it
  burns only past its 30 A surge rating.
- A **bipolar transistor** (NPN, PNP) has **gain**: its base conducts from
  about 0.6 V, and its collector carries its gain (a few hundred for a small
  part, a few thousand for a Darlington) times the base current — no more
  than the circuit lets through, in which case it is **saturated**, a tenth
  of a volt or less across it (a Darlington, whose output transistor is
  driven by another, never below about 0.7 V). Its gain falls at high
  currents as its datasheet's does. A base fed through 10 MΩ barely turns it
  on, where the standard engine treats any HIGH base as a closed switch.
- A **MOSFET** turns on from its **gate threshold**, measured from its
  source — about 2 V for a logic-level part, 3.6 V for the IRF540N, which a
  5 V logic output only just turns fully on and a 3.3 V one not at all — its
  current rising with the square of the gate drive until its channel is
  fully on, down to its datasheet's on-resistance. Its gate draws nothing and
  **keeps the voltage it was last driven to** when left floating; the
  transistor's lamp rings amber while it does. The CD4007UB's six
  transistors are its family's own output transistors.
- An **analog switch** (CD4066B, CD4051B/52B/53B) closes and opens by the
  voltage on its control pin, read through its thresholds like any input, and
  its channel passes whatever voltage is on it through its on-resistance.

Each transistor is held to its own part's ratings: carrying more current than
its part is made for, or dissipating more than its package can (a TO-92 about
0.6 W, a TO-220 with no heatsink about 2 W), warns that a real one would fail.

A transistor's lamp on the desk lights while it conducts.

Each transistor also has what a real one has to survive an inductor (below):
a MOSFET's **body diode**, which conducts backwards from drain to source
like any diode, and a **breakdown** voltage past which the transistor
conducts anyway — 40 V across a bipolar transistor's collector and emitter,
60 V across a MOSFET. Neither is reached in an ordinary logic circuit.

## Inductors

An inductor with an **Inductance** is a real inductor under Spice Lite (with
none it is a wire, as it is on the standard engine). Its **current** cannot
change in an instant: switched on, it rises along its time constant, the
inductance over the resistance in its path; switched off, it has to go
somewhere.

- **Its winding has resistance.** Under Spice Lite an inductor's
  **Properties…** card gains a **Winding** choice — **Lowest**, **Typical**
  (the default), **Higher** or **Highest** — each showing the resistance it
  gives the part as it stands (for example, **Typical — 0.74Ω** for a 1 mH
  Coil over two holes). The figures come from real ranges of each style and
  size (a Bourns drum series for the Can, a Bourns toroid series for the
  Coil), and they move with the Inductance: a bigger value is wound with
  more, finer wire. The card offers it only while Spice Lite is on; turning
  Spice Lite off hides it and keeps your choice.
- **Switched off, the current finds a way.** A **flyback diode** across a
  relay coil carries it round, and it dies away in milliseconds; so does a
  MOSFET's body diode, or a CMOS output's protection diodes, when one of
  those is in its path. With **nothing** to carry it, the voltage across the
  coil rises until the transistor switching it **breaks down**, and an
  **Inductive kick** warning names the transistor, the voltage it reached
  and the energy the coil dumped into it. A real transistor may survive a
  few of those; it is the reason relay coils have diodes across them.
- **The probe** reads the current through an inductor's lead and the voltage
  on each side of it, and a coil and a capacitor together **ring** — an LC
  circuit is solved exactly, its oscillation included.

## Clock waves

A clock brick's **Wave type** (its Properties card) turns its square into a
**triangle**, a **trapezoid**, a **sawtooth** either way — a *ramp up* climbs
and drops straight back, a *ramp down* drops and climbs straight back — or a
**sine**, under Spice Lite only. Each swings from 0 V to the clock's supply
over one period of its rate, starting at its low point, and drives its `out`
as an ideal source, sourcing out of its supply and sinking into its ground.
Its **Amplitude** (peak to peak) and **Offset** (its centre) move that swing —
a 1 V sine about 2.5 V for an op-amp to amplify; blank, they are the whole
supply about half of it. Set past a rail, the wave is **clipped** flat on it,
exactly, as a generator running from those rails would be.
(A **PWM** clock is not a wave but a level, as the square is: it runs in both
engines — see [Power & Clock Sources](power-and-clocks.md).)

The wave keeps its square's timing: its LOW half is the first half of the
cycle and its HIGH half the second, so the triangle peaks and the sine crests
at the LOW → HIGH edge, and a sawtooth drops back at the HIGH → LOW one. A
trapezoid sits at 0 V for the first 30 % of the cycle, climbs over the next
20 % to reach its supply at the LOW → HIGH edge, holds there for 30 % and
falls over the last 20 %, back at 0 V by the HIGH → LOW edge. **Step**
moves it half a period, **Pause** stops it where it is, and a clock held by its
own **⏸** holds its voltage, picking up from there when it is let go.

It is solved like a capacitor's curve, never stepped: an RC filter fed a sine
gives the filter's own gain and phase, a capacitor carries a sawtooth's drop
straight through, and an input reads the wave where it crosses its threshold
— a Schmitt-trigger input (a 74LS14, a CD40106B) squares a triangle or a sine
at its two thresholds, an LM358 follows it to 1.5 V short of its supply. The
clock's lamp lights while its output is above half its supply, and the logic
analyzer draws the wave, sixteen points a period (at most one every 2 ms) —
while it has a channel to record. Each of those points is a whole tick of the
desk, so with no channels the wave asks only to be redrawn as often as any
other moving voltage.

## Bench parts

The regulators, the relay, the electronic load, the LM358, the LM339, the
ULN2003A and the optocouplers are each what they are under Spice Lite, in the
same voltage solve as everything else (one common set of figures per kind,
from the TI, Vishay and Sharp datasheets):

- **A linear regulator** holds its output at its voltage — a 78xx's above its
  GND, an LM317's 1.25 V above ADJ — as long as its input stays its
  **dropout** above that (2 V, 1.7 V for the LM317); below it the output
  follows the input down, with a **Regulator in dropout** warning. It gives
  up to **1.5 A** and droops past it (**current-limiting**), and it never
  sinks. Its own working current (5 mA for a 78xx, 50 µA out of an LM317's
  ADJ) fades away as its input falls toward its GND or ADJ, so one whose GND
  is not wired back to the supply's ground floats with its input instead of
  reading nonsense. One whose GND is wired to **nothing at all** has nothing to
  regulate against: its output rises to its input less its dropout, as on a
  bench, and a **Regulator's GND goes nowhere** warning (and its hover) says
  so. It burns the difference between its input and its
  output as heat: past **1 W** in free air it warns that it is running hot.
  It warms up over seconds, not at once: kept past **2 W** it heats until
  its **thermal shutdown** trips (about 5 s at 5 W, under 2 s at 15 W), its
  output goes, and a second later it tries again — and, still hot, soon
  trips again, until you lighten its load or lower its input. A short burst
  — charging a big output capacitor at its current limit — does not trip
  it. Its hover shows what it is delivering.

  For the first **half second** after Run, a regulator gives no dropout,
  current-limit or running-hot warning. During that time its input's
  reservoir capacitor is still charging, or it is charging its own output's.
  If the condition is still there after half a second, or comes back later,
  the warning appears as usual. A thermal shutdown is always reported.
- **The LM358** is an amplifier: its output is its open-loop gain (100 000)
  times the difference between its inputs, about the middle of its swing, and
  that swing runs from a few millivolts above ground to **1.5 V short of its
  supply**, behind 20 Ω, sourcing up to 30 mA and sinking 20 mA. With
  feedback it settles where its datasheet says: two 10 kΩ give a gain of 2.
  Its inputs draw nothing.
- **The LM339** is the same kind of unit with a gain of 200 000 and an
  **open-collector** output: it only ever sinks — about 50 mV plus 25 Ω, so
  150 mV at 4 mA, up to **16 mA** — and past its crossing it lets go
  entirely, leaving the pin wherever its pull-up puts it, even above the
  LM339's own supply. With no pull-up a let-go output has no voltage at all.
  Positive feedback through the pull-up gives it hysteresis, so a Schmitt
  trigger or an RC oscillator switches at the thresholds its resistors set.
- **The ULN2003A** is seven Darlingtons, each behind its 2.7 kΩ — about 1 V
  from output to E at a few hundred milliamps, as its sheet's typical
  figures — with each output's clamp diode to COM. Left with COM open, a coil
  it switches off kicks its output into breakdown at 50 V. Past 500 mA an
  output warns.
- **An optocoupler**'s LED is an infrared LED (about 1.2 V); its
  phototransistor carries the LED's current times its **CTR**, never more —
  so a load wanting more than that gets less, and the transistor does not
  saturate. The CTR you set holds from 5 mA through the LED up; below that
  it falls, as both makers' curves do: to about half at 1 mA and a third at
  0.5 mA. So a coupler fed only a milliamp or two needs more CTR, or a
  larger load resistor, than its setting suggests. Past 60 mA through its
  LED, or 50 mA through its transistor, it warns. Its LED wired backwards
  simply doesn't conduct, so the transistor stays off. Nothing warns about
  it.
- **The relay**'s coil is an **inductor** (0.14 H behind its 70 Ω at 5 V,
  0.8 H behind 400 Ω at 12 V — about 2 ms to build its current), and its
  contacts follow that **current**: they pull in once it reaches 75 % of its
  rating and let go below 10 %. So a relay switched on closes a few
  milliseconds later, and one with a flyback diode lets go a little late,
  while the diode keeps its current going. Without one, switching it off
  kicks the transistor driving it into breakdown (see [Inductors](#inductors)).
  Its contacts are 0.1 Ω, and past 10 A they warn.
- **The electronic load** draws its set current from whatever it is across
  (**CC**) — until the voltage is too low for it to (under about half a volt
  at an amp), when its readout turns amber and reads **UNREG** — or behaves as
  its resistance (**CR**). In **CV** it draws nothing until the voltage
  reaches its setting, then whatever current holds it there (10 mV more for
  every amp): put it across a supply set higher and the supply goes to its
  current limit at the load's voltage — how a charger or a solar panel is
  tested. In **CP** it draws its power, P / V, more current the lower the
  voltage. In every mode it draws at most **5 A**, and never more than a
  half-ohm's worth (the least voltage it can work at), so it reads **UNREG**
  wherever it cannot do what it is set to: a CV load set above what it is
  across, a CP load asking past 5 A. A CP load that has to come up from
  nothing (a regulator charging its output capacitor, a supply behind a
  resistance) can stay down there: low on the voltage it asks for more
  current than the source can give, so it holds the voltage down — as a real
  one does. It never sources. Its brick shows the volts, amps and watts while
  the circuit runs, and past **25 W** it warns.

## Speakers

A **speaker** is a resistor of its impedance in the solve (its coil's
inductance, a few ohms at an audio tone, is left out). What makes it a
speaker is that Spice Lite times the voltage across it, as it times a 555's
output: each time the voltage swings past the middle of its swing it is a
cycle, and the time between two of them is the pitch. The swing it makes,
half of it squared over its impedance, is the power in its coil, and that
power and its **Volume** set how loud it plays — a 25 mW tone at 100 % is
as loud as it goes. The pitch is the circuit's own, even for a tone faster
than the desk shows (a 555 at 5 kHz plays 5 kHz), times the run's speed.
Below 20 Hz or above 20 kHz it is silent, and so is it on the standard
engine, which has no voltages to time.

Its coil is rated **0.5 W**, and it **heats**: the power in it, a tone's or a
steady voltage's, warms the coil over about a second. Warmed past its rating
it warns. Heated to **twice** its rating (1 W), the coil burns open in smoke.
It is silent and carries nothing for the rest of the run, until you stop the
simulation. 5 V straight across an 8 Ω speaker is 3.1 W, which burns it in
about 0.4 s. The surge into the capacitor in front of a speaker at power-on
is a few watts for a few milliseconds, which warms it hardly at all.

## LEDs

With Spice Lite on, an LED carries the current its circuit really pushes
through it, worked out from its colour's datasheet, and what that current does
to it is what it would do on a bench. The standard engine only asks whether
something limits the current; Spice Lite asks how many milliamps.

| Colour | Datasheet              | Forward voltage | Rated | Burns at |
| ------ | ---------------------- | --------------- | ----- | -------- |
| Red    | Kingbright WP7113ID    | 1.9 V at 10 mA  | 30 mA | 72 mA    |
| Yellow | Kingbright WP7113YD    | 1.95 V at 10 mA | 30 mA | 62 mA    |
| Green  | Kingbright WP7113GD    | 2.0 V at 10 mA  | 25 mA | 54 mA    |
| Blue   | Kingbright WP7113QBC/D | 3.3 V at 20 mA  | 30 mA | 39 mA    |
| White  | Kingbright WP7113QWC/D | 3.3 V at 20 mA  | 30 mA | 41 mA    |

These are ordinary 5 mm LEDs. Every segment of a display and every bar of a
bar graph is taken as an LED of its colour.

- **Each colour follows its datasheet's curve.** The current rises steeply
  from a toe — a red LED carries about 0.4 mA at 1.6 V, 1.5 mA at 1.7 V and
  10 mA at 1.9 V; a blue or white one about 1 mA at 2.6 V and 20 mA at
  3.3 V — and then more slowly, as its own resistance takes over. A blue LED
  behind 100 Ω on a 3 V supply glows dimly (2.7 mA); on 5 V it is bright
  (18 mA).
- **Brightness follows the current.** An LED is drawn at full brightness at
  the current its datasheet quotes its brightness at (10 mA, or 20 mA for blue
  and white), dimmer below it, and with a wider glow above it. Below 50 µA it
  is dark.
- **Past its rating it is overdriven.** It lights brightly and a warning
  names the current against its rating: a red LED behind 220 Ω on 9 V takes
  31 mA. A real one would dim and fail early.
- **Past its maximum junction temperature it burns.** The datasheet gives how
  hot the junction runs per watt, and the junction warms towards that
  temperature over about a second, as a regulator does. Once it reaches its
  maximum, the LED burns out (a red cross and smoke) and stops conducting for
  the rest of the run. Segments sharing one resistor with it then share its
  current too. Stopping the simulation restores it. So an LED tolerates a
  little too much current: below the **Burns at** figure it never burns,
  only warns. A short pulse of a lot does no harm either, which is what the
  datasheets' pulse ratings allow. A steady current past the figure burns
  it, sooner the further past: a red LED straight across 5 V (about 410 mA)
  lasts about a tenth of a second, through 10 Ω (174 mA) about 0.4 s, and at
  100 mA about a second.
- **Backwards, it is rated for 5 V.** More than that across it the wrong way
  gives a warning.
- **The probe reads its current.** Point the [probe](probing.md) at an LED's
  leg — or at the resistor beside it, or the chip output driving it — to see
  the milliamps through that lead. No part shows a current on the desk; only a
  power supply shows its draw.

**A chip output is not a perfect source.** Each output is modelled as its
datasheet says it behaves:

- A **74LS** output follows the curves of the gate's own transistors. Driving
  HIGH it is about 4.5 V with nothing on it, drops to 3.6 V by a fifth of a
  milliamp, and then behaves like 120 Ω, so an LED wired straight from it to
  ground lights at about 16 mA and survives. Driving LOW it sits at 0.2 V and
  has little in the way, so an LED from the supply straight into it takes
  nearly 100 mA and burns.
- A **CD4000** output is a small transistor that can only pass so much: about
  4 mA at 5 V, 16 mA at 10 V and 28 mA at 15 V. Lightly loaded it is about
  400 Ω at 5 V; the more it carries the more it gives way, along the curve a
  transistor follows, until it can pass no more. At 5 V that is a resistor in
  all but name.
- The **NE555**'s output is good for 200 mA, and burns an LED wired straight
  to it. The **CD4511B**'s segment outputs, and the **CD4049UB** and
  **CD4050B**'s sinks, are stronger than an ordinary CD4000 output, as their
  datasheets say.

## Character LCDs

The LCD modules' **backlight** is an LED of the module's colour between `A`
and `K`, behind the 100 Ω resistor the common 1602A and 2004A boards carry
for it. Wired to the supply it lights and draws its current (about 18 mA
for a blue module on 5 V, 28 mA for a green one); unwired, the panel is dark.
Its rating is the module maker's, so it never warns or burns.

`V0` sets the **contrast**. The glass is driven by the voltage between `VDD`
and `V0`: full contrast from 3 V (the controller's minimum) up, fading below
that, and blank with `V0` at the supply or left unconnected. The usual 10 kΩ
potentiometer from the supply to ground, its wiper on `V0`, works as it does
on a bench. With Spice Lite off, the backlight and contrast are cosmetic as
before.

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

## Switch bounce

A real push button or slide switch doesn't close once. Its contact touches,
springs off and touches again, three to six times over a couple of
milliseconds, before it rests closed. A counter clocked straight from a
button counts every touch, which is why real circuits **debounce** their
switches: an RC into a Schmitt-trigger input, or a slide switch into an S-R
latch.

With **Switch bounce** on (Settings ▸ Spice Lite, Off by default), Spice Lite's
switches do the same. Every slide switch, push button (momentary or toggle) and
DIP switch bounces as its contacts close, for up to 3 ms, the same way each time
you run the same presses. A contact that opens opens cleanly, and a slide
switch's old side never touches again while its new one bounces, which is
exactly what makes the S-R latch debouncer work. The logic analyzer shows every
bounce. With it off, or on the standard engine, every switch closes cleanly.

## The Spice Lite settings

**Settings ▸ Spice Lite** holds:

- **Spice Lite**: On or Off (On by default).
- **Switch bounce**: On or Off (Off by default) — see
  [Switch bounce](#switch-bounce).
- A **TTL | CMOS** strip showing the families your tray shows (and any family
  the open project uses). Under each are its datasheet source, a **Reset to
  defaults** button, and an **Advanced** section with every number Spice Lite
  uses for that family:
  - **Gate delay**: how long an output takes to follow its inputs.
  - **Output source and sink current**: the strength of the family's output
    — the current it delivers at its datasheet's test voltage. Twice the
    figure is an output twice as strong (half the resistance behind it, and
    twice the current a CMOS output saturates at).
  - **Input current, LOW**: what a 74LS input pushes out of a pin held LOW
    (the figure is the datasheet's maximum, and the input pushes about half
    of it at 0.4 V, typically). A CMOS input's is too small to measure, and
    adds nothing unless you set it to something that is.
  - **Supply current per chip**, **input LOW and HIGH thresholds** and the
    **switching load** (what each output charges when it switches).

  CMOS values are stated at 5 V: the gate delay and the input thresholds
  follow each chip's supply, and the currents and the switching load are used
  as their 5 V figures at any supply. A part in no family (the memories,
  processors and peripherals) is no family's: its outputs are a common
  rail-to-rail stage, and its inputs read at the 74LS thresholds.

Every change, the numbers included, applies at the **next Run**: a circuit
that is running keeps the settings it started with. Your changes apply to
every project on this computer. Each field has a range — hover over it to
see it — wide enough for any logic part (a gate delay of up to 10 µs, a
threshold of up to 5 V): a number outside it is set to the nearest end of
it, so 20,000 ns becomes 10,000 ns and 0 becomes the smallest value allowed.
A field that won't read at all, or a LOW threshold at or above the HIGH
one, turns red, keeps the previous value, and says why underneath. A very short gate delay is taken as no more than about 64 times faster
than the slowest gate on the desk, so a run never crawls.

## What stays the same

- **Exports**: the KiCad and Digital exports ignore Spice Lite entirely and
  use your parts' real values.
- **The AI builder** and the **example circuits** are proven on the standard
  engine.
- **The standard engine** is untouched: with Spice Lite off, every circuit
  behaves exactly as before.

**Open-collector outputs tied together** (a wired-AND, such as two 74LS05
outputs sharing a pull-up) read LOW in both engines when one of them sinks
and the other's input is undecided: the undecided output either sinks as well
or lets go, and the LOW one holds the net either way. Spice Lite also checks
that the LOW really holds the net down — an ordinary output reaching it
through a switch channel or a diode, or a pull-up too stiff for the LOW, is a
fight there, and it says so. The standard engine has no currents to tell.

## How close it is to SPICE

Spice Lite is checked against **ngspice**, a full circuit simulator, on the
same circuits: each one is built once and run through both, and the answers
are compared (the tests do it on every build). Within 2 % is graded **A**,
within 10 % **B**.

| What it models                                                   | Grade | How close                                                          |
| ---------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| Resistor networks, dividers and potentiometers                   | A     | exact                                                              |
| One capacitor charging, Schmitt-trigger RC oscillators           | A     | within 0.03 %                                                      |
| Several capacitors together (RC ladders, filters)                | A     | within 0.01 %                                                      |
| Two-gate RC oscillators, with or without their series resistor   | A     | within 0.8 %                                                       |
| The 555                                                          | A     | within 0.4 %, from 1 kΩ to 1 MΩ                                    |
| The CD4047B, CD4060B, CD4541B and the CD4000 one-shots           | A     | within 0.3 % of the same circuits in ngspice                       |
| LEDs, every colour, and diodes                                   | A     | within 0.25 % of their datasheet curves                            |
| Transistors, every grade — switched, in between, near threshold  | A     | within 1.3 % of the maker's model or the grade's own datasheet fit |
| Inductors: charging, a relay coil with and without its diode, LC | A     | within 0.3 %                                                       |
| A CMOS output charging a capacitor                               | A     | within 0.1 % at 5 V, 1.4 % at 10 V                                 |
| A 74LS input and output, into resistors, LEDs and capacitors     | A     | within 0.4 % of the gate's own transistors                         |
| Circuits mixing 74LS, CD4000 and transistors                     | A     | within 0.6 %                                                       |
| A clock's triangle, sine, sawtooth and trapezoid waves           | A     | within 0.05 mV, into RCs and a Schmitt input                       |
| The ULN2003A                                                     | A     | within 0.3 % of its Darlingtons' own models                        |
| Optocouplers, the LM358 and LM339, regulators and the load       | A     | exact to their own laws (no maker publishes a model to check them) |

Each grade of transistor is one part's figures (the table under
[Diodes and transistors](#diodes-and-transistors)), so a transistor whose part
number differs from its grade's simulates as that part, not its own.

## What Spice Lite does not model

To keep it light, some things are left out deliberately:

- a fast oscillation on a desk with a running **clock wave**: the wave never
  comes round to the same voltage within one of its halves, so an oscillator
  faster than 1 kHz elsewhere on the desk (a 555 at audio rates) is run
  crossing by crossing instead of drawn by its schedule, and the desk runs
  slower — the speed button says so. A wave never swings below 0 V or above
  its own supply (it is clipped there);
- a gate's **linear region**: an inverter whose own output is fed back to
  its input through a resistor (a CD4069UB amplifier, a crystal oscillator's
  bias) sits half way between LOW and HIGH on a bench — an amplifier. Spice
  Lite says so with a **Gate in its linear region** warning, and leaves the
  level there undefined;
- anything faster than a gate's delay: edges have no slope, and wires have no
  capacitance, inductance or ringing;
- the magnetic side of an inductor: its core never saturates, and two coils
  couple only inside a transformer brick (two inductors side by side never
  do). A relay's contacts move with its coil's current, at once — the
  armature's own travel is not modelled;
- a regulator's own dynamics (its output follows its reference at once) and
  its temperature (its shutdown trips on the power in it, and it cools in a
  second); an op-amp's slew rate, offsets and bias currents;
- the timers' comparator references beyond what their datasheets say (the
  CD4098B, CD4528B and CD4538B are worked back from their formulas) and their
  internal propagation delays;
- two oscillations both faster than the desk can show, wired into ONE
  circuit without being locked to each other: only a circuit that repeats as
  a whole is drawn at 1 kHz, so the pair is reported as oscillating. (Two
  that share nothing but a supply rail are two circuits, each drawn on its
  own.);
- a CD4047B's special RC COMMON protection diodes (its datasheet's formulas
  assume the full swing past the supply, and so does Spice Lite);
- two power supplies wired onto the same rail: the load is booked to the
  first of them only, and neither shares it with the other;
- current sharing across parallel wires, and the resistance of the
  breadboard's own contacts;
- heat, beyond an LED's or diode's own junction; signal reflections on long
  wires; and crosstalk between wires.
