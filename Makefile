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

# Full unsigned macOS release: every mac target from package.json's build.mac
# (dmg + zip, arm64 + x64). No code-signing or notarization — UNSIGNED_ENV
# strips signing from the environment and -c.mac.notarize=false forces it off,
# so the artifacts are distributable-but-unsigned. Signed/store builds are the
# packaging backlog's job.
release: build-setup build-install
	@echo "Building unsigned macOS release artifacts (dmg + zip, arm64 + x64)…"
	@cd $(BUILD_DIR)/src; env $(UNSIGNED_ENV) npx electron-builder --mac --publish never -c.mac.notarize=false
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
	@echo "    build         Build Electron app for macOS (dir only, unsigned)"
	@echo "    build-linux   Package smoke-test for Linux (dir only, unsigned)"
	@echo "    build-win     Package smoke-test for Windows (dir only, unsigned)"
	@echo "    dmg           Build unsigned macOS .dmg (default 'make')"
	@echo "    release       Build all unsigned macOS artifacts (dmg + zip, arm64/x64)"
	@echo "    dist          Build installers for all platforms (host builds its own)"
	@echo "    dist-mac      Build macOS installer (dmg + zip; signed if a cert is present)"
	@echo "    dist-linux    Build Linux installer (AppImage + deb)"
	@echo "    dist-win      Build Windows installer (nsis + portable)"
	@echo "    site          Regenerate website/versions.json from GitHub Releases"
	@echo "    clean         Remove build and dist directories"
	@echo "    version       Print version string"
	@echo "    info          Print full build information"

.PHONY: version info install debug fmt fmt-check lint license-headers icons \
        datasheets demos test test-license-headers build build-mac build-linux \
        build-win dmg release dist dist-mac dist-linux dist-win site \
        build-setup build-install clean help
