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

// pinout.js — entry point for the standalone pin-assignments OS window
// (web/pinout.html). Reads the part ref from the query string, renders its
// pin/terminal map via the shared buildPartPinout (chip / discrete / brick),
// and titles the window. This page is a pure, sandboxed reference view — no
// bridge, no electrical logic, no writes. Main owns the window itself
// (float-above default + the right-click toggle).

import { partDef } from "./catalog/index.js";
import { buildPartPinout } from "./components/chip-pinout.js";

const root = document.getElementById("pinout-root");
const ref = new URLSearchParams(location.search).get("ref");
const def = ref ? partDef(ref) : null;
const pinout = def ? buildPartPinout(def) : null;

if (pinout) {
  document.title = `${def.id} · ${def.title}`;
  root.append(pinout);
} else {
  document.title = "Pin assignments";
  const msg = document.createElement("p");
  msg.className = "pinout-empty";
  msg.textContent = ref
    ? `No pin assignments for “${ref}”.`
    : "No part selected.";
  root.append(msg);
}
