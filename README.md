# EZ QR Code

Set the colors with a hex code, download a QR code as PNG or SVG.

No build step, no dependencies, no server, no tracking. The QR code is encoded
in the browser, so nothing you type ever leaves your machine.

## Pages

| Path | What it does |
| --- | --- |
| `/` | Encodes a URL or any text. |
| `/wifi` | Encodes Wi-Fi credentials so guests can scan to join the network. |
| `/verify` | Reads an existing code with the camera and shows what is inside it, without opening it. |

## Features

- **Any color** — type a hex code (`#2f6bff`, `2f6bff`, or `#fff` shorthand) or
  use the native color picker. Both stay in sync.
- **Contrast checking** — warns when the colors are too close to scan, or when a
  light-on-dark code might fail on older scanners.
- **Transparent background** for placing the code on artwork.
- **PNG and SVG export**, plus copy-to-clipboard. The SVG is a single vector
  path, so it prints at any size.
- **Adjustable error correction** (L/M/Q/H), export size, and quiet zone.
- Full QR spec support: versions 1–40, up to ~2,900 bytes, UTF-8 safe.

## Running it locally

It's static files — anything that serves a directory works:

```bash
python3 -m http.server 8765 --directory public
```

Then open http://localhost:8765.

## Deploying to Render

The repo includes a [`render.yaml`](render.yaml) blueprint. In the Render
dashboard, choose **New → Blueprint**, point it at this repo, and it will create
a free static site that serves `public/`.

To set it up by hand instead, create a **New → Static Site** with:

| Setting | Value |
| --- | --- |
| Build command | *(leave empty)* |
| Publish directory | `public` |

Every push to `main` redeploys automatically.

## Project layout

```
public/
  index.html      the Link page
  link.js         its inputs (URL field, bare-domain hint)
  wifi/
    index.html    the Wi-Fi page
    wifi.js       its inputs and WIFI: payload builder
  verify/
    index.html    the Verify (scanner) page
    verify.js     camera handling and payload interpretation
  qr-ui.js        everything the generator pages share: colors, presets,
                  error correction, sizing, preview, contrast, exports
  qr.js           the QR encoder (no dependencies)
  qr-decode.js    the QR reader (no dependencies)
  styles.css      styling, light and dark
render.yaml       Render blueprint
```

Adding another code type means writing a page with its own input fields plus a
`getPayload()`, then handing it to `QRUI.mount()` — see the top of
[`public/qr-ui.js`](public/qr-ui.js).

## About the Wi-Fi payload

Wi-Fi codes use the `WIFI:` scheme that iOS and Android cameras understand:

```
WIFI:T:WPA;S:My Network;P:secret;;
```

The characters `\ ; , : "` are escaped automatically, which matters more than it
sounds — an unescaped semicolon in a password silently truncates the rest of the
payload, producing a code that scans but won't connect.

## About the encoder

`public/qr.js` is a from-scratch implementation of ISO/IEC 18004 in byte mode:
Reed-Solomon error correction over GF(256), automatic version selection,
block interleaving, and automatic mask selection using the spec's four penalty
rules.

It was verified end-to-end against the platform barcode decoder
(`BarcodeDetector`): all 160 combinations of version 1–40 and error correction
level L/M/Q/H were generated at exact capacity, rendered, and decoded back to
the original input, along with the colored, inverted, transparent, and
unicode rendering paths. The Wi-Fi payloads are checked the same way, including
passwords containing every character that needs escaping.

## About the reader

`public/qr-decode.js` reads codes back out of a camera frame or a photo:
adaptive thresholding that copes with uneven lighting, finder-pattern
detection, a perspective correction so the code need not be square to the
lens, then Reed-Solomon error *correction* to repair damage — the half of the
algorithm the encoder never needs.

It exists because **Safari on iOS has no `BarcodeDetector`**, the browser API
that would otherwise do this. It has been disabled since iOS 17, and every
browser on iOS is Safari underneath, so an iPhone or iPad has no built-in way
to do it. Where the API *is* available (Android Chrome, desktop Chrome and
Edge) the page uses it, because it is faster, and falls back to this everywhere
else.

Verified by round-tripping against the encoder — all 160 version/level
combinations at exact capacity, every rotation, perspective tilts, blur, sensor
noise, glare gradients, colored and inverted codes, and physical damage up to
the error-correction limit — then cross-checked against the platform decoder on
120 randomized payloads, where the two agreed every time. Reed-Solomon is tested
separately: 330 correctable cases repaired exactly, and 300 beyond-limit cases
refused rather than silently returning wrong data.

### What the Verify page will not do

It never acts on what it reads. No link is followed, no network joined, nothing
fetched. The value is decoded on the device and shown as text, and opening it
is left to a deliberate tap. It also points out the things worth noticing
before that tap: an address whose real destination differs from what it appears
to say, `http://` rather than `https://`, a shortened link whose endpoint the
code does not reveal, a punycode host, an open Wi-Fi network, or a payload
carrying a two-factor secret.

## License

MIT
