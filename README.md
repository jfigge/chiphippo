# Chip Hippo

Design and simulate 74xx TTL logic circuits on virtual solderless breadboards, laid
out on an infinitely pannable desk. Place Full (830 tie-point), Half (400) or Tiny
(170) breadboards; populate them with 74xx DIP chips, jumper wires, switches, LEDs,
and 3 V / 5 V / 12 V power sources; then run the simulation engine and watch the
logic ripple through the circuit.

Chip Hippo is a native JavaScript / Node.js / Electron desktop app (no UI
framework), sharing its engineering foundation with its siblings
[Rest Hippo](../resthippo) and [Port Hippo](../porthippo).

**Status: in progress.** The implementation plan lives in
[`features/ROADMAP.md`](features/ROADMAP.md); stages are implemented in order, and
finished plans move to `features/done/`. Stages 00–70 are done — `make install &&
make debug` opens the app with a pannable, zoomable desk where Full / Half / Tiny
breadboards can be added, dragged, and deleted (every tie point addressable on
hover), 74xx DIP chips, slide switches, push buttons, and LEDs from the searchable
parts palette seat into the boards with full occupancy checking, power-supply
bricks (3 V / 5 V / 12 V) sit on the desk with wireable `+`/`−` terminals, colored
jumper wires connect any two free points — including across boards — the
connectivity probe highlights an entire electrical net on hover, and every 74xx
gate chip has correct TTL behavior (proven by exhaustive truth-table tests). The
simulation engine that drives it all is next.

## License

Apache-2.0.
