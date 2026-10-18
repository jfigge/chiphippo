# Publishing Chip Hippo to the Microsoft Store

The maintainer's runbook for the **Microsoft Store (MSIX / `.appx`)** channel. It follows
what Rest Hippo did (published 2026-06-30, Store ID `9NPC93LNBT9Q`) and adds what Chip
Hippo still needs. The Mac App Store process is in [STORE-PUBLISHING.md](STORE-PUBLISHING.md).

---

## 0. Key facts

| Thing | Value | Where it came from |
| --- | --- | --- |
| Partner Center account | **Already registered** (the Rest Hippo account). No new fee. | Rest Hippo |
| Publisher (`build.appx.publisher`) | `CN=BFD01680-674C-4CB1-B9B1-B63602557051` | `gh variable list -R jfigge/resthippo` → `APPX_PUBLISHER` |
| Publisher display name | `jkfigge` | same → `APPX_PUBLISHER_DISPLAY_NAME` |
| Identity-name prefix | `16486jkfigge.` (Rest Hippo's is `16486jkfigge.RestHippo`) | same → `APPX_IDENTITY_NAME` |
| Chip Hippo identity name | **Probably `16486jkfigge.ChipHippo`, but don't guess it.** Copy it from Partner Center after you reserve the name (§2). | Partner Center |
| Application id | `ChipHippo` (letters and digits only, no spaces) | our choice |
| Package version | `src/package.json` `version` + `.0`. Today that's `1.4.3` → `1.4.3.0` | electron-builder |
| Architectures | x64 + arm64: two `.appx` files, upload both | matches the NSIS build |
| Code-signing certificate | **None needed.** The Store re-signs the package on upload. | Rest Hippo |
| Restricted capability | `runFullTrust`. Every Electron app has it and it can't be removed, only justified (§6.6). | Rest Hippo |
| Privacy policy URL | `https://chiphippo.com/privacy.html` (needs one line updated, §3.6) | website |

### About `resthippo/certs/`

**That folder has nothing for Microsoft.** Everything in it is Apple material: the CSR,
`development.cer`, `distribution.cer`, `mac_installer.cer`, `developerID_application.cer`
and the MAS provisioning profile. The Microsoft side never needed a certificate because
the Store signs the package. All it needed was the three non-secret identity values in
the table above, which live as **GitHub repository variables on `jfigge/resthippo`**.
Those three values are already written out above.

The publisher CN and display name belong to the **account**, not the app, so Chip Hippo
uses the same two. Only the identity name is new.

> Nothing here is secret. The publisher, identity name and display name are all written
> into every published package's `AppxManifest.xml`, which is why it's fine to commit
> them to `src/package.json` (§3.1). Rest Hippo used `FILL-LATER-*` placeholders plus
> env overrides, which only added plumbing.

---

## 1. What Chip Hippo already has, and what it lacks

**Already in place:**

- `src/app/store-build.js` defines `isAppx()` (Electron's `process.windowsStore`) and
  `isStoreBuild()`. The self-updater, the *Check for Updates…* menu item and the About
  controls already turn off in an appx build, so no updater work is needed.
- `allowsDonations()` is MAS-only, so the sponsor link stays in the Microsoft Store
  build. That's correct: Microsoft permits it.
- The `win.files` filter already ships the `win32-x64` and `win32-arm64` serialport
  prebuilds (`npmRebuild: false`). The appx target is a Windows target, so it inherits
  that filter.
- The seven UI languages (de, en, es, fr, it, ja, zh) are the same seven Rest Hippo
  declared.

**Missing. §3 covers each one:**

1. A `build.appx` block in `src/package.json`.
2. Store tile assets. Without them electron-builder falls back to its own generic sample
   logos.
3. A `make appx` target.
4. A `store-appx` CI job. Jason is on a Mac, and **electron-builder can only build
   `.appx` on Windows**, so CI is the practical build host. A Windows VM is the other
   option.
5. The "Updates are delivered through the **App Store**" strings. A Microsoft Store user
   would see them as written.
6. The privacy page and a few comments/docs that say "Mac App Store only".
7. `packaging.test.js` coverage for the new block.

---

## 2. Reserve the name in Partner Center (once)

1. Go to <https://partner.microsoft.com/dashboard> → **Apps and games** → **+ New
   product** → **MSIX or PWA app**.
2. Reserve **Chip Hippo**. If it's taken, choose a fallback now. The reserved name has
   to match the package's `displayName`.
3. Open the product → **Product management → Product identity** and copy:
   - **Package/Identity/Name**, which goes into `build.appx.identityName`
   - **Package/Identity/Publisher**, which should equal
     `CN=BFD01680-674C-4CB1-B9B1-B63602557051`. If it doesn't, stop: you're in a
     different account from Rest Hippo's.
   - **Package/Properties/PublisherDisplayName**, which should be `jkfigge`
   - the **Store ID** (`9N…`) and the **Package Family Name (PFN)**. Record both in
     §0 and in `APP_STORE_TODO.md`.

---

## 3. Repository changes

### 3.1 `src/package.json` → `build.appx`

Add this beside `win`, with the identity name copied from §2:

```json
"appx": {
  "identityName": "16486jkfigge.ChipHippo",
  "publisher": "CN=BFD01680-674C-4CB1-B9B1-B63602557051",
  "publisherDisplayName": "jkfigge",
  "applicationId": "ChipHippo",
  "displayName": "Chip Hippo",
  "backgroundColor": "transparent",
  "showNameOnTiles": true,
  "languages": ["en-US", "de-DE", "es-ES", "fr-FR", "it-IT", "ja-JP", "zh-CN"]
}
```

- `publisherDisplayName` must match Partner Center **exactly**, or certification
  rejects the package. Rest Hippo's committed `"Jason Figge"` only worked because CI
  overrode it with `jkfigge`.
- Each declared language adds a Store-listing slot in Partner Center (§6.5).

### 3.2 Tile assets

electron-builder reads appx assets from `<buildResources>/appx/`. The default
`buildResources` is `build/`, and **`.gitignore`'s unanchored `build/` would swallow
`src/build/appx/`**. So keep them with the other packaging material instead:

```json
"directories": { "output": "dist", "buildResources": "packaging" }
```

Then create `src/packaging/appx/` with these PNGs, all with transparent backgrounds:

| File | Size | Required |
| --- | --- | --- |
| `StoreLogo.png` | 50×50 | yes |
| `Square44x44Logo.png` | 44×44 | yes (taskbar, Start list) |
| `Square150x150Logo.png` | 150×150 | yes (medium tile) |
| `Wide310x150Logo.png` | 310×150 | yes (icon centred on a transparent wide canvas) |
| `SmallTile.png` | 71×71 | optional |
| `LargeTile.png` | 310×310 | optional |

Generate them in `scripts/make-icons.mjs` from `src/web/chiphippo-icon.svg` (the
edge-to-edge art) so `make icons` keeps them in step with every other raster. After
changing `buildResources`, run `make dmg` once to confirm the mac build doesn't care.
It shouldn't: every mac/mas icon and entitlement path is already explicit.

### 3.3 `Makefile` → `make appx`

Put this next to `mas` / `mas-dev`, and add `appx` to `.PHONY` and `help`:

```make
# The Microsoft Store channel. electron-builder can only make an .appx on
# Windows, so on any other host this skips cleanly (exit 0), like `mas` without
# its profile. No certificate: the Store re-signs the package on upload. The
# identity is committed in build.appx; it's public, since it's in every
# published manifest.
appx:
	@if [ "$$OS" != "Windows_NT" ]; then \
		echo "make appx needs a Windows host (or the store-appx CI job) — skipping."; \
		exit 0; \
	fi; \
	$(MAKE) build-setup build-install && \
	echo "Building Microsoft Store packages (.appx, x64 + arm64)..." && \
	( cd $(BUILD_DIR)/src && npx electron-builder --win appx --x64 --arm64 --publish never ) && \
	echo "  → $(BUILD_DIR)/src/dist/  (upload BOTH .appx files in Partner Center)" && \
	echo "--------------------------------"
```

The output is `build/src/dist/Chip-Hippo-<version>-x64.appx` and `…-arm64.appx`, named
from the global `artifactName`.

### 3.4 `.github/workflows/release.yml` → `store-appx`

This follows Rest Hippo's job, plus Chip Hippo's Electron-cache and retry guards from the
`build` job. It's gated like `store-mas`:

```yaml
  # ── Microsoft Store package (.appx) ─────────────────────────────────────────
  # The same codebase down the Store pipe. No signing secrets: the Store
  # re-signs on upload. Kept as a run artifact and uploaded to Partner Center
  # by hand (§6); NOT attached to the GitHub Release, which globs installers-*.
  store-appx:
    name: Microsoft Store build
    needs: build
    if: >-
      (startsWith(github.ref, 'refs/tags/') || github.event_name == 'workflow_dispatch')
      && vars.MSSTORE_ENABLED == 'true'
    runs-on: windows-latest
    permissions:
      contents: read
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm
          cache-dependency-path: src/package-lock.json
      - name: Cache Electron download
        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6
        with:
          path: |
            ~/AppData/Local/electron/Cache
            ~/AppData/Local/electron-builder/Cache
          key: electron-${{ runner.os }}-${{ hashFiles('src/package-lock.json') }}
          restore-keys: |
            electron-${{ runner.os }}-
      - uses: msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884 # v2
        with:
          msystem: UCRT64
          install: make rsync
          path-type: inherit
      - name: Build Microsoft Store packages
        shell: "msys2 {0}"
        run: |
          for attempt in 1 2 3; do
            if make appx; then exit 0; fi
            [ "$attempt" -lt 3 ] && sleep $(( attempt * 20 ))
          done
          echo "::error::appx build failed after 3 attempts"; exit 1
      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6
        with:
          name: store-appx
          path: build/src/dist/*.appx
          if-no-files-found: error
          retention-days: 5
```

Then turn it on:

```sh
gh variable set MSSTORE_ENABLED --body true -R jfigge/chiphippo
```

Run **Actions → Release → Run workflow** (manual dispatch) to get packages without
cutting a release, then fetch them with `gh run download <run-id> -n store-appx`.
**Artifacts expire after 5 days**, so download them promptly or re-run the job.

### 3.5 Store-specific wording (all seven locales)

`src/web/locales/*.json` has `updater.storeBuild` ("Updates are delivered through the
App Store.") and `updater.storeHint` ("…delivered through the App Store, so it never
checks for them itself."). In a Microsoft Store build both name the wrong store.

Fix it properly rather than blurring the wording. `app:info:get` currently carries
`distribution: "store" | "direct"`. Add a `store: "mas" | "msstore" | null` field from
`store-build.js` (the one place that reads the flags), and have `settings-dialog.js`
pick `storeHint` or a new `storeHintMs`. Do the same for the updater's `reason:
"store-build"` toast (`storeBuild` / `storeBuildMs`). `make test-i18n` will require the
new keys in every locale.

### 3.6 Text that says "Mac App Store only"

- `website/privacy.html` (~line 171): "builds installed from the Mac App Store have no
  updater at all" → "…from the Mac App Store or the Microsoft Store…". Bump its *Last
  updated* date.
- `src/app/store-build.js` header: delete "Chip Hippo has no Microsoft Store channel
  yet…".
- `STORE-PUBLISHING.md`: link here from the top, or merge this file into it as a
  second part, the way Rest Hippo's covers both stores.
- `.claude/rules/release.md`: add a short "Microsoft Store packaging" section, and add
  `MICROSOFT-STORE.md` to its `paths:`.

### 3.7 `src/app/tests/packaging.test.js`

Hold the block to its shape the way `build.mas` is held: `identityName` starts with
`16486jkfigge.`, `publisher` is the CN above, `publisherDisplayName === "jkfigge"`,
`applicationId` matches `/^[A-Za-z0-9]+$/`, `languages` matches the locale files one for
one, and every required tile PNG exists under `src/packaging/appx/`.

---

## 4. Build

- **CI (recommended):** use §3.4, then `gh run download <run-id> -n store-appx`.
- **Windows machine or VM** (Parallels on Apple Silicon gives arm64 Windows, which builds
  both architectures): install Node 22, MSYS2 (`make`, `rsync`) and git, then run
  `make install && make appx`.

Check the manifest before uploading (PowerShell):

```powershell
Expand-Archive .\Chip-Hippo-1.4.3-x64.appx -DestinationPath .\x64-check   # copy to .zip first if it refuses
Select-String -Path .\x64-check\AppxManifest.xml -Pattern 'Identity|PublisherDisplayName|Version='
```

Expect `Name="16486jkfigge.ChipHippo"`, the CN publisher, and `Version="1.4.3.0"`.

---

## 5. Smoke-test the package locally (before the first submission)

MSIX changes how the app behaves in ways a direct build can't show. The Store's signature
isn't on the package yet, so sideload it with a throwaway certificate whose subject is
**exactly** the publisher CN:

```powershell
# once: a test cert matching the publisher
$cert = New-SelfSignedCertificate -Type Custom -KeyUsage DigitalSignature `
  -Subject "CN=BFD01680-674C-4CB1-B9B1-B63602557051" -FriendlyName "Chip Hippo sideload test" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
$pw = ConvertTo-SecureString -String "test" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath .\sideload.pfx -Password $pw
Import-PfxCertificate -FilePath .\sideload.pfx -Password $pw -CertStoreLocation Cert:\LocalMachine\TrustedPeople  # admin shell

# per build: sign a COPY (never upload the test-signed one) and install
signtool sign /fd SHA256 /f .\sideload.pfx /p test .\Chip-Hippo-1.4.3-x64-test.appx
Add-AppxPackage .\Chip-Hippo-1.4.3-x64-test.appx
```

`signtool` comes with the Windows SDK. Remove the package afterwards with
`Get-AppxPackage *ChipHippo* | Remove-AppxPackage`.

**What to exercise.** Each item is something MSIX can break:

- [ ] **Launch from Start.** Check the tile, the name, and that the icon isn't
      electron-builder's sample art.
- [ ] **Settings ▸ About.** No update controls, the hint names the *Microsoft Store*
      (§3.5), and the sponsor link is present.
- [ ] **Save As to Documents, quit, relaunch, Open Recent.** MSIX is full-trust, so
      this should behave like a direct build, but confirm it.
- [ ] **Datasheet download, then open a PDF.** ⚠️ **The most likely MSIX bug.** The
      PDFs go to `userData\datasheets`, and MSIX **redirects writes under
      `%APPDATA%`** into
      `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\Chip Hippo\`. `shell.openPath`
      passes the *un-redirected* path to the PDF viewer, which runs outside the package
      and may not find the file. If it fails, the fix is in `main.js`: under `isAppx()`,
      translate a path under `app.getPath("appData")` into its `LocalCache\Roaming`
      equivalent before handing it to the shell.
- [ ] **Program a ROM from a `.bin`, then export the BOM as RTF.**
- [ ] **AI builder** with a key. The key is stored through `safeStorage` (DPAPI).
- [ ] **Serial.** Connect a real Arduino on a COM port and Run a circuit with an
      Output. Full trust should open COM ports, but the Mock opens none, so only real
      hardware proves it.
- [ ] **Uninstall, then reinstall.** Settings, autosave and downloaded datasheets are
      gone, because MSIX deletes its redirected AppData on uninstall. That's expected,
      but worth knowing for support questions. Projects saved in Documents survive.
- [ ] **Store and NSIS builds side by side.** They don't share settings or autosave,
      because the Store copy's `%APPDATA%` is private.

---

## 6. The submission in Partner Center

Product → **Start your submission**.

### 6.1 Pricing and availability

- **Markets:** all. **Pricing:** Free. **Free trial:** none.
- **Visibility:** public, discoverable.
- **Publish date:** choose *"Publish as soon as it passes certification"*, or the
  manual-publish option if you want to line it up with the website change (§8).

### 6.2 Properties

- **Category:** Developer tools. A second category isn't offered; mention education in
  the description instead.
- **Privacy policy URL:** `https://chiphippo.com/privacy.html`. It's required, because
  the AI builder and datasheet download use the network.
- **Website:** `https://chiphippo.com`
- **Support contact:** `https://github.com/jfigge/chiphippo/issues`
- **Product declarations:** leave the defaults. Not an Xbox title, no NT services or
  drivers.
- **System requirements:** none beyond the defaults (Windows 10/11 desktop, x64 or
  arm64).

### 6.3 Age ratings (IARC questionnaire)

The category is an app, not a game. Answer **No** to violence, sex, language,
gambling, controlled substances, user-to-user interaction, sharing location, digital
purchases and unrestricted web access. Chip Hippo isn't a browser, and the AI and
datasheet calls go to fixed endpoints. Expect **3+ / Everyone**.

### 6.4 Packages

Upload **both** `Chip-Hippo-<version>-x64.appx` and `…-arm64.appx`. Partner Center
reads the identity, version, architectures and languages from them, and rejects an
identity or publisher mismatch here, before certification.

### 6.5 Store listings

Use [APP_STORE_LISTING.md](APP_STORE_LISTING.md) as the source so all three listings
read alike. Microsoft's fields and limits differ from Apple's:

| Field | Limit | Source in APP_STORE_LISTING.md |
| --- | --- | --- |
| Description | 10,000 chars | the description (3,578 chars, fits as-is) |
| What's new in this version | 1,500 | the release's notes (blank for the first release) |
| Product features | up to 20 × 200 chars | the description's feature bullets |
| Short description | 1,000 | the promotional text plus the subtitle |
| Search terms | 7 terms, ≤ 30 chars each | pick 7 from the 100-char keyword list (TTL, 74LS, CMOS, breadboard, logic simulator, digital electronics, circuit) |
| Screenshots (Desktop) | 1–10 PNGs, ≥ 1366×768 | the website's `hero-*.png` captures, or fresh ones taken on Windows |
| Store logos | 1:1 app tile icon 300×300 (recommended); optional 1:1 box art 2160×2160 / 9:16 poster 1440×2160 | rasterise `chiphippo-icon.svg` |

The package declares seven languages, so Partner Center opens a listing per language.
Fill in English (US) fully. For the others, either translate (the app's own locales
show the vocabulary) or use *Manage additional languages* to see which ones Partner
Center will accept empty. Rest Hippo declared the same seven and passed.

### 6.6 Submission options → restricted capabilities

`runFullTrust` gets flagged. Justification (reuse Rest Hippo's wording if you kept it;
this is equivalent):

> Chip Hippo is an Electron desktop application packaged with the Desktop Bridge. The
> `runFullTrust` capability is declared by the packaging tool for every Win32/Electron
> app (`EntryPoint="Windows.FullTrustApplication"`) and is required for the application
> to run at all. The app uses it only for ordinary desktop functionality: opening and
> saving user project files through the standard file dialogs, and (optionally) talking
> to a user-connected Arduino board over a USB serial port.

### 6.7 Notes for certification

> Chip Hippo is a free, offline logic-circuit designer and simulator. No account or
> sign-in is required. To exercise it: open any chip's context menu → *Pinout* →
> *Example*, or Help ▸ Examples, then press **Run**. The AI circuit builder is optional
> and needs the user's own API key; it is not required to evaluate the app. The Arduino
> serial integration requires hardware; the built-in **Mock** device (Settings ▸ Serial
> I/O) demonstrates it without any. The app does not update itself in this build;
> updates come through the Store.

Check that path against the current UI before pasting. Then **Submit to the Store**.
Certification usually takes 1–3 business days.

---

## 7. Updates — the version rule

> **⚠️ A package version must be strictly greater than the published one, forever.**
> The Store compares the four-part identity version (`major.minor.patch.0`, straight
> from `src/package.json`). electron-builder has no per-target version override.
> **This went wrong once for Rest Hippo:** a typo'd `1.18.4` reached the Store, stranded
> the whole real `1.1.x` line (`1.1.5.0 < 1.18.4.0`), and forced a jump to `1.19.0`.

Before each upload, check what's live (replace the Store ID):

```sh
curl -s "https://displaycatalog.mp.microsoft.com/v7.0/products/<STORE_ID>?languages=en-us&market=US" \
  | grep -o '"PackageFullName":"[^"]*"' | head -2
```

For each release:

1. `make release VERSION=x.y.z`. The tag runs `store-appx` (once `MSSTORE_ENABLED` is
   on).
2. `gh run download <run-id> -n store-appx`.
3. Partner Center → **Update** the submission → **Packages**: remove the old pair,
   upload the new pair, and write *What's new* → **Submit**.

A rejected build can't be re-uploaded at the same version. Bump the patch version and
cut a new release. There's no separate build number as on the Mac.

---

## 8. After it's live

- **Website:** add the Microsoft Store row to the Windows card in `website/index.html`.
  The `.dl-store` block was designed for this; see the CSS comment at ~line 560. Copy
  the Mac card's `dl-store` block (~line 963) with
  `https://apps.microsoft.com/detail/<STORE_ID>`. Consider adding it to the JSON-LD
  `installUrl` too.
- **README / user guide:** note the Store as a Windows install route.
- **`APP_STORE_TODO.md`:** record the Store ID, the PFN, the first published version and
  its date.

## 9. Later: CI auto-submit (optional)

Rest Hippo has a `msstore publish --noCommit` step, but **it has never run**: its
`MS_STORE_PRODUCT_ID` variable was never set. To turn it on for Chip Hippo:

1. Partner Center → **Account settings → User management → Microsoft Entra
   applications** → create or associate an app, give it the *Manager* role, and create
   a client secret.
2. Add secrets `MS_STORE_TENANT_ID`, `MS_STORE_CLIENT_ID`, `MS_STORE_CLIENT_SECRET` and
   variable `MS_STORE_PRODUCT_ID` (the Store ID) to `jfigge/chiphippo`. The same Entra
   app can serve Rest Hippo as well.
3. Add a tag-only step to `store-appx`, copied from Rest Hippo's `Submit to Microsoft
   Store` (`winget install Microsoft.MSStoreCLI` → `msstore reconfigure …` → `msstore
   publish <appx> --productId … --noCommit`). Gate it on its own variable, not a shared
   `STORE_SUBMIT_ENABLED`, which Chip Hippo doesn't set. `--noCommit` leaves a draft
   submission, so the final **Submit** is still a click.
4. Expect to debug it on the first tag. It's untested in both repos.
