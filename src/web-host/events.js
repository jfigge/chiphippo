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

// events.js — Node's EventEmitter, as much of it as Electron's objects need in
// the web build (`on`, `once`, `off`/`removeListener`, `emit`), and the event
// object Electron hands a preventable listener (`close`, `before-quit`,
// `page-title-updated`).

export class EventEmitter {
  #listeners = new Map();

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push({ fn, once: false });
    return this;
  }

  addListener(event, fn) {
    return this.on(event, fn);
  }

  once(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push({ fn, once: true });
    return this;
  }

  off(event, fn) {
    const list = this.#listeners.get(event);
    if (!list) return this;
    const i = list.findIndex((l) => l.fn === fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }

  removeListener(event, fn) {
    return this.off(event, fn);
  }

  removeAllListeners(event) {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  listenerCount(event) {
    return this.#listeners.get(event)?.length ?? 0;
  }

  emit(event, ...args) {
    const list = this.#listeners.get(event);
    if (!list?.length) return false;
    for (const entry of [...list]) {
      if (entry.once) this.off(event, entry.fn);
      try {
        entry.fn.apply(this, args);
      } catch (err) {
        console.error(`[web] "${String(event)}" listener failed:`, err);
      }
    }
    return true;
  }
}

/** The first argument of a preventable Electron event. */
export function electronEvent(extra = {}) {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    ...extra,
  };
  return event;
}
