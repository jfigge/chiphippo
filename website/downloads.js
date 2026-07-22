/* Chip Hippo website — dynamic downloads + version history.
 *
 * Data comes from ./versions.json, generated at deploy time from the GitHub
 * Releases API (see scripts/build-versions.mjs). Progressive enhancement: if the
 * fetch fails or the file is absent, the static "Latest release on GitHub"
 * fallback links already in index.html are left in place. */
(function () {
  "use strict";

  var RELEASES_URL = "https://github.com/jfigge/chiphippo/releases";

  var DL_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

  function mb(bytes) {
    return bytes || bytes === 0 ? (bytes / 1048576).toFixed(1) + " MB" : "";
  }

  // versions.json is generated in trusted CI, but never navigate to a URL it
  // didn't expect: constrain every download/link href to a GitHub-owned https
  // host, falling back to the releases page if anything looks off (a tampered
  // manifest, a javascript: URL, an unexpected host).
  function safeUrl(u) {
    try {
      var p = new URL(u, location.href);
      if (p.protocol !== "https:") return RELEASES_URL;
      var h = p.hostname.toLowerCase();
      var ok =
        h === "github.com" ||
        h === "objects.githubusercontent.com" ||
        h.endsWith(".github.com") ||
        h.endsWith(".githubusercontent.com");
      return ok ? p.href : RELEASES_URL;
    } catch (e) {
      return RELEASES_URL;
    }
  }

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function setText(id, text) {
    var n = document.getElementById(id);
    if (n) n.textContent = text;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (e) {
      return "";
    }
  }

  function sep(text) {
    var d = el('<div class="dl-sep"></div>');
    d.textContent = text;
    return d;
  }

  function row(asset) {
    var a = el(
      '<a class="dl-row"><span class="dl-icon">' +
        DL_ICON +
        '</span><div class="dl-info"><div class="dl-label"></div><div class="dl-meta"></div></div><span class="dl-arch"></span></a>'
    );
    a.href = safeUrl(asset.url);
    a.querySelector(".dl-label").textContent = asset.label;
    a.querySelector(".dl-meta").textContent = asset.name + (asset.size ? " · " + mb(asset.size) : "");
    a.querySelector(".dl-arch").textContent = asset.arch;
    return a;
  }

  // Order within an OS/arch group: recommended installer first, archives last.
  var KIND_RANK = { dmg: 0, setup: 0, appimage: 0, deb: 1, portable: 2, zip: 3 };
  function byPreferred(a, b) {
    var ra = KIND_RANK[a.kind] != null ? KIND_RANK[a.kind] : 5;
    var rb = KIND_RANK[b.kind] != null ? KIND_RANK[b.kind] : 5;
    return ra - rb;
  }

  function renderMac(list, assets) {
    var groups = [
      { arch: "arm64", label: "Apple Silicon (M1 / M2 / M3)" },
      { arch: "x64", label: "Intel" },
    ];
    var any = false;
    groups.forEach(function (g) {
      var items = assets.filter(function (a) { return a.arch === g.arch; }).sort(byPreferred);
      if (!items.length) return;
      any = true;
      list.appendChild(sep(g.label));
      items.forEach(function (a) { list.appendChild(row(a)); });
    });
    return any;
  }

  function renderWin(list, assets) {
    var groups = [
      { arch: "x64", label: "Intel / AMD (64-bit)" },
      { arch: "arm64", label: "ARM (arm64)" },
    ];
    var any = false;
    groups.forEach(function (g) {
      var items = assets.filter(function (a) { return a.arch === g.arch; }).sort(byPreferred);
      if (!items.length) return;
      any = true;
      list.appendChild(sep(g.label));
      items.forEach(function (a) { list.appendChild(row(a)); });
    });
    return any;
  }

  function renderFlat(label) {
    return function (list, assets) {
      if (!assets.length) return false;
      list.appendChild(sep(label));
      assets.sort(byPreferred).forEach(function (a) { list.appendChild(row(a)); });
      return true;
    };
  }

  function fillCard(id, latestAssets, render) {
    var list = document.getElementById(id);
    if (!list) return;
    var os = list.getAttribute("data-os");
    var assets = latestAssets.filter(function (a) { return a.platform === os; });
    if (!assets.length) return; // no asset for this OS in the latest release — keep the fallback
    list.textContent = "";
    render(list, assets);
  }

  function renderHistory(releases) {
    var wrap = document.getElementById("version-history");
    var listEl = document.getElementById("version-history-list");
    if (!wrap || !listEl || releases.length < 2) return; // nothing to show beyond "latest"
    releases.forEach(function (r) {
      var a = el(
        '<a class="vh-row"><span class="vh-ver"></span><span class="vh-date"></span><span class="vh-link">View release →</span></a>'
      );
      a.href = safeUrl(r.url);
      a.querySelector(".vh-ver").textContent = "v" + r.version + (r.prerelease ? " · pre-release" : "");
      a.querySelector(".vh-date").textContent = fmtDate(r.publishedAt);
      listEl.appendChild(a);
    });
    wrap.hidden = false;
  }

  function injectStyles() {
    var css =
      ".version-history{margin-top:52px}" +
      ".vh-head{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--accent);margin-bottom:14px}" +
      ".vh-list{display:flex;flex-direction:column;gap:6px;max-width:600px}" +
      ".vh-row{display:flex;align-items:center;gap:14px;padding:11px 14px;background:var(--mantle);border:1px solid var(--surface-0);border-radius:10px;text-decoration:none;color:var(--text);transition:border-color .15s,background .15s,transform .15s}" +
      ".vh-row:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--mantle));transform:translateX(3px)}" +
      ".vh-ver{font-weight:700;font-family:monospace;font-size:.85rem;min-width:130px}" +
      ".vh-date{flex:1;color:var(--overlay-0);font-size:.8rem}" +
      ".vh-link{color:var(--accent);font-size:.8rem;font-weight:600}";
    var s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  // index.html renders the "still in active development" pre-release banner
  // statically, so it survives even if this script never runs (fail-safe: an
  // unfinished app keeps warning). Drop it once the app leaves pre-release —
  // i.e. the latest stable release reaches 1.0.0. Keyed on the major version,
  // not GitHub's prerelease flag: the 0.x releases may be flagged
  // non-prerelease, yet the app as a whole is still pre-1.0.
  function updatePrereleaseBanner(latest) {
    var banner = document.querySelector(".prerelease-banner");
    if (!banner) return;
    var major = parseInt(String(latest.version).split(".")[0], 10);
    // display:none (beats the banner's display:flex) also drops it from the a11y
    // tree, so its role="alert" no longer fires.
    if (!latest.prerelease && major >= 1) banner.style.display = "none";
  }

  function apply(data) {
    var releases = data.releases || [];
    var latest = releases.find(function (r) { return r.version === data.latest; }) || releases[0];
    if (!latest) return;
    var assets = latest.assets || [];
    setText("hero-version", "v" + latest.version);
    setText("dl-version", latest.version);
    setText("footer-version", "v" + latest.version);
    fillCard("dl-list-mac", assets, renderMac);
    fillCard("dl-list-win", assets, renderWin);
    fillCard("dl-list-linux", assets, renderFlat("64-bit"));
    renderHistory(releases);
    updatePrereleaseBanner(latest);
  }

  // versions.json sits behind a CDN (GitHub Pages / Fastly); a single transient
  // network blip would otherwise strand the whole page load on the static
  // fallback. Retry a few times with a short backoff, and let the final attempt
  // accept a cached copy, before giving up to the static "on GitHub" links.
  function load(attempt) {
    fetch("versions.json", { cache: attempt < 3 ? "no-cache" : "force-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("versions.json " + r.status);
        return r.json();
      })
      .then(apply)
      .catch(function () {
        if (attempt < 3) {
          setTimeout(function () {
            load(attempt + 1);
          }, 300 * (attempt + 1));
        }
        /* final attempt failed → keep the static fallback links → */ void RELEASES_URL;
      });
  }

  function init() {
    injectStyles();
    load(0);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
