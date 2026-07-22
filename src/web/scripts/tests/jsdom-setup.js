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

import { JSDOM } from "jsdom";

/**
 * Install a clean jsdom document on the Node globals and return its `window`.
 * Call at the top of every test that mounts a component.
 * @returns {Window}
 */
export function resetDom() {
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
