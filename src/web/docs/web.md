# Chip Hippo in the Browser

Chip Hippo also runs in a web browser, with nothing to install. It is the same
app: the same desk, parts, simulation (both engines), examples, CPU monitor,
chip designer and 3D view. Your work stays in the browser on your own computer,
and nothing is sent anywhere.

Each Chip Hippo release comes out in both forms at once: the desktop app, and
the web version at the same version number.

## Which browser

Any current browser runs Chip Hippo. **Chrome** and **Edge** do the most:

|                                      | Chrome / Edge | Firefox                         | Safari                          |
| ------------------------------------ | ------------- | ------------------------------- | ------------------------------- |
| Design, simulate, examples, 3D       | ✓             | ✓                               | ✓                               |
| Open and save files on your computer | ✓             | kept in the browser (see below) | kept in the browser (see below) |
| A real Arduino over USB              | ✓             | ✓                               | — (the built-in Mock works)     |
| Install as an app                    | ✓             | —                               | Add to Dock                     |

## Saving your work

The working copy is saved automatically, a couple of seconds after each
change. An untitled project lives in the browser and is there again next time
you open Chip Hippo, and a project with unsaved changes comes back with them if
the tab closes or reloads.

**In Chrome and Edge**, File ▸ **Open…** and **Save As…** use your computer's
own file dialogs. A project you save is a real `.chiphippo` file, the same
format the desktop app uses, so you can move projects between the two freely.
The first time you save to a file in a session, the browser asks whether
Chip Hippo may change it.

**In Safari and Firefox** a web page can't write to a file on your computer.
Instead, **Save As…** asks for a name and keeps the project in the browser.
File ▸ **Open…** lists every project kept there, and each has a **Download**
button that gives you a copy as a `.chiphippo` file. **Upload from Computer…**
brings a file in. Exports (a desktop, a KiCad or Digital export, a ROM image, a
serial log, generated Arduino code) are downloaded. A KiCad export arrives as a
single `.zip`.

> Projects kept in the browser live in that browser's storage. Clearing your
> browsing data for the site deletes them, so download a copy of anything you
> want to keep. **Safari also deletes a site's storage on its own when you
> haven't visited it for seven days** (unless Chip Hippo is added to the
> Dock), so in Safari download your projects before a break.

If Chrome or Edge says a file you saved from Chip Hippo has been **changed
outside Chip Hippo**, something else (the desktop app, another browser) saved
it since this tab last read it. **Replace** puts this tab's project over that
newer copy; **Cancel** leaves the file alone, and Save As keeps your work under
another name.

## Windows

The pin assignments, memory inspector, chip designer, CPU monitor, floated
sliders, serial connection windows and this guide each open in a window of
their own, as they do on the desktop. If your browser blocks them, Chip Hippo
shows an **Open Window** button. Allow pop-ups for the site to skip that step.

Chip Hippo runs in one tab at a time. Opening it in a second tab shows a note
until the first one closes.

## Menus and shortcuts

There is no menu bar. Its commands are in the app itself:

- **File**: the toolbar's File group has New, Open (a right-click lists recent
  projects), Save and Save As. Bill of Materials is in the desk tools.
- **Desktop**: the tab strip's **+** and each tab's right-click menu.
- **Settings**: the gear at the top right.
- **Help**: the **book** beside the gear opens the Help menu: the User Guide,
  Support, Keyboard Shortcuts, Check for Updates and About.

The shortcuts all still work: `Cmd/Ctrl+S`, `Cmd/Ctrl+Z`, `Cmd/Ctrl+,`,
`Cmd/Ctrl+/` and the rest. A browser keeps a few for itself and never passes
them to a page: `Cmd/Ctrl+N`, `Cmd/Ctrl+W` and `Cmd/Ctrl+T`. Use **New** in the
toolbar's File group instead.

## What is different

- **The Arduino integration** needs Chrome, Edge or Firefox, which can reach a
  USB serial port (Safari can't; its built-in Mock still works). In Settings ▸
  Serial I/O, click **Add Device…** and choose the board in the browser's own
  list. A board you have allowed stays allowed next time.
- **The AI circuit builder** calls the provider straight from your browser,
  with your own key. The key is kept in this browser's storage, not in an
  operating-system keychain, and anything that runs on the site could read it.
- **Datasheets**: there is nothing to set up. Every part with a known
  datasheet has the datasheet button in its pin assignments window, and it
  opens the manufacturer's own PDF in a new browser window (this needs a
  connection). Settings ▸ Data Sheets has no folder or **Download** button
  here.
- **Updates** arrive on their own. A new release is fetched in the background
  and Chip Hippo offers **Restart** to switch to it.
- **Offline**: after the first visit, Chip Hippo opens without a connection.
  The guide's pages and the datasheet pictures you have already looked at are
  available offline too.
