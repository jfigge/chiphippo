# The Gallery

The gallery is a collection of circuits built in Chip Hippo, at
[chiphippo.com/gallery](https://chiphippo.com/gallery/). You can open any of
them on your own desk to run it, take it apart, or build on it, and you can
share a design of your own for others to find.

## Browsing the gallery

Choose **Help ▸ Browse Gallery…**. The gallery opens in its own window, one
card for each design, showing its picture, who made it, its level (Beginner,
Intermediate or Advanced), which engine it is built for, and how many chips and
parts it has.

Narrow the list with the search box (it matches titles, names and tags) and
the three filters beside it: a tag, a level, and the engine (Logic or
Spice Lite). Choose **Open** on a card to put that design on your desk.

**The first time**, Chip Hippo asks whether it may read the gallery. Browsing
reads the list of designs and their pictures from chiphippo.com, and a design
when you open one; nothing of yours is sent. Choose **Allow** to go on, or
**Not now** to leave it. You can change the answer later in
**Settings ▸ Gallery ▸ Gallery access**.

## Opening a design

A design from the gallery arrives as a **new desktop** in the project you have
open, named after the design, so nothing already on your desk is touched. Open
the same design again and Chip Hippo switches to the desktop it is already on
rather than adding a second copy. It is yours from then on: change it, save it
with the project, or export it.

A design that uses **custom chips** brings them along. They join the open
project only, not your chip library, so browsing never changes the parts tray
for your other projects. If the project already has an older revision of one of
those chips, Chip Hippo asks what to do: **Update** uses the new revision
everywhere the project places that chip, and **Keep Both** adds it as a second
chip.

Before a design lands, Chip Hippo checks that it will open as it was built:

- A design published for an **older** version of Chip Hippo is checked against
  this one. If anything would be lost — a part, a wire, a custom chip that can
  no longer run — the message names it, and you can **Open Anyway** to see what
  remains, or leave it.
- A design built for **Spice Lite** while the logic engine is on offers to
  **Turn On Spice Lite** (Settings ▸ Simulator), so it runs as designed, or to
  **Open Without** it.
- A design saved by a **newer** version of Chip Hippo than yours can't be
  opened; update the app first.

### From the website

Each design on [chiphippo.com/gallery](https://chiphippo.com/gallery/) has
three buttons:

- **Open in browser** opens it in [Chip Hippo in the browser](web.md), with
  nothing to install.
- **Open in desktop app** hands it to Chip Hippo on your computer, if you have
  it installed. It opens as a new desktop, with the same checks as above.
- **Download** saves its `.desktop.chiphippo` file. Double-click the file to
  open it in Chip Hippo, or bring it into a project with **Desktop ▸ Import
  Desktop…**.

## Sharing a design

Any desktop can be shared to the gallery from the desktop app. Choose
**Desktop ▸ Share to Gallery…**, or right-click a desktop's tab and choose
**Share to Gallery…** to share that one. Stop the circuit first; sharing is
greyed out while it runs.

The card asks for four things:

- **Title** — what the design is called in the gallery (up to 80 characters).
- **Your name** — the name shown with it (up to 40 characters). Use whatever
  name you are happy to see published; it need not be your real one. Chip Hippo
  remembers it for next time.
- **Description** — what it does and how to use it (optional, up to 1,000
  characters).
- **Tags** — up to eight words, separated by commas, that help people find it,
  such as `counter, 555`. A tag is letters, digits and hyphens.

Below the fields the card says whether the design is ready: it is checked the
way the gallery will check it, so an empty desktop, or one that would not open
whole from the gallery, can't be sent, and the card says why.

Then it says what sharing means, and **Share Publicly** sends it:

- **What is sent**: this desktop's design — its boards, parts, wiring, notes,
  the contents of any ROM on it, and the custom chips it uses — the four fields,
  and the version of Chip Hippo. Nothing else from your computer.
- **It is reviewed** before it appears, and may be turned down.
- **Once approved it is public**: anyone can open and download it, under the
  name you gave.

When it has gone, Chip Hippo says **Sent for review**. Your design appears in the
gallery once it is approved.

Each share is a new design in the gallery. To publish a changed version, share
it again under a new title.

### If a share is refused

- **This design is already waiting for review** — the same design under the
  same title is in the queue already; there is nothing more to do.
- **Too many shares from this connection** — one connection can share five
  designs an hour. Try again later.
- **The gallery has too many designs waiting for review** — the review queue is
  full. Try again later.
- **The gallery refused some of the wording** — change the title, name,
  description or tags.
- **This design is larger than the gallery allows** — a shared design can be up
  to 512 KB; large ROM images are the usual cause.
- **The gallery couldn't be reached** — check the connection and try again.

Sharing isn't available in Chip Hippo in the browser; use the desktop app.

## Settings ▸ Gallery

- **Gallery access** — whether Chip Hippo may read the gallery (Yes or No). It
  is asked the first time you browse, so you seldom need to set it here. Chip
  Hippo in the browser is already on the gallery's website, so it has no such
  setting.
- **Share consent** — what Share to Gallery shows before it sends:
  - **Ask** (the default) shows the full notice above every time.
  - **Yes** shows it in one line.
  - **No** switches sharing off; Share to Gallery then points you here.

## Privacy

Browsing sends nothing of yours. Sharing sends only what the card lists, to the
gallery's own service, which sees your IP address as any website does and keeps
only a scrambled form of it, for an hour, to limit how often one address can
share. The [privacy statement](https://chiphippo.com/privacy.html) has the
details, including how to have a shared design taken down.
