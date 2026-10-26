/* Chip Hippo website — /app/ → /desktop/, where the web app moved.
 *
 * A plain page can't redirect with the query and fragment intact (the meta
 * refresh in index.html drops them), so this does it, before anything paints.
 * `replace`, so Back doesn't land on the redirect again. */
(function () {
  "use strict";
  location.replace("/desktop/" + location.search + location.hash);
})();
