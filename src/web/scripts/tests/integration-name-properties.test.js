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

// An Output's, Input's or Data bus's Name, in its Properties card: a name no
// generated source could hold (model/integration-names.js) is refused AT THE
// FIELD — red as it is typed, the reason as its tooltip, nothing written to
// the element, the text left there to fix.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

function mount() {
  resetDom();
  const doc = new DeskDoc(null);
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const controller = new DeskController({
    viewport,
    deskView: {
      surface,
      camera: { cx: 0, cy: 0, zoom: 1 },
      worldFromEvent: () => ({ x: 0, y: 0 }),
    },
    deskDoc: doc,
  });
  return { doc, controller };
}

for (const kind of ["output", "data"]) {
  test(`a ${kind}'s Name with a control character is refused at the field`, () => {
    const { doc, controller } = mount();
    const id = controller.addIntegration(kind, 8).id;
    const before = doc.getIntegration(id).name;
    controller.openIntegrationProperties(id);
    const name = document.querySelector(".properties-text-input");
    name.value = "bad\u0000name";
    name.dispatchEvent(new window.Event("input"));
    assert.equal(name.getAttribute("aria-invalid"), "true");
    assert.match(name.title, /control characters/);
    name.dispatchEvent(new window.Event("change"));
    assert.equal(doc.getIntegration(id).name, before, "nothing written");
    assert.equal(name.value, "bad\u0000name", "the text is left to fix");

    // A keyword is fine for an ELEMENT: it gains In/Out in the code.
    name.value = "int";
    name.dispatchEvent(new window.Event("input"));
    assert.equal(name.hasAttribute("aria-invalid"), false);
    name.dispatchEvent(new window.Event("change"));
    assert.equal(doc.getIntegration(id).name, "int");
    PopupManager.close();
  });
}
