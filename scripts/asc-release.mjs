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

// asc-release.mjs — drive the App Store Connect side of a release: point a
// version record at an uploaded build, write its release notes, and submit it.
//
// ONE tool, used by BOTH the CI job and a human at a terminal, for the reason
// every other pair in this repo shares one source: a release path that is
// automated down one route and hand-run down another is two paths that will
// disagree, and the disagreement shows up as a botched submission.
//
//   node scripts/asc-release.mjs status
//   node scripts/asc-release.mjs prepare --version 1.0.1 --build 1.0.2 --notes-file notes.txt
//   node scripts/asc-release.mjs submit  --version 1.0.1
//
// Auth is an App Store Connect API key, taken from the environment:
//   APPLE_API_KEY_ID      the key's 10-character id
//   APPLE_API_ISSUER      the issuer UUID
//   APPLE_API_KEY_BASE64  the .p8 itself, base64 (CI), OR the file is read from
//                         ~/.appstoreconnect/private_keys/AuthKey_<id>.p8 (local)
//
// Nothing here prints key material, and nothing writes to the repo.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUNDLE_ID = "com.chiphippo.app";
const PLATFORM = "MAC_OS";
const API = "https://api.appstoreconnect.apple.com";

// ── auth ─────────────────────────────────────────────────────────────────────

function privateKey() {
  const b64 = process.env.APPLE_API_KEY_BASE64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  const id = requireEnv("APPLE_API_KEY_ID");
  const p = path.join(
    os.homedir(),
    ".appstoreconnect",
    "private_keys",
    `AuthKey_${id}.p8`,
  );
  if (!fs.existsSync(p)) {
    fail(`No API key. Set APPLE_API_KEY_BASE64, or place the .p8 at ${p}`);
  }
  return fs.readFileSync(p, "utf8");
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) fail(`Missing required environment variable ${name}`);
  return v;
}

// Buffer must be handled before the JSON branch: the signature arrives as one,
// and JSON.stringify turns it into {"type":"Buffer","data":[...]} — which still
// base64s cleanly, so the only symptom is a 401 from a well-formed-looking JWT.
const b64u = (v) => {
  const buf = Buffer.isBuffer(v)
    ? v
    : Buffer.from(typeof v === "string" ? v : JSON.stringify(v));
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

// The JWT is minted per call rather than cached: it is valid for 10 minutes and
// `prepare` can sit waiting on build processing for far longer than that.
function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({
    alg: "ES256",
    kid: requireEnv("APPLE_API_KEY_ID"),
    typ: "JWT",
  });
  const body = b64u({
    iss: requireEnv("APPLE_API_ISSUER"),
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  });
  const sig = crypto.sign(null, Buffer.from(`${head}.${body}`), {
    key: privateKey(),
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${b64u(sig)}`;
}

async function api(method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = (() => {
      try {
        return JSON.parse(text)
          .errors.map((e) => `${e.title}: ${e.detail}`)
          .join("; ");
      } catch {
        return text.slice(0, 400);
      }
    })();
    const err = new Error(`${method} ${endpoint} -> ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const get = (e) => api("GET", e);
const post = (e, b) => api("POST", e, b);
const patch = (e, b) => api("PATCH", e, b);

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ── lookups ──────────────────────────────────────────────────────────────────

async function appId() {
  const r = await get(`/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  if (!r.data.length) fail(`No app found for bundle id ${BUNDLE_ID}`);
  return r.data[0].id;
}

async function versions(app) {
  const r = await get(`/v1/apps/${app}/appStoreVersions?limit=50`);
  return r.data.map((v) => ({
    id: v.id,
    version: v.attributes.versionString,
    state: v.attributes.appStoreState ?? v.attributes.appVersionState,
  }));
}

// The record we may edit. App Store Connect allows exactly one version in an
// editable state at a time, so this is a lookup, never a choice.
const EDITABLE = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);

async function editableVersion(app) {
  return (await versions(app)).find((v) => EDITABLE.has(v.state)) ?? null;
}

// ── promotional text ─────────────────────────────────────────────────────────
//
// The whole reason this script exists rather than a few curl calls. Promotional
// text is per-VERSION, not per-app: a freshly created version record starts with
// it EMPTY, and because it is the one field that is not shown on the version
// page until you scroll, it is silently lost on exactly the releases nobody is
// watching closely. So it is carried forward explicitly, from the newest version
// that has one, and never simply assumed to have survived.

async function localizations(versionId) {
  const r = await get(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
  );
  return r.data;
}

async function inheritedPromotionalText(app, exceptVersionId) {
  for (const v of await versions(app)) {
    if (v.id === exceptVersionId) continue;
    for (const l of await localizations(v.id)) {
      if (l.attributes.promotionalText) {
        return {
          locale: l.attributes.locale,
          text: l.attributes.promotionalText,
        };
      }
    }
  }
  return null;
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const app = await appId();
  console.log(`app ${app}  (${BUNDLE_ID})\n`);

  console.log("versions:");
  for (const v of await versions(app)) {
    const build = await get(`/v1/appStoreVersions/${v.id}/build`).catch(
      () => null,
    );
    console.log(
      `  ${v.version.padEnd(10)} ${v.state.padEnd(24)} build: ${build?.data?.id ?? "<none attached>"}`,
    );
    for (const l of await localizations(v.id)) {
      const a = l.attributes;
      console.log(
        `      ${a.locale}  promotionalText: ${a.promotionalText ? "set" : "EMPTY"}   whatsNew: ${a.whatsNew ? "set" : "EMPTY"}`,
      );
    }
  }

  console.log("\nbuilds (newest first):");
  const b = await get(
    `/v1/builds?filter[app]=${app}&limit=10&sort=-uploadedDate&include=preReleaseVersion`,
  );
  const trains = Object.fromEntries(
    (b.included ?? []).map((i) => [i.id, i.attributes.version]),
  );
  for (const x of b.data) {
    const train = trains[x.relationships.preReleaseVersion?.data?.id] ?? "?";
    console.log(
      `  short ${String(train).padEnd(8)} build ${String(x.attributes.version).padEnd(10)} ${x.attributes.processingState}`,
    );
  }
}

async function cmdPrepare(opts) {
  const target = opts.version ?? fail("--version is required");
  const app = await appId();

  // 1. The version record.
  let record = (await versions(app)).find((v) => v.version === target) ?? null;
  if (!record) {
    const editable = await editableVersion(app);
    if (editable) {
      // Renaming the open record beats creating a second one: App Store Connect
      // permits only one editable version, so a create would simply be refused.
      console.log(
        `retargeting the editable ${editable.version} record -> ${target}`,
      );
      await patch(`/v1/appStoreVersions/${editable.id}`, {
        data: {
          type: "appStoreVersions",
          id: editable.id,
          attributes: { versionString: target },
        },
      });
      record = { ...editable, version: target };
    } else {
      console.log(`creating a new version record ${target}`);
      const created = await post("/v1/appStoreVersions", {
        data: {
          type: "appStoreVersions",
          attributes: { platform: PLATFORM, versionString: target },
          relationships: { app: { data: { type: "apps", id: app } } },
        },
      });
      record = {
        id: created.data.id,
        version: target,
        state: created.data.attributes.appStoreState,
      };
    }
  } else {
    console.log(`using existing ${target} record (${record.state})`);
  }

  // 2. Promotional text, carried forward BEFORE anything else touches the
  //    localization — see the note above.
  const locs = await localizations(record.id);
  const inherited =
    opts.promotionalText === false
      ? null
      : await inheritedPromotionalText(app, record.id);
  for (const l of locs) {
    const attrs = {};
    if (!l.attributes.promotionalText && inherited) {
      attrs.promotionalText = inherited.text;
      console.log(
        `carrying promotional text forward into ${l.attributes.locale}`,
      );
    }
    if (opts.notes) attrs.whatsNew = opts.notes;
    if (!Object.keys(attrs).length) continue;
    await patch(`/v1/appStoreVersionLocalizations/${l.id}`, {
      data: {
        type: "appStoreVersionLocalizations",
        id: l.id,
        attributes: attrs,
      },
    });
  }
  if (inherited && !locs.some((l) => !l.attributes.promotionalText)) {
    console.log("promotional text already present — left as it is");
  }

  // 3. The build. Matched on BOTH the train (short version) and the build
  //    number, because the same build number legitimately exists in more than
  //    one train and attaching the wrong one is not visible on the version page.
  if (opts.build) {
    const found = await get(
      `/v1/builds?filter[app]=${app}&filter[preReleaseVersion.version]=${target}` +
        `&filter[version]=${opts.build}&limit=1`,
    );
    if (!found.data.length) {
      fail(
        `No build ${opts.build} in the ${target} train. Upload it first, or wait for processing.`,
      );
    }
    const build = found.data[0];
    if (build.attributes.processingState !== "VALID") {
      fail(
        `Build ${opts.build} is ${build.attributes.processingState}, not VALID — cannot attach yet.`,
      );
    }
    await patch(`/v1/appStoreVersions/${record.id}/relationships/build`, {
      data: { type: "builds", id: build.id },
    });
    console.log(`attached build ${opts.build} (${build.id})`);
  }

  console.log(
    `\nprepared ${target}. Review it, then: node scripts/asc-release.mjs submit --version ${target}`,
  );
}

async function cmdSubmit(opts) {
  const target = opts.version ?? fail("--version is required");
  const app = await appId();
  const record = (await versions(app)).find((v) => v.version === target);
  if (!record) fail(`No version record ${target}`);

  const build = await get(`/v1/appStoreVersions/${record.id}/build`).catch(
    () => null,
  );
  if (!build?.data)
    fail(`Version ${target} has no build attached — run 'prepare' first.`);

  // The modern flow is reviewSubmissions + items; appStoreVersionSubmissions is
  // the older single-shot call and is refused for apps onboarded since.
  const existing = await get(
    `/v1/reviewSubmissions?filter[app]=${app}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW&limit=1`,
  ).catch(() => ({ data: [] }));
  if (existing.data?.length)
    fail(
      `A review submission is already open (${existing.data[0].attributes.state}).`,
    );

  const submission = await post("/v1/reviewSubmissions", {
    data: {
      type: "reviewSubmissions",
      attributes: { platform: PLATFORM },
      relationships: { app: { data: { type: "apps", id: app } } },
    },
  });
  await post("/v1/reviewSubmissionItems", {
    data: {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: {
          data: { type: "reviewSubmissions", id: submission.data.id },
        },
        appStoreVersion: { data: { type: "appStoreVersions", id: record.id } },
      },
    },
  });
  await patch(`/v1/reviewSubmissions/${submission.data.id}`, {
    data: {
      type: "reviewSubmissions",
      id: submission.data.id,
      attributes: { submitted: true },
    },
  });
  console.log(
    `submitted ${target} for review (submission ${submission.data.id})`,
  );
}

// ── entry ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--version") o.version = argv[++i];
    else if (a === "--build") o.build = argv[++i];
    else if (a === "--notes") o.notes = argv[++i];
    else if (a === "--notes-file")
      o.notes = fs.readFileSync(argv[++i], "utf8").trim();
    else if (a === "--no-promotional-text") o.promotionalText = false;
    else fail(`Unknown argument ${a}`);
  }
  return o;
}

const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
try {
  if (cmd === "status") await cmdStatus();
  else if (cmd === "prepare") await cmdPrepare(opts);
  else if (cmd === "submit") await cmdSubmit(opts);
  else fail("Usage: asc-release.mjs <status|prepare|submit> [options]");
} catch (e) {
  fail(e.message);
}
