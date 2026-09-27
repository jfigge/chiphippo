/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// DIP switches → inverted LEDs (Arduino Uno).
//
//   D13  Dip1  input    ─┐
//   D12  Dip2  input     │ each switch between its pin and GND; the internal
//   D11  Dip3  input     │ pull-up holds an open switch HIGH, so ON reads LOW
//   D10  Dip4  input    ─┘
//   D9   Led1  output   ─┐ each LED from its pin through a 330 Ω–1 kΩ series
//   D8   Led2  output   ─┘ resistor to GND (≈ 3–9 mA, under the 20 mA per pin)
//
// Each LED is the inverse of its switch: Dip LOW → Led HIGH, Dip HIGH → Led LOW.
// Dip3 and Dip4 are configured but not read yet.
//
// The LED follows the input level on every pass, so a bouncing contact costs a
// few milliseconds of flicker and nothing else; there is no debounce.

const uint8_t DIP1_PIN = 13;
const uint8_t DIP2_PIN = 12;
const uint8_t DIP3_PIN = 11;
const uint8_t DIP4_PIN = 10;

const uint8_t LED1_PIN = 9;
const uint8_t LED2_PIN = 8;

String last = "";
String dips = "";

void setup() {
  Serial.begin(115200);
  Serial.println("Started");
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
}

void loop() {
  dips  = digitalRead(DIP1_PIN) == HIGH ? "1" : "0";
  dips += digitalRead(DIP2_PIN) == HIGH ? "1" : "0";
  dips += digitalRead(DIP3_PIN) == HIGH ? "1" : "0";
  dips += digitalRead(DIP4_PIN) == HIGH ? "1" : "0";

  if (last != dips) {
    Serial.print("Dips: ");
    Serial.println(dips);
    last = dips;

    digitalWrite(LED1_PIN, digitalRead(DIP1_PIN) == LOW ? HIGH : LOW);
    digitalWrite(LED2_PIN, digitalRead(DIP2_PIN) == LOW ? HIGH : LOW);
  }
}
