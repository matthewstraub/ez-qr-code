# Redirect resolver

A Cloudflare Worker that follows a URL's redirect chain and reports each hop,
so the Verify page can show where a shortened link actually ends up.

## Why it exists

A browser page cannot do this. Cross-origin redirect targets are hidden on
purpose — a `no-cors` fetch returns an opaque response with status 0, an empty
URL and no headers, and `redirect: "manual"` throws — because being able to
read them would reveal which sites you are signed in to. Following a chain
therefore has to happen outside the browser tab.

Cloudflare was chosen over a Render web service for one reason: free Render web
services spin down when idle, so the first scan after a quiet spell would stall
for 30–60 seconds. Workers have no cold start, which matters when the point is
to get an answer while standing in a shop.

## Deploying without installing anything

There is no build step and no dependencies, so the dashboard route works and
needs no Node on your machine:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**
2. Name it `ez-qr-resolve`, deploy the placeholder, then **Edit code**
3. Replace the contents with [`resolve.js`](resolve.js) and **Deploy**
4. Copy the worker URL (`https://ez-qr-resolve.<your-subdomain>.workers.dev`)
5. Paste it into `RESOLVER_ENDPOINT` at the top of
   [`../public/verify/verify.js`](../public/verify/verify.js)

With Node available, `npx wrangler deploy` from this directory does the same
thing using [`wrangler.toml`](wrangler.toml).

Leaving `RESOLVER_ENDPOINT` empty is a supported state: the page simply does
not offer to resolve anything, and still contacts nothing.

## What it will not do

It is a public endpoint, so it is deliberately narrow:

- **Only its own front end may call it.** `ALLOWED_ORIGINS` lists the site and
  localhost. Edit that list if the site moves.
- **Only `http` and `https`.** No `file:`, `gopher:`, or anything else.
- **No private addresses.** Loopback, RFC 1918, carrier-grade NAT, link-local
  (which covers the `169.254.169.254` cloud metadata address), unique-local and
  link-local IPv6, and `.local` / `.internal` / `.home.arpa` names are all
  refused — both for the address you pass in and for every address it is
  redirected to. Without that check, a public "fetch this for me" endpoint is
  a way to probe networks it happens to sit inside.
- **No response bodies.** Each body is cancelled as soon as the headers arrive.
  Only statuses and addresses come back, so it cannot be used as a general
  proxy for page content.
- **Bounded work.** At most 10 hops, 5 seconds per hop and 8 seconds overall.

It issues `GET` rather than `HEAD`, because a number of sites answer `HEAD`
with `405` and truncate the chain — Amazon does exactly this, which is how the
bug was found.
