# Publishing Chip Hippo to the Mac App Store

The maintainer's runbook. Everything here is macOS-only and needs an Apple Developer
account; nothing in it is required to build or ship the direct downloads.

## What a store build is, and is not

Chip Hippo ships **one codebase** to every channel. Electron sets `process.mas` in a Mac
App Store build, and `src/app/store-build.js` is the single place that reads it. Nothing
about the app is branched at BUILD time — a store build is the same code, gated at
runtime.

| Disabled in a store build | Why |
| --- | --- |
| The in-app updater, the Help ▸ *Check for Updates…* item, and the Settings ▸ About controls | The App Store delivers updates; electron-builder strips the feed from the package, and the sandbox forbids an app replacing itself. Settings ▸ About says so rather than showing dead buttons. |

Everything else works: opening and saving projects, exporting and importing desktops,
programming ROMs from `.bin`/Intel HEX, the build guide's RTF export, the AI circuit
builder, the datasheet download, **Open Recent**, and the external **Settings ▸ Data
Sheets** folder. The last two only work because of security-scoped bookmarks
(`src/app/store/bookmark-store.js`) — see *Sandbox notes* below.

## 1. Prerequisites, once per app

1. **App Store Connect record** — appstoreconnect.apple.com → Apps → **+** → New App.
   Platform macOS, bundle ID **`com.chiphippo.app`** (it must match `build.appId` in
   `src/package.json`), and an SKU of your choosing.
2. **Register the App ID with the App Sandbox capability** — developer.apple.com →
   Certificates, Identifiers & Profiles → Identifiers. App Store apps are always
   sandboxed; `src/packaging/entitlements.mas.plist` is what declares it.
3. **Two certificates**, both distinct from the **Developer ID Application** cert the
   direct DMG uses (one machine can hold all three):
   - **Apple Distribution** — signs the `.app`.
   - **Mac Installer Distribution** — signs the `.pkg` you upload. It appears in the
     keychain as *3rd Party Mac Developer Installer: …*.
   For `make mas-dev` you also need an **Apple Development** certificate.
4. **Provisioning profiles** for `com.chiphippo.app`, downloaded and saved as:
   ```
   src/packaging/embedded.provisionprofile     ← Mac App Store distribution → make mas
   src/packaging/development.provisionprofile  ← Mac App Store development  → make mas-dev
   ```
   Both paths are **git-ignored** (`*.provisionprofile`). Never commit them.

A profile **embeds the certificate it authorizes**. If you re-issue a certificate, the
old profile still names the dead one: the build succeeds locally and then fails App
Store validation (or, for `mas-dev`, is killed at launch by AMFI). Regenerate the
profile whenever a certificate changes.

## 2. Build

```sh
make mas-dev   # local sandbox smoke-test — run this FIRST
make mas       # the universal .pkg for the store
```

Both **skip cleanly** (a message, exit 0) when their profile is absent, so a fresh clone
with no Apple material still builds everything else.

`make mas-dev` is the only way to find out what the sandbox denies. Install the built
`.app`, launch it, and exercise the paths that leave the container:

- Save As to `~/Documents`, **quit, relaunch**, and re-open it from **Open Recent**.
- ⌘S back to that file.
- Point **Settings ▸ Data Sheets** at a folder of PDFs, **quit, relaunch**, open a
  pin-assignments window and press the datasheet button.
- Load and export a ROM image; export the Bill Of Materials as RTF.
- Ask the AI builder for a circuit (proves `network.client`).
- Confirm Help has no *Check for Updates…* and About explains why.

The quit-and-relaunch steps are the point: they are what a bookmark buys, and the only
way to see it fail.

`make mas` writes `build/src/dist/mas-universal/Chip-Hippo-<version>-universal.pkg`.
Verify before uploading:

```sh
APP="build/src/dist/mas-universal/Chip Hippo.app"
codesign -dvvv "$APP"                 # Apple Distribution, TeamIdentifier=2C564TQ2FY
codesign -d --entitlements - --xml "$APP"   # app-sandbox + the four others
lipo -archs "$APP/Contents/MacOS/Chip Hippo"   # x86_64 arm64
pkgutil --check-signature build/src/dist/mas-universal/*.pkg
```

`pkgutil` labels the installer certificate *"issued by Apple (Development)"* — a
cosmetic quirk of the Mac Installer Distribution certificate type, not a real
development cert.

## 3. Upload and submit

Upload the `.pkg` with **Transporter** (free on the Mac App Store) or:

```sh
xcrun altool --upload-app -t macos -f <pkg> \
  --apiKey "$APPLE_API_KEY_ID" --apiIssuer "$APPLE_API_ISSUER"
```

Then attach the build to a version in App Store Connect and submit for review. Uploading
only makes the build APPEAR in App Store Connect — *Submit for Review* stays a
deliberate click.

**Re-uploading the same version needs a unique build number.** Either bump `version` in
`src/package.json`, or pass a build number on the command line:

```sh
make mas MAS_CSC_NAME="$MAS_CSC_NAME"   # …then rebuild with, e.g.
cd build/src && npx electron-builder --mac mas --universal --publish never \
  -c.mac.notarize=false -c.mac.bundleVersion=0.9.1.1
```

## 4. Signing identities

The certificates live in your login keychain; the Makefile finds them by
auto-discovery, with two deliberate wrinkles:

- **`MAS_SIGN_ENV`** strips `CSC_LINK`/`CSC_KEY_PASSWORD` for the MAS targets. Those name
  a *Developer ID* `.p12` for the direct builds, which is invalid for the store —
  electron-builder would sign with it and fall back to an ad-hoc signature that macOS
  refuses to launch.
- **`MAS_CSC_NAME`** (default `Jason Figge (2C564TQ2FY)`) pins the identity search for
  `make mas`. electron-builder applies ONE qualifier to both the `.app` and the `.pkg`
  searches, so it must be the substring common to the Apple Distribution and Mac
  Installer certificates. Override it for another account.
  **`mas-dev` deliberately does not pin it** — the development profile embeds *Apple
  Development: Jason Figge (F457H24AUH)*, so the pin would exclude the one certificate
  that profile authorizes. That parenthetical is **not** a team id and not a mismatch:
  Apple names development certificates after a per-developer identifier where the
  distribution ones carry the team. The team is the certificate's **OU**, and it is
  `2C564TQ2FY` on all of them —
  `security find-certificate -c "<CN>" -p | openssl x509 -noout -subject`.

## Sandbox notes

Two facts drive everything unusual in this build.

**A path is only yours if a dialog gave it to you, this launch.** Chip Hippo re-opens
paths it stored earlier — the recent-projects list and the datasheet folder — so those
are backed by **security-scoped bookmarks**: minted by the dialog that granted the path,
stored in the main-only sidecar `userData/bookmarks.json`, and redeemed for access when
the path is used again. `src/app/store/bookmark-store.js` is the only place that does
any of it, and it is inert outside a store build.

**A SAVE PANEL'S BOOKMARK DOES NOT SURVIVE, and only a store build can see it.**
`showSaveDialog` with `securityScopedBookmarks` creates a blank file and mints a
bookmark against it that is stale from the next launch
([electron/electron#32544](https://github.com/electron/electron/issues/32544), open
upstream). `startAccessingSecurityScopedResource` returns a stop function either way,
so nothing detects it at the call — and `existsSync` cannot either, because the sandbox
answers metadata questions about files it will not open. Left alone, every project made
with Save As reopened as a raw `EPERM`. So a redeem is **proved** with a real read, a
blob that fails is dropped, and the recent list reports **`denied`** separately from
**`missing`**: the renderer offers to *re-grant* the file through an open panel (whose
bookmark does last) rather than to forget it. Asked once per project, not once per
launch. **This is exactly the class of bug `make mas-dev` exists to find — it cannot
reproduce in a direct build, and the quit-and-relaunch step is the only thing that
surfaces it.**

**Writes to a user-chosen file are not atomic in a store build.** The sandbox denies the
sibling temp file `atomicWrite` normally renames into place, so under `isMas()` — and
only after a genuine permission error — `io.js` falls back to a durable in-place write.
Everything the app owns lives under `userData`, inside the container, where the atomic
path is unchanged; that includes the 30-second autosave slot, so a torn user file is
still recoverable.

## Verify without an Apple account

`make mas`, `make mas-dev` and `make test` all exit 0 with no certificates, no profiles
and no App Store Connect record — the store targets skip with a message, and
`src/app/tests/packaging.test.js` checks the configuration itself (that the entitlements
files exist, that the sandbox keys are the intended ones, that hardened runtime and
notarization are off) on every platform.
