We're adding Electron-packaged desktop builds of JsonHippo, plus a proper
landing page for it on HippoHerd (matching the other Hippo apps), instead
of the feature link going straight to the live web app.

CONTEXT
- JsonHippo (this repo) is currently a static web app: HTML, CSS, and
  class-based ES modules, no bundler, no JSON.parse/stringify, jQuery
  4.0.0 pinned for the tree/filter. `make site` builds it and copies
  dist/ into ../hippoherd/website/jsonhippo/.
- HippoHerd's content/hippos.mjs currently marks JsonHippo as
  externalSite: true and webApp: true, so its card launches the live
  app directly rather than showing a description page.
- RestHippo and ChipHippo already ship signed, multi-platform Electron
  binaries (macOS arm64/x64, Windows, Linux arm64/x64) via GitHub
  Releases — reuse their signing certificates/scripts and CI job
  structure rather than inventing a new approach. Pull the signing
  assets from those repos (paths to be confirmed on the build machine).

PART 1 — Electron wrapper for JsonHippo
- Add an Electron shell that loads the existing static JsonHippo app
  unmodified (no change to app logic, parser, or UI).
- Configure Electron Forge (or whatever RestHippo/ChipHippo use — stay
  consistent with them) to produce six artifacts: macOS arm64, macOS
  x64, Windows arm64, Windows x64, Linux arm64, Linux x64.
- Code-sign the macOS and Windows artifacts using the same certificates
  and signing workflow as RestHippo/ChipHippo. Flag clearly in the PR
  description any secret/certificate references that need to be wired
  up manually on the build machine — don't invent placeholder secrets
  silently.
- Extend the CI/CD pipeline (same platform as the existing `make site`
  pipeline) so a push to main builds and signs all six artifacts and
  publishes them to GitHub Releases, following RestHippo/ChipHippo's
  existing release job as the template.

PART 2 — HippoHerd landing page for JsonHippo
- Add a new JsonHippo page to the HippoHerd site, in the same style as
  the other Hippo apps' pages (not the external/webApp card pattern
  currently used): hero image, feature list (tree view filtering,
  smart paste/unescape, hand-written parser with precise error
  location, diff mode / schema inference / linter warnings if already
  shipped), and download links for the six signed artifacts.
- Add a "Launch" link/button on that page that opens the live web app
  (hippoherd.com/jsonhippo) in the same way the feature card does
  today.
- Update content/hippos.mjs: JsonHippo's card on the main HippoHerd
  index should now link to this new page instead of launching the app
  directly. Keep webApp/externalSite flags accurate to the new
  behavior — check how other non-pure-webapp Hippos (e.g. RestHippo,
  ChipHippo) are modeled in hippos.mjs and follow that pattern.

PART 3 — Deployment
- Extend `make site` (or add a parallel target if cleaner) so it copies
  both the new landing page content and the six built/signed Electron
  artifacts into the ../hippoherd checkout, in the place the new
  landing page expects to serve them from.
- Follow the existing pattern: after `make site`, cd into the hippoherd
  checkout, git add, commit, push — don't change that workflow, just
  make sure the new artifacts and page land in the right place for it.

SCOPE / CONSTRAINTS
- Don't touch JsonHippo's app logic, parser, or existing three features.
- Don't restructure the existing static web deploy path — it still
  needs to work exactly as it does today for the live app itself.
- Keep this scoped to wiring the build/sign/publish/landing-page
  pipeline — not a redesign of JsonHippo itself.
- Call out anywhere RestHippo/ChipHippo's signing setup doesn't cleanly
  generalize to JsonHippo, rather than forcing a fit.

