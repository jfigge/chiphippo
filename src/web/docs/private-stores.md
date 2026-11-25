# Private Stores

A **private store** is a place to keep designs that only you and the friends
you choose can see. You can all open them, change them and save new versions,
so a store is a way to work on circuits together. It is not like the public
[gallery](gallery.md): nothing is reviewed or published.

A store lives on a service you already use. Chip Hippo runs no server for it,
and none of your designs ever comes to us. That service's own sharing decides
who can get in, and there are two kinds:

- **A folder you sync** — a folder that Google Drive, Dropbox, OneDrive,
  iCloud Drive, or any other service keeps in step across computers. You
  share the folder with your friends the way you share any folder there.
  There's no sign-in, and Chip Hippo reads and writes the folder like any
  other folder on your disk.
- **A private GitHub repository** — a free private repository on your GitHub
  account. Chip Hippo can make one for you, or use a folder in a private
  repository you already have. Friends get in by being invited by their
  GitHub username.

You can add as many stores as you like, such as one for a club, one for a
class and one shared with a single friend.

Private stores are in the desktop app only. Chip Hippo in the browser doesn't
have them.

## Adding a store

Open **Settings ▸ Gallery**, choose the **Private** tab and press
**Add Store…**. Chip Hippo asks where the designs should live, and walks you
through the rest one short step at a time:

- **A folder you sync** makes a new store in a folder.
- **GitHub** makes a new store on GitHub.
- **I have a link from a friend** joins a store someone has shared with you
  (see [Joining a friend's store](#joining-a-friends-store)).
- **A store folder already on this computer** adds back a store you removed
  from the list, or one that synced here from another of your computers. It
  needs no link.

### A folder you sync

1. Choose **which service** keeps the folder in step: Google Drive, Dropbox,
   OneDrive, iCloud Drive, or **Another synced folder** (Syncthing, a shared
   network drive, …). If that service's app isn't on this computer yet, the
   step says how to get it and links to its download page.
2. Give the store a **name**, such as `Bench club`.
3. Press **Choose Where…** and pick the folder your service keeps in step,
   such as "My Drive" for Google Drive, your Dropbox folder, or iCloud Drive.
   A folder inside it works too.

Chip Hippo makes a new folder there, named after the store, and says where it
is. To let your friends in:

1. **Share that new folder with them** in your service, and let them edit it.
   The step says how for the service you chose (for example, in Google Drive,
   right-click the folder ▸ Share and give them Editor access).
2. **Send them the store's link**, shown on the same step with a button to
   copy it. When they open it, Chip Hippo walks them through adding the store.

### GitHub

1. **Sign in to GitHub.** Press **Sign In to GitHub**, and Chip Hippo shows a
   short code. Press **Copy Code and Open GitHub**, paste the code on GitHub's
   page, and approve Chip Hippo, then come back. You never type your GitHub
   password into Chip Hippo. If you don't have an account, **Make one free**
   opens GitHub's sign-up page.
2. **Choose where the store goes:**
   - **A new private repository** — Chip Hippo makes one on your account,
     named after the store.
   - **A folder in one of my repositories** — pick one of your repositories
     and type a folder name (`chiphippo` to start with). The store's files
     go in that folder, apart from everything else the repository holds. If
     the folder already holds a Chip Hippo store, that store is added rather
     than made again. Only **private** repositories you can write to are
     listed, because a store in a public one would publish every design.
3. Give the store a **name** and press **Make the Store**.

Then **invite your friends** by their GitHub username, and send them the
store's link. Invited people show as *invited — waiting for them* until they
join.

To reach your private repositories, Chip Hippo asks GitHub for access to them
when you sign in. That is the only kind of access GitHub offers that can
reach a private repository. Chip Hippo reads and writes designs only in the
store's own repository or folder. Besides that, it asks GitHub only for your
username, your pending invitations (to accept the one for a store you join),
and, when you pick "A folder in one of my repositories", the names of your
private repositories.

## Sharing a store

A store's link is all a friend needs from Chip Hippo. It names the store and
says where it lives, but it carries no password and nothing private. Someone
who has the link but hasn't been given access sees nothing of the designs.

- In **Settings ▸ Gallery ▸ Private**, press **Copy link** on the store. The
  link is copied, and Chip Hippo shows what else your friend needs: the folder
  shared with them, or a GitHub invitation.
- For a GitHub store, **Invite** adds a friend by their GitHub username, and
  **Manage who has access on GitHub** opens the repository's access page,
  where you can also take someone's access away.
- For a folder store, you choose who has access in your service, and you take
  it away there too.

The link looks like `https://chiphippo.com/store/#…`. Opened in a browser,
that page offers to open the store in Chip Hippo, or to download Chip Hippo
first.

## Joining a friend's store

Open the link your friend sent you. Chip Hippo opens and goes straight to the
store's steps. You can also paste the link yourself in **Settings ▸ Gallery
▸ Private ▸ Add Store… ▸ I have a link from a friend**.

**A folder store** takes three steps, worded for your friend's service:

1. **Accept the share**, for example by opening the email from Google Drive or
   Dropbox.
2. **Get the folder onto this computer.** In Google Drive, add a shortcut to it
   in My Drive, and make sure Google Drive for desktop is installed. In
   OneDrive, choose "Add shortcut to My files". In Dropbox, check it has synced.
3. Press **Choose the Folder…** and pick it. Picking the folder just above it
   works too. Chip Hippo checks that it's the store the link names.

**A GitHub store**: sign in with the GitHub account your friend invited and
press **Join the Store**. Chip Hippo accepts the invitation for you, so you
never need to find it on GitHub. If your friend hasn't invited that account
yet, Chip Hippo says which account you're signed in as, so you can tell them.
Press **Join the Store** again once they have invited you.

## Saving a design to a store

Choose **Desktop ▸ Share To…**, or right-click a desktop's tab and choose it
there, then set the switch at the card's top to **Private**, which turns on
the **Store** picker beside it (**Public** is the
[gallery](gallery.md#sharing-a-design); the fields are the same, so flipping
it keeps what you typed). A desktop you opened from a store opens
on **Private** by itself. Stop the circuit first, because saving is
greyed out while it runs. The card asks:

- **Store** — which of your stores to save to.
- **Save as** — this appears only for a desktop you opened from a store:
  - **A new version of "…"** (the default) adds this desktop as the design's
    next version, with an optional note on **What changed?**. The design's
    own title, description and tags are shown greyed, since a version keeps
    them.
  - **A new design** saves it as a separate design.
- **Title**, and optionally a **Description** and **Tags**, the same as for
  the gallery.
- **Your name** — shown with the version, so your friends know who saved it.
  Chip Hippo remembers it for next time.

Press **Save**. The design and the custom chips it uses are written into the
store, and from then on the desktop remembers where it came from. A picture of
the board goes with it when you save the desktop that's on screen. A desktop
saved from its tab's menu while another one is showing is saved without a
picture. If the store can't be read just then (you're offline, or it
hasn't finished syncing), the card says it will save a new design instead of
a version.

Nothing in a store is ever changed or deleted. Every save adds a new version
beside the ones already there, so an older version is always still there to go
back to.

### When someone saved first

If a friend saved a newer version after the one you opened, Chip Hippo says
who and when, and gives you two choices:

- **Open Theirs** opens their version, so you can carry on from it.
- **Save Mine Alongside** keeps your version as well. Both are kept, and the
  store shows that the design has two latest versions.

Chip Hippo never saves over someone else's work, and never makes a second
version without asking.

## Browsing a store

Each store has its own tab in **File ▸ Browse Projects…** (`Shift+Cmd/Ctrl+B`),
after Recent Projects and the Gallery, in the order the stores were added. A
row with more tabs than fit scrolls sideways. A store's tab looks like the
gallery's: a card for each design, with its picture, who made it, and a search
box.

- **Open Latest** puts the design's newest version on your desk as a new
  desktop, as the gallery does. Open it again and Chip Hippo switches to the
  desktop it is already on.
- Choose a card to see its details, which include **every version**: when it
  was saved, who saved it, what changed, and an **Open** button for each. The
  newest is marked *latest*. When two people saved from the same version, the
  details say so, and the other version is marked *another version*.
- **Refresh** reads the store again. Chip Hippo doesn't watch a store on its
  own, so press it to see what your friends have saved since. A folder store
  shows a friend's save only once your service has synced it to this computer.

A store's tab can also be opened from Settings: **Browse** on the store's
line.

## Managing your stores

**Settings ▸ Gallery ▸ Private** lists your stores, each with where it lives
and these buttons:

- **Copy link** — copies the store's link (see [Sharing a store](#sharing-a-store)).
- **Invite** — for a GitHub store, invites a friend by their GitHub username.
- **Browse** — opens the store's tab in Browse Projects.
- **Show folder** or **Open on GitHub** — shows the store's folder in Finder
  or Explorer, or opens its repository on GitHub.
- **Remove** — takes the store off this computer's list, after asking first.
  **Nothing is deleted**: the store and its designs stay where they are, for
  you and everyone it is shared with, and you can add it again from its link.

When you're signed in to GitHub, **Sign out** is shown below the list. It
removes Chip Hippo's GitHub sign-in from this computer. To withdraw Chip Hippo's
access on GitHub's side as well, open GitHub's **Settings ▸ Applications ▸
Authorized OAuth Apps** and revoke it there.

## What a store holds

A store's folder (or repository) holds a `chiphippo-store.json` file that
names the store, and an `entries` folder with one folder per design. Each
design's folder holds every version: its `.desktop.chiphippo` file, its
picture, and a small file saying who saved it and what it was based on.

**Leave the folder's contents alone.** Chip Hippo only ever adds files, so
there's never anything to tidy, and a renamed or moved file is a version
Chip Hippo can no longer find. You can copy a version's `.desktop.chiphippo`
file out of the folder and double-click it to open it like any other desktop.
Files your service adds (such as `.DS_Store` or a "conflicted copy") are
ignored.

## If something goes wrong

Chip Hippo says what happened and, where it can, what to do. The messages you
are most likely to see:

- **This store has not been shared with your GitHub account yet** — ask your
  friend to invite the account the guide names, then press **Join the Store**
  again.
- **That folder holds a different store from the one the link is for** — choose
  the folder your friend shared with you.
- **That folder does not hold this store** — if it was only just shared with
  you, your service may still be syncing it. Wait a minute and try again.
- **That store could not be found** — its folder has moved, or it hasn't
  finished syncing to this computer. Add it again with **A store folder
  already on this computer**.
- **This store's repository is public** — the repository was made public after
  the store was made. Chip Hippo won't join it or save to it, because anything
  saved there could be seen by anyone. Ask its owner to make it private again.
- **That repository is public** — shown when you pick a repository for a new
  store. Choose a private one.
- **Your GitHub account can only read that repository** — choose a repository
  you can write to, or ask its owner for write access.
- **GitHub asked Chip Hippo to slow down** — GitHub limits how often an app may
  ask. Wait a few minutes and try again.
- **Chip Hippo is not allowed to write in that folder** — check you still have
  access to it in your service.
- **This store was made by a newer Chip Hippo** — you can still open its
  designs, but update Chip Hippo before you save to it.

## Privacy

A folder store involves no network connection from Chip Hippo at all: it reads
and writes files on your disk, and your service moves them. A GitHub store
talks only to GitHub, from your computer, using your own GitHub account.
Neither kind sends anything to chiphippo.com or to us. Your GitHub sign-in is
kept on this computer, encrypted by your operating system's keychain, and is
sent only to GitHub. The [privacy statement](https://chiphippo.com/privacy.html)
has the details.
