# ChipHippo Gallery, Sharing and Challenges: Feature Spec

Handoff document for Claude Code. It collects every decision made so far about the gallery, sharing, education layer and the new "challenge" (competition) feature. Items marked **DEFERRED** are intentionally not part of the first build.

---

## 1. Goals and constraints

- Let users share circuit designs and browse others' designs, since people have asked for sharing.
- Preserve ChipHippo's promise: **nothing leaves the user's machine** and there is no cloud storage. The one exception is sharing, which is strictly opt-in and explicit.
- Keep the free, local, no-account ChipHippo exactly as it is. Gallery features are additive.
- Build the basics first: gallery and sharing, then challenges, then (much later) any paid teacher service.
- Zero or near-zero running cost: static hosting plus a small Cloudflare Worker.

## 2. Architecture overview

| Piece | Choice |
|---|---|
| Gallery site | Static site at `chiphippo.com/gallery`, served by GitHub Pages from the **existing ChipHippo repo** (Pages ties one domain to one repo, so the gallery lives in a folder/path within it, not a separate repo) |
| Submission endpoint | Small Cloudflare Worker holding a fine-grained GitHub token scoped to the one repo |
| Submission path | Worker opens a **pull request** against the ChipHippo repo (not the user's own GitHub/gist; GitHub-account flows were rejected as too much friction for average users) |
| Validation/automation | GitHub Actions on every PR |
| Index | A single generated data file listing all entries, rebuilt automatically when a PR is merged |
| Moderation | Curated: final merge is always manual (human in the loop). May loosen to open submission later |

## 3. Sharing flow (user side)

1. User clicks **Share** in ChipHippo.
2. App validates the circuit locally (schema, all components exist).
3. App generates a thumbnail locally.
4. A **separate, explicit consent prompt** appears (this action sends the user's circuit data). See section 8.
5. App sends circuit + thumbnail + metadata (title, author name, description, optional tags) to the Worker.
6. Worker re-validates everything server-side, then opens a PR.
7. Maintainer reviews and merges; the index rebuilds; the design appears in the gallery.

## 4. Gallery site

- Grid of cards: thumbnail, title, author, tags.
- Client-side search and filter (by tag, level, author, etc.).
- Detail page per design with **Open in ChipHippo** and **Download** buttons.
- Download saves the raw circuit file for offline/manual Open.
- Ratings were wanted but are **DEFERRED** (need storage/accounts). Launch with a hand-curated "Featured" section instead.

## 5. Submission pipeline (GitHub Actions)

- **Validation**: schema check plus verification that every referenced component exists.
- **Thumbnail**: auto-rendered by headlessly loading the circuit in the actual ChipHippo web app and taking a screenshot. This doubles as a smoke test of the app.
- **Auto-tagging** derived from circuit file contents, not image analysis (e.g. 6502 + ROM gives "CPU"; 555 timer gives "clock/oscillator").
- **Level** (beginner / intermediate / advanced) inferred from chip count.
- Index file regenerated on merge.

## 6. Seeding

- Launch seeded with ChipHippo's own built-in example circuits (already tested; avoids an empty gallery).
- **Open question**: seed entries as copies in the repo vs. links to the original example files (copies can drift). Not yet resolved.

## 7. Shared UI code and opening designs

- **One gallery-view UI, written once**: fetches the index, renders cards, search/filter client-side. The same code runs in the web app, the Electron desktop app and the public website, with only minor OS-level wrappers (e.g. file-opening differences).
- **Web**: "Open in ChipHippo" passes a URL parameter pointing at the circuit file; the app fetches and loads it.
- **Desktop (Electron)**: custom URL protocol (e.g. `chiphippo://open?...`) launches the installed app; falls back to the web app or Download if not installed.
- **In-app "Browse Gallery"** menu item so users can browse and open designs without visiting the website.

## 8. Desktop permission prompts

- **Gallery access**: one-time consent dialog the first time the Gallery is opened in the desktop app, explaining it makes a network request to chiphippo.com and sends no circuit data. Allow / Not now, with "remember my choice". Revocable in Settings.
- **Share action**: a **separate, more explicit** prompt, because this one does send the user's circuit data.

## 9. Spam and security defenses (Worker)

- Submission size cap, and a cap on the number of open PRs at once.
- Per-visitor rate limiting (Cloudflare rate-limit rules / KV).
- Mandatory server-side re-validation of file and thumbnail. Never trust the client.
- Optional Cloudflare Turnstile bot check.
- Length limits plus a basic profanity filter on text fields.
- GitHub token scoped to the one repo only.
- Manual final merge.

## 10. Repo size and scaling

GitHub limits (recommended under 1 GB, hard review at 5 GB, 100 MB per file) are nowhere near a concern for JSON circuit files at any realistic gallery scale. The real risk would be large image/video assets, so keep thumbnails small.

## 11. Gallery of galleries (decentralized collections)

- Other people (a teacher, an enthusiast) can publish their own repo as a collection using the **same index-file convention**, so ChipHippo can read any compliant repo as a gallery.
- A top-level directory lists collections via small per-collection metadata entries only (not full contents), paginated (about 50 at a time) with search. Collection contents are fetched only when opened.
- Private collections never appear in the public directory, so a user's own list stays short regardless of overall scale.

## 12. Education layer (builds on the same mechanism)

- **Public teacher lesson collections**: just another gallery (teacher's own repo, same index format), listed in the directory. Entries can carry extra fields such as instructions or goals.
- **Student hand-in**: simplest path is a plain downloaded file submitted through whatever LMS or email the school already uses (no GitHub needed). GitHub Classroom is an option for schools already using it.
- **Privacy reality**: a static page cannot be selectively private. An "unlisted" link is obscurity, not privacy. True privacy requires an underlying private store.
- **Class codes**
  - **Tier 1 (build first)**: the code is a long, random, unguessable address. Typing it into ChipHippo's "Join a class" box adds that collection to a private local shelf. Never listed publicly. Fine for ordinary lesson material, not for anything sensitive such as exam content.
  - **Tier 2 (later)**: the code is checked server-side by the Worker against a class record in a real datastore (e.g. Cloudflare D1); only then are contents released from private storage (e.g. R2) whose address is never exposed. Codes can be revoked or rotated by the teacher.
- **Student identity** (so codes are not casually shared): per-student codes bound to a device on first use (casual and younger classes), optionally a class code plus nickname plus PIN, with school SSO as the option for universities. Goal is to make casual sharing fail, not to build exam security.

## 13. Paid teacher service (**DEFERRED**, build after the gallery has real users)

- Charging teachers means a real website with teacher sign-in and payment collection, which also becomes a home for the Worker code.
- Stack on Cloudflare free tier: Workers (logic), D1 (classes, codes, memberships), R2 (private lesson files); managed auth provider (no stored passwords); Stripe hosted checkout and customer portal (no card handling).
- **Teachers pay individually first**; a school plan can absorb them later. A solo teacher is a "school of one", so there is one model, not two.
- **Identity design principle**: students and teachers are **opaque internal IDs** with a separate list of sign-in methods (per-student device-bound codes now, school/university SSO later) so SSO can slot in without a rewrite. SSO is a possible premium institutional tier, not the base plan.
- Keep student data minimal (an opaque ID plus a nickname per class) to limit COPPA/FERPA exposure.
- **Open**: pricing model (per seat / per class / school licence), whether students need any account (leaning no), privacy-law approach.
- A school administrator can sign up the school and invite teachers; ownership is transferable; verified email domains can auto-join teachers. Considered too pie-in-the-sky for now.

---

## 14. NEW: Challenges (competitions to improve a design)

Inspired by Poly Bridge's gallery: a level has many submissions, shown in a grid with Sort By / World / Level dropdowns, each card showing a thumbnail, a cost figure and a score, ranked by the chosen metric.

### 14.1 Concept

Instead of simply posting a design, an author can post a **challenge**: a base design plus **judging criteria that the ChipHippo engine can measure**. Others then submit improved versions. All submissions live under the **same single gallery entry** and are ranked against each other.

### 14.2 Challenge definition (set by the challenge author)

- The base circuit.
- **Test harness**: the stimulus (signal inputs, clock, initial state), the observation points and the run length, so measurements are deterministic and repeatable.
- **Criteria**, each tagged with the engine that measures it (**digital** or **SPICE**) and a ranking direction (lower is better, higher is better, or pass/fail):
  - Parts count and chip count (static, from the file).
  - Speed: max stable clock frequency, settle time or propagation delay (digital engine).
  - Max and average supply current, total power (SPICE).
  - Other measurable behaviour: output frequency accuracy, rise/fall time, voltage on a net, number of correct outputs on a test sequence, and so on.
- **Constraints** (optional): e.g. maximum chip count, allowed component families, required I/O pins, so submissions must remain functionally valid.
- A **functional correctness check** (pass/fail) that a submission must meet before it is ranked at all.
- The author chooses which criteria are active, which determines the sort options shown.

### 14.3 Submissions

- A submission is a modified circuit, submitted through the same Share flow (PR via the Worker).
- **Scores are never trusted from the client.** The pipeline re-runs the harness headlessly (GitHub Actions) with the pinned engine version and records the measured values.
- Each submission stores: submitter name, circuit file, thumbnail, measured scores per criterion, pass/fail, engine version and date.
- Moderation still applies (manual merge), with length limits and a profanity filter on the displayed name.

### 14.4 Challenge page (the single gallery entry)

- The base design plus all accepted submissions, shown as a grid like the Poly Bridge example: thumbnail, submitter name, key scores on the card.
- **Sort By dropdown** driven by the criteria the author enabled (parts count, chip count, speed, max current, average current, and so on), with a ranked position per criterion.
- **Compare view**: overlay a submission on the base design, with changed or added parts highlighted (**red board** or another distinguishing colour) so differences are visible at a glance. Compare any two submissions, not just against the base.
- Optionally highlight the **best per criterion**, and a **Pareto view** (submissions not beaten on every criterion), since criteria trade off against each other.
- Actions per submission: Open in ChipHippo, Download.

### 14.5 Technical needs

- **Headless engine**: the digital and SPICE engines must be runnable outside the UI (Node or a CLI) so Actions can measure submissions. This is the largest new dependency.
- **Determinism**: the same circuit and harness must give the same numbers. Pin engine versions per challenge, and decide whether scores are re-run when the engine updates.
- **Measurement API in the engine**: a small, well-defined set of metrics (static counts, settle time, max frequency, current stats) exposed in one place so new criteria can be added without touching the pipeline.
- **Performance budget**: SPICE runs roughly 1 kHz on standard circuits (about 4 kHz on simple ones, and a very heavy circuit takes about 600 real seconds per simulated second), so harness run lengths must be short windows. Measurement jobs need time limits.
- Index schema extended to represent a challenge entry with child submissions and per-criterion scores.

### 14.6 Open questions

- Re-scoring policy when the engine version changes.
- Tie-breaking and how multiple criteria combine (separate rankings only, or an optional weighted overall score).
- Whether a challenge can be closed or time-limited.
- How to prevent gaming (e.g. a circuit that passes the harness but is functionally degenerate): richer test sequences, hidden test vectors.
- Whether the challenge author may add or retire criteria after submissions arrive.

---

## 15. Suggested build order

1. Gallery entry format (the per-design metadata fields). Sketch this first, since everything else hangs off it.
2. Static gallery site and shared gallery-view UI, seeded with built-in examples.
3. Share flow: Worker, PR creation, Actions validation and thumbnail, auto-tagging.
4. Desktop integration: URL protocol, in-app Browse Gallery, consent prompts.
5. Headless engine and measurement API.
6. Challenges: challenge entry format, scoring pipeline, ranked grid, compare view.
7. Gallery-of-galleries and Tier 1 class codes.
8. Later: Tier 2 class codes and the paid teacher service.

## 16. Other next steps (not yet acted on)

- Possible outreach to CMU's "Build Your Own Breadboard Computer" course or Western Design Center about piloting ChipHippo as a no-hardware companion.
- Precomputed lookup curves for the SPICE engine: profile a heavy circuit first to see where the time goes before building anything.
