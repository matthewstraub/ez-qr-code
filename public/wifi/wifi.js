/*
 * wifi.js — the "Wi-Fi" page: builds a join-this-network QR code.
 *
 * The payload follows the widely supported WIFI: scheme that iOS and Android
 * cameras understand:
 *
 *   WIFI:T:WPA;S:My Network;P:secret;;
 *
 * Fields are T (security type), S (SSID), P (password) and H (hidden network).
 * The whole thing ends with a double semicolon.
 *
 * Shared controls, preview and exports come from qr-ui.js.
 */
(function () {
  "use strict";

  const ssid = document.getElementById("ssid");
  const password = document.getElementById("password");
  const togglePassword = document.getElementById("toggle-password");
  const security = document.getElementById("security");
  const hiddenNetwork = document.getElementById("hidden-network");
  const notice = document.getElementById("wifi-notice");
  const payloadRow = document.getElementById("payload-row");
  const payloadOut = document.getElementById("payload");

  let securityType = "WPA";
  let passwordVisible = true;

  /**
   * Escape the characters that mean something to the WIFI: format. Without
   * this, a password containing a semicolon or colon silently truncates the
   * rest of the payload.
   */
  function escapeValue(value) {
    return value.replace(/([\\;,:"])/g, "\\$1");
  }

  function needsPassword() {
    return securityType !== "nopass";
  }

  /**
   * Note: values made up entirely of hex digits are technically ambiguous in
   * this format and the spec suggests wrapping them in double quotes. Real
   * scanners — including the one built into Android's own Wi-Fi sharing — do
   * not quote them, and some fail to strip the quotes back off, so quoting
   * would break more codes than it fixes. We leave such values as-is.
   */
  function buildPayload() {
    // SSIDs and passwords may legitimately contain leading or trailing spaces,
    // so unlike the Link page these values are never trimmed.
    const parts = ["WIFI:", "T:" + securityType + ";", "S:" + escapeValue(ssid.value) + ";"];
    if (needsPassword()) {
      parts.push("P:" + escapeValue(password.value) + ";");
    }
    if (hiddenNetwork.checked) {
      parts.push("H:true;");
    }
    return parts.join("") + ";";
  }

  function hasEdgeWhitespace(value) {
    return value.length > 0 && /^\s|\s$/.test(value);
  }

  function updateNotice() {
    notice.classList.remove("warn", "bad");

    const spaceFields = [];
    if (hasEdgeWhitespace(ssid.value)) spaceFields.push("network name");
    if (needsPassword() && hasEdgeWhitespace(password.value)) {
      spaceFields.push("password");
    }

    if (spaceFields.length) {
      notice.textContent =
        "Your " +
        spaceFields.join(" and ") +
        " starts or ends with a space. That's allowed, but if it wasn't intentional the code won't connect.";
      notice.classList.add("warn");
      notice.classList.remove("hidden");
      return;
    }

    // Tell people when escaping kicked in, so a payload that looks different
    // from what they typed isn't a surprise.
    const raw = ssid.value + (needsPassword() ? password.value : "");
    if (/[\\;,:"]/.test(raw)) {
      notice.textContent =
        "Special characters were escaped automatically so scanners read them correctly.";
      notice.classList.add("warn");
      notice.classList.remove("hidden");
      return;
    }

    notice.classList.add("hidden");
  }

  function updatePayloadReadout(payload) {
    if (!payload) {
      payloadRow.classList.add("hidden");
      return;
    }
    payloadRow.classList.remove("hidden");
    if (passwordVisible || !needsPassword()) {
      payloadOut.textContent = payload;
    } else {
      // Match the masking of the password field itself.
      payloadOut.textContent = payload.replace(
        /P:(?:\\.|[^;\\])*;/,
        "P:" + "•".repeat(8) + ";"
      );
    }
  }

  const ui = QRUI.mount({
    controls: document.getElementById("qr-controls"),
    preview: document.getElementById("qr-preview"),
    // A missing password is a different problem than a missing network name.
    // This is a function so the right message survives any re-render, including
    // ones triggered by the shared color and sizing controls.
    emptyMessage() {
      if (ssid.value.length === 0) {
        return "Enter your network name to generate a code.";
      }
      return "Enter the network password, or set Security to None for an open network.";
    },

    getPayload() {
      updateNotice();

      if (ssid.value.length === 0) {
        updatePayloadReadout(null);
        return null;
      }
      if (needsPassword() && password.value.length === 0) {
        updatePayloadReadout(null);
        return null;
      }

      const payload = buildPayload();
      updatePayloadReadout(payload);
      return payload;
    },

    filename() {
      return "qr-wifi-" + (QRUI.slug(ssid.value) || "network");
    },
  });

  const refresh = () => ui.refresh();

  ssid.addEventListener("input", refresh);
  password.addEventListener("input", refresh);
  hiddenNetwork.addEventListener("change", refresh);

  togglePassword.addEventListener("click", () => {
    passwordVisible = !passwordVisible;
    password.type = passwordVisible ? "text" : "password";
    togglePassword.textContent = passwordVisible ? "Hide" : "Show";
    refresh();
  });

  security.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-security]");
    if (!button) return;
    securityType = button.dataset.security;
    security.querySelectorAll("button").forEach((b) => {
      const active = b === button;
      b.classList.toggle("active", active);
      b.setAttribute("aria-checked", String(active));
    });
    // An open network has no password to collect.
    const open = !needsPassword();
    password.disabled = open;
    togglePassword.disabled = open;
    refresh();
  });

  refresh();
})();
