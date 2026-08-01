# Chip Hippo — Mac App Store checklist

Live working notes for the store channel. The *process* lives in
[STORE-PUBLISHING.md](STORE-PUBLISHING.md); this file tracks what is done and what is
left.

## Key facts

| Thing | Value |
| --- | --- |
| Apple Team ID | `2C564TQ2FY` (Jason Figge) |
| Bundle ID | `com.chiphippo.app` (matches `build.appId`) |
| App Store Connect app id | _(fill in once the record exists)_ |
| Current version | `0.9.1` (`src/package.json`) |
| Distribution profile | `src/packaging/embedded.provisionprofile` — *Chip Hippo MAS Distribution*, expires **2027-07-07** |
| Development profile | `src/packaging/development.provisionprofile` — *Chip Hippo macOS App Development*, expires **2027-07-30** |
| App signing cert | Apple Distribution: Jason Figge (2C564TQ2FY) |
| Installer cert | 3rd Party Mac Developer Installer: Jason Figge (2C564TQ2FY) |
| Dev signing cert | Apple Development: Jason Figge (F457H24AUH) |
| Built package | `build/src/dist/mas-universal/Chip-Hippo-<version>-universal.pkg` |

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

## Before the first submission

- [ ] Create the **App Store Connect record** for `com.chiphippo.app` and record its app
      id in the table above.
- [ ] Run the `make mas-dev` round trips in STORE-PUBLISHING.md §2 — especially the
      **quit-and-relaunch** ones (Open Recent, datasheet folder), which are the only way
      to see a bookmark fail.
- [ ] Decide the marketing version. `0.9.x` is honest but reads as a beta on a store
      listing; a `1.0.0` submission is a version bump in `src/package.json` first.
- [ ] Screenshots (macOS, 2560×1600 or 2880×1800). The desk with a wired 74LS-series
      circuit running, the schematic view, the build guide, and the AI builder are the
      four that show what the app is.
- [ ] Description, keywords, support URL, marketing URL (chiphippo.com), category
      (Developer Tools).
- [ ] **Privacy answers.** Chip Hippo collects nothing and has no analytics. The one
      thing to declare carefully: an AI build sends the user's prompt to *their own*
      provider account, using a key they supplied — no data reaches us at any point.
- [ ] **Export compliance.** Standard TLS only (HTTPS to the AI provider and the
      datasheet hosts) plus the OS keychain via `safeStorage` — exempt.
      `ITSAppUsesNonExemptEncryption: false` is already in the build, so the
      per-submission prompt should not appear.
- [ ] Review notes: say that the in-app updater is absent **on purpose** in a store
      build, so a reviewer does not report it as a missing feature.

## Known gotchas

- **A re-upload of the same version needs a unique build number** — bump `version` or
  pass `-c.mac.bundleVersion=<version>.<n>` (STORE-PUBLISHING.md §3).
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
