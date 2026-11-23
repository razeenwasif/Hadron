// Force-dark for all sites (BACKLOG #40). Smart CSS invert that backs off on
// sites that already render dark, softens harsh #000/#fff contrast, prevents
// double-inverting nested media/backgrounds, and restores native colors in
// fullscreen video. Toggled live by `window.__fluxDark(on)`.
(function () {
  var STYLE_ID = "flux-darkmode";
  var INVERT_CSS =
    "html{background-color:#121214!important;color-scheme:dark!important;" +
    "filter:invert(0.92) hue-rotate(180deg) contrast(0.96)!important}" +
    "img,video,canvas,iframe,embed,object,svg image," +
    'twitter-widget,[style*="background-image"]{' +
    "filter:invert(1) hue-rotate(180deg)!important}" +
    "picture img,[style*=\"background-image\"] img,[style*=\"background-image\"] video," +
    "[style*=\"background-image\"] svg,[style*=\"background-image\"] [style*=\"background-image\"]," +
    ":fullscreen,:-webkit-full-screen{filter:none!important}";
  var NATIVE_DARK_CSS = "html{color-scheme:dark!important}";

  var active = false;
  var obs = null;
  var checkTimer = 0;

  function parseBg(el) {
    if (!el) return null;
    try {
      var bg = getComputedStyle(el).backgroundColor;
      var m = bg && bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/i);
      if (!m) return null;
      var a = m[4] !== undefined ? parseFloat(m[4]) : 1;
      if (!isFinite(a) || a <= 0.35) return null;
      return (0.2126 * parseFloat(m[1]) + 0.7152 * parseFloat(m[2]) + 0.0722 * parseFloat(m[3])) / 255;
    } catch (e) {
      return null;
    }
  }

  function isAlreadyDark() {
    try {
      var lum = parseBg(document.body);
      if (lum === null) lum = parseBg(document.documentElement);
      if (lum !== null) return lum < 0.28;
      var meta = document.querySelector('meta[name="color-scheme"]');
      var content = meta ? (meta.getAttribute("content") || "").trim() : "";
      return /^\s*(?:only\s+)?dark\b/i.test(content);
    } catch (e) {
      return false;
    }
  }

  function applyStyle() {
    if (!active) return;
    try {
      var d = document;
      var s = d.getElementById(STYLE_ID);
      var next = isAlreadyDark() ? NATIVE_DARK_CSS : INVERT_CSS;
      if (!s) {
        s = d.createElement("style");
        s.id = STYLE_ID;
      }
      if (s.textContent !== next) s.textContent = next;
      var host = d.head || d.documentElement;
      if (host && !s.parentNode) host.appendChild(s);
    } catch (e) {}
  }

  function scheduleCheck() {
    if (!active || checkTimer) return;
    checkTimer = setTimeout(function () {
      checkTimer = 0;
      applyStyle();
    }, 120);
  }

  function startWatch() {
    if (obs || typeof MutationObserver === "undefined") return;
    try {
      obs = new MutationObserver(scheduleCheck);
      var opts = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-mode", "theme"] };
      if (document.documentElement) obs.observe(document.documentElement, opts);
      if (document.body) obs.observe(document.body, opts);
      document.addEventListener("DOMContentLoaded", onReady, { once: true });
      window.addEventListener("load", applyStyle, { once: true });
    } catch (e) {}
  }

  function onReady() {
    applyStyle();
    if (active && obs && document.body) {
      try {
        obs.observe(document.body, {
          attributes: true,
          attributeFilter: ["class", "style", "data-theme", "data-color-mode", "theme"],
        });
      } catch (e) {}
    }
  }

  function stopWatch() {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = 0;
    }
    if (obs) {
      obs.disconnect();
      obs = null;
    }
    document.removeEventListener("DOMContentLoaded", onReady);
    window.removeEventListener("load", applyStyle);
  }

  window.__fluxDark = function (on) {
    active = !!on;
    try {
      if (active) {
        applyStyle();
        startWatch();
      } else {
        stopWatch();
        var s = document.getElementById(STYLE_ID);
        if (s && s.parentNode) s.parentNode.removeChild(s);
      }
    } catch (e) {}
  };

  if (window.__FLUX_DARK__) window.__fluxDark(true);
})();
