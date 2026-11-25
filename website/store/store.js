// store.js — the share link's page (website/store/index.html; the private
// stores work). Reads the store from the address's FRAGMENT — never sent to
// the server — to say which store it is, and offers the same link in the
// app's own scheme. Only the display is decoded here; Chip Hippo reads and
// checks the link itself (stores/store-format.js `parseStoreLink`).

const $ = (id) => document.getElementById(id);
const payload = location.hash.replace(/^#/, "");

/** The store's name and where it lives, or null when the link is broken. */
function readStore(text) {
  // The app reads a whole link of at most 1024 characters, its 29-character
  // page address included.
  if (!/^[A-Za-z0-9_-]{8,995}$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const json = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bin, (c) => c.charCodeAt(0)),
    );
    const ref = JSON.parse(json);
    // The app's own rules (store-format.js `normalizeStoreRef`), so a link
    // Chip Hippo would refuse is not shown as found.
    if (ref?.v !== 1 || !/^s-[0-9a-f]{16}$/.test(ref.id ?? "")) return null;
    if (ref.kind === "github") {
      const repo = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/; // prettier-ignore
      if (!repo.test(ref.where?.repo ?? "")) return null;
      // A folder in the repository, read exactly as the app's `githubDir`
      // reads it (trimmed, its outer slashes dropped), so the page and the
      // app never disagree about a link.
      const raw = ref.where?.dir;
      const dir = raw == null ? "" : String(raw).trim().replace(/^\/+|\/+$/g, ""); // prettier-ignore
      const part = "(?!\\.\\.?(?:/|$))[A-Za-z0-9._-]{1,64}";
      if (dir && !(dir.length <= 120 && new RegExp(`^${part}(?:/${part}){0,3}$`).test(dir))) return null; // prettier-ignore
      return { ...ref, where: { ...ref.where, dir } };
    }
    return ref.kind === "folder" ? ref : null;
  } catch {
    return null;
  }
}

/** store-format.js's CONTROL_RE: control characters and the bidi controls. */
const CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const PROVIDERS = {
  gdrive: "a shared Google Drive folder",
  dropbox: "a shared Dropbox folder",
  onedrive: "a shared OneDrive folder",
  icloud: "a shared iCloud Drive folder",
  other: "a shared folder",
};

const ref = readStore(payload);
$("store-link").value = location.href;
if (ref) {
  // A name that is no text is no name (the app shows the store's id then);
  // held to one line as the app holds it — no control or bidi characters.
  const clean = typeof ref.name === "string" ? ref.name.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim() : ""; // prettier-ignore
  const name = clean || "A private store";
  // Cut as the app cuts (60 UTF-16 units, never through a pair).
  const cut = name.slice(0, 60);
  $("store-name").textContent = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut; // prettier-ignore
  const where = ref.where?.dir ? `${ref.where.repo}/${ref.where.dir}` : ref.where?.repo; // prettier-ignore
  $("store-where").textContent =
    ref.kind === "github"
      ? `A private GitHub repository (${where})`
      : (PROVIDERS[ref.where?.provider] ?? PROVIDERS.other);
  $("store-open").href = `chiphippo://store/add#${payload}`;
  $("store-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("store-copy").textContent = "Copied";
    } catch {
      $("store-link").select();
    }
  });
  $("store-found").hidden = false;
} else {
  $("store-bad").hidden = false;
  // No Open in Chip Hippo button on a broken link: the step naming it goes.
  for (const li of document.querySelectorAll(".store-step-open")) li.hidden = true; // prettier-ignore
}
