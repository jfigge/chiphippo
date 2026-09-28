#include "ChipHippo.h"

const uint8_t DIP1_PIN = 13;
const uint8_t DIP2_PIN = 12;
const uint8_t DIP3_PIN = 11;
const uint8_t DIP4_PIN = 10;

const uint8_t LED1_PIN = 9;
const uint8_t LED2_PIN = 8;

String last = "";
String dips = "";

void setup() {
  pinMode(DIP1_PIN, INPUT_PULLUP);
  pinMode(DIP2_PIN, INPUT_PULLUP);
  pinMode(DIP3_PIN, INPUT_PULLUP);
  pinMode(DIP4_PIN, INPUT_PULLUP);

  pinMode(LED1_PIN, OUTPUT);
  pinMode(LED2_PIN, OUTPUT);

  last  = digitalRead(DIP1_PIN) == HIGH ? "1" : "0";
  last += digitalRead(DIP2_PIN) == HIGH ? "1" : "0";
  last += digitalRead(DIP3_PIN) == HIGH ? "1" : "0";
  last += digitalRead(DIP4_PIN) == HIGH ? "1" : "0";

  digitalWrite(LED1_PIN, digitalRead(DIP1_PIN) == LOW ? HIGH : LOW);
  digitalWrite(LED2_PIN, digitalRead(DIP2_PIN) == LOW ? HIGH : LOW);

  ChipHippo.onConnect(sendInputs);
  ChipHippo.begin();
}

void loop() {
  dips  = digitalRead(DIP1_PIN) == HIGH ? "1" : "0";
  dips += digitalRead(DIP2_PIN) == HIGH ? "1" : "0";
  dips += digitalRead(DIP3_PIN) == HIGH ? "1" : "0";
  dips += digitalRead(DIP4_PIN) == HIGH ? "1" : "0";

  if (last != dips) {
    ChipHippo.print("Dips: ");
    ChipHippo.println(dips);
    last = dips;

    digitalWrite(LED1_PIN, digitalRead(DIP1_PIN) == LOW ? HIGH : LOW);
    digitalWrite(LED2_PIN, digitalRead(DIP2_PIN) == LOW ? HIGH : LOW);
  }
  ChipHippo.poll();
}

// Runs at the start of every run: give each Input its starting value.
void sendInputs() {
  // The Input "Nano".
  ChipHippo.NanoOut.setLed1(false);
  ChipHippo.NanoOut.setLed2(false);
  ChipHippo.NanoOut.send();
  // The Input "Dips".
  ChipHippo.DipsOut.setDip1(false);
  ChipHippo.DipsOut.setDip2(false);
  ChipHippo.DipsOut.setDip3(false);
  ChipHippo.DipsOut.setDip4(false);
  ChipHippo.DipsOut.send();
}