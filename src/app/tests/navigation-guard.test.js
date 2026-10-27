/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// The navigation guard (navigation-guard.js) and the CSP every page carries:
// together they keep a dropped file or followed link from replacing a window
// that holds the `window.chiphippo` bridge.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const { isSameDocument, guardWebContents } = require("../navigation-guard");

const INDEX = "file:///Applications/Chip%20Hippo.app/web/index.html";

test("isSameDocument: a reload of the same page, query or hash aside", () => {
  assert.equal(isSameDocument(INDEX, INDEX), true);
  assert.equal(isSameDocument(INDEX, `${INDEX}?ref=74LS00#x`), true);
});

test("isSameDocument: another file, another scheme, or junk is refused", () => {
  assert.equal(isSameDocument(INDEX, "file:///Users/me/desk.chiphippo"), false);
  assert.equal(isSameDocument(INDEX, "https://example.com/"), false);
  assert.equal(isSameDocument(INDEX, "not a url"), false);
  assert.equal(isSameDocument("", INDEX), false);
});

test("guardWebContents: a dropped file's navigation is prevented", () => {
  const contents = new EventEmitter();
  contents.getURL = () => INDEX;
  let openHandler = null;
  contents.setWindowOpenHandler = (fn) => (openHandler = fn);
  guardWebContents(contents);

  const fire = (name, url) => {
    let prevented = false;
    contents.emit(name, { preventDefault: () => (prevented = true) }, url);
    return prevented;
  };
  assert.equal(fire("will-navigate", "file:///tmp/a.chiphippo"), true);
  assert.equal(fire("will-navigate", "https://evil.example/"), true);
  assert.equal(fire("will-navigate", INDEX), false, "a reload is allowed");
  assert.equal(fire("will-redirect", "https://evil.example/"), true);
  assert.equal(fire("will-attach-webview"), true);
  assert.deepEqual(openHandler({ url: "https://x.example/" }), {
    action: "deny",
  });
});

test("every page carries a Content-Security-Policy", () => {
  const web = path.join(__dirname, "..", "..", "web");
  const pages = fs.readdirSync(web).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 6, `found ${pages.join(", ")}`);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(web, page), "utf8");
    assert.match(
      html,
      /http-equiv="Content-Security-Policy"[\s\S]*?script-src\s+'self';/,
      `${page} has no CSP`,
    );
    // No plugins, no <base> to re-point every relative URL, no form posting
    // anywhere — none is used, so none is allowed.
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? ""; // prettier-ignore
    for (const rule of [
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      // prettier-ignore
      assert.match(csp.replace(/\s+/g, " "), new RegExp(rule), `${page}: ${rule}`);
    }
  }
});

test("every permission is denied but the clipboard write", () => {
  const {
    permissionAllowed,
    guardPermissions,
  } = require("../navigation-guard");
  assert.equal(permissionAllowed("clipboard-sanitized-write"), true);
  for (const p of [
    "media",
    "geolocation",
    "notifications",
    "clipboard-read",
    "serial",
    "hid",
    "usb",
    "display-capture",
    "openExternal",
    "fullscreen",
  ]) {
    assert.equal(permissionAllowed(p), false, p);
  }
  const handlers = {};
  guardPermissions({
    setPermissionRequestHandler: (fn) => (handlers.request = fn),
    setPermissionCheckHandler: (fn) => (handlers.check = fn),
  });
  let answer = null;
  handlers.request({}, "media", (ok) => (answer = ok));
  assert.equal(answer, false);
  handlers.request({}, "clipboard-sanitized-write", (ok) => (answer = ok));
  assert.equal(answer, true);
  assert.equal(handlers.check({}, "geolocation"), false);
});
