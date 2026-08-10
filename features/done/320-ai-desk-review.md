# Feature 320 — Ask the AI what's wrong with this desktop

## Context

The AI panel could build a circuit and prove it. It could not look at one.

Everything Feature 260 shipped points one way: you describe a circuit, a compiler
places it, the L3a–L7 ladder proves it, and a ghost is armed. Turn the question
around — *"I built this myself and it doesn't work; what's wrong?"* — and the app
had no answer. The simulator knows a great deal about a broken circuit (a net that
never resolves, opposing supplies on one node, a chip at 3 V, a tri-state part whose
outputs never enable) but it reported only a subset, only while the circuit **ran**,
and only as toasts that fire and fade. Nothing surveyed a stopped desk and said what
it found.

Two things already in the tree did most of the work:

- **`model/autobuild-verify.js`** is a fault ladder over a *built document* — L5's
  settle, its chip-status sweep, its `tristateEnables` blame map, L6's undriven-net
  rule. Every one of those is a question about a DOCUMENT, not about a compiler;
  only the plumbing that fed them was generated-circuit-specific.
- **`model/build-plan.js`'s `buildWarnings`** (`build-plan.js:826`) already derived
  three localized findings from a plain desk document — floating leads, unpowered
  chips, single-member nets.

So the split is the one the builder already made for geometry, one level over: **an
LLM cannot decide whether a net is shorted — the engine can.** The app finds the
faults; the model explains what they mean and what to do. That keeps the answer
grounded in the same solver the desk runs on, and it means a wrong model cannot
invent a fault that is not there.

Prerequisites: 70 (netlist), 90 (engine), 140 (build-plan warnings), 260 (the panel,
providers, credential store). Nothing here touches the compiler, the ladder's own
callers, or the placement path.

## Goal

A **Review** mode in the AI panel. It reads the active desktop, runs the app's own
checks against it, shows what it found, and asks the model to explain the findings
and answer a question about the circuit — in prose, in the user's language. It
**never changes the desk**: no ghost, no placement, no edits, no repair rounds. It
works while the simulation runs, because a read-only second opinion has no reason to
be locked out.

## Design decisions (settled)

**THE ENGINE FINDS THE FAULTS; THE MODEL EXPLAINS THEM.** The model is handed a
coordinate-free description of the circuit plus the findings the app derived, and is
asked what they mean. It is never asked to inspect wiring and judge whether something
is shorted — an answer it would give confidently and sometimes wrongly, with nothing
to check it against. `ai/catalog-brief.js`'s `REVIEW_RULES` is one instruction said
three ways: do not re-derive, do not contradict, you may say it looks fine.

**REVIEW IS READ-ONLY, AND THAT IS WHAT LETS IT RUN WHILE THE SIM DOES.** `#onSend`
gates Build on `isLocked()` because a build ends in a placement the desk would
refuse. A review ends in a paragraph. It reads `deskDoc.toJSON()` (a deep copy) and
settles its own copy, so a live transport is untouched.

**IT RUNS ITS OWN SETTLE RATHER THAN READING THE TRANSPORT'S.** `SimController`
exposes no last-result accessor, and — the reason that matters — a review that only
worked while the circuit ran would be useless for the case it exists for: a stopped
desk that does nothing. Clocks are pinned idle-low exactly as L5 pins them, and for
the same stated reason: a bare settle leaves a clock line at `Z` and every net it
feeds is then reported as undriven on a perfectly good circuit.

**ONLY THE INPUTS OF A GATE THAT IS IN USE ARE REPORTED, and this is the decision the
whole finding list stands or falls on.** A 74LS00 has four gates; a design that needs
one leaves six inputs floating. On a real bench those want tying — but reporting them
would bury every genuine fault under six lines of housekeeping on every circuit,
*including the ones this app generates and ships*. So a gate whose OUTPUT drives
nothing is idle, not broken. `logic.units` asks exactly that question per gate (each
unit has one `output` pin); a part with no units block — a counter, a latch, a
memory — is judged whole, on whether any of its outputs is wired to anything.
Measured: all 52 shipped example benches report **zero faults**, and the two that
report a warning do so correctly (the '125's enable rests on an open switch; the
'193's count-down clock is deliberately left to float HIGH).

**AN UNWIRED ENABLE AND A HIGH ONE ARE NOT THE SAME FAULT.** Nobody wired it is an
omission the desk cannot recover from — the part is dead and no switch throw brings
it back, so it is a **fault**. Wired but currently HIGH is a part that is switched
OFF, which on a bench with an enable on a slide switch is a state rather than a
mistake, so it is a **warning** and says so differently. `tristateEnables` already
distinguished the two; this is the first caller that acts on the distinction.

**MODE IS A SEGMENTED PICKER IN `.ai-header`, AND SWITCHING STARTS A NEW
CONVERSATION.** `buildSegmented` is the app's shared either/or track; it sits after
`.ai-title`, left-packed, because `.ai-tools` is the header's elastic member. The two
modes run under different system prompts, so a mixed thread is incoherent — switching
clears `#history`. It does NOT clear the transcript (a record) or the prompt history
(the user's, and cross-project). The mode is session-only and not a setting: the
picker shows which is armed, so a remembered one buys nothing.

**THE STREAMED REPLY IS SHOWN.** Build hides the stream because the reply is JSON and
a character count is the honest progress signal. A review's reply is prose written for
the person watching, so it streams into the row and that row is promoted to the answer
when it lands (`.ai-row--reply`, the one row whose CONTENT is the point).

**THE FINDINGS ARE LOCALIZED; THE BRIEF'S IDENTIFIERS ARE NOT.** Findings are shown to
the user *and* embedded in the brief, so they go through `tf()` like `build-plan.js`'s
do — one wording, one place, and the user and the model are looking at the same claim.
Part ids, refs, pin names and net ids stay verbatim (`c1.1A`), the vocabulary Build
mode already taught the model. The prompt names the UI language and asks for the answer
in it. The brief's own scaffolding is English by construction, like the ladder's fault
messages: it is protocol, never rendered to anyone.

**A `tristateEnables` MESSAGE IS FOUR WHOLE SENTENCES, NOT ONE ASSEMBLED FROM
FRAGMENTS.** "enable/enables", "is/are" and "it/them" do not agree the same way in
seven languages, and a translator handed `{chip} … its {enables} {pin} {verb} {level}`
cannot produce a correct sentence in any of them. Two keys × two plural forms, each a
complete sentence, with `count` as the selector and never in the text.

**NO SILENT CAPS.** A large desk is trimmed in the brief to keep the request bounded,
and the brief *says* what it dropped — the rule `autobuild.js` states for kit pruning.

**`ai:start` GREW AN OPTIONS ARGUMENT, NOT A SECOND CHANNEL.** `buildRequest` gained a
`schema` parameter defaulting to `NETLIST_SCHEMA`; `null` means prose and each adapter
omits its format field (Anthropic keeps `output_config.effort` — a review must think
exactly as hard as a build — and drops `format`; the OpenAI-compatible adapter drops
`response_format` entirely, so a local server that never implemented it sees a request
it can serve). `opts.format` is a NAMED format rather than a caller-supplied schema:
main decides what the model may be asked for, exactly as it decides which URLs may be
reached.

## Implementation steps

1. `model/desk-review.js` (new, pure) — `reviewDesk(document, netlist)` →
   `{findings, stats, settled}`. Folds in `buildPlan().warnings`, the engine's own
   warnings, and the new checks: `NO_SUPPLY`, `UNPOWERED_CHIP`, `INPUT_FLOATING`,
   `OUTPUTS_DISABLED`, `BUS_FIGHT`, `LED_UNLIMITED`.
2. `model/autobuild-verify.js` — export `tristateEnables`; add `componentId` to its
   blame object so a caller can name the part its own way.
3. `ai/desk-brief.js` (new, pure) — the circuit as the model reads it.
4. `ai/catalog-brief.js` — `buildReviewSystemPrompt(defs, language)`.
5. `app/ai/providers.js` + `app/ai/client.js` + `main.js` + `preload.js` — the
   `schema` seam and `ai:start`'s `opts`.
6. `components/ai-panel.js` — the picker, `#mode`, `setMode`, `#review`, the promoted
   reply row; `app.js` passes `deskDoc` + `netlist: netlistCache`.
7. `styles/app.css` — `.ai-mode` (a fixed-width slot) and `.ai-row--reply`.
8. Seven locale catalogs — a new `review.*` section and eighteen `ai.*` keys.
9. `docs/ai-builder.md` — the Review section.

## Acceptance criteria

- Every finding above is reported on a deliberately broken bench and none on a
  working one; **no shipped example bench reports a fault** (a ratchet over all 52).
- The desk is byte-identical before and after a review.
- Review works with the simulation running and with it stopped; Build stays locked.
- Build mode is unchanged — same prompt, same schema, same ladder, same ghost.
- `make fmt && make lint && make test` green, `make test-i18n` included.

## Constraints

- No new IPC channel; no renderer network access; the key still never crosses the
  bridge.
- `desk-review.js` and `desk-brief.js` stay DOM-free and take a plain document.
- The one shared `NetlistCache` is reused — never a second `buildNetlist` per panel.
- No new dependency.

## Verify

1. `make fmt-check && make lint && make test`.
2. `make debug` with a configured key:
   - Open an example bench, delete a wire, switch to **Review**, ask "what's wrong?"
     — the missing connection is named and explained.
   - Tie a `74LS244`'s `OE` HIGH; confirm the enable is named.
   - Wire an LED straight across the rails; confirm the burn finding.
   - Run the simulation and review again — it answers rather than refusing.
   - Switch back to Build; a normal build still arms a ghost.
3. Confirm ⌘Z has nothing to undo after a review.
