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

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build an SVG element. Like `el()` but for the SVG namespace: attrs always
 * go through `setAttribute` (SVG has none of HTML's meaningful DOM-property
 * shortcuts) and a null/undefined value is skipped rather than stringified.
 * `children` may be a single node, an array (falsy entries filtered), or
 * omitted.
 * @param {string} tag
 * @param {Object<string, any>} [attrs]
 * @param {Node|null|false|Array<Node|null|false>} [children]
 * @returns {SVGElement}
 */
export function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}
