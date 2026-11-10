#!/usr/bin/env python3
"""Local stand-in for the Cloudflare Worker, for trying the Verify page before
deploying anything.

It speaks the same request and response shape as resolve.js, so the page cannot
tell the difference:

    GET /?url=https%3A%2F%2Fqrco.de%2Fbh5Bqe
    -> {"ok": true, "hops": [{"status": 302, "url": "..."}, ...],
        "final": "...", "truncated": false}

Run it next to the site:

    python3 worker/mock-resolver.py          # listens on 127.0.0.1:8766
    python3 -m http.server 8765 --directory public

DEVELOPMENT ONLY. It binds to localhost and applies the same address checks as
the worker, but it has none of Cloudflare's isolation, so do not expose it.
"""

import ipaddress
import json
import re
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, urljoin
from urllib.request import Request, build_opener, HTTPRedirectHandler

PORT = 8766
MAX_HOPS = 10
TIMEOUT = 5
ALLOWED_ORIGINS = {"http://localhost:8765", "http://127.0.0.1:8765"}
USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)

BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa")


class NoRedirects(HTTPRedirectHandler):
    """Hand back the redirect instead of following it, so each hop is visible."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def is_blocked(hostname):
    host = (hostname or "").lower().strip("[]")
    if not host or host == "localhost" or host.endswith(BLOCKED_SUFFIXES):
        return True
    # Literal addresses are checked directly; names are resolved first, which
    # is what stops a public name that points at a private address.
    candidates = []
    try:
        candidates.append(ipaddress.ip_address(host))
    except ValueError:
        try:
            for info in socket.getaddrinfo(host, None):
                candidates.append(ipaddress.ip_address(info[4][0]))
        except OSError:
            return True
    return any(
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
        or ip.is_multicast or ip.is_unspecified
        for ip in candidates
    )


def vet(raw):
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        return None, "Only http and https addresses can be followed."
    if is_blocked(parsed.hostname):
        return None, "That address points inside a private network."
    return raw, None


def follow(start):
    opener = build_opener(NoRedirects)
    hops = []
    current = start
    truncated = False

    for index in range(MAX_HOPS + 1):
        if index == MAX_HOPS:
            truncated = True
            break
        # GET, not HEAD: several sites answer HEAD with 405 and cut the chain
        # short. Only the headers are read.
        request = Request(current, method="GET", headers={"User-Agent": USER_AGENT})
        try:
            response = opener.open(request, timeout=TIMEOUT)
            status, headers = response.status, response.headers
            response.close()
        except Exception as error:  # includes the redirect responses
            status = getattr(error, "code", None)
            headers = getattr(error, "headers", None)
            if status is None:
                hops.append({"status": None, "url": current, "error": "could not be reached"})
                break

        hops.append({"status": status, "url": current})
        location = headers.get("Location") if headers else None
        if not (300 <= (status or 0) < 400) or not location:
            break

        nxt = urljoin(current, location)
        checked, problem = vet(nxt)
        if problem:
            hops.append({"status": None, "url": nxt, "error": problem})
            break
        current = checked

    return {
        "ok": True,
        "hops": hops,
        "final": hops[-1]["url"] if hops else start,
        "truncated": truncated,
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, payload, status=200):
        body = json.dumps(payload).encode()
        origin = self.headers.get("Origin", "")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header(
            "Access-Control-Allow-Origin",
            origin if origin in ALLOWED_ORIGINS else "http://localhost:8765",
        )
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send({"ok": True})

    def do_GET(self):
        target = parse_qs(urlparse(self.path).query).get("url", [None])[0]
        if not target:
            return self._send({"ok": False, "error": "Pass ?url=<address>."}, 400)
        checked, problem = vet(target)
        if problem:
            return self._send({"ok": False, "error": problem}, 400)
        try:
            self._send(follow(checked))
        except Exception:
            self._send({"ok": False, "error": "The chain could not be followed."}, 502)

    def log_message(self, fmt, *args):
        print("mock-resolver: " + (fmt % args))


if __name__ == "__main__":
    print(f"mock resolver on http://127.0.0.1:{PORT} (development only)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
