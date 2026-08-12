/*
 * link.js — the "Link" page: turns a URL or arbitrary text into a QR code.
 *
 * Shared controls, preview and exports come from qr-ui.js.
 */
(function () {
  "use strict";

  const content = document.getElementById("content");
  const contentHint = document.getElementById("content-hint");
  const contentCounter = document.getElementById("content-counter");
  const addScheme = document.getElementById("add-scheme");

  /** True when the text looks like "example.com/page" with no scheme. */
  function looksLikeBareDomain(text) {
    return (
      text.length > 0 &&
      !/^[a-z][a-z0-9+.-]*:/i.test(text) &&
      !/\s/.test(text) &&
      /^[^\s/]+\.[a-z]{2,}(\/|$|\?|#)/i.test(text)
    );
  }

  function updateHints(text) {
    const bytes = new TextEncoder().encode(text).length;
    contentCounter.textContent = `${bytes} byte${bytes === 1 ? "" : "s"}`;

    if (looksLikeBareDomain(text)) {
      contentHint.textContent =
        "No https:// — some apps will treat this as plain text, not a link.";
      addScheme.classList.remove("hidden");
    } else {
      contentHint.textContent = "";
      addScheme.classList.add("hidden");
    }
  }

  const ui = QRUI.mount({
    controls: document.getElementById("qr-controls"),
    preview: document.getElementById("qr-preview"),
    emptyMessage: "Enter a URL or some text to generate a code.",

    getPayload() {
      // Trim before encoding: a pasted URL often carries a trailing newline or
      // space, and encoding that can break the link for some scanners.
      const text = content.value.trim();
      updateHints(text);
      return text.length ? text : null;
    },

    filename() {
      const text = content.value.trim();
      // Name the file after the host when this really is a URL. The URL
      // constructor is lenient enough to turn "hello world" into a hostname of
      // "hello%20world", so the result has to be checked before it's used.
      if (!/\s/.test(text)) {
        try {
          const url = new URL(
            /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : "https://" + text
          );
          const host = url.hostname.replace(/^www\./, "");
          if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return "qr-" + host;
        } catch (err) {
          // Not a URL — fall through to a slug of the text itself.
        }
      }
      return "qr-" + (QRUI.slug(text) || "code");
    },
  });

  content.addEventListener("input", () => ui.refresh());

  addScheme.addEventListener("click", () => {
    content.value = "https://" + content.value.trim();
    content.focus();
    ui.refresh();
  });
})();
