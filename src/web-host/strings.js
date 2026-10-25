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

// strings.js — the words the web host shows itself (its dialogs, the menu
// bar's few items of its own), from the same catalogs as every other string
// and resolved the way main resolves its own (app/i18n.js): the visitor's
// chosen language, else the browser's, else English. Keys live under `web.*`
// in src/web/locales/.

import { vfs } from "./node/fs.js";
import i18n from "../app/i18n.js";

const SETTINGS_FILE = "/userData/settings.json";

let catalog = null;

function requestedLocale() {
  try {
    const raw = vfs.readFileSync(SETTINGS_FILE, "utf8");
    return JSON.parse(raw)?.locale ?? "system";
  } catch {
    return "system";
  }
}

/** Forget the resolved catalog (the language setting moved). */
export function reloadStrings() {
  catalog = null;
}

/**
 * A host string: `key` under the active catalog, else English, else
 * `fallback`; `{name}` placeholders filled from `params`.
 */
export function t(key, fallback, params) {
  let cat = catalog;
  if (!cat) {
    cat = i18n.loadCatalog({
      requested: requestedLocale(),
      systemLocale: globalThis.navigator?.language ?? "en",
    });
    // Asked before the catalogs are on hand (a startup that failed early):
    // the fallback serves, and the next ask tries again.
    if (Object.keys(cat.fallback ?? {}).length) catalog = cat;
  }
  return i18n.label(cat, key, fallback, params);
}
