# EZ QR Code

Set the colors with a hex code, download a QR code as PNG or SVG.

No build step, no dependencies, no server, no tracking. The QR code is encoded
in the browser, so nothing you type ever leaves your machine.

## Pages

| Path | What it does |
| --- | --- |
| `/` | Encodes a URL or any text. |
| `/wifi` | Encodes Wi-Fi credentials so guests can scan to join the network. |

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
  qr-ui.js        everything the pages share: colors, presets, error
                  correction, sizing, preview, contrast checks, exports
  qr.js           the QR encoder (no dependencies)
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

## License

MIT
