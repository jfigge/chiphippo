# ChipHippo Feature: CD4000 Batch 2

## Summary

This batch adds CD4000 parts beyond the basic gates: more flip-flops, counters, a shift register, a decoder, a display driver, and the analog switches and multiplexers.

**This builds on Batch 1 (`chiphippo-cd4000-feature.md`).** Batch 1 must be finished first, because it adds the `family` property, the three-way mode switch, the parts-panel tree, supply-voltage validation, CMOS floating-input behaviour, and the datasheet downloader. Everything here plugs into that work. The same rules apply:

- Study how existing parts are built and follow the same patterns.
- Never guess a pinout. Take every pin, active level and clock edge from the datasheet.
- Many of these datasheets are scanned Harris originals. The pinouts and function tables are images, so render the pages and read them visually.
- Write a test for every behaviour listed in a part's datasheet.
- Downloads de-duplicate by URL.

## Phase 2a: Digital sequential and functional parts

These use the same machinery as Batch 1's 4013, 4017 and 4040.

| Part | Description | Folder | Datasheet URL |
|---|---|---|---|
| CD4027B | Dual J-K flip-flop with set/reset | FLIP-FLOP | https://www.ti.com/lit/ds/symlink/cd4027b.pdf |
| CD4094B | 8-stage shift-and-store bus register, 3-state outputs | SHIFT REGISTER | https://www.ti.com/lit/ds/symlink/cd4094b.pdf |
| CD4028B | BCD-to-decimal decoder | DECODER | https://www.ti.com/lit/ds/symlink/cd4028b.pdf |
| CD4511B | BCD-to-7-segment latch/decoder/driver | DISPLAY DRIVER | https://www.ti.com/lit/ds/symlink/cd4511b.pdf |
| CD4029B | Presettable up/down counter, binary or decade | COUNTER | https://www.ti.com/lit/ds/symlink/cd4029b.pdf |
| CD4510B | Presettable BCD up/down counter | COUNTER | https://www.ti.com/lit/ds/symlink/cd4510b.pdf |
| CD4516B | Presettable binary up/down counter | COUNTER | https://www.ti.com/lit/ds/symlink/cd4510b.pdf |
| CD4020B | 14-stage binary ripple counter | COUNTER | https://www.ti.com/lit/ds/symlink/cd4040b.pdf |
| CD4024B | 7-stage binary ripple counter | COUNTER | https://www.ti.com/lit/ds/symlink/cd4040b.pdf |
| CD4022B | Divide-by-8 counter with 8 decoded outputs | COUNTER | https://www.ti.com/lit/ds/symlink/cd4017b.pdf |

The CD4040B datasheet from Batch 1 also covers the CD4020B and CD4024B. The CD4510B and CD4516B share one datasheet.

Notes for specific parts:
- **CD4024B has 14 pins.** The other parts in its datasheet have 16, so don't copy the CD4040B layout.
- **CD4027B:** the datasheet's function table shows that if Set and Reset are both high, Q and Q̄ both go high. Model this exactly, because it is a good example of the realistic wrong-wiring behaviour ChipHippo is meant to teach. Set and Reset are asynchronous and active high. The clock triggers on the rising edge. Confirm all of this against the datasheet.
- **CD4511B:** model the Lamp Test, Blanking and Latch Enable inputs. Check the datasheet for how the 4511 displays inputs above 9.
- **CD4094B:** has a strobe-controlled storage latch and output enable. When disabled, the outputs are high-impedance. Use however the engine already represents 3-state outputs.
- **CD4022B:** check that the CD4017B link really covers the CD4022B before you use it. I have not checked this one. If it doesn't, leave the 4022 out and report it.

## Phase 2b: Analog switches and multiplexers (needs an engine decision)

| Part | Description | Folder | Datasheet URL |
|---|---|---|---|
| CD4051B | Single 8-channel analog mux/demux | MULTIPLEXER | https://www.ti.com/lit/ds/symlink/cd4051b.pdf |
| CD4052B | Dual (differential) 4-channel analog mux/demux | MULTIPLEXER | https://www.ti.com/lit/ds/symlink/cd4051b.pdf |
| CD4053B | Triple 2-channel analog mux/demux | MULTIPLEXER | https://www.ti.com/lit/ds/symlink/cd4051b.pdf |
| CD4066B | Quad bilateral switch | See below | https://www.ti.com/lit/ds/symlink/cd4066b.pdf |

**These parts are different from everything else so far.** They don't drive outputs. Each channel is a **bidirectional switch**: when it is on, it connects two nets so a signal passes either way. When it is off, the channel is high-impedance. The 4051 used as a demultiplexer is the same chip with the signal going the other way.

Before implementing them:
1. Check whether the engine can already represent a component that joins two nets on command, in either direction. If it can, use that.
2. If it can't, **stop and report back** with a proposed approach before building one. This is a core engine change and Jason should approve it first.
3. Model the parts digitally only. Logic levels pass through, but on-resistance and analog voltages are out of scope.
4. The 405x parts have a **VEE pin** (pin 7), a negative supply for analog signals. In ChipHippo's single-supply digital use, VEE is tied to VSS. Decide with Jason whether an unconnected VEE should warn the user, the way a floating input does.
5. The CD4066B function table: when the control input is high, the signal passes either way. When it is low, the switch is high-impedance.

**Open question for Jason:** the parts panel has no SWITCH folder. Put the 4066 under MULTIPLEXER, or add a SWITCH folder? Use MULTIPLEXER unless told otherwise.

## Testing

Use the same rules as Batch 1. Every truth table and state sequence must come from the datasheet, and the download test must cover every new URL. Also test:
- Every counter's preset/load, up/down, carry-out and reset behaviour.
- The 4027 with Set and Reset both high.
- The 4094's high-impedance outputs when disabled.
- For Phase 2b: a signal passing both ways through an on channel, and the channel going high-impedance when it is off or inhibited.

## Deliverables

When you finish, report:
1. Which chips were implemented, and any that were skipped or added, with the reason.
2. The Phase 2b engine approach, or the proposal for it if you stopped at step 2.
3. Whether the 4022 link was confirmed.
4. Any follow-ups or open questions for Jason.
