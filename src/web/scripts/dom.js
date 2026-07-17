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

// dom.js — tiny DOM-construction helpers (ported from Port Hippo). They keep
// components free of repetitive createElement boilerplate without pulling in
// a framework (the project's hard rule): `el(tag, props, children)` builds an
// element and `clear` empties one.

/**
 * Build an element. `props` keys are interpreted as:
 *   - `class`/`className` → className
 *   - `dataset` (object)  → data-* attributes
 *   - `style` (object)    → inline styles
 *   - `text`              → textContent
 *   - `for`               → htmlFor (label association)
 *   - `on<Event>` (fn)    → addEventListener("<event>", fn)
 *   - `aria-*` / `role` / hyphenated keys → setAttribute
 *   - anything else that is a real DOM property → property assignment
 *   - otherwise           → setAttribute
 * `children` is a node, string, or (possibly nested-falsey) array thereof.
 *
 * @param {string} tag
 * @param {Object<string, any>} [props]
 * @param {(Node|string|null|false)|Array<Node|string|null|false>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class" || key === "className") {
      node.className = value;
    } else if (key === "dataset") {
      for (const [d, dv] of Object.entries(value)) {
        if (dv != null) node.dataset[d] = dv;
      }
    } else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value);
    } else if (key === "text") {
      node.textContent = value;
    } else if (key === "for") {
      node.htmlFor = value;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "role" || key.startsWith("aria") || key.includes("-")) {
      node.setAttribute(key, value === true ? "" : value);
    } else if (key in node) {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? "" : value);
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids.flat()) {
    if (child == null || child === false) continue;
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return node;
}

/** Remove every child of `node` and return it. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}
