(() => {
  const BAYER = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ];
  const STOPS = [
    [240, 156, 103],
    [232, 130, 85],
    [229, 107, 111],
  ];

  function colorAt(t) {
    const clamped = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
    const i = Math.min(Math.floor(clamped), STOPS.length - 2);
    const f = clamped - i;
    const a = STOPS[i];
    const b = STOPS[i + 1];
    return [
      Math.round((a[0] + (b[0] - a[0]) * f) * 0.34),
      Math.round((a[1] + (b[1] - a[1]) * f) * 0.34),
      Math.round((a[2] + (b[2] - a[2]) * f) * 0.34),
    ];
  }

  // Subtle Bayer 8x8 dither behind showcase frame
  const ditherCanvas = document.getElementById("heroDither");
  if (ditherCanvas) {
    const ctx = ditherCanvas.getContext("2d");
    let lastW = 0;
    let lastH = 0;
    const drawDither = () => {
      if (!ctx) return;
      const rect = ditherCanvas.getBoundingClientRect();
      const nw = Math.max(1, Math.ceil(rect.width / 2));
      const nh = Math.max(1, Math.ceil(rect.height / 2));
      if (nw === lastW && nh === lastH) return;
      lastW = nw;
      lastH = nh;
      ditherCanvas.width = nw;
      ditherCanvas.height = nh;
      const img = ctx.createImageData(nw, nh);
      const data = img.data;
      const palette = Array.from({ length: nw }, (_, x) => colorAt(x / Math.max(nw - 1, 1)));
      const cx = nw * 0.5;
      const cy = nh * 1.04;
      const rx = nw * 0.68;
      const ry = nh * 0.72;
      for (let y = 0; y < nh; y++) {
        const dy = (y - cy) / ry;
        for (let x = 0; x < nw; x++) {
          const dx = (x - cx) / rx;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= 1) continue;
          const strength = Math.pow(1 - dist, 1.8) * 0.48;
          if (strength * 64 <= BAYER[(y & 7) * 8 + (x & 7)]) continue;
          const c = palette[x];
          const idx = (y * nw + x) * 4;
          data[idx] = c[0];
          data[idx + 1] = c[1];
          data[idx + 2] = c[2];
          data[idx + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };
    drawDither();
    let timer = 0;
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(drawDither, 140);
    }).observe(ditherCanvas);
  }

  // Interactive showcase switcher
  const tabs = document.querySelectorAll(".showcase-tab");
  const showcaseImg = document.getElementById("showcaseImg");
  const showcaseCaption = document.getElementById("showcaseCaption");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      const shot = tab.getAttribute("data-shot");
      const alt = tab.getAttribute("data-alt");
      const caption = tab.getAttribute("data-caption");
      if (showcaseImg && shot) {
        showcaseImg.src = shot;
        if (alt) showcaseImg.alt = alt;
      }
      if (showcaseCaption && caption) {
        showcaseCaption.textContent = caption;
      }
    });
  });

  // Copy build commands
  const copyBtn = document.getElementById("copyBuildBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const text = [
        "git clone https://github.com/razeenwasif/Hadron.git",
        "cd Hadron",
        "bash scripts/install-macos.sh",
      ].join("\n");
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "Copied";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("copied");
        }, 1800);
      } catch {
        copyBtn.textContent = "Select text";
      }
    });
  }

  // Live GitHub Releases API hydration (graceful fallback if rate-limited/offline)
  fetch("https://api.github.com/repos/razeenwasif/Hadron/releases/latest", {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((rel) => {
      if (!rel || !rel.tag_name) return;
      const navTag = document.getElementById("navTag");
      const relTag = document.getElementById("releaseTag");
      const relAsset = document.getElementById("releaseAssetName");
      const relSize = document.getElementById("releaseSize");
      const relDate = document.getElementById("releaseDate");
      const dlBtn = document.getElementById("downloadAssetBtn");

      if (navTag) navTag.textContent = rel.tag_name;
      if (relTag) relTag.textContent = rel.tag_name;
      if (dlBtn && rel.html_url) dlBtn.href = rel.html_url;

      const archive = Array.isArray(rel.assets)
        ? rel.assets.find((a) => a.name && a.name.endsWith(".tar.gz")) || rel.assets[0]
        : null;
      if (archive) {
        if (relAsset) relAsset.textContent = `Asset: ${archive.name}`;
        if (relSize && typeof archive.size === "number") {
          const mb = (archive.size / (1024 * 1024)).toFixed(1);
          relSize.textContent = `Size: ${mb} MB`;
        }
      }
      if (relDate && rel.published_at) {
        const d = new Date(rel.published_at);
        if (!Number.isNaN(d.getTime())) {
          relDate.textContent = `Published: ${d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}`;
        }
      }
    })
    .catch(() => {
      /* keep static fallback */
    });
})();
