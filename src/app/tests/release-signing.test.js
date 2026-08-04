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

// release-signing.test.js — the release workflow's signing configuration, held
// against what the PUBLIC CODE-SIGNING POLICY promises about it.
//
// website/code-signing-policy.html tells visitors, in as many words, which
// platforms are wired for signing and which are not, so that a reader deciding
// whether to trust an unsigned binary is reading something true. That page has
// already been wrong once — it claimed both platforms would "activate without
// any code change once the certificates are configured" when there was no
// Windows signing step at all, and when nothing passed Apple's notarization
// credentials, so a configured certificate would still have produced a build
// Gatekeeper blocks.
//
// A page cannot notice the workflow changing underneath it. This is what
// notices. Every assertion below corresponds to a sentence on that page, and a
// failure here is not necessarily a bug in the workflow — adding Windows
// signing is a GOOD change — it is a reminder that the page now says something
// the pipeline does not do.
//
// Deliberately text-based rather than YAML-parsed: js-yaml is not a direct
// dependency (only a transitive one), and what is being checked is the presence
// and absence of specific credentials and tools, which is a textual question.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const WORKFLOW = path.join(ROOT, ".github/workflows/release.yml");
const POLICY = path.join(ROOT, "website/code-signing-policy.html");

const workflow = () => fs.readFileSync(WORKFLOW, "utf8");
const policy = () => fs.readFileSync(POLICY, "utf8");

/** One `- name: <title>` step's text, up to the next step at the same indent. */
function step(yaml, title) {
  const start = yaml.indexOf(`- name: ${title}`);
  assert.notEqual(start, -1, `release.yml should still have a "${title}" step`);
  const rest = yaml.slice(start + 1);
  const end = rest.search(/\n {6}- (name|uses):/);
  return end === -1 ? rest : rest.slice(0, end);
}

// ── macOS: wired, waiting on a certificate ──────────────────────────────────

test("macOS signing is gated on repository secrets, not on a code change", () => {
  const build = step(workflow(), "Build installers (macOS / Linux)");

  // Passed under INPUT_ names and exported only when non-empty. A workflow
  // `env:` entry always DEFINES the variable, so `CSC_LINK: ${{ secrets.X }}`
  // on a missing secret is an empty STRING, which electron-builder reads as an
  // explicit (blank) certificate path and fails on — not as "no certificate".
  assert.match(build, /INPUT_CSC_LINK:\s*\$\{\{\s*secrets\.CSC_LINK\s*\}\}/);
  assert.match(
    build,
    /INPUT_CSC_KEY_PASSWORD:\s*\$\{\{\s*secrets\.CSC_KEY_PASSWORD\s*\}\}/,
  );
  assert.match(build, /if \[ -n "\$INPUT_CSC_LINK" \]/);
  assert.match(build, /export CSC_LINK="\$INPUT_CSC_LINK"/);

  // And the no-certificate path must stay explicit, or electron-builder goes
  // looking in the runner's keychain for an identity that is not there.
  assert.match(build, /CSC_IDENTITY_AUTO_DISCOVERY=false/);
});

test("notarization credentials reach the build, and only alongside a certificate", () => {
  const build = step(workflow(), "Build installers (macOS / Linux)");

  for (const name of [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(
      build,
      new RegExp(`INPUT_${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`),
      `${name} must be passed through, or a signed build is still not notarized ` +
        `and Gatekeeper still blocks it — which the policy page says it does not`,
    );
  }

  // notarytool rejects an unsigned app, so credentials WITHOUT a certificate
  // would turn a working unsigned build into a failed one. The Apple block has
  // to sit inside the `if [ -n "$INPUT_CSC_LINK" ]` branch.
  const signing = build.slice(
    build.indexOf('if [ -n "$INPUT_CSC_LINK" ]'),
    build.indexOf("\n          else"),
  );
  assert.ok(
    signing.length > 0,
    "the signing branch should still be shaped that way",
  );
  assert.match(signing, /export APPLE_ID="\$INPUT_APPLE_ID"/);
});

test("the mac build does not pin notarize off — only the store builds do", () => {
  // `mas`/`masDev` set `notarize: false` correctly: App Store review notarizes.
  // The plain `mac` block must NOT, or electron-builder skips notarization even
  // with every credential present, and no amount of secrets would help.
  const build = require("../../package.json").build;
  assert.equal(
    Object.prototype.hasOwnProperty.call(build.mac, "notarize"),
    false,
    "build.mac must leave notarize at its default (credential-driven)",
  );
  assert.equal(build.mas.notarize, false);
  assert.equal(build.masDev.notarize, false);
});

// ── Windows: not built yet ──────────────────────────────────────────────────

// If this test fails because Windows signing was ADDED, that is a good day —
// update website/code-signing-policy.html §3, which currently tells visitors
// "There is no Authenticode signing step in the release workflow at all", and
// then update the list here.
const WINDOWS_SIGNING = [
  "signtool",
  "azuresigntool",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "certificateFile",
  "certificateSubjectName",
  "certificateSha1",
  "signingHashAlgorithms",
  "signtoolOptions",
  "azureSignOptions",
];

test("the Windows build passes no signing credentials", () => {
  const build = step(workflow(), "Build installers (Windows)");
  // It is the one build step with no `env:` at all — the CSC block above is
  // guarded `if: runner.os != 'Windows'`, and electron-builder's CSC_LINK is
  // cross-platform, so a stray env entry here WOULD start signing.
  assert.doesNotMatch(build, /\bCSC_LINK\b/);
  for (const token of WINDOWS_SIGNING) {
    assert.doesNotMatch(
      build,
      new RegExp(token, "i"),
      `"${token}" in the Windows build step means the policy page's ` +
        `"no Authenticode signing step" is now false`,
    );
  }
});

test("electron-builder's win config declares no certificate", () => {
  const win = require("../../package.json").build.win;
  for (const token of WINDOWS_SIGNING) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(win, token),
      false,
      `build.win.${token} would sign Windows builds — update the policy page`,
    );
  }
});

// ── The pair ────────────────────────────────────────────────────────────────

test("the policy page still points at the workflow as the authority", () => {
  // The page's own closing line makes release.yml the source of truth and asks
  // a reader to report a mismatch. Losing that link is how a page starts being
  // believed over the thing it describes.
  const html = policy();
  assert.match(html, /\.github\/workflows\/release\.yml/);
});

test("the workflow points back at the policy page", () => {
  // The other half of the pair: whoever edits the signing steps should be told,
  // in the file they are editing, that a public page describes them.
  assert.match(workflow(), /code-signing policy/i);
});
