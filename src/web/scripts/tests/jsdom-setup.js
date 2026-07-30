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

// jsdom-setup.js — a fresh DOM per test (ported from Port Hippo). The renderer
// components reference the bare globals `window`/`document`/`CustomEvent`, so
// `resetDom()` installs a new jsdom window onto Node's globals (isolating
// window-level listeners between tests) and returns it so the test can attach
// `window.chiphippo` stubs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { applyCatalog } from "../i18n.js";

// ── The English catalog, loaded once for every component test ────────────────
// In the app, `app.js` awaits `i18n.init()` before anything renders, so a
// component always builds against a real catalog. A test that mounted one
// without doing the same would see `t()` return raw KEYS, and every assertion
// about on-screen text would be asserting the key rather than the string.
//
// So the setup every component test already imports installs the real
// `locales/en.json` — the same file the app ships. That keeps the existing
// English assertions meaningful AND makes them exercise the catalog: a key
// deleted from en.json now fails the test that reads it, rather than quietly
// rendering the key to the user.
//
// Read with fs rather than a JSON import so this works whatever the running
// Node's import-attributes support.
const EN_CATALOG = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "locales",
      "en.json",
    ),
    "utf8",
  ),
);

/** The languages `resetDom()` reports as shipped, unless a test says otherwise.
    A stand-in for main's own LOCALES table (app/i18n.js is CommonJS, so it
    cannot be imported here) — two entries is enough to prove a list renders. */
const DEFAULT_LOCALES = [
  { code: "en", nativeName: "English" },
  { code: "de", nativeName: "Deutsch" },
];

/**
 * Install a clean jsdom document on the Node globals and return its `window`.
 * Call at the top of every test that mounts a component.
 * @param {{locales?: Array<{code: string, nativeName: string}>}} [opts]
 *   `locales` overrides the shipped-language list the Settings picker builds
 *   from — it arrives on the catalog payload in the app, so it is installed here
 *   with the catalog rather than set separately (a second `applyCatalog` call
 *   from a test would replace the whole payload and wipe the messages).
 * @returns {Window}
 */
export function resetDom({ locales = DEFAULT_LOCALES } = {}) {
  applyCatalog({
    active: "en",
    lang: "en",
    messages: EN_CATALOG,
    fallback: EN_CATALOG,
    locales,
  });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  global.window = window;
  global.document = window.document;
  // NOTE: `global.navigator` is a read-only getter in modern Node — don't
  // assign it. The components don't need it; jsdom's window.navigator is fine.
  global.HTMLElement = window.HTMLElement;
  global.Node = window.Node;
  global.Element = window.Element;
  global.Event = window.Event;
  global.CustomEvent = window.CustomEvent;
  global.KeyboardEvent = window.KeyboardEvent;
  global.getComputedStyle = window.getComputedStyle.bind(window);

  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }

  // jsdom has no ResizeObserver; DeskView (and views that compose it) observe
  // their viewport. A no-op stub is enough — tests drive size explicitly.
  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.ResizeObserver = ResizeObserver;
    global.ResizeObserver = ResizeObserver;
  }

  // jsdom doesn't implement the canvas 2d context (getContext returns null and
  // logs "not implemented"). LcdView draws its characters onto a <canvas>, so
  // install a lightweight recording context: it captures clearRect/fillRect ops
  // on `canvas.__ctx.ops` for assertions and lets the view draw without error.
  if (window.HTMLCanvasElement) {
    window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
      if (type !== "2d") return null;
      if (!this.__ctx) {
        const ops = [];
        this.__ctx = {
          ops,
          fillStyle: "#000000",
          clearRect: (...a) => ops.push(["clearRect", ...a]),
          fillRect: (...a) => ops.push(["fillRect", ...a]),
        };
      }
      return this.__ctx;
    };
  }

  // jsdom doesn't implement the <dialog> modal surface the popup manager
  // uses. Polyfill just enough of it — showModal/show set `open`; close
  // clears it and fires a `close` event. Production uses the real element.
  const dialogProto = window.HTMLDialogElement
    ? window.HTMLDialogElement.prototype
    : window.HTMLElement.prototype;
  if (!dialogProto.showModal) {
    dialogProto.showModal = function showModal() {
      this.open = true;
      this.setAttribute("open", "");
    };
    dialogProto.show = dialogProto.showModal;
    dialogProto.close = function close(returnValue) {
      if (returnValue !== undefined) this.returnValue = returnValue;
      this.open = false;
      this.removeAttribute("open");
      this.dispatchEvent(new window.Event("close"));
    };
  }
  return window;
}
