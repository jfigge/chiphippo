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

// The serial protocol reference's header button (Settings ▸ Serial I/O and the
// Generate card). Its page is a SLUG, and a slug the guide does not list opens
// the overview instead — silently, the kind of drift nothing else would
// notice — so the page is held to the contents list and to a file on disk.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resetDom } from "./jsdom-setup.js";

const { PROTOCOL_PAGE, protocolDocButton } =
  await import("../components/protocol-doc-button.js");
const { PAGES } = await import("../docs-pages.js");

test("the protocol page is one the guide lists, with its Markdown on disk", () => {
  const page = PAGES.find((p) => p.slug === PROTOCOL_PAGE);
  assert.ok(page, `${PROTOCOL_PAGE} is in the contents list`);
  const file = new URL(
    `../../docs/${page.file ?? page.slug}.md`,
    import.meta.url,
  );
  assert.ok(fs.existsSync(file), `${file.pathname} exists`);
  assert.match(fs.readFileSync(file, "utf8"), /^# Serial Protocol\n/);
});

test("a click asks main to open the guide on that page; no bridge, no throw", async () => {
  resetDom();
  const opened = [];
  const btn = protocolDocButton({
    docs: { open: async (s) => opened.push(s) },
  });
  assert.equal(btn.type, "button");
  assert.equal(btn.title, "Serial protocol reference");
  assert.equal(btn.getAttribute("aria-label"), btn.title);
  btn.click();
  assert.deepEqual(opened, [PROTOCOL_PAGE]);

  protocolDocButton(undefined).click();
  protocolDocButton({}).click();
  // A refused IPC is reported, never an unhandled rejection.
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a);
  try {
    protocolDocButton({
      docs: { open: () => Promise.reject(new Error("nope")) },
    }).click();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
});
