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

// app-boot-web.test.js — app-boot.test.js again, as the WEB build boots it
// (.claude/rules/web.md): the web preload's `window.chiphippoWeb` is there
// before app.js runs, so every place the shell differs (web-flavour.js) is
// taken. The shell must still stand up whole, and the header gains its book.

globalThis.chiphippoWeb = Object.freeze({ fsAccess: true, serial: true });
await import("./app-boot.test.js");
