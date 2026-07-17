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

// app.js — renderer entry point: mounts the app shell.
//
// Stage 00 shell only: a header bar (brand + empty toolbar slot) above a
// full-bleed, empty desk viewport with an inert hint. The infinite desk
// (camera, grid, boards) arrives with Features 10–30.

function buildHeader() {
  const header = document.createElement("header");
  header.className = "app-header";
  header.setAttribute("aria-label", "Application header");

  const brand = document.createElement("div");
  brand.className = "app-header-brand";

  const icon = document.createElement("img");
  icon.className = "app-header-icon";
  icon.src = "chiphippo-icon.svg";
  icon.width = 28;
  icon.height = 28;
  icon.alt = "";
  icon.setAttribute("aria-hidden", "true");
  icon.draggable = false;

  const logo = document.createElement("span");
  logo.className = "app-logo";
  logo.textContent = "Chip Hippo";

  const subtitle = document.createElement("span");
  subtitle.className = "app-subtitle";
  subtitle.textContent = "TTL Breadboard Designer";

  brand.append(icon, logo, subtitle);

  // Empty toolbar slot — later stages mount desk tools (add board, zoom, …).
  const toolbar = document.createElement("div");
  toolbar.className = "app-header-toolbar";
  toolbar.id = "app-toolbar";

  const meta = document.createElement("div");
  meta.className = "app-header-meta";

  const version = document.createElement("span");
  version.className = "app-header-version";
  version.id = "app-version";
  meta.append(version);

  header.append(brand, toolbar, meta);
  return header;
}

function buildDesk() {
  const desk = document.createElement("section");
  desk.className = "desk-viewport";
  desk.setAttribute("aria-label", "Desk");

  const hint = document.createElement("p");
  hint.className = "desk-hint";
  hint.textContent = "Add a breadboard to get started";

  desk.append(hint);
  return desk;
}

async function init() {
  const app = document.getElementById("app");
  app.append(buildHeader(), buildDesk());

  // Prove the IPC bridge end-to-end: the version comes from the main
  // process's package.json over window.chiphippo.getVersion().
  try {
    const version = await window.chiphippo.getVersion();
    document.getElementById("app-version").textContent = `v${version}`;
  } catch (err) {
    console.error("[renderer] app:version failed:", err);
  }
}

init();
