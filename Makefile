# ─────────────────────────────────────────────────────────────────────────────
#  Chip Hippo – TTL breadboard designer & simulator
#  Electron desktop app (Vanilla JS + Node.js)
# ─────────────────────────────────────────────────────────────────────────────

VERSION    ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT     ?= $(shell git rev-parse --short=7 HEAD 2>/dev/null || echo "unknown")
BRANCH     ?= $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
BUILD_TIME ?= $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')

# Workspace directories
WORKSPACE  ?= $(realpath $(dir $(realpath $(firstword $(MAKEFILE_LIST)))))
BUILD_DIR  ?= $(WORKSPACE)/build
DIST_DIR   ?= $(WORKSPACE)/dist
DATA_DIR   ?= $(WORKSPACE)/data
SRC_DIR    ?= $(WORKSPACE)/src
WEB_DIR    ?= $(WORKSPACE)/src/web
APP_DIR    ?= $(WORKSPACE)/src/app

SHELL := /bin/bash

# ── Shared dev environment ────────────────────────────────────────────────────
# One place to set the values every dev target sees. Copy dev.env.example →
# dev.env (git-ignored) and edit it; `-include` is after the ?= defaults so
# dev.env wins over them, while a one-off `make VAR=value` still wins over both.
DEV_ENV_VARS :=
-include $(WORKSPACE)/dev.env
export $(DEV_ENV_VARS)

# Bare `make` builds an unsigned local dmg (macOS). Signed/release targets and
# the full multi-platform matrix arrive with the packaging backlog stage.
.DEFAULT_GOAL := dmg

# Neutralize signing for one electron-builder call: disable keychain
# auto-discovery so the output is unsigned regardless of any identities in the
# keychain. Paired per-recipe with `-c.mac.notarize=false` to also force
# notarization off. Signed builds arrive with the packaging backlog stage.
UNSIGNED_ENV := CSC_IDENTITY_AUTO_DISCOVERY=false

# ─── Version / Info ───────────────────────────────────────────────────────────
version:
	@echo "Version: $(VERSION)"

info:
	@echo "Build Information:"
	@echo "  Version:    $(VERSION)"
	@echo "  Branch:     $(BRANCH)"
	@echo "  Commit:     $(COMMIT)"
	@echo "  Build Time: $(BUILD_TIME)"

# ─── Dependencies ─────────────────────────────────────────────────────────────
install:
	@echo "Installing Node.js dependencies..."
	@cd $(SRC_DIR) && npm ci
	@echo "--------------------------------"

# ─── Development ──────────────────────────────────────────────────────────────
debug:
	@echo "Starting Electron in debug mode (hot-reload)..."
	@cd $(SRC_DIR) && npx electron app/main.js --hot-reload --user-data-dir=$(DATA_DIR)
	@echo "--------------------------------"

# ─── Formatting ───────────────────────────────────────────────────────────────
fmt:
	@echo "Formatting JavaScript / CSS / HTML..."
	@cd $(SRC_DIR) && npx prettier --write \
		"web/**/*.{js,css,html}" \
		"app/**/*.js" > /dev/null
	@echo "--------------------------------"

fmt-check:
	@echo "Checking formatting (prettier --check)..."
	@cd $(SRC_DIR) && npx prettier --check \
		"web/**/*.{js,css,html}" \
		"app/**/*.js"
	@echo "--------------------------------"

# ─── Linting ──────────────────────────────────────────────────────────────────
lint:
	@echo "Linting JavaScript..."
	@cd $(SRC_DIR) && npx eslint \
		"web/scripts/**/*.js" \
		"app/**/*.js"
	@echo "--------------------------------"

# ─── License headers ──────────────────────────────────────────────────────────
# Stamp the Apache 2.0 header onto any first-party src/ JS+CSS or build script
# that is missing it (see CLAUDE.md → "License headers" for the scope).
license-headers:
	@echo "Stamping Apache 2.0 license headers..."
	@node $(WORKSPACE)/scripts/license-header.mjs
	@echo "--------------------------------"

# ─── Testing ──────────────────────────────────────────────────────────────────
# Per-test timeout so a leaked handle / never-resolving promise fails the run
# loudly instead of hanging the suite (and CI) forever.
TEST_TIMEOUT ?= 30000

test: test-license-headers
	@echo "Running JavaScript unit tests..."
	@cd $(SRC_DIR) && node --test --test-timeout=$(TEST_TIMEOUT) \
		"app/tests/**/*.test.js" \
		"web/scripts/tests/**/*.test.js"
	@echo "--------------------------------"

# Guard: every first-party src/ JS+CSS file and build script must carry the
# Apache 2.0 header. Fix any failure with `make license-headers`.
test-license-headers:
	@echo "Checking Apache 2.0 license headers (guard)..."
	@node $(WORKSPACE)/scripts/license-header.mjs --check
	@echo "--------------------------------"

# ─── Icons ────────────────────────────────────────────────────────────────────
# Regenerate every app-icon raster (macOS .png, Windows .ico, Linux set + logo)
# from src/web/chiphippo-icon.svg and src/web/chiphippo-mac-icon.svg. macOS-only
# (uses qlmanage/sips); outputs are committed and consumed at build + run time.
icons:
	@echo "Regenerating app icons from the SVG sources..."
	@cd $(SRC_DIR) && npx electron $(WORKSPACE)/scripts/make-icons.mjs
	@echo "--------------------------------"

# ─── Datasheets ───────────────────────────────────────────────────────────────
# Regenerate the datasheet connection-diagram / function-table crops shown in
# the pin-assignments window, one committed PNG per catalog chip that has a
# datasheet. Reads the crop manifest (scripts/datasheet-crops.mjs) and the
# source PDFs (not in the repo — override the folder with DATASHEETS_DIR).
datasheets:
	@echo "Regenerating datasheet crops for the pinout window..."
	@cd $(SRC_DIR) && npx electron $(WORKSPACE)/scripts/make-datasheets.mjs
	@echo "--------------------------------"

# ─── Demos ────────────────────────────────────────────────────────────────────
# Regenerate the loadable demo schematics in demos/ (a .chiphippo layout + a .hex
# ROM image each). The generator computes every wire from the model and then runs
# each demo through the simulation engine, asserting the LED blinks / the LCD
# prints "HI" before writing the files. Plain Node — no Electron needed.
demos:
	@echo "Regenerating + validating the demo schematics..."
	@node $(WORKSPACE)/scripts/make-demos.mjs
	@echo "--------------------------------"

# ─── User guide (Feature 230) ───────────────────────────────────────────────────
# One Markdown source (src/web/docs/*.md) drives three outputs: the in-app
# Help ▸ Chip Hippo User Guide window, this hosted website build, and the PDF.

# Rebuild the bundled marked+DOMPurify renderer the in-app viewer imports
# (web/scripts/vendor/markdown.js) from web/scripts/vendor/markdown-entry.js.
# A generated artifact — reformat it too so `make fmt-check` stays clean.
vendor-markdown:
	@echo "Rebuilding the vendored Markdown renderer..."
	@cd $(SRC_DIR) && npm run vendor-markdown --silent
	@cd $(SRC_DIR) && npx prettier --write web/scripts/vendor/markdown.js > /dev/null
	@echo "--------------------------------"

# Render src/web/docs/*.md into the Chip Hippo–themed static site under
# website/docs/, copy the images, and write website/sitemap.xml.
docs:
	@echo "Building the hosted user guide..."
	@node $(WORKSPACE)/scripts/build-docs.mjs
	@echo "--------------------------------"

PDF_OUT ?= $(WORKSPACE)/docs/chip-hippo-user-guide.pdf

# Stitch the same Markdown into one printable PDF (cover + contents + a
# section per page) via a hidden Electron window's printToPDF. Needs a
# display server on headless Linux/CI (xvfb-run); macOS runs it hidden.
pdf:
	@echo "Building user-guide PDF..."
	@mkdir -p $(dir $(PDF_OUT))
	@cd $(SRC_DIR) && PDF_OUT="$(PDF_OUT)" npx electron $(WORKSPACE)/scripts/build-pdf.mjs
	@echo "  → $(PDF_OUT)"
	@echo "--------------------------------"

# ─── Build ────────────────────────────────────────────────────────────────────
build: build-mac

# Fast, unsigned `--dir` packaging smoke-test: exercises the full
# electron-builder pack (asar, file globs, icons) without producing an
# installer. UNSIGNED_ENV keeps the output unsigned regardless of any keychain
# identities.
build-mac: build-setup build-install
	@echo "Building Electron app for macOS (dir, unsigned)..."
	@cd $(BUILD_DIR)/src; env $(UNSIGNED_ENV) npx electron-builder --mac --dir --publish never -c.mac.notarize=false
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

# Per-platform `--dir` packaging smoke-tests (no installer). CI runs the matching
# one on each native runner to prove the app packs; a given host can only build
# its own platform (mac needs macOS, etc.).
build-linux: build-setup build-install
	@echo "Building Electron app for Linux (dir, unsigned)..."
	@cd $(BUILD_DIR)/src; env $(UNSIGNED_ENV) npx electron-builder --linux --dir --publish never
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

build-win: build-setup build-install
	@echo "Building Electron app for Windows (dir, unsigned)..."
	@cd $(BUILD_DIR)/src; env $(UNSIGNED_ENV) npx electron-builder --win --dir --publish never
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

dmg: build-setup build-install
	@echo "Building macOS .dmg (unsigned, un-notarized)…"
	@cd $(BUILD_DIR)/src; env $(UNSIGNED_ENV) npx electron-builder --mac dmg --publish never -c.mac.notarize=false
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

build-setup:
	@echo "Preparing build directory..."
	@rm -rf $(BUILD_DIR)/src || true
	@mkdir -p $(BUILD_DIR)/src
	@rsync -a --exclude=node_modules $(SRC_DIR)/ $(BUILD_DIR)/src/

build-install:
	@echo "Installing Node.js dependencies (build dir)..."
	@cd $(BUILD_DIR)/src; npm install > /dev/null
	@echo "--------------------------------"

# ─── Distribution packages ────────────────────────────────────────────────────
# Real installers per platform — the entrypoints the Release workflow runs on
# native runners. `dist` builds all three, but a given host can only build its
# own (a mac .dmg needs macOS, an .exe needs a Windows runner, etc.).
#
# Signing is driven by the ENVIRONMENT, not forced off like the convenience
# builds above: dist-mac signs + when creds are present. macOS reads CSC_LINK /
# CSC_KEY_PASSWORD (a Developer ID .p12) — absent ⇒ electron-builder emits an
# unsigned .app with no failure, so this works before any certificate exists (in
# CI those come from repository secrets; see .github/workflows/release.yml).
# Notarization stays off for now (it needs hardenedRuntime + entitlements).
dist: dist-mac dist-linux dist-win

dist-mac: build-setup build-install
	@echo "Building macOS distribution (dmg + zip; signed if a cert is present)..."
	@cd $(BUILD_DIR)/src; npx electron-builder --mac --publish never -c.mac.notarize=false
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

dist-linux: build-setup build-install
	@echo "Building Linux distribution (AppImage + deb)..."
	@cd $(BUILD_DIR)/src; npx electron-builder --linux --publish never
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

dist-win: build-setup build-install
	@echo "Building Windows distribution (nsis installer + portable)..."
	@cd $(BUILD_DIR)/src; npx electron-builder --win --publish never
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

# ─── Release ──────────────────────────────────────────────────────────────────
# Cut a release (Model A — "shipped pointer"):
#   validate -> preflight (on main, clean, in sync with origin) -> gate on tests
#   -> bump src/package.json on main -> fast-forward `release` to main -> tag
#   -> atomic push of main + release + tag (the tag push triggers the build).
# `release` stays a strict fast-forward of `main`, so history is linear and the
# branch always points at exactly what was last shipped. The tag push is what
# fires .github/workflows/release.yml (which builds + publishes the installers).
# Usage:  make release VERSION=1.2.3
MAIN_BRANCH    ?= main
RELEASE_BRANCH ?= release

release:
	@set -e; \
	NEW="$(VERSION)"; \
	if ! [[ "$$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$$ ]]; then \
		echo "Error: version must be in x.y.z format (got '$$NEW')."; \
		echo "Usage: make release VERSION=1.2.3"; exit 1; \
	fi; \
	ORIG=$$(git rev-parse --abbrev-ref HEAD); \
	trap 'git checkout "$$ORIG" --quiet 2>/dev/null || true' EXIT; \
	if [ "$$ORIG" != "$(MAIN_BRANCH)" ]; then \
		echo "Error: release must be run from '$(MAIN_BRANCH)' (currently on '$$ORIG')."; exit 1; \
	fi; \
	if ! git diff-index --quiet HEAD --; then \
		echo "Error: working tree has uncommitted changes; commit or stash first."; exit 1; \
	fi; \
	CURRENT=$$(cd $(SRC_DIR) && node -p "require('./package.json').version"); \
	if [ "$$NEW" = "$$CURRENT" ]; then \
		echo "Error: new version equals the current version ($$CURRENT)."; exit 1; \
	fi; \
	echo "Fetching origin..."; \
	git fetch --quiet --tags origin; \
	if git rev-parse -q --verify "refs/tags/v$$NEW" >/dev/null; then \
		echo "Error: tag v$$NEW already exists."; exit 1; \
	fi; \
	if ! git merge-base --is-ancestor origin/$(MAIN_BRANCH) $(MAIN_BRANCH); then \
		echo "Error: local '$(MAIN_BRANCH)' is behind/diverged from origin; pull or rebase first."; exit 1; \
	fi; \
	echo ""; \
	echo "  Current version: $$CURRENT"; \
	echo "  New version:     $$NEW"; \
	echo "  Flow: bump on $(MAIN_BRANCH) -> ff '$(RELEASE_BRANCH)' -> tag v$$NEW -> push (triggers build)"; \
	echo ""; \
	read -p "Run tests and cut release v$$NEW? [y/N] " ans; \
	if [[ "$$ans" != "y" && "$$ans" != "Y" ]]; then echo "Aborted."; exit 1; fi; \
	echo "Running test suite..."; \
	if ! $(MAKE) test; then echo "Tests failed; aborting release (no changes made)."; exit 1; fi; \
	echo "Bumping version on $(MAIN_BRANCH)..."; \
	(cd $(SRC_DIR) && npm version "$$NEW" --no-git-tag-version >/dev/null); \
	sed -i.bak -E \
		-e "s|(id=\"hero-version\">)v[0-9]+\.[0-9]+\.[0-9]+|\1v$$NEW|" \
		-e "s|(id=\"dl-version\">)[0-9]+\.[0-9]+\.[0-9]+|\1$$NEW|" \
		-e "s|(id=\"footer-version\">)v[0-9]+\.[0-9]+\.[0-9]+|\1v$$NEW|" \
		website/index.html && rm -f website/index.html.bak; \
	git add src/package.json src/package-lock.json website/index.html; \
	git commit -m "Release v$$NEW" >/dev/null; \
	echo "Fast-forwarding $(RELEASE_BRANCH) to $(MAIN_BRANCH)..."; \
	if git show-ref --verify --quiet refs/remotes/origin/$(RELEASE_BRANCH); then \
		git checkout -B $(RELEASE_BRANCH) origin/$(RELEASE_BRANCH) --quiet; \
	elif git show-ref --verify --quiet refs/heads/$(RELEASE_BRANCH); then \
		git checkout $(RELEASE_BRANCH) --quiet; \
	else \
		git checkout -b $(RELEASE_BRANCH) --quiet; \
	fi; \
	git merge --ff-only $(MAIN_BRANCH) --quiet; \
	git tag -a "v$$NEW" -m "Release v$$NEW"; \
	echo "Pushing $(MAIN_BRANCH) + $(RELEASE_BRANCH) + tag v$$NEW (atomic)..."; \
	if ! git push --atomic origin $(MAIN_BRANCH) $(RELEASE_BRANCH) "v$$NEW"; then \
		echo "Push failed. Local commit/tag were created but nothing was pushed."; \
		echo "Retry with: git push --atomic origin $(MAIN_BRANCH) $(RELEASE_BRANCH) v$$NEW"; \
		exit 1; \
	fi; \
	echo "Released v$$NEW — the Release workflow will build and publish the installers."; \
	SLUG=$$(git remote get-url origin 2>/dev/null | sed -E 's#^.*github\.com[:/]##; s#\.git$$##'); \
	if [ -n "$$SLUG" ]; then \
		echo "  Release: https://github.com/$$SLUG/releases/tag/v$$NEW"; \
	fi

# ─── Website ──────────────────────────────────────────────────────────────────
# Regenerate website/versions.json from the GitHub Releases API so the download
# buttons + version history track real release assets. Needs a token to avoid the
# unauthenticated rate limit:  GITHUB_TOKEN=$(gh auth token) make site
# CI runs this in .github/workflows/deploy-site.yml, then publishes website/ to
# GitHub Pages (chiphippo.com). The custom domain comes from website/CNAME.
site:
	@echo "Regenerating website/versions.json from GitHub Releases..."
	@node $(WORKSPACE)/scripts/build-versions.mjs --repo jfigge/chiphippo --out $(WORKSPACE)/website/versions.json
	@echo "--------------------------------"

# ─── Clean ────────────────────────────────────────────────────────────────────
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR) $(DIST_DIR)
	@echo "--------------------------------"

# ─── Help ─────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  Chip Hippo — TTL breadboard designer & simulator"
	@echo ""
	@echo "  Targets:"
	@echo "    install       Install Node.js dependencies (npm ci)"
	@echo "    debug         Run Electron with hot-reload (primary dev workflow)"
	@echo "    fmt           Format JS/CSS/HTML (prettier)"
	@echo "    fmt-check     Check formatting without writing (prettier --check)"
	@echo "    lint          Lint JS (eslint)"
	@echo "    test          Run license-header guard + JS unit tests"
	@echo "    license-headers  Stamp the Apache 2.0 header on any file missing it"
	@echo "    icons         Regenerate app-icon rasters from the SVG sources"
	@echo "    datasheets    Regenerate datasheet crops for the pinout window"
	@echo "    demos         Regenerate + validate the loadable demo schematics"
	@echo "    vendor-markdown  Rebuild the bundled marked+DOMPurify renderer"
	@echo "    docs          Build the hosted user guide (website/docs/)"
	@echo "    pdf           Build the user-guide PDF (PDF_OUT=path to override)"
	@echo "    build         Build Electron app for macOS (dir only, unsigned)"
	@echo "    build-linux   Package smoke-test for Linux (dir only, unsigned)"
	@echo "    build-win     Package smoke-test for Windows (dir only, unsigned)"
	@echo "    dmg           Build unsigned macOS .dmg (default 'make')"
	@echo "    dist          Build installers for all platforms (host builds its own)"
	@echo "    release       Bump version, tag, and push to trigger a release (VERSION=x.y.z)"
	@echo "    dist-mac      Build macOS installer (dmg + zip; signed if a cert is present)"
	@echo "    dist-linux    Build Linux installer (AppImage + deb)"
	@echo "    dist-win      Build Windows installer (nsis + portable)"
	@echo "    site          Regenerate website/versions.json from GitHub Releases"
	@echo "    clean         Remove build and dist directories"
	@echo "    version       Print version string"
	@echo "    info          Print full build information"

.PHONY: version info install debug fmt fmt-check lint license-headers icons \
        datasheets demos vendor-markdown docs pdf test test-license-headers \
        build build-mac build-linux build-win dmg release dist dist-mac \
        dist-linux dist-win site build-setup build-install clean help
