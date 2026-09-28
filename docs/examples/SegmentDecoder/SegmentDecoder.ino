// SegmentDecoder.ino — an Arduino taking part in a running Chip Hippo circuit.
// (Generate ▸ View files shows the smallest possible sketch for any header;
// this is a fuller one, with real hardware on the Arduino's side.)
//
// It consumes the ChipHippo.h that Chip Hippo's Generate button saves for a
// connection whose desktop has these three elements (the names and fields are
// what each one's Properties say; the header is generated from them):
//
//   Output "Digit"     Byte value, Bit blank   trigger tag on the counter's clock
//   Input  "Segments"  Byte pattern            Trigger: Auto (live)
//   Input  "Buttons"   Bit step, Bit reset     Trigger: Auto (live)
//
// The circuit counts. On each clock edge it sends the count to Digit and
// WAITS; the sketch looks the count up in a hex-to-7-segment table and sends
// the pattern back through Segments before DigitIn() returns, so the
// segment lines change in the same step the count did — the Arduino standing
// in for a decoder ROM. Two real push buttons on D2 and D3 drive the circuit's
// Step and Reset lines through Buttons.
//
// Names read from the Arduino's side: the circuit's Output "Digit" ARRIVES
// here as DigitIn(), and its Inputs "Segments" and "Buttons" are SENT from
// here as ChipHippo.SegmentsOut and ChipHippo.ButtonsOut.
//
// Save ChipHippo.h into this sketch's folder, beside this file, and upload.
// Chip Hippo owns the serial port while the circuit runs, so close the Serial
// Monitor first; what this sketch prints appears in the connection's window.

#include "ChipHippo.h"

// Two push buttons from D2 / D3 to GND, read through the internal pull-ups.
const uint8_t STEP_PIN = 2;
const uint8_t RESET_PIN = 3;
const unsigned long DEBOUNCE_MS = 20;

// 0–F on a common-cathode display: bit 0 = segment a … bit 6 = g, 1 = lit.
// Wire Segments' tag 1 to a, tag 2 to b, … tag 7 to g (tag 8 is the dp).
const uint8_t HEX_SEGMENTS[16] = {
    0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07,  // 0 1 2 3 4 5 6 7
    0x7F, 0x6F, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71,  // 8 9 A b C d E F
};

// ── Outputs ──────────────────────────────────────────────────────────────────
// ChipHippo.h DECLARES one function per Output and the sketch DEFINES it: the
// Output's name + In, its fields as parameters in order (Bit → bool, Byte →
// uint8_t, Word → uint16_t). It is called from ChipHippo.poll(), and the
// circuit stands still until it returns — so keep it short, and never delay()
// in it.

void DigitIn(uint8_t value, bool blank) {
  const uint8_t pattern = blank ? 0 : HEX_SEGMENTS[value & 0x0F];

  // Answer BEFORE returning. An Input sent while an Output is being handled
  // reaches the circuit in the same step that asked for it: that is what
  // makes this a lookup rather than a value that turns up a step late.
  ChipHippo.SegmentsOut.setPattern(pattern);
  ChipHippo.SegmentsOut.send();

  // Log through ChipHippo, never Serial: this shows in the connection window.
  ChipHippo.print("digit ");
  ChipHippo.print(value & 0x0F, HEX);
  ChipHippo.println(blank ? " (blanked)" : "");
}

// ── Inputs ───────────────────────────────────────────────────────────────────
// Each is ChipHippo.<its name + Out>. Set the fields that changed, then send()
// the whole Input as one value.
// send() waits for Chip Hippo's acknowledgement (a few milliseconds) and
// returns true once the circuit has the value. With no run listening it
// returns false: at once before a run has greeted the sketch, or after
// 1.5 s of resends the first time after one has stopped. Either way it is
// safe to call whenever something changes.

// A debounced push button. (Its logic is a member function because the
// Arduino IDE writes prototypes for a sketch's free functions at the TOP of
// the file — above this struct, which a Button& parameter would then precede.)
struct Button {
  uint8_t pin;
  bool pressed;         // the debounced state
  bool reading;         // the last raw reading
  unsigned long since;  // when the raw reading last changed

  // True when the settled state has just changed.
  bool changed() {
    const bool raw = digitalRead(pin) == LOW;  // pulled up: pressed reads LOW
    if (raw != reading) {
      reading = raw;
      since = millis();
    }
    if (pressed != reading && millis() - since >= DEBOUNCE_MS) {
      pressed = reading;
      return true;
    }
    return false;
  }
};

Button stepButton = {STEP_PIN, false, false, 0};
Button resetButton = {RESET_PIN, false, false, 0};

void sendButtons() {
  ChipHippo.ButtonsOut.setStep(stepButton.pressed);
  ChipHippo.ButtonsOut.setReset(resetButton.pressed);
  ChipHippo.ButtonsOut.send();
}

// An Input drives nothing (Z) until its first value, so tell each new run
// where everything stands rather than leaving those lines floating until a
// button is pressed or the first digit arrives.
void sendInitialState() {
  sendButtons();
  ChipHippo.SegmentsOut.setPattern(0);  // dark until the first digit
  ChipHippo.SegmentsOut.send();
  ChipHippo.println("hello from the segment decoder");
}

void setup() {
  pinMode(STEP_PIN, INPUT_PULLUP);
  pinMode(RESET_PIN, INPUT_PULLUP);
  // poll() runs this at the start of EVERY run — including on a board that
  // does not reset when Chip Hippo opens the port (a Leonardo, a Micro), where
  // the sketch simply carries on from one run into the next.
  ChipHippo.onConnect(sendInitialState);
  ChipHippo.begin();  // opens Serial at the connection's baud rate
}

void loop() {
  // Services the link — reads what arrived, runs Output functions, answers
  // Chip Hippo. Call it every time round, and keep the loop quick.
  ChipHippo.poll();

  // Evaluate both, so neither button's debounce is skipped.
  const bool stepChanged = stepButton.changed();
  const bool resetChanged = resetButton.changed();
  if (stepChanged || resetChanged) sendButtons();
}
