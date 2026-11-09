/*
 * verify.js — the "Verify" page: read an existing QR code and show what is
 * inside it.
 *
 * The one rule this page exists to keep: the contents are never acted on. No
 * link is followed, no network is joined, nothing is fetched. The value is
 * decoded on the device and displayed as text, and any opening is left to a
 * deliberate tap by the person reading it.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    scanner: $("scanner"),
    video: $("video"),
    idle: $("scanner-idle"),
    start: $("start"),
    stop: $("stop"),
    file: $("file"),
    status: $("scan-status"),
    error: $("scan-error"),
    result: $("result"),
    resultType: $("result-type"),
    details: $("details"),
    raw: $("raw"),
    warnings: $("warnings"),
    copy: $("copy"),
    open: $("open"),
    copyStatus: $("copy-status"),
    scanAgain: $("scan-again"),
  };

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const SCAN_INTERVAL_MS = 100; // about ten looks a second

  let stream = null;
  let scanTimer = null;
  let scanning = false;
  let nativeDetector = null;
  let nativeBroken = false;

  // ------------------------------ Decoding ------------------------------

  /**
   * Use the browser's own decoder where it exists, since it is faster and
   * hardware-assisted. Safari has never shipped it, which is exactly why
   * qr-decode.js exists.
   */
  function getNativeDetector() {
    if (nativeBroken || nativeDetector) return nativeDetector;
    if (typeof BarcodeDetector === "undefined") {
      nativeBroken = true;
      return null;
    }
    try {
      nativeDetector = new BarcodeDetector({ formats: ["qr_code"] });
    } catch (err) {
      nativeBroken = true;
    }
    return nativeDetector;
  }

  async function decodeFrom(source, imageData, options) {
    const detector = getNativeDetector();
    if (detector && source) {
      try {
        const found = await detector.detect(source);
        if (found.length) return { text: found[0].rawValue, via: "native" };
      } catch (err) {
        // Fall through to our own decoder and stop trying this one.
        nativeBroken = true;
        nativeDetector = null;
      }
    }
    const result = QRDecode.decode(imageData, options);
    return result ? { text: result.text, via: "built-in", meta: result } : null;
  }

  // ------------------------------ Interpretation ------------------------------

  const SHORTENERS = [
    "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly", "is.gd",
    "rb.gy", "cutt.ly", "shorturl.at", "rebrand.ly", "lnkd.in", "tiny.cc",
    "s.id", "qrco.de", "short.io", "trib.al", "shrtco.de",
  ];

  /** Split a WIFI: payload into its fields, undoing the backslash escaping. */
  function parseWifi(payload) {
    const body = payload.replace(/^WIFI:/i, "");
    const fields = {};
    let i = 0;
    while (i < body.length) {
      let key = "";
      while (i < body.length && body[i] !== ":" && body[i] !== ";") {
        key += body[i];
        i++;
      }
      if (body[i] !== ":") {
        i++; // a stray separator
        continue;
      }
      i++;
      let value = "";
      while (i < body.length && body[i] !== ";") {
        if (body[i] === "\\") {
          i++;
          if (i < body.length) {
            value += body[i];
            i++;
          }
        } else {
          value += body[i];
          i++;
        }
      }
      i++;
      if (key) fields[key.toUpperCase()] = value;
    }
    return fields;
  }

  function describeWifi(text) {
    const fields = parseWifi(text);
    const security = (fields.T || "nopass").toUpperCase();
    const details = [
      { label: "Network name", value: fields.S || "(none given)" },
      {
        label: "Security",
        value:
          security === "NOPASS"
            ? "Open — no password"
            : security === "WEP"
            ? "WEP"
            : "WPA/WPA2/WPA3",
      },
    ];
    if (security !== "NOPASS") {
      details.push({ label: "Password", value: fields.P || "(none given)", secret: true });
    }
    if (fields.H && fields.H.toLowerCase() === "true") {
      details.push({ label: "Hidden network", value: "Yes" });
    }

    const warnings = [];
    if (security === "NOPASS") {
      warnings.push({
        level: "warn",
        text: "This joins an open network with no password. Traffic on it can be read by others nearby.",
      });
    }
    return { type: "Wi-Fi network", details, warnings };
  }

  function describeUrl(text) {
    let url;
    try {
      url = new URL(text);
    } catch (err) {
      return null;
    }

    const host = url.hostname;
    const details = [
      { label: "Goes to", value: host, strong: true },
      { label: "Full address", value: url.href },
    ];
    const warnings = [];

    if (url.protocol === "http:") {
      warnings.push({
        level: "warn",
        text: "This is an http:// address, so the connection is not encrypted. Treat anything you type on it as public.",
      });
    }
    if (url.username || url.password) {
      warnings.push({
        level: "bad",
        text:
          "The address has a username buried in it, before the “@”. The real destination is " +
          host +
          ", not whatever appears first. This is a common trick.",
      });
    }
    if (/^xn--/i.test(host) || host.split(".").some((p) => /^xn--/i.test(p))) {
      warnings.push({
        level: "bad",
        text: "This address uses non-Latin characters that can be made to look like a familiar brand. Check the destination carefully.",
      });
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) {
      warnings.push({
        level: "warn",
        text: "This points at a raw IP address rather than a named site.",
      });
    }
    if (SHORTENERS.includes(host.toLowerCase().replace(/^www\./, ""))) {
      warnings.push({
        level: "warn",
        text: "This is a shortened link, so the code does not reveal where it actually ends up.",
      });
    }
    if (url.port && url.port !== "80" && url.port !== "443") {
      details.push({ label: "Port", value: url.port });
    }

    return { type: "Link", details, warnings, openable: url.href };
  }

  /** Work out what a decoded string actually represents. */
  function interpret(text) {
    const trimmed = text.trim();

    if (/^WIFI:/i.test(trimmed)) return describeWifi(trimmed);

    if (/^https?:\/\//i.test(trimmed)) {
      const described = describeUrl(trimmed);
      if (described) return described;
    }

    if (/^mailto:/i.test(trimmed)) {
      const address = trimmed.slice(7).split("?")[0];
      return { type: "Email address", details: [{ label: "Sends email to", value: decodeURIComponent(address), strong: true }], warnings: [] };
    }
    if (/^(tel|sms|smsto):/i.test(trimmed)) {
      const [scheme, rest] = [trimmed.split(":")[0].toLowerCase(), trimmed.slice(trimmed.indexOf(":") + 1)];
      return {
        type: scheme === "tel" ? "Phone number" : "Text message",
        details: [{ label: scheme === "tel" ? "Calls" : "Texts", value: rest.split(/[?:]/)[0], strong: true }],
        warnings: [],
      };
    }
    if (/^geo:/i.test(trimmed)) {
      return { type: "Location", details: [{ label: "Coordinates", value: trimmed.slice(4), strong: true }], warnings: [] };
    }
    if (/^otpauth:/i.test(trimmed)) {
      return {
        type: "Two-factor secret",
        details: [{ label: "Contents", value: trimmed, secret: true }],
        warnings: [{
          level: "bad",
          text: "This is a two-factor authentication secret. Anyone who photographs or copies it can generate your login codes — do not share this code or let it be photographed.",
        }],
      };
    }
    if (/^(bitcoin|ethereum|litecoin|bitcoincash):/i.test(trimmed)) {
      return {
        type: "Cryptocurrency payment",
        details: [{ label: "Pay to", value: trimmed, strong: true }],
        warnings: [{
          level: "bad",
          text: "This is a request to send cryptocurrency, which cannot be reversed. Confirm the address through another channel before paying.",
        }],
      };
    }
    if (/^BEGIN:VCARD/i.test(trimmed) || /^MECARD:/i.test(trimmed)) {
      return { type: "Contact card", details: [], warnings: [] };
    }
    if (/^javascript:/i.test(trimmed) || /^data:/i.test(trimmed)) {
      return {
        type: "Executable content",
        details: [],
        warnings: [{
          level: "bad",
          text: "This code contains script or embedded data rather than an ordinary address. There is no legitimate reason for a printed QR code to do this. Do not run it.",
        }],
      };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      const scheme = trimmed.split(":")[0];
      return {
        type: "App link",
        details: [{ label: "Scheme", value: scheme + ":", strong: true }],
        warnings: [{
          level: "warn",
          text: "This opens an app rather than a web page. Make sure you recognise what it is for.",
        }],
      };
    }

    return { type: "Plain text", details: [], warnings: [] };
  }

  // ------------------------------ Result rendering ------------------------------

  function renderResult(text) {
    const info = interpret(text);

    el.resultType.textContent = info.type;
    el.raw.textContent = text;

    el.details.innerHTML = "";
    for (const detail of info.details) {
      const wrap = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = detail.label;
      const dd = document.createElement("dd");
      if (detail.strong) dd.className = "strong";

      if (detail.secret) {
        // Shown, but not before the person asks: they may be holding the
        // screen up in a room full of people.
        const span = document.createElement("span");
        span.className = "secret";
        span.textContent = "•".repeat(Math.min(12, Math.max(6, detail.value.length)));
        const reveal = document.createElement("button");
        reveal.type = "button";
        reveal.className = "link-btn";
        reveal.textContent = "Show";
        let shown = false;
        reveal.addEventListener("click", () => {
          shown = !shown;
          span.textContent = shown
            ? detail.value
            : "•".repeat(Math.min(12, Math.max(6, detail.value.length)));
          reveal.textContent = shown ? "Hide" : "Show";
        });
        dd.appendChild(span);
        dd.appendChild(reveal);
      } else {
        dd.textContent = detail.value;
      }
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      el.details.appendChild(wrap);
    }

    el.warnings.innerHTML = "";
    for (const warning of info.warnings) {
      const p = document.createElement("p");
      p.className = "notice " + (warning.level === "bad" ? "bad" : "warn");
      p.textContent = warning.text;
      el.warnings.appendChild(p);
    }

    // The link is never followed automatically; this only arms a button the
    // reader has to press after seeing where it goes.
    if (info.openable) {
      const risky = info.warnings.some((w) => w.level === "bad");
      el.open.href = info.openable;
      el.open.textContent = risky ? "Open anyway" : "Open link";
      el.open.classList.toggle("risky", risky);
      el.open.classList.remove("hidden");
    } else {
      el.open.removeAttribute("href");
      el.open.classList.add("hidden");
    }

    el.result.classList.remove("hidden");
    el.result.focus();
  }

  // ------------------------------ Camera ------------------------------

  function setError(message) {
    if (!message) {
      el.error.classList.add("hidden");
      return;
    }
    el.error.textContent = message;
    el.error.classList.remove("hidden");
  }

  function setStatus(message) {
    el.status.textContent = message;
  }

  async function startCamera() {
    setError(null);

    if (!window.isSecureContext) {
      setError(
        "The camera only works over a secure (https) connection. Open this page at its https address and try again."
      );
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError(
        "This browser will not give a web page access to the camera. You can still use “Use a photo or screenshot” below."
      );
      return;
    }

    setStatus("Asking for camera permission…");
    const attempts = [
      { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: "environment" }, audio: false },
      { video: true, audio: false },
    ];

    let lastError = null;
    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastError = err;
        // A device without a rear camera rejects the constraint; try simpler.
        if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) break;
      }
    }

    if (!stream) {
      const name = lastError && lastError.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError(
          "Camera permission was declined. Allow camera access for this site in your browser settings, or use a photo instead."
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera was found on this device. You can scan a photo or screenshot instead.");
      } else if (name === "NotReadableError") {
        setError("The camera is already in use by another app. Close it and try again.");
      } else {
        setError("The camera could not be started. You can scan a photo or screenshot instead.");
      }
      setStatus("");
      return;
    }

    el.video.srcObject = stream;
    try {
      await el.video.play();
    } catch (err) {
      // Some browsers resolve this late; the loop copes either way.
    }

    el.scanner.classList.add("live");
    el.idle.classList.add("hidden");
    el.start.classList.add("hidden");
    el.stop.classList.remove("hidden");
    setStatus("Point the camera at a QR code.");

    scanning = true;
    scanTimer = setTimeout(tick, SCAN_INTERVAL_MS);
  }

  function stopCamera(message) {
    scanning = false;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    el.video.srcObject = null;
    el.scanner.classList.remove("live");
    el.idle.classList.remove("hidden");
    el.start.classList.remove("hidden");
    el.stop.classList.add("hidden");
    setStatus(message || "Works offline. Nothing you scan leaves your device.");
  }

  /** Copy the current video frame into the scratch canvas, scaled down. */
  function captureFrame(maxDimension) {
    const vw = el.video.videoWidth;
    const vh = el.video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, maxDimension / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(el.video, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /**
   * The scan loop runs on a timer rather than requestAnimationFrame. A timer
   * keeps a steady ten looks a second whatever the display does, and it keeps
   * running when the browser decides not to paint — an animation-frame loop
   * simply stops dead in that case, and a scanner that silently stops is
   * worse than one that costs a few frames.
   */
  async function tick() {
    if (!scanning) return;

    try {
      if (el.video.readyState >= 2) {
        const imageData = captureFrame(640);
        if (imageData) {
          // A live feed gets many frames, so each is scanned quickly rather
          // than exhaustively; the next frame gets another go.
          const found = await decodeFrom(el.video, imageData, {
            blockSizes: [8, 16],
          });
          if (found && scanning) {
            stopCamera("Found a code. Scan another when you are ready.");
            renderResult(found.text);
            return;
          }
        }
      }
    } catch (err) {
      // A bad frame is not worth stopping over; try the next one.
    }

    if (scanning) scanTimer = setTimeout(tick, SCAN_INTERVAL_MS);
  }

  // ------------------------------ Photo fallback ------------------------------

  async function scanFile(file) {
    setError(null);
    setStatus("Reading that image…");
    stopCamera("Reading that image…");

    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (err) {
      setError("That file could not be read as an image.");
      setStatus("");
      return;
    }

    // A photo gets the thorough treatment, at a couple of sizes.
    for (const maxDimension of [1000, 1600, 640]) {
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(bitmap, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);

      let found = null;
      try {
        found = await decodeFrom(canvas, imageData);
      } catch (err) {
        found = null;
      }
      if (found) {
        bitmap.close && bitmap.close();
        setStatus("Found a code in that image.");
        renderResult(found.text);
        return;
      }
    }

    bitmap.close && bitmap.close();
    setStatus("");
    setError(
      "No QR code was found in that image. Try a closer, sharper shot with the whole code and a little space around it."
    );
  }

  // ------------------------------ Wiring ------------------------------

  el.start.addEventListener("click", startCamera);
  el.stop.addEventListener("click", () => stopCamera());

  el.file.addEventListener("change", () => {
    const file = el.file.files && el.file.files[0];
    if (file) scanFile(file);
    el.file.value = ""; // allow re-picking the same file
  });

  el.scanAgain.addEventListener("click", () => {
    el.result.classList.add("hidden");
    setError(null);
    startCamera();
  });

  el.copy.addEventListener("click", async () => {
    const text = el.raw.textContent;
    try {
      await navigator.clipboard.writeText(text);
      el.copyStatus.textContent = "Copied.";
    } catch (err) {
      el.copyStatus.textContent = "Could not copy — select the text above instead.";
    }
    clearTimeout(el.copy.timer);
    el.copy.timer = setTimeout(() => {
      el.copyStatus.textContent = "";
    }, 3000);
  });

  // Don't hold the camera open in a background tab.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && scanning) stopCamera("Camera paused.");
  });
  window.addEventListener("pagehide", () => stopCamera());
})();
