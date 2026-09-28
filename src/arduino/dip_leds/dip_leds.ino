// The Arduino side of the "Arduino1" connection. The design it talks to:
//
//   Output "Output 3"  pin 1 bit0               the push button's line
//   Input  "Dips"      Dip1, Dip2, Dip3, Dip4   driven from this sketch
//
// When the button on the Chip Hippo board goes HIGH, Output3In(true) runs
// here: the sketch reads its four DIP switches and answers by sending Dips
// from INSIDE that function. Chip Hippo waits until the function returns, so
// the answer has reached the circuit before the circuit moves on.
//
// Between runs the sketch keeps doing what it did on its own: DIP1 and DIP2
// light LED1 and LED2, and every change of the switches is logged.

#include "ChipHippo.h"

const uint8_t DIP1_PIN = 13;
const uint8_t DIP2_PIN = 12;
const uint8_t DIP3_PIN = 11;
const uint8_t DIP4_PIN = 10;

const uint8_t LED1_PIN = 9;
const uint8_t LED2_PIN = 8;

const uint8_t DIP_PINS[4] = {DIP1_PIN, DIP2_PIN, DIP3_PIN, DIP4_PIN};

// The switches as last read: bit 0 is DIP1 … bit 3 is DIP4.
uint8_t last = 0;

// Read the four switches as one value. A bit is 1 when its pin reads HIGH —
// with INPUT_PULLUP, that is a switch that is OFF (open); a switch that is
// ON pulls its pin LOW and reads 0.
uint8_t readDips() {
  uint8_t v = 0;
  for (uint8_t i = 0; i < 4; i++) {
    if (digitalRead(DIP_PINS[i]) == HIGH) v |= (uint8_t)(1u << i);
  }
  return v;
}

// LED1 and LED2 light while DIP1 and DIP2 are ON (their pins LOW).
void showDips(uint8_t v) {
  digitalWrite(LED1_PIN, (v & 0x01) ? LOW : HIGH);
  digitalWrite(LED2_PIN, (v & 0x02) ? LOW : HIGH);
}

// "1011" — DIP1 first, 1 for HIGH, as the log has always shown them.
void printDips(uint8_t v) {
  for (uint8_t i = 0; i < 4; i++) ChipHippo.print((v >> i) & 1 ? "1" : "0");
  ChipHippo.println();
}

// Send all four switches to the circuit's Input "Dips" as one value: each
// Dip is its pin's level, so a pin reading HIGH drives that tag HIGH.
bool sendDips(uint8_t v) {
  ChipHippo.DipsOut.setDip1(v & 0x01);
  ChipHippo.DipsOut.setDip2(v & 0x02);
  ChipHippo.DipsOut.setDip3(v & 0x04);
  ChipHippo.DipsOut.setDip4(v & 0x08);
  return ChipHippo.DipsOut.send();
}

// The circuit's Output "Output 3": the button's line. Chip Hippo calls this
// each time it sends that Output — on Auto, at the start of a run and on
// every change, so a press arrives as true and a release as false. Only the
// press asks for the switches. Keep it short: the circuit waits on it.
void Output3In(bool bit0) {
  if (!bit0) return;
  const uint8_t dips = readDips();
  ChipHippo.print("Button: sending dips ");
  printDips(dips);
  sendDips(dips);
}

// Runs at the start of every run: give each Input its starting value.
void sendInputs() {
  // The Input "Dips".
  ChipHippo.DipsOut.setDip1(false);
  ChipHippo.DipsOut.setDip2(false);
  ChipHippo.DipsOut.setDip3(false);
  ChipHippo.DipsOut.setDip4(false);
  ChipHippo.DipsOut.send();
}

void setup() {
  for (uint8_t i = 0; i < 4; i++) pinMode(DIP_PINS[i], INPUT_PULLUP);
  pinMode(LED1_PIN, OUTPUT);
  pinMode(LED2_PIN, OUTPUT);

  last = readDips();
  showDips(last);

  ChipHippo.onConnect(sendInputs);
  ChipHippo.begin();
}

void loop() {
  const uint8_t dips = readDips();
  if (dips != last) {
    last = dips;
    showDips(dips);
    ChipHippo.print("Dips: ");
    printDips(dips);
  }
  ChipHippo.poll();
}