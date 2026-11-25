// store.js — the share link's page (website/store/index.html; the private
// stores work). Reads the store from the address's FRAGMENT — never sent to
// the server — to say which store it is, and offers the same link in the
// app's own scheme. Only the display is decoded here; Chip Hippo reads and
// checks the link itself (stores/store-format.js `parseStoreLink`).

const $ = (id) => document.getElementById(id);
const payload = location.hash.replace(/^#/, "");

/** The store's name and where it lives, or null when the link is broken. */
function readStore(text) {
  if (!/^[A-Za-z0-9_-]{8,1000}$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const json = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bin, (c) => c.charCodeAt(0)),
    );
    const ref = JSON.parse(json);
    if (ref?.v !== 1 || typeof ref.id !== "string") return null;
    return ref;
  } catch {
    return null;
  }
}

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
  $("store-name").textContent = String(ref.name ?? "A private store").slice(
    0,
    60,
  );
  $("store-where").textContent =
    ref.kind === "github"
      ? `A private GitHub repository (${String(ref.where?.repo ?? "").slice(0, 140)})`
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
}
