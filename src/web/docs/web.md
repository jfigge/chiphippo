# Chip Hippo in the Browser

Chip Hippo also runs in a web browser, with nothing to install. It is the same
app: the same desk, parts, simulation (both engines), examples, CPU monitor,
chip designer and 3D view. Your work stays in the browser on your own computer,
and nothing is sent anywhere.

Each Chip Hippo release comes out in both forms at once: the desktop app, and
the web version at the same version number.

## Which browser

Any current browser runs Chip Hippo. **Chrome** and **Edge** do the most:

| | Chrome / Edge | Safari / Firefox |
|---|---|---|
| Design, simulate, examples, 3D | ✓ | ✓ |
| Open and save files on your computer | ✓ | kept in the browser (see below) |
| A real Arduino over USB | ✓ | — (the built-in Mock works) |
| Install as an app | ✓ | Safari: Add to Dock |

## Saving your work

The working copy is saved automatically, exactly as on the desktop. An untitled
project lives in the browser and is there again next time you open Chip Hippo.
Projects with unsaved changes are kept safe if the tab closes.

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
> want to keep.

## Windows

The pin assignments, memory inspector, chip designer, CPU monitor, floated
sliders, serial connection windows and this guide each open in a window of
their own, as they do on the desktop. If your browser blocks them, Chip Hippo
shows an **Open Window** button. Allow pop-ups for the site to skip that step.

Chip Hippo runs in one tab at a time. Opening it in a second tab shows a note
until the first one closes.

## The menu bar

The application menu (File, Desktop, Edit and Help) is a bar along the top of
the page, with the same items and shortcuts as on the desktop. A browser keeps a
few shortcuts for itself and never passes them to a page: `Cmd/Ctrl+N`,
`Cmd/Ctrl+W` and `Cmd/Ctrl+T`. Use **New Project** in the toolbar's File group
or in the menu bar instead.

## What is different

- **The Arduino integration** needs Chrome or Edge, which can reach a USB serial
  port. In Settings ▸ Serial I/O, click **Add Device…** and choose the board in
  the browser's own list. A board you have allowed stays allowed next time.
- **The AI circuit builder** calls the provider straight from your browser,
  with your own key. The key is kept in this browser's storage, not in an
  operating-system keychain, and anything that runs on the site could read it.
- **Datasheets**: Settings ▸ Data Sheets can point at a folder of PDFs on your
  computer (in Safari and Firefox, for that visit only). The **Download**
  button is not offered, because the manufacturers' sites don't allow a web
  page to fetch their PDFs.
- **Updates** arrive on their own. A new release is fetched in the background
  and Chip Hippo offers **Restart** to switch to it.
- **Offline**: after the first visit, Chip Hippo opens without a connection.
  The guide's pages and the datasheet pictures you have already looked at are
  available offline too.
