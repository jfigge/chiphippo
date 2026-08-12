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
| Current build | **1.0.0 (`CFBundleVersion` 1.0.0.1)**, built 2026-08-12 with the 1.5.0 + 2.1(a) fixes |

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
- [ ] Screenshots (macOS, 2560×1600 or 2880×1800). The desk with a wired 74LS-series
      circuit running, the schematic view, the build guide, and the AI builder are the
      four that show what the app is.
- [ ] Description, keywords, support URL, marketing URL (chiphippo.com), category
      (Developer Tools). **Drafted in [APP_STORE_LISTING.md](APP_STORE_LISTING.md)**,
      with the review notes, privacy answers and screenshot shot list beside them.
- [ ] **Privacy answers.** Chip Hippo collects nothing and has no analytics. The one
      thing to declare carefully: an AI build sends the user's prompt to *their own*
      provider account, using a key they supplied — no data reaches us at any point.
- [ ] **Export compliance.** Standard TLS only (HTTPS to the AI provider and the
      datasheet hosts) plus the OS keychain via `safeStorage` — exempt.
      `ITSAppUsesNonExemptEncryption: false` is already in the build, so the
      per-submission prompt should not appear.
- [ ] Review notes: say that the in-app updater is absent **on purpose** in a store
      build, so a reviewer does not report it as a missing feature.

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
  `make mas MAS_BUILD_VERSION=<version>.<n>` (STORE-PUBLISHING.md §3). Never bump
  `version` to get past it: that moves `CFBundleShortVersionString` away from the
  App Store Connect version record it has to match.
- **A re-issued certificate invalidates the profile that embeds it.** Regenerate and
  re-download the profile, or the build passes locally and fails validation.
- **`pkgutil` labels the installer cert "issued by Apple (Development)"** — cosmetic,
  not a wrong certificate.

## Later — CI

Not wired up yet. The shape, when it is (mirroring Rest Hippo's `store-mas` job):

- A `store-mas` job in `.github/workflows/release.yml`, gated
  `if: vars.MAS_ENABLED == 'true'`, on `macos-latest`.
- Secrets: `MAS_CSC_LINK` / `MAS_CSC_KEY_PASSWORD` (Apple Distribution `.p12`),
  `MAS_INSTALLER_CSC_LINK` / `MAS_INSTALLER_CSC_KEY_PASSWORD` (Mac Installer),
  `MAS_PROVISIONING_PROFILE_BASE64` — decoded into
  `src/packaging/embedded.provisionprofile` before `make mas`. Setting that last one is
  also the marker `MAS_SIGN_ENV` uses to know it is in CI and must NOT strip `CSC_LINK`.
- Upload the `.pkg` as a run artifact (not attached to the public Release, which globs
  `installers-*`).
- A separate submit step gated on BOTH a tag push and `vars.STORE_SUBMIT_ENABLED`, using
  an App Store Connect API key (`APPLE_API_KEY_ID` / `APPLE_API_ISSUER` /
  `APPLE_API_KEY_BASE64`) — app-specific passwords do not work headless with 2FA. Even
  then, *Submit for Review* stays a manual click.
