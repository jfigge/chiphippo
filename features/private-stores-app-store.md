# Private stores and the Mac App Store

This file checks the private stores against the App Review Guidelines and the App
Privacy rules as they stood on 2026-11-22. It ends with drafts of what goes into App Store
Connect.

Sources:
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [App privacy details](https://developer.apple.com/support/app-privacy-on-the-app-store/)

## Before a store build can carry it

1. **The `stores` flag is off** (removed 2026-11-22), so the next store build carries
   the private stores.
2. **The GitHub OAuth App is registered** ("Chip Hippo", `Ov23lixgbUNY4hbDuwEo`, set in
   `GITHUB_CLIENT_ID` 2026-11-22; device flow on, expiring tokens refreshed in main).
   - Should the id ever be emptied, the GitHub choice is now **left out** of the Add Store guide. It used
     to be greyed with "Coming soon".
   - Changed 2026-11-22, because App Review (2.1 / 2.2) rejects placeholder or
     "coming soon" features.
   - A friend's GitHub link opened in such a build says GitHub stores aren't available.
3. **Run a `make mas-dev` click-through** of the stores in the sandbox:
   - make a store in an iCloud Drive or Dropbox folder;
   - quit and relaunch, then check the bookmark still reaches the folder (Browse, Save,
     Show folder);
   - quit Google Drive or Dropbox, relaunch Chip Hippo (the store reads as unreachable),
     then start the sync app again: the store must come back without being added again
     (its bookmark is kept, `withAccess(…, {keep: true})`);
   - join from a `chiphippo://store/add#…` link;
   - GitHub sign-in through the browser.

   None of this has been run in a sandboxed build yet.

## The guidelines, one by one

| Guideline | Applies? | Where the stores stand |
|---|---|---|
| **1.2 User-generated content** | **Risk point** | See below. |
| **2.1 / 2.2 Completeness** | Yes | Fixed: no greyed "coming soon" GitHub choice. A reviewer can test folder stores with no account: pick any folder. GitHub needs a GitHub account, so offer one in the review notes (below). |
| **2.5.2 Downloading code** | No | A design is data that the app interprets, as for the public gallery. Nothing in a store changes what the app does. |
| **4.8 Login services** | **Exempt** | GitHub sign-in is not a Chip Hippo account; Chip Hippo has none. 4.8 exempts an app that "is a client for a specific third-party service" where users sign in to their own third-party account to reach their content, and that is exactly the GitHub store. Sign in with Apple is not required. |
| **5.1.1(v) Account sign-in** | Met | No account is created in the app; *Make one free* opens github.com's own sign-up. Sign-in is optional, since folder stores need none. **Sign out** removes the token from the device, which is the in-app way to "revoke … credentials and disable data access", and the guide names GitHub's page to revoke it there too. The token never leaves the device except to GitHub. |
| **5.1.1(i) Privacy policy** | Met | `website/privacy.html` (2026-11-22) has a Private stores section and a store-link section. |
| **5.1.2 Data use / App Privacy** | No change | See "App Privacy answers" below. |
| **Sandbox** | Met | The entitlements are already in `packaging/entitlements.mas.plist`: `network.client`, `files.user-selected.read-write` and `files.bookmarks.app-scope`. An iCloud Drive folder is reached as a user-picked folder, so no iCloud/CloudKit entitlement is needed. |
| **Export compliance** | No change | GitHub is reached over HTTPS only. `ITSAppUsesNonExemptEncryption` stays `false`. |
| **Age rating** | No change | "User-generated content: yes" was already answered for the gallery. |

### 1.2 — the one to watch

1.2 covers "apps that enable users to create, generate, upload, share, or otherwise
contribute content". It asks for four things: a filter, reporting, blocking and published
contact details. Its stated targets are "social media, user-generated content platforms,
and AI content creation apps".

**Why the stores should not count as a UGC platform:**
- They are file storage in the user's OWN accounts: a synced folder, or their own private
  GitHub repository.
- No content passes through, or is held on, any service the developer runs. The developer
  cannot see the content, so cannot filter or remove it.
- There is no public or anonymous audience. Only people the owner explicitly shares the
  folder with, or invites on GitHub, can see anything.
- This is the same position as a document editor that opens files from Dropbox or a
  shared iCloud folder.

**What already stands in for 1.2's tools:**
- **Blocking**: the owner chooses who has access and takes it away in the service. The
  app opens GitHub's access page (*Manage who has access on GitHub*). Anyone can stop
  seeing a store with *Remove*.
- **Contact information**: published on the privacy page and in the app.

**If App Review still asks under 1.2**, the smallest addition that answers it would be,
per store:
- a **Hide designs by this person** filter (by the author name on each version); and
- a **Report** that opens the platform's own abuse report (GitHub's "Report abuse"), or an
  email to the store's owner.

Neither is built; ask if you want them before submitting.

## App Privacy answers

**No change to the answers already given for the gallery** (User Content + Name, optional,
App Functionality, not linked, no tracking).

Apple's definition: "'Collect' refers to transmitting data off the device in a way that
allows you and/or your third-party partners to access it…". "Third-party partners" means
"analytics tools, advertising networks, third-party SDKs, or other external vendors whose
code you've added to your app".

A private store sends nothing to the developer, and GitHub or Dropbox is not a vendor
whose code is in the app. It is a service the user signs in to directly, for their own
content.

## Draft: App Review notes (add to the existing paragraph)

> Private stores (Settings ▸ Gallery ▸ Private ▸ Add Store…) let a user keep designs in a
> folder they already sync (iCloud Drive, Dropbox, Google Drive, OneDrive) or in a private
> repository on their own GitHub account, and share that folder or repository with
> people they choose. No content goes to, or is stored on, any server of ours; access is
> controlled entirely by the user's own folder sharing or GitHub invitations, and the
> app offers no public or anonymous audience. To try it without any account: Add Store… ▸
> A folder you sync ▸ Another synced folder ▸ Choose Where… (any folder, e.g. Documents),
> then Desktop ▸ Share To… ▸ Private ▸ Save, and File ▸ Browse Projects… shows the store's
> tab. GitHub sign-in uses GitHub's device flow in the browser; it is optional, is not an
> account with us, and can be removed in the app with Sign out. [Optional: GitHub test
> account: …]

## Still to do on your side

- Sign in to GitHub through the app once, for real (it has run only against a stand-in).
- Optionally, make a throwaway GitHub account for App Review.
- Run the `make mas-dev` click-through above before submitting.
