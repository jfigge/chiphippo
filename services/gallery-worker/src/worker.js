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
// which holds every rule.

import { handleRequest, refuse } from "./handler.js";
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
    });
  },
};
