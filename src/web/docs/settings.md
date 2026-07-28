# Settings

Chip Hippo keeps its handful of app-wide preferences in one small **Settings**
dialog — a tabbed master-detail card with a left nav rail and a panel on the
right. It's deliberately minimal: three tabs, a few controls each, applied
live the moment you change them.

![The Settings dialog](images/settings.png)

## Opening Settings

Open the dialog with `Cmd/Ctrl+,`, or click the gear icon in the top-right
corner of the header. Both routes lead to the same dialog seeded with your
current settings, so it doesn't matter which you use.

## Appearance

The **Appearance** tab is the one the dialog opens on:

- **Theme** — **System**, **Light** or **Dark**. System follows your
  operating system's own setting; the other two pin it. The choice applies to
  every Chip Hippo window at once, including the floating pinout, memory
  inspector and user-guide windows, and to the native menus and dialogs.
- **Show desk hub** — off by default. This toggles a debug overlay (the
  `DeskHud`) on the desk; most users can leave it off.
- **Selection border colour** — a `#rrggbb` colour picker for the outline
  drawn around whatever's selected on the desk. Leave it unset to use the
  theme's default accent colour instead of a custom one.
- **Default LED color** — which colour a newly placed LED, LED bar or
  seven-segment digit gets. Unlike the others this one isn't applied live; it's
  read when you place a part, so changing it doesn't recolour anything already
  on the desk. Any placed part's colour can still be changed from its
  **Properties…** dialog.

Everything but the LED colour takes effect immediately — there's no separate
Apply or OK step.

## Data Sheets

The **Data Sheets** tab points Chip Hippo at an external folder of
manufacturer datasheet PDFs on your machine. Click **Browse…** to pick a
folder with the native file picker; the chosen path is shown next to it, with
a trash-can button to clear it back to no folder selected.

Name the PDFs in that folder after each chip's catalog reference (for
example `74LS00.pdf`). When a chip's file is found there, its
[pin-assignments window](chip-library.md) grows a button that opens the PDF
in your system's default viewer. This is separate from the small datasheet
crop the pinout window already shows for most chips — the external folder is
for the full manufacturer document, not the built-in crop.

## AI

The **AI** tab is where you point Chip Hippo at your own AI connection, for
the [AI circuit builder](ai-builder.md). Nothing here is required — the app
works completely without it, and makes no outbound request of any kind until
a connection is configured and you ask the builder for something.

![The AI tab of the Settings dialog](images/settings-ai.png)

- **Provider** — **Anthropic**, or **OpenAI-compatible**. The second covers
  Ollama, LM Studio, OpenRouter, vLLM and anything else speaking that request
  format; you supply the base URL.
- **Base URL** and **Model** — leave either blank to use the chosen provider's
  default, which is shown as the field's placeholder. Both commit when you
  leave the field or press `Enter`, not as you type.
- **API key** — paste it and click **Save key**. **Clear key** forgets it.
  A local server that needs no key works with this left blank.
- **Test connection** — one small request that checks the base URL, key and
  model together, so a typo is found here rather than on your first build.

**The key is never written to Chip Hippo's settings file.** It's handed to
your operating system's own secure credential store — Keychain on macOS, the
Credential Manager on Windows, the desktop keyring on Linux — encrypted, and
it's never read back into the app's window afterwards; the dialog only learns
*whether* a key is stored. If no secure store is available on your system,
Chip Hippo **refuses to save the key** and says so rather than quietly writing
it out in the clear.

## What else persists automatically

A few things aren't part of this dialog but are remembered between sessions
without any action on your part: the app window's position and size, the desk
camera — your current pan position and zoom level — and which panels you left
open (the parts tray, the build guide, the analyzer, the AI builder) along with
the height you dragged each docked one to. Close Chip Hippo and reopen it, and
you're back exactly where you left off.

See [Files, Saving & Undo](files-and-undo.md) for how your circuit itself
is saved.
