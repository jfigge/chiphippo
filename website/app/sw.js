/* Chip Hippo website — retires the web app's service worker at /app/.
 *
 * The web app was first published at /app/ and moved to /desktop/. A visitor
 * from then still has its worker here, answering /app/ from its cache with the
 * old app, so the redirect beside this file would never be reached. The
 * browser's update check on their next visit fetches this file instead: it
 * takes over at once and unregisters itself, and the visit after that goes to
 * the network and is redirected.
 *
 * It leaves open tabs alone (a reload could cost an edit in progress), and
 * leaves the caches alone: their `chiphippo-*` names are shared across the
 * site, and /desktop's own worker clears the stale ones when it activates. */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.unregister());
});
