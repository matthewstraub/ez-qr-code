/*
 * qr-ui.js — the parts of the interface every page shares.
 *
 * Each page supplies its own input fields plus a `getPayload()` that turns
 * those fields into the string to encode. Everything else — colors, presets,
 * error correction, sizing, the live preview, contrast checks and the PNG/SVG
 * exports — lives here so the pages can't drift apart.
 *
 * Usage:
 *   const ui = QRUI.mount({
 *     controls: document.getElementById("qr-controls"),
 *     preview: document.getElementById("qr-preview"),
 *     getPayload: () => "https://example.com" || null,
 *     emptyMessage: "Enter a URL to generate a code.",   // string or function
 *     filename: () => "qr-example"
 *   });
 *   ui.refresh();   // call whenever a page-specific input changes
 */
const QRUI = (function () {
  "use strict";

  const PRESETS = [
    { name: "Classic black", fg: "#0f1115", bg: "#ffffff" },
    { name: "Ink blue", fg: "#1b3a8f", bg: "#ffffff" },
    { name: "Forest", fg: "#14532d", bg: "#f0fdf4" },
    { name: "Merlot", fg: "#7f1d1d", bg: "#fef2f2" },
    { name: "Plum", fg: "#4c1d95", bg: "#f5f3ff" },
    { name: "Slate on cream", fg: "#334155", bg: "#faf7f0" },
    { name: "Inverted", fg: "#ffffff", bg: "#0f1115" },
  ];

  const CONTROLS_MARKUP = `
    <div class="field">
      <span class="label">Colors</span>
      <div class="color-grid">
        <div class="color-field">
          <span class="sub-label" id="fg-label">Foreground</span>
          <div class="color-input">
            <input type="color" id="fg-picker" value="#0f1115" aria-label="Pick foreground color" />
            <input type="text" id="fg-hex" class="hex" value="#0f1115" spellcheck="false"
                   autocapitalize="off" autocorrect="off" aria-labelledby="fg-label" aria-describedby="fg-error" />
          </div>
          <p class="error hidden" id="fg-error"></p>
        </div>
        <div class="color-field">
          <span class="sub-label" id="bg-label">Background</span>
          <div class="color-input">
            <input type="color" id="bg-picker" value="#ffffff" aria-label="Pick background color" />
            <input type="text" id="bg-hex" class="hex" value="#ffffff" spellcheck="false"
                   autocapitalize="off" autocorrect="off" aria-labelledby="bg-label" aria-describedby="bg-error" />
          </div>
          <p class="error hidden" id="bg-error"></p>
        </div>
      </div>
      <label class="checkbox">
        <input type="checkbox" id="transparent" />
        <span>Transparent background</span>
      </label>
      <div class="presets" id="presets" role="group" aria-label="Color presets"></div>
      <button type="button" class="ghost-btn" id="swap">Swap foreground and background</button>
      <p class="notice hidden" id="contrast-notice" role="status"></p>
    </div>

    <div class="field">
      <span class="label" id="ecl-label">Error correction</span>
      <div class="segmented" role="radiogroup" aria-labelledby="ecl-label" id="ecl">
        <button type="button" role="radio" data-ecl="L" aria-checked="false">L</button>
        <button type="button" role="radio" data-ecl="M" aria-checked="true" class="active">M</button>
        <button type="button" role="radio" data-ecl="Q" aria-checked="false">Q</button>
        <button type="button" role="radio" data-ecl="H" aria-checked="false">H</button>
      </div>
      <p class="hint">
        Higher levels survive more damage (a logo, a scuff, a bad print) but pack
        the code more densely. M is a good default.
      </p>
    </div>

    <details class="field advanced">
      <summary>Size &amp; spacing</summary>
      <div class="slider-field">
        <label for="size">Export size <output id="size-out">1024</output> px</label>
        <input type="range" id="size" min="128" max="2048" step="32" value="1024" />
      </div>
      <div class="slider-field">
        <label for="margin">Quiet zone <output id="margin-out">4</output> modules</label>
        <input type="range" id="margin" min="0" max="12" step="1" value="4" />
      </div>
      <p class="hint">
        The quiet zone is the blank border around the code. The spec asks for at
        least 4 modules; going below that can stop scanners from finding the code.
      </p>
    </details>`;

  const PREVIEW_MARKUP = `
    <div class="canvas-wrap" id="canvas-wrap">
      <canvas id="canvas" width="512" height="512" role="img" aria-label="QR code preview"></canvas>
    </div>
    <p class="error-box hidden" id="encode-error" role="alert"></p>
    <dl class="meta">
      <div><dt>Version</dt><dd id="meta-version">—</dd></div>
      <div><dt>Modules</dt><dd id="meta-modules">—</dd></div>
      <div><dt>Level</dt><dd id="meta-ecl">—</dd></div>
    </dl>
    <div class="actions">
      <button type="button" id="download-png" class="primary-btn">Download PNG</button>
      <button type="button" id="download-svg" class="secondary-btn">Download SVG</button>
      <button type="button" id="copy" class="secondary-btn">Copy image</button>
    </div>
    <p class="hint center" id="action-status" role="status"></p>
    <p class="hint center">Scan the preview with your phone before you print or publish it.</p>`;

  // ------------------------------ Color helpers ------------------------------

  /** Parse "#abc", "abc", "#aabbcc" or "aabbcc" into a normalized "#aabbcc". */
  function parseHex(input) {
    const raw = String(input).trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(raw)) {
      return "#" + raw.split("").map((c) => c + c).join("").toLowerCase();
    }
    if (/^[0-9a-fA-F]{6}$/.test(raw)) {
      return "#" + raw.toLowerCase();
    }
    return null;
  }

  function toRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  /** WCAG relative luminance. */
  function luminance(hex) {
    const [r, g, b] = toRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Turn arbitrary text into something safe for a filename. */
  function slug(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  }

  // ------------------------------ Mount ------------------------------

  function mount(options) {
    const controlsRoot = options.controls;
    const previewRoot = options.preview;
    controlsRoot.insertAdjacentHTML("beforeend", CONTROLS_MARKUP);
    previewRoot.insertAdjacentHTML("beforeend", PREVIEW_MARKUP);

    const $ = (id) => document.getElementById(id);
    const el = {
      fgPicker: $("fg-picker"),
      fgHex: $("fg-hex"),
      fgError: $("fg-error"),
      bgPicker: $("bg-picker"),
      bgHex: $("bg-hex"),
      bgError: $("bg-error"),
      transparent: $("transparent"),
      presets: $("presets"),
      swap: $("swap"),
      contrastNotice: $("contrast-notice"),
      ecl: $("ecl"),
      size: $("size"),
      sizeOut: $("size-out"),
      margin: $("margin"),
      marginOut: $("margin-out"),
      canvasWrap: $("canvas-wrap"),
      canvas: $("canvas"),
      encodeError: $("encode-error"),
      metaVersion: $("meta-version"),
      metaModules: $("meta-modules"),
      metaEcl: $("meta-ecl"),
      downloadPng: $("download-png"),
      downloadSvg: $("download-svg"),
      copy: $("copy"),
      actionStatus: $("action-status"),
    };

    const state = {
      fg: "#0f1115",
      bg: "#ffffff",
      transparent: false,
      ecl: "M",
      size: 1024,
      margin: 4,
    };

    let currentQr = null; // the last successfully encoded code, or null

    // ------------------------------ Rendering ------------------------------

    /**
     * Draw the code onto a canvas at the requested pixel size. Module edges are
     * snapped to whole pixels so the code never renders with seams or
     * half-pixel gaps that confuse scanners.
     */
    function drawToCanvas(canvas, qr, pixelSize) {
      const total = qr.size + state.margin * 2;
      const scale = Math.max(1, Math.floor(pixelSize / total));
      const dim = scale * total;

      canvas.width = dim;
      canvas.height = dim;

      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, dim, dim);

      if (!state.transparent) {
        ctx.fillStyle = state.bg;
        ctx.fillRect(0, 0, dim, dim);
      }

      ctx.fillStyle = state.fg;
      for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
          if (qr.get(x, y)) {
            ctx.fillRect(
              (x + state.margin) * scale,
              (y + state.margin) * scale,
              scale,
              scale
            );
          }
        }
      }
      return dim;
    }

    /** Build an SVG string. Dark modules become one path, so the file stays small. */
    function buildSvg(qr) {
      const total = qr.size + state.margin * 2;
      const parts = [];
      for (let y = 0; y < qr.size; y++) {
        let x = 0;
        while (x < qr.size) {
          if (!qr.get(x, y)) {
            x++;
            continue;
          }
          // Collapse each horizontal run of dark modules into a single rect.
          let run = 1;
          while (x + run < qr.size && qr.get(x + run, y)) run++;
          parts.push(`M${x + state.margin} ${y + state.margin}h${run}v1h-${run}z`);
          x += run;
        }
      }

      const background = state.transparent
        ? ""
        : `<rect width="${total}" height="${total}" fill="${state.bg}"/>`;

      return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
        `width="${state.size}" height="${state.size}" shape-rendering="crispEdges">` +
        background +
        `<path fill="${state.fg}" d="${parts.join("")}"/>` +
        `</svg>`
      );
    }

    // ------------------------------ Warnings ------------------------------

    function updateContrastNotice() {
      const notice = el.contrastNotice;
      notice.classList.remove("warn", "bad");

      if (state.transparent) {
        // On a transparent background the code sits on whatever is behind it,
        // so contrast can't be checked here.
        notice.textContent =
          "Transparent background: make sure whatever sits behind the code is light and plain, or scanners will struggle.";
        notice.classList.add("warn");
        notice.classList.remove("hidden");
        return;
      }

      const ratio = contrastRatio(state.fg, state.bg);
      const inverted = luminance(state.fg) > luminance(state.bg);

      if (ratio < 3) {
        notice.textContent = `These colors are too close (${ratio.toFixed(
          1
        )}:1 contrast). Most scanners need at least 3:1 — darken the foreground or lighten the background.`;
        notice.classList.add("bad");
        notice.classList.remove("hidden");
      } else if (inverted) {
        notice.textContent =
          "Light code on a dark background. It scans on most modern phones, but older scanners expect dark-on-light — test before printing.";
        notice.classList.add("warn");
        notice.classList.remove("hidden");
      } else if (ratio < 7) {
        notice.textContent = `Contrast is ${ratio.toFixed(
          1
        )}:1. That usually works on screen, but push it higher for print.`;
        notice.classList.add("warn");
        notice.classList.remove("hidden");
      } else {
        notice.classList.add("hidden");
      }
    }

    // ------------------------------ Main update ------------------------------

    function setActionsEnabled(enabled) {
      el.downloadPng.disabled = !enabled;
      el.downloadSvg.disabled = !enabled;
      el.copy.disabled = !enabled;
    }

    function setFailed(message) {
      currentQr = null;
      el.encodeError.textContent = message;
      el.encodeError.classList.remove("hidden");
      el.metaVersion.textContent = "—";
      el.metaModules.textContent = "—";
      el.metaEcl.textContent = "—";
      const ctx = el.canvas.getContext("2d");
      ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
      setActionsEnabled(false);
    }

    function render() {
      updateContrastNotice();
      el.canvasWrap.classList.toggle("is-transparent", state.transparent);

      const payload = options.getPayload();
      if (!payload) {
        setFailed(
          typeof options.emptyMessage === "function"
            ? options.emptyMessage()
            : options.emptyMessage
        );
        return;
      }

      let qr;
      try {
        qr = QR.encode(payload, state.ecl);
      } catch (err) {
        setFailed(
          err && err.message
            ? err.message +
                ". Try shorter content or a lower error correction level."
            : "Could not generate a code for this input."
        );
        return;
      }

      currentQr = qr;
      el.encodeError.classList.add("hidden");
      setActionsEnabled(true);

      el.metaVersion.textContent = String(qr.version);
      el.metaModules.textContent = `${qr.size}×${qr.size}`;
      el.metaEcl.textContent = qr.ecl;

      // The preview is capped at a sane resolution; downloads use the full size.
      drawToCanvas(el.canvas, qr, 640);
    }

    // ------------------------------ Downloads ------------------------------

    function saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a moment to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    function status(message) {
      el.actionStatus.textContent = message;
      clearTimeout(status.timer);
      status.timer = setTimeout(() => {
        el.actionStatus.textContent = "";
      }, 3000);
    }

    function renderExportCanvas() {
      const canvas = document.createElement("canvas");
      drawToCanvas(canvas, currentQr, state.size);
      return canvas;
    }

    el.downloadPng.addEventListener("click", () => {
      if (!currentQr) return;
      renderExportCanvas().toBlob((blob) => {
        saveBlob(blob, options.filename() + ".png");
        status("PNG downloaded.");
      }, "image/png");
    });

    el.downloadSvg.addEventListener("click", () => {
      if (!currentQr) return;
      const blob = new Blob([buildSvg(currentQr)], {
        type: "image/svg+xml;charset=utf-8",
      });
      saveBlob(blob, options.filename() + ".svg");
      status("SVG downloaded.");
    });

    el.copy.addEventListener("click", async () => {
      if (!currentQr) return;
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
        status("This browser can't copy images — use Download PNG instead.");
        return;
      }
      try {
        const canvas = renderExportCanvas();
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/png")
        );
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        status("Copied to clipboard.");
      } catch (err) {
        status("Copy failed — use Download PNG instead.");
      }
    });

    // ------------------------------ Input wiring ------------------------------

    /** Keep a hex text box, its color picker and the state in sync. */
    function wireColor(key, textInput, picker, errorEl) {
      textInput.addEventListener("input", () => {
        const parsed = parseHex(textInput.value);
        if (parsed) {
          state[key] = parsed;
          picker.value = parsed;
          textInput.setAttribute("aria-invalid", "false");
          errorEl.classList.add("hidden");
          render();
        } else {
          textInput.setAttribute("aria-invalid", "true");
          errorEl.textContent = "Use a hex code like #2f6bff or #fff.";
          errorEl.classList.remove("hidden");
        }
      });

      // Normalize whatever is left in the box when focus leaves it.
      textInput.addEventListener("blur", () => {
        const parsed = parseHex(textInput.value);
        textInput.value = parsed || state[key];
        textInput.setAttribute("aria-invalid", "false");
        errorEl.classList.add("hidden");
        state[key] = textInput.value;
        picker.value = textInput.value;
        render();
      });

      picker.addEventListener("input", () => {
        state[key] = picker.value.toLowerCase();
        textInput.value = state[key];
        textInput.setAttribute("aria-invalid", "false");
        errorEl.classList.add("hidden");
        render();
      });
    }

    wireColor("fg", el.fgHex, el.fgPicker, el.fgError);
    wireColor("bg", el.bgHex, el.bgPicker, el.bgError);

    function applyColors(fg, bg) {
      state.fg = fg;
      state.bg = bg;
      el.fgHex.value = fg;
      el.fgPicker.value = fg;
      el.bgHex.value = bg;
      el.bgPicker.value = bg;
      el.fgError.classList.add("hidden");
      el.bgError.classList.add("hidden");
      el.fgHex.setAttribute("aria-invalid", "false");
      el.bgHex.setAttribute("aria-invalid", "false");
      render();
    }

    el.swap.addEventListener("click", () => applyColors(state.bg, state.fg));

    el.transparent.addEventListener("change", () => {
      state.transparent = el.transparent.checked;
      el.bgHex.disabled = state.transparent;
      el.bgPicker.disabled = state.transparent;
      render();
    });

    PRESETS.forEach((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preset";
      button.title = preset.name;
      button.setAttribute("aria-label", preset.name);
      button.style.setProperty("--preset-fg", preset.fg);
      button.style.setProperty("--preset-bg", preset.bg);
      button.addEventListener("click", () => {
        if (state.transparent) {
          el.transparent.checked = false;
          state.transparent = false;
          el.bgHex.disabled = false;
          el.bgPicker.disabled = false;
        }
        applyColors(preset.fg, preset.bg);
      });
      el.presets.appendChild(button);
    });

    el.ecl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-ecl]");
      if (!button) return;
      state.ecl = button.dataset.ecl;
      el.ecl.querySelectorAll("button").forEach((b) => {
        const active = b === button;
        b.classList.toggle("active", active);
        b.setAttribute("aria-checked", String(active));
      });
      render();
    });

    el.size.addEventListener("input", () => {
      state.size = Number(el.size.value);
      el.sizeOut.textContent = String(state.size);
    });

    el.margin.addEventListener("input", () => {
      state.margin = Number(el.margin.value);
      el.marginOut.textContent = String(state.margin);
      render();
    });

    render();

    return { refresh: render };
  }

  return { mount, slug };
})();
