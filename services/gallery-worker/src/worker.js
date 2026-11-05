/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// worker.js — the gallery's submission service, as Cloudflare runs it
// (services/gallery-worker/README.md): its bindings handed to the handler,
// which holds every rule. Status answers are reused through Cloudflare's own
// cache (free, and no KV write per question).

import { STATUS_CACHE_S, handleRequest, refuse } from "./handler.js";
import { makeGitHub } from "./github.js";

export default {
  async fetch(request, env) {
    // Not set up yet (a secret or the KV namespace missing): say so, never
    // half-run a share.
    if (
      !env.GITHUB_TOKEN ||
      !env.RATE_SALT ||
      !env.RATE ||
      !env.SUBMISSION_REPO
    ) {
      return refuse(503, "unavailable");
    }
    return handleRequest(request, {
      github: makeGitHub({
        token: env.GITHUB_TOKEN,
        repo: env.SUBMISSION_REPO,
      }),
      rate: env.RATE,
      salt: env.RATE_SALT,
      owner: env.SUBMISSION_REPO.split("/")[0],
      cache: edgeCache(new URL(request.url).origin),
    });
  },
};

/**
 * Cloudflare's cache, holding one JSON answer per key for STATUS_CACHE_S. Its
 * keys are URLs on the service's own host (the cache belongs to the zone),
 * under a path no request is ever routed to.
 */
function edgeCache(origin) {
  const url = (key) => `${origin}/__status-cache/${encodeURIComponent(key)}`;
  return {
    async get(key) {
      const hit = await caches.default.match(url(key));
      return hit ? hit.json() : null;
    },
    async put(key, value) {
      await caches.default.put(
        url(key),
        new Response(JSON.stringify(value), {
          headers: { "cache-control": `max-age=${STATUS_CACHE_S}` },
        }),
      );
    },
  };
}
