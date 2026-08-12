# Chip Hippo — Mac App Store checklist

Live working notes for the store channel. The *process* lives in
[STORE-PUBLISHING.md](STORE-PUBLISHING.md); this file tracks what is done and what is
left.

## Key facts

| Thing | Value |
| --- | --- |
| Apple Team ID | `2C564TQ2FY` (Jason Figge) |
| Bundle ID | `com.chiphippo.app` (matches `build.appId`) |
| App Store Connect record | Exists — *Chip Hippo*, macOS App Version **1.0.0**, Prepare for Submission |
| Current version | `1.0.0` (`src/package.json`) |
| Distribution profile | `src/packaging/embedded.provisionprofile` — *Chip Hippo MAS Distribution*, expires **2027-07-07** |
| Development profile | `src/packaging/development.provisionprofile` — *Chip Hippo macOS App Development*, expires **2027-07-30** |
| App signing cert | Apple Distribution: Jason Figge (2C564TQ2FY) |
| Installer cert | 3rd Party Mac Developer Installer: Jason Figge (2C564TQ2FY) |
| Dev signing cert | Apple Development: Jason Figge (F457H24AUH) |
| Built package | `build/src/dist/mas-universal/Chip-Hippo-<version>-universal.pkg` |
| First upload | **1.0.0 uploaded 2026-08-04** — delivery UUID `6cc4e2ff-3ae3-4459-a913-96d90befe83b` |
| First submission | **1.0.0 submitted for review 2026-08-04** — REJECTED |
| Rejected upload | **`CFBundleVersion` 1.0.0.1, 2026-08-12** — refused: a build number is three components at most, not four |
| Current build | **1.0.0 (`CFBundleVersion` 1.0.1)**, built 2026-08-12 with the 1.5.0 + 2.1(a) fixes. Verified: Apple Distribution, universal, sandboxed, profile embedded. |
| Second upload | **`CFBundleVersion` 1.0.1 uploaded 2026-08-12** — delivery UUID `71cd2385-ea5b-44b5-bae7-d54d085d9876`, processed **VALID**. |
| Second submission | **1.0.0 (build 1.0.1) submitted 2026-08-12 17:54 UTC** — `WAITING_FOR_REVIEW`, submission `fa5a89e4-b871-4a64-bb95-b000b9ae7225`. Submitted by hand in the console. |
| Next binary | **1.0.1 (`CFBundleVersion` 1.0.2)** built 2026-08-12, at `build/src/dist/mas-universal/`. **Not uploaded** — see "Shipping 1.0.1" below. |
| ASC app id | `6797996411`; version record `1.0.0` is `70269974-2ad1-49af-a123-3bb3bc9a09ed` |
| API key | `X3M2YK7357`, issuer `245bb0e6-5b7e-47e4-946b-60e8ee1bc19c`; `.p8` in `certs/` (⇄ `~/.appstoreconnect/private_keys/`) |

## Done

- [x] `src/packaging/` — sandbox entitlements (app-sandbox, allow-jit,
      user-selected.read-write, **bookmarks.app-scope**, network.client) + the inherit
      plist for the helpers.
- [x] `mas` / `masDev` blocks in `src/package.json`; `ITSAppUsesNonExemptEncryption`
      declared for both macs.
- [x] `make mas` / `make mas-dev`, both skipping cleanly without a profile.
- [x] Security-scoped bookmarks (`app/store/bookmark-store.js`) so **Open Recent** and
      the **datasheet folder** survive a relaunch inside the sandbox.
- [x] `io.js` in-place write fallback, so saving to a user-chosen file works under the
      sandbox.
- [x] `make mas` produces a universal `.pkg`, app signed by Apple Distribution,
      installer signed by 3rd Party Mac Developer Installer.
- [x] `make mas-dev` produces an app that launches sandboxed (not AMFI-killed).
- [x] **Save-As bookmarks fixed.** The smoke test found the one bug only a store build
      can have: `showSaveDialog`'s bookmark is stale from the next launch
      ([electron#32544](https://github.com/electron/electron/issues/32544)), so every
      project made with Save As reopened as a raw `EPERM`. A redeem is now proved with
      a real read (`existsSync` lies under the sandbox — it answers true for files it
      will not open), a dead blob is dropped, and `denied` is reported separately from
      `missing` so the renderer offers to **re-grant** the file through an open panel
      instead of offering to forget it.

## Before the first submission

- [x] Create the **App Store Connect record** for `com.chiphippo.app`. Its version
      string must match `CFBundleShortVersionString` EXACTLY — it was created as `1.0`
      against the build's `1.0.0` and was corrected in App Store Connect, not the repo.
- [x] Run the `make mas-dev` round trips in STORE-PUBLISHING.md §2 — all pass. The
      quit-and-relaunch pair earned their place: Open Recent FAILED and produced the
      Save-As bookmark fix above; the datasheet folder passed, proved by pointing it at
      an external folder holding only `74LS00.pdf` and confirming 74LS10 stayed absent
      (a fallback to the app's own folder would have shown one, since it has 74LS10).
- [x] Decide the marketing version — shipped as `1.0.0`.
- [x] Screenshots — **6 uploaded, all `COMPLETE`** in the `APP_DESKTOP` set.
- [x] Description (3106 chars), keywords, support URL, marketing URL — all set on the
      `en-US` version localization. Categories are **Developer Tools** (primary) +
      **Education** (secondary).
- [x] **Privacy answers**, **export compliance** and **review notes** — all answered.
      Not individually re-checked here, but the submission reached `WAITING_FOR_REVIEW`,
      which App Store Connect refuses until every app-level setting below exists.

**Verified live 2026-08-12 via `scripts/asc-release.mjs` + the ASC API**, not from
memory — this section had gone stale and was claiming work that was already done.

## App-level settings (not per-version — done once, block "Add for Review")

"Add for Review" refuses until all five exist. None are part of the build, and
four are a single click; only Content Rights is a decision.

- **Privacy Policy URL** → `https://chiphippo.com/privacy.html` (already written
  and live; `website/privacy.html` in this repo).
- **Primary category** → **Developer Tools**, matching the binary's
  `LSApplicationCategoryType`. Secondary **Education** optional.
- **Price** → **Free**.
- **App Privacy** → **Data Not Collected**. Needs the **Admin** role. The AI
  builder does not change this: the prompt goes to the USER's own provider
  account under the USER's own key, so it is not collected by us or by a partner
  of ours.
- **Content Rights** → **Yes**, plus the rights confirmation. The app SHIPS
  cropped manufacturer datasheet regions (`src/web/datasheets/*.png`, shown in
  every pin-assignments window) and DOWNLOADS manufacturer PDFs on request, so
  "no third-party content" would be untrue.

## Rejections to clear

`1.0.0` (submitted 2026-08-04) came back with several. Tracked here as they are
worked; the wording of each fix is in
[APP_STORE_LISTING.md](APP_STORE_LISTING.md).

- [x] **1.5.0 Safety: Developer Information (macOS)** — the app carried no
      contact route. Added About ▸ *Support:* and Help ▸ *Chip Hippo Support*
      (both `hippoherd@gmail.com`), plus a `mailto:` Contact link in the
      website footer. Localized in all seven catalogs and pinned by a test.
- [x] **2.1(a) Performance: App Completeness** — *"all buttons in the app menu
      were unresponsive"* (MacBook Air 15" M3, macOS 26.6). **Not reproduced**:
      the menu wiring was verified end to end (template → `sendToMain` →
      preload re-dispatch → renderer listener → a real `ProjectWorkspace`
      method), a sandboxed `mas-dev` build boots clean from a fresh container
      on macOS 15.6, and the universal `mas` artifact is well formed (one
      `app.asar`, x86_64 + arm64, `embedded.provisionprofile` present, signed
      *Apple Distribution*). What the symptom DOES fit exactly is a window that
      never appeared: `show: false` plus `win.once("ready-to-show", …)` as the
      **only** route to `show()`, with `loadFile`'s rejection swallowed. That
      leaves a running app with a full menu bar and no window, so every item
      pushes into something nobody can see. Measured here: `did-finish-load`
      beats `ready-to-show` on this machine, i.e. the paint is genuinely the
      late signal, and it is the one that was being waited on. Fixed by making
      the window's appearance unconditional — first of `ready-to-show` /
      a paint grace period after load / `did-fail-load` / `render-process-gone`
      / an 8 s backstop — and by logging every fallback and every load failure.
      Separately, About / Settings / Keyboard Shortcuts now register at the TOP
      of `init()` rather than its last lines, so the application menu answers
      even when something below has failed to build.

## Known gotchas

- **A re-upload of the same version needs a unique build number** —
  `make mas MAS_BUILD_VERSION=<x.y.z>` (STORE-PUBLISHING.md §3). Never bump
  `version` to get past it: that moves `CFBundleShortVersionString` away from the
  App Store Connect version record it has to match.
- **The build number is THREE components, never four.** `CFBundleVersion` is at
  most three period-separated integers, so `1.0.0.1` is rejected on upload — which
  is what happened to the 2026-08-12 re-upload. It is its own ascending counter,
  unrelated in shape to the marketing version: `1.0.1` under a `1.0.0` marketing
  version is correct.
- **A build belongs to the TRAIN of its `CFBundleShortVersionString`, permanently.** Both
  builds uploaded on 2026-08-12 are in the `1.0.0` train, so neither can ever attach to a
  `1.0.1` version record however high its build number is. Shipping `1.0.1` needs a binary
  built *after* the `src/package.json` bump — bumping `MAS_BUILD_VERSION` alone is not it.
- **Only one version record may be editable at a time.** While one sits in
  `WAITING_FOR_REVIEW` / `IN_REVIEW`, the next version cannot be created beside it.
- **A re-issued certificate invalidates the profile that embeds it.** Regenerate and
  re-download the profile, or the build passes locally and fails validation.
- **`pkgutil` labels the installer cert "issued by Apple (Development)"** — cosmetic,
  not a wrong certificate.

## Shipping 1.0.1 — blocked until 1.0.0 clears review

The 1.0.1 binary exists (short `1.0.1`, `CFBundleVersion` 1.0.2) and is built. It
**cannot be shipped yet**, and the reason is not a missing step:

- App Store Connect allows **exactly one version record in an editable state**, and
  `1.0.0` is currently `WAITING_FOR_REVIEW`. A `1.0.1` record cannot be added beside it.
- Making room means **removing 1.0.0 from review** (developer-reject), which forfeits its
  place in the queue — days of waiting, to ship a build whose fixes are the ones already
  under review. Not worth it.
- Both uploaded builds (`1.0.0`, `1.0.1`) live in the **`1.0.0` short-version train**, so
  neither can ever attach to a `1.0.1` record. The already-built 1.0.2 binary is the one
  that can.

So: **wait for the 1.0.0 verdict.**

- *Approved* → create the `1.0.1` record, `make upload`, then
  `node scripts/asc-release.mjs prepare --version 1.0.1 --build 1.0.2 --notes-file …`
  and `submit`. Or just push the tag once CI is fully configured (below).
- *Rejected* → the record returns to an editable state, and 1.0.1 becomes the natural
  answer to whatever came back.

## CI — wired, awaiting four secrets

`.github/workflows/release.yml` carries **`store-mas`** (build → verify → upload) and
**`store-submit`** (wait for processing → prepare → submit), both triggered by the tag
`make release VERSION=x.y.z` pushes. `scripts/asc-release.mjs` is the App Store Connect
client, used by **both** CI and a human at a terminal so the two paths cannot diverge.

All eight secrets are configured:

- [x] `MAS_PROVISIONING_PROFILE_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`,
      `APPLE_API_KEY_BASE64` — pushed 2026-08-12 17:53.
- [x] `MAS_CSC_LINK` / `MAS_CSC_KEY_PASSWORD` (*Apple Distribution*) and
      `MAS_INSTALLER_CSC_LINK` / `MAS_INSTALLER_CSC_KEY_PASSWORD` (*3rd Party Mac
      Developer Installer*) — pushed 2026-08-12 19:07–19:09.

Then the two switches. The jobs are gated on these **variables** rather than on the
secrets existing, so a half-configured signing setup fails loudly instead of skipping
silently:

```bash
gh variable set MAS_ENABLED --body true          # build + upload every tagged release
gh variable set STORE_SUBMIT_ENABLED --body true # also submit it for review
```

Keep them independent: uploading is reversible, submitting joins a review queue.

### Proving the credentials without cutting a release

Six of the eight secrets are opaque blobs, and **nothing local can tell you a `.p12` was
exported correctly** — so `store-mas` also runs on a **manual dispatch**, where it builds,
signs and verifies exactly as a tagged run does but stops short of the upload:

```bash
gh variable set MAS_ENABLED --body true
gh workflow run release.yml --ref main
```

A green run means the certificates, the passphrases and the profile are all good. Do this
**before** trusting a tagged release to them — otherwise the first test of a store
credential is a real release, and a bad one costs the tag. The upload is tag-only because
it is the one step that cannot be repeated: every upload burns a build number
permanently, and a build number cannot be reused even after its build is deleted.
