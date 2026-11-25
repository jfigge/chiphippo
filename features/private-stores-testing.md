# Testing private stores by hand

This is a step-by-step guide to trying the private stores yourself. Each part builds on the one before. Part 1 needs no cloud account and no network. Part 3 needs two GitHub accounts.

Private stores are in every desktop build (the `stores` flag was removed 2026-11-22), so no launch needs a flag.

In this guide, **Ann** is you and **Bob** is "your friend". On one Mac they are two copies of Chip Hippo, each with its own data folder.

---

## 0. Before you start

1. Install dependencies if you haven't: `make install`.
2. Optionally, run the automated tests first: `make test-fast` (about 2.5 minutes). The private-stores tests are `src/app/tests/stores-*.test.js` and `src/web/scripts/tests/stores-format.test.js`.
3. Open two terminal windows: one for Ann, one for Bob.

> Two copies run side by side because each has its own `--user-data-dir`. Chip Hippo's single-instance lock is per data folder.

---

## Part 1 — A folder store on one Mac (no cloud needed)

A plain folder stands in for "a Dropbox folder both computers sync". Both copies of the app point at the same folder, which is exactly what a sync service gives two real computers.

### 1.1 Make the "cloud" folder

```bash
mkdir -p ~/Desktop/FakeDropbox
```

### 1.2 Start Ann

In terminal 1:

```bash
make debug
```

This is your normal dev session, using the repo's `data/` folder.

### 1.3 Start Bob

In terminal 2, use a throwaway data folder so Bob is a separate person:

```bash
cd src && npx electron app/main.js --dev --user-data-dir=/tmp/chip-bob
```

Drag the two windows side by side.

### 1.4 Ann makes a store

1. In **Ann**'s window: **Settings** (gear, top right) ▸ **Gallery**.
2. Choose the **Private** tab at the top of the Gallery page, then press **Add Store…**.
3. Choose **A folder you sync**.
4. Set **Which service?** to **Dropbox** (any choice works; it only changes the instructions shown).
5. Type a **Store name**, e.g. `Bench club`.
6. Press **Choose Where…**, pick `~/Desktop/FakeDropbox`, and confirm.
7. You should see **"Bench club" is ready**, with:
   - where the folder is (`~/Desktop/FakeDropbox/Bench club`);
   - how to share it in Dropbox;
   - a link box with **Copy link**.
8. Press **Copy link**, then **Done**. The store now appears in the list.

**Check:**
- In Finder, `~/Desktop/FakeDropbox/Bench club/` exists and holds `chiphippo-store.json`.
- The store's line in Settings has these actions: **Copy link · Browse · Show folder · Remove**.
- **Show folder** opens it in Finder.

### 1.5 Ann saves a design to it

1. Close Settings. Put something on Ann's desk: a board and a chip, or open an example from any chip's pinout window.
2. Choose **Desktop ▸ Share To…** and pick the **Private** tab. A tab's right-click menu has Share To… too.
3. The card shows **Store: Bench club** and the Title, Description, Tags and Your name fields. Give it a title, e.g. `LED chaser`, and your name.
4. Press **Save**. You should see **Saved — Saved to "Bench club".**

**Check:** Finder shows `Bench club/entries/led-chaser-xxxxxx/`, holding `entry.json` and a `revs/` folder. In `revs/` there are three files with the same name: `.desktop.chiphippo` (the design), `.png` (the board picture) and `.json` (who saved it and when).

**Also try:**
- Share To… ▸ Private with an **empty** desk: the card says the design can't be saved, and Save stays greyed.
- Start the circuit (Run), then open the card: it says to stop the circuit first.

### 1.6 Bob joins with the link

1. In **Bob**'s window: **Settings ▸ Gallery ▸ Private ▸ Add Store…**.
2. Choose **I have a link from a friend**.
3. Paste the link Ann copied, then press **Next**.
4. You should see **Join "Bench club"**, with three Dropbox-specific steps.
5. Press **Choose the Folder…** and pick `~/Desktop/FakeDropbox/Bench club`. Picking the folder *above* it (`FakeDropbox`) works too.
6. You should see **"Bench club" is added**. Press **Show Its Designs**.

**Check:**
- The **Browse Projects** window opens on a tab named **Bench club**, after Recent Projects and Gallery. Each private store gets its own tab, in the order they were added. With many stores, the strip of tabs scrolls sideways.
- Ann's **LED chaser** card is there, with its picture and "by Ann".

### 1.7 Bob opens it and saves a new version

1. Click the card, then press **Open Latest**.
2. Bob's app gets a new desktop tab called **LED chaser**.
3. Change something, e.g. move a part.
4. Choose **Desktop ▸ Share To…**. This time the card opens on **Private** by itself and offers **Save as: ◉ A new version of "LED chaser" ○ A new design**, plus **What changed?**.
5. Type a note, e.g. `moved the clock`, then press **Save**.

### 1.8 Ann saves from the old version, and is asked first

1. Back in **Ann**'s window, without opening Bob's version, change her desk.
2. Choose **Desktop ▸ Share To…** (it opens on Private) and keep **A new version of "LED chaser"**. Press **Save**.
3. The card should say: **Bob saved a newer version (…) after the one you opened.** It offers **Open Theirs** or **Save Mine Alongside**.
4. Press **Save Mine Alongside**.

### 1.9 Bob sees both versions

1. In Bob's Browse window, press **Refresh**, then click the card.
2. The detail shows **3 versions** and a note that 2 people saved from the same version. The list shows:
   - Ann's version, marked **latest**;
   - Bob's version, marked **another version**, with his note;
   - the first save.
3. Each version has its own **Open** button.

### 1.10 Removing

In Ann's Settings, press **Remove** on the store, then **Remove from This Computer**.

**Check:** the store leaves her list, the folder and every design are still in Finder, and Bob's app still has the store.

To add it back without a link: **Add Store… ▸ A store folder already on this computer** ("Restore an existing local store location"), then pick the folder.

### 1.11 Things that should fail politely

| Try this | Expect |
|---|---|
| In Bob's join step, pick an unrelated empty folder | "That folder does not hold this store… it may still be syncing" |
| Paste half a link, or garbage, into "I have a link" | "That is not a Chip Hippo store link…" |
| Rename the store's folder in Finder, then Browse it | A message that the store could not be found |
| Delete one revision's `.json` in Finder, then Refresh | That version disappears (a revision missing its `.json` counts as "still syncing"). Nothing breaks. |

---

## Part 2 — A real synced folder on two computers (optional)

This is the same as Part 1, with a real cloud service and a second computer, or a friend.

1. On both machines, install the service's desktop app (Google Drive for desktop, Dropbox, or OneDrive) and sign in.
2. On machine A, follow 1.4, but pick a folder **inside** the cloud folder (e.g. Dropbox, or My Drive).
3. Share the new store folder with machine B's account in the service's own app or website, with edit rights. The guide's **How to share a folder** button opens that service's help page.
4. On machine B:
   1. Accept the share.
   2. Make sure it syncs to that computer:
      - Google Drive: right-click the folder ▸ Organise ▸ Add shortcut ▸ My Drive.
      - OneDrive: "Add shortcut to My files".
   3. Then follow 1.6 with the link from A.
5. Repeat 1.5 to 1.9 across the two machines. Allow a few seconds for sync before pressing **Refresh**.

Both machines need a desktop build that carries the private stores.

---

## Part 3 — A GitHub store

Chip Hippo's GitHub OAuth App is registered: "Chip Hippo", client ID `Ov23lixgbUNY4hbDuwEo`, with device flow on and user tokens set to expire. The ID is built into `GITHUB_CLIENT_ID`, so there is nothing to register or pass. `CHIPHIPPO_GITHUB_CLIENT_ID` still overrides it in a `--dev` launch, if you ever want to try another app.

### 3.1 You need two GitHub accounts

Ann is your main account; Bob is a second one (a spare account, or a friend's). Bob's sign-in happens in a browser, so use a **private/incognito window** logged in as Bob. Otherwise GitHub signs Bob in as Ann.

### 3.2 Start both copies

Terminal 1 (Ann):

```bash
make debug
```

Terminal 2 (Bob):

```bash
cd src && npx electron app/main.js --user-data-dir=/tmp/chip-bob
```

### 3.3 Ann makes the store

1. **Settings ▸ Gallery ▸ Private ▸ Add Store… ▸ GitHub**. The GitHub choice should now be there.
2. Press **Sign In to GitHub**. A short code appears.
3. Press **Copy Code and Open GitHub**. Your browser opens github.com/login/device. Paste the code and approve **Chip Hippo**.
4. Back in the app it should say **Signed in to GitHub as @ann-account**.
5. Type a store name, then press **Make the Store**.
6. You should see **"…" is ready**, naming the private repository (e.g. `ann-account/Bench-club`), plus an invite box and the link.
7. Type Bob's GitHub username and press **Invite**. It appears as **invited — waiting for them**.
8. Press **Copy link**, then **Done**.

**Check on github.com:**
- the repository exists, **is private**, and holds `chiphippo-store.json`;
- under Settings ▸ Collaborators, Bob is invited.

### 3.3b Or: a store in a repository you already have

Instead of making a new repository, you can keep a store in a folder of one you already have.

1. **Add Store… ▸ GitHub**. Once you're signed in, choose **A folder in one of my repositories**.
2. Pick a repository from the list. Only **private** repositories you can write to are listed: a store in a public one would publish every design.
3. Keep the folder as `chiphippo`, or type another name. Use `/` for a folder inside a folder, e.g. `designs/chiphippo`.
4. Type a store name, then press **Make the Store**.

**Check on github.com:**
- The repository now has a `chiphippo/` folder (or whatever you named it) holding `chiphippo-store.json`.
- Nothing else in the repository changed.
- The store's line in Settings reads `GitHub · you/repo/chiphippo`, and **Open on GitHub** opens that folder.

**Also try:**
- Do the same again with the same repository and folder: the existing store is added back rather than made twice.
- Type `../x` as the folder: **Make the Store** stays greyed.
- Bob joins this store exactly as in 3.4. The link carries the folder.

### 3.4 Bob joins

1. In Bob's app: **Add Store… ▸ I have a link from a friend**. Paste the link, then press **Next**.
2. It says **Join "…"** and names the repository.
3. Press **Sign In to GitHub**, then copy the code.
4. Open <https://github.com/login/device> **in the private window logged in as Bob**, paste the code and approve.
5. Press **Join the Store**. Chip Hippo accepts Bob's invitation for him; he never sees GitHub's invitation page.
6. You should see **"…" is added**.

**Check:**
- On github.com, Bob is now a collaborator rather than "invited".
- Then repeat 1.5 to 1.9 between Ann and Bob. Each save is a few commits in the repository (the design, its picture, its note). Commits are only ever added.

### 3.5 GitHub things that should fail politely

| Try this | Expect |
|---|---|
| Bob joins **before** Ann invites him | "You are signed in as @bob, but this store has not been shared with that account yet. Ask your friend to invite @bob…" Invite him, then press Join again: it works. |
| Ann invites a username that doesn't exist | "GitHub has no account by that name." |
| Press **Cancel** on GitHub's approval page | "The GitHub sign-in did not finish. Try again." |
| Revoke the app at <https://github.com/settings/applications>, then Browse the store | "Sign in to GitHub again to reach this store." |
| Make a second store with the same name | The repository is named `…-2` |

### 3.6 Clean up after GitHub testing

- In each app, use the **Sign out** link under the store list in Settings ▸ Gallery.
- Delete the test repositories on github.com (Settings ▸ Danger Zone).
- Optionally, revoke the app at <https://github.com/settings/applications>.

---

## Part 4 — The link arriving by itself (optional)

The guide also opens on its own when a `chiphippo://store/add#…` link reaches the app.

1. In Ann's Settings, press **Copy link** on a store. This copies the web form, `https://chiphippo.com/store/#XXXX`.
2. Turn it into the app form by swapping the start for `chiphippo://store/add#`, keeping everything after the `#`.
3. Hand it to a fresh Bob on the command line:

   ```bash
   cd src && npx electron app/main.js --dev --user-data-dir=/tmp/chip-bob2 "chiphippo://store/add#XXXX"
   ```

4. Bob's window opens with an **Add a Private Store** card that already knows the store, and goes straight to the Join step.

(Clicking a `chiphippo://` link in a browser opens whichever Chip Hippo is *installed*, not the dev copy, so use the command line for this test.)

### 4.1 The web page the link points at

To look at `website/store/` locally:

```bash
node scripts/serve-web.mjs website --port 8799
```

Then open `http://127.0.0.1:8799/store/#XXXX`, using the same `XXXX`. The page:
- shows the store's name and where it lives;
- has an **Open in Chip Hippo** button and **Copy link**;
- has the "what happens next" steps.

A broken fragment shows "This link is not complete".

---

## Part 5 — Other things worth a look

- **Languages:** Settings ▸ Appearance ▸ Language. All seven languages have the new strings, and the guide redraws in the new language the next time it opens.
- **Light theme:** Settings ▸ Appearance ▸ Theme ▸ Light. Check the guide, the store list and the Browse tab.
- **The web build** (`make web-serve`): there should be no Private stores section, no store tabs in Browse Projects, and Share To… opens straight on the gallery's card, with no Public | Private tabs.
- **Project file:** save Ann's project (⌘S) after opening or saving a store design. Each desktop that came from a store carries a small `storeFrom` entry in the `.chiphippo` file. Close and reopen the project, then **Share To… ▸ Private** still offers "A new version of …". **Duplicate Desktop** makes a copy that does *not* (it is a new design).

## Resetting

- Bob's data: `rm -rf /tmp/chip-bob /tmp/chip-bob2`.
- Ann's stores: Remove them in Settings, or delete the `stores` entry from `data/settings.json` with the app closed.
- The fake cloud: `rm -rf ~/Desktop/FakeDropbox`.
