/*
 * resolve.js — a Cloudflare Worker that follows a URL's redirect chain and
 * reports every hop.
 *
 * The Verify page cannot do this itself. Browsers deliberately hide
 * cross-origin redirect targets: a `no-cors` fetch comes back opaque, with
 * status 0, an empty url and no headers, and asking for `redirect: "manual"`
 * throws outright. Letting a page read them would reveal where you are signed
 * in. So the only way to show a chain is to ask something that isn't a browser
 * tab, which is all this is.
 *
 * Request:  GET /?url=https%3A%2F%2Fqrco.de%2Fbh5Bqe
 * Response: { "ok": true, "hops": [ { "status": 302, "url": "..." }, ... ],
 *             "final": "https://...", "truncated": false }
 *
 * It returns statuses and addresses only. No response body is ever read or
 * passed back, so this cannot be used to launder page content.
 */

const MAX_HOPS = 10;
const TOTAL_TIMEOUT_MS = 8000;
const PER_HOP_TIMEOUT_MS = 5000;

// Only these origins may call it. A worker that fetches arbitrary URLs for
// anyone is an open relay, and this keeps it pointed at its own front end.
//
// Note what this does and does not buy: browsers always attach Origin to a
// cross-origin fetch, so it stops other sites using this from a page. It does
// nothing against curl, which simply sends no Origin at all. The guards below
// (no private addresses, no bodies, bounded hops) are what limit the damage in
// that case; add a Cloudflare rate-limit rule if it ever gets abused.
const ALLOWED_ORIGINS = [
  "https://ez-qr-code.onrender.com",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
];

// A plain curl user agent gets a 503 from some sites; this behaves more like
// the phone the reader is holding, and some shorteners vary their destination
// by user agent, which is exactly what we want to observe.
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

/** Addresses that must never be fetched on a caller's behalf. */
function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }

  // IPv4 literals in private, loopback, link-local or reserved space. The
  // link-local range covers 169.254.169.254, the cloud metadata address.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }

  // IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    if (/^f[cd]/.test(host)) return true;
    if (/^fe[89ab]/.test(host)) return true;
    // IPv4-mapped forms such as ::ffff:127.0.0.1
    const mapped = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mapped) return isBlockedHost(mapped[1]);
  }

  return false;
}

/** Parse and vet a candidate address. Returns a URL or an error string. */
function vet(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return { error: "That is not a valid address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http and https addresses can be followed." };
  }
  if (isBlockedHost(url.hostname)) {
    return { error: "That address points inside a private network." };
  }
  return { url };
}

async function followChain(startUrl, deadline) {
  const hops = [];
  let current = startUrl;
  let truncated = false;

  for (let i = 0; i <= MAX_HOPS; i++) {
    if (i === MAX_HOPS) {
      truncated = true;
      break;
    }
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }

    let response;
    try {
      // GET rather than HEAD: plenty of sites answer HEAD with 405 and cut the
      // chain short. The body is cancelled immediately below, so nothing is
      // downloaded beyond the headers.
      response = await fetch(current.href, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        signal: AbortSignal.timeout(
          Math.max(500, Math.min(PER_HOP_TIMEOUT_MS, deadline - Date.now()))
        ),
      });
    } catch (err) {
      hops.push({ status: null, url: current.href, error: "could not be reached" });
      break;
    }

    if (response.body) {
      try {
        await response.body.cancel();
      } catch (err) {
        /* nothing to clean up */
      }
    }

    hops.push({ status: response.status, url: current.href });

    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) break;

    let next;
    try {
      next = new URL(location, current.href); // Location may be relative
    } catch (err) {
      hops.push({ status: null, url: location, error: "redirects somewhere unparseable" });
      break;
    }

    const vetted = vet(next.href);
    if (vetted.error) {
      hops.push({ status: null, url: next.href, error: vetted.error });
      break;
    }
    current = vetted.url;
  }

  return { hops, truncated, final: hops.length ? hops[hops.length - 1].url : startUrl.href };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ ok: false, error: "Use GET." }, 405, origin);
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ ok: false, error: "Not an allowed origin." }, 403, origin);
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return json({ ok: false, error: "Pass ?url=<address>." }, 400, origin);
    }

    const vetted = vet(target);
    if (vetted.error) {
      return json({ ok: false, error: vetted.error }, 400, origin);
    }

    try {
      const result = await followChain(vetted.url, Date.now() + TOTAL_TIMEOUT_MS);
      return json({ ok: true, ...result }, 200, origin);
    } catch (err) {
      return json({ ok: false, error: "The chain could not be followed." }, 502, origin);
    }
  },
};
