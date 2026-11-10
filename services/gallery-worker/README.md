# The gallery's submission service

A Cloudflare Worker with two endpoints. Chip Hippo's Desktop ▸ Share to
Gallery… (`src/app/gallery/share.js`) sends **`POST /v1/share`** a design and
its four fields; the Worker checks them, opens a pull request in the private
**jfigge/chiphippo-gallery-submission** repo, and answers with the pull
request's number and a **status key** (an HMAC of the share under
`RATE_SALT`). Settings ▸ Gallery ▸ Your shares sends **`POST /v1/status`**
`{id, number, key}` to learn what became of it: waiting, accepted (merged) or
declined (closed), plus the **reviewer's note** — the latest comment the repo's
owner left on the pull request, so write anything you want the sharer to read
there. Status answers are cached for five minutes. Both answer CORS for
`https://chiphippo.com`, so the web build can share too. Merging that PR publishes the
design, via that repo's Publish workflow, to the public **chiphippo-gallery**,
and from there to the site.

- `src/handler.js`: every rule, in order (size, shape, the fields, the word
  list, the rate limits, the review queue, the id). The limits: 3 shares a
  minute and 5 an hour from one address (an IPv6 one by its /64), 10 a minute
  for the whole service, and every attempt that reaches GitHub counts. It is pure, so
  `tests/handler.test.js` runs it under `make test`.
- `src/github.js`: the GitHub calls (one commit on a `share/<id>` branch, then
  the PR).
- `src/wording.js`: the short word list.
- `src/worker.js`: Cloudflare's entry point, which hands the bindings to the
  handler.

The full check of whether a design loads is NOT done here. It needs the catalog
and the migrations, so it runs in the submission repo's CI against the released
app (`scripts/check-submission.mjs`), and Jason sees its verdict on the PR. The
app runs the same check before it lets a share go.

## Setting it up

1. **A Cloudflare account** (the free plan is enough).
2. **Choose the address.** It is hard-coded in every app build
   (`src/app/gallery/sources.js` `SHARE_URL`), so settle it before a release
   ships with Share switched on.
   - **`share.chiphippo.com`** (the default here) needs chiphippo.com's DNS on
     Cloudflare:
     1. In the dashboard, choose Add a domain and enter chiphippo.com, on the
        Free plan.
     2. Check that the imported records include GitHub Pages' four `A` records
        (`185.199.108–111.153`), the `www` CNAME and any mail records.
     3. Set the GitHub Pages records to **DNS only** (grey cloud), so Pages keeps
        serving its own certificate.
     4. At whois.com, change the nameservers to the two Cloudflare names.
   - **Or skip the DNS move:** delete the `routes` line in `wrangler.toml`, and
     after the first deploy set `SHARE_URL` to the `*.workers.dev` address it
     prints.
3. **Log in:** `cd services/gallery-worker && npx wrangler login`.
4. **The rate limit's store:** run `npx wrangler kv namespace create RATE`, and
   put the id it prints in `wrangler.toml`. The two rate-limiting bindings
   (`SHARE_BURST`, `SHARE_ALL`) need nothing created — `wrangler deploy`
   (4.36 or later) makes them from `wrangler.toml`. Their `namespace_id`s
   only have to be integers no other binding on the account uses.
5. **The GitHub token:** GitHub ▸ Settings ▸ Developer settings ▸ Fine-grained
   tokens ▸ Generate.
   - Repository access: **Only select repositories →
     chiphippo-gallery-submission**.
   - Permissions: **Contents: Read and write**, **Pull requests: Read and
     write**. (If status checks answer "unavailable" for shares that exist,
     add **Issues: Read** too — the reviewer's note is read through the
     issue-comments endpoint.)
   - Then run `npx wrangler secret put GITHUB_TOKEN` and paste the token.
6. **The salt** for hashing addresses:
   `openssl rand -hex 32 | npx wrangler secret put RATE_SALT`.
7. **Deploy:** `npx wrangler deploy`.
8. **Try it:** `curl -s -X POST https://share.chiphippo.com/v1/share -d '{}'`
   should answer `{"ok":false,"code":"invalid"}`. A missing secret, KV
   namespace or rate-limiting binding answers `"unavailable"` instead. `curl -s -X POST
   https://share.chiphippo.com/v1/status -d '{}'` answers `invalid` too.

After a change to `src/`, deploy again with `make deploy-worker` (from the repo
root; it runs `npx wrangler deploy` here). `make release` runs it too, last,
after the release is pushed — the Worker bundles the repo's `entry-format.js`,
so it goes out with each release. A failed deploy there is a warning, not a
failed release.

**Limits fail closed.** KV's free plan allows 1,000 writes a day and every
counted attempt is one; when they are spent (or a limiter or KV is down) a
share answers a coded `503 dailyLimit` — the app's "today's limit has been
reached, try again tomorrow" (an older app reads it as `busy`) — never an
uncoded 500. Anything else that throws answers `503 unavailable`, CORS
headers and all.

The submission repo needs a `main` branch before the first share, because each
share branches off it.

## Limits

The free plan's 10 ms of CPU a request covers a typical design. A design near
the 512 KiB cap may not fit, and Cloudflare then answers with error 1102 (the
app says "couldn't be reached"). The Workers Paid plan raises the limit.

## Trying it locally

`npx wrangler dev` serves it on `http://127.0.0.1:8787`. A dev launch of the
app sends there with
`CHIPHIPPO_SHARE_URL=http://127.0.0.1:8787/v1/share make debug`
(a loopback address only, and only in a dev launch). With a real
`GITHUB_TOKEN` in `.dev.vars`, that opens real PRs.
