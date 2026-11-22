// Cited passage(s) and agent callouts, shown on their page (cite.rs): run in
// Flux's own JavaScript world (pagejs.rs), so the page neither sees them nor
// answers for them. ARGS is {"text": "…", "n": 2}, {"items": [{n, text,
// selector?}], "scroll"?: bool}, or {"clear": true}.
// Uses CSS Custom Highlights + a closed shadow root (unreachable by page CSS).
const ARGS = __ARGS__;
const NAME = "flux-cite";
const doc = document;
doc.getElementById("flux-cite-badge")?.remove();
doc.getElementById("flux-cite-layer")?.remove();
window.__fluxCiteFollow?.disconnect();
const highlights = window.CSS && CSS.highlights;
if (highlights) highlights.delete(NAME);
if (ARGS.clear) return "cleared";
if (!doc.body) return Array.isArray(ARGS.items) ? JSON.stringify({ shown: [], missing: [] }) : "not_found";

if (!doc.getElementById("flux-cite-style")) {
  const st = doc.createElement("style");
  st.id = "flux-cite-style";
  st.textContent = `::highlight(${NAME}) { background-color: rgba(209, 0, 209, 0.2); }`;
  (doc.head || doc.documentElement).appendChild(st);
}

// Build normalized whitespace-stripped text map once per invocation (lazy).
let textIndex = null;
const buildIndex = () => {
  if (textIndex) return textIndex;
  const nodes = [];
  const offs = [];
  const idx = [];
  let flat = "";
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      return /\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let n; (n = walker.nextNode()); ) {
    const k = nodes.push(n) - 1;
    const d = n.data;
    for (let i = 0; i < d.length; i++) {
      if (/\s/.test(d[i])) continue;
      flat += d[i].toLowerCase();
      idx.push(k);
      offs.push(i);
    }
  }
  textIndex = { nodes, offs, idx, flat };
  return textIndex;
};

const findRange = (rawText) => {
  const needle = String(rawText || "").replace(/\s+/g, "").toLowerCase();
  if (!needle) return null;
  const { nodes, offs, idx, flat } = buildIndex();
  let at = flat.indexOf(needle);
  let len = needle.length;
  // A passage that changed a little since it was read: its opening still places it.
  if (at < 0 && needle.length > 80) {
    at = flat.indexOf(needle.slice(0, 80));
    len = 80;
  }
  if (at < 0) return null;
  const range = doc.createRange();
  range.setStart(nodes[idx[at]], offs[at]);
  range.setEnd(nodes[idx[at + len - 1]], offs[at + len - 1] + 1);
  return range;
};

const watchLayout = (ignoreEl, place) => {
  place();
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      place();
    });
  };
  const obs = new ResizeObserver(soon);
  obs.observe(doc.body);
  const moved = new MutationObserver((records) => {
    if (records.some((r) => r.target !== ignoreEl)) soon();
  });
  moved.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  });
  window.__fluxCiteFollow = {
    disconnect() {
      obs.disconnect();
      moved.disconnect();
    },
  };
};

if (Array.isArray(ARGS.items)) {
  const BLOCK_SEL = "tr, li, article, p, h1, h2, h3, h4, h5, h6, a, div, blockquote, pre";
  const promoteTarget = (range, selector) => {
    if (selector) {
      try {
        const el = doc.querySelector(selector);
        const r = el?.getBoundingClientRect();
        if (r && r.width > 2 && r.height > 2) return el;
      } catch {}
    }
    if (!range) return null;
    let cur =
      range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    for (let depth = 0; cur && cur !== doc.body && depth < 5; depth++, cur = cur.parentElement) {
      if (!cur.matches?.(BLOCK_SEL)) continue;
      const r = cur.getBoundingClientRect();
      if (r.width >= 60 && r.height >= 14 && r.height <= 260) return cur;
    }
    return null;
  };

  const shown = [];
  const missing = [];
  const entries = [];
  const ranges = [];
  for (const item of ARGS.items.slice(0, 12)) {
    const n = Number(item?.n || entries.length + 1);
    const range = findRange(item?.text);
    const target = promoteTarget(range, item?.selector);
    if (!range && !target) {
      missing.push(n);
      continue;
    }
    if (range) ranges.push(range);
    shown.push(n);
    entries.push({ n, range, target });
  }

  if (ranges.length && highlights && window.Highlight) {
    highlights.set(NAME, new Highlight(...ranges));
  }

  if (entries.length) {
    const layer = doc.createElement("div");
    layer.id = "flux-cite-layer";
    layer.style.cssText =
      "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
    const root = layer.attachShadow({ mode: "closed" });

    for (const e of entries) {
      const box = doc.createElement("div");
      box.style.cssText =
        "position:absolute;border:1.5px solid rgba(120,120,130,0.52);background:rgba(128,128,136,0.07);border-radius:8px;box-sizing:border-box;";
      const badge = doc.createElement("span");
      badge.textContent = String(e.n);
      badge.style.cssText =
        "position:absolute;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:999px;background:#111114;color:#fff;border:1px solid rgba(255,255,255,0.22);font:700 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.28);";
      e.box = box;
      e.badge = badge;
      root.append(box, badge);
    }

    const rectOf = (e) => {
      const r = e.target ? e.target.getBoundingClientRect() : e.range?.getBoundingClientRect();
      return r && r.width >= 1 && r.height >= 1 ? r : null;
    };

    const place = () => {
      for (const e of entries) {
        const r = rectOf(e);
        if (!r) {
          e.box.style.display = "none";
          e.badge.style.display = "none";
          continue;
        }
        e.box.style.display = "";
        e.badge.style.display = "inline-flex";
        e.box.style.left = `${Math.max(2, r.left + scrollX - 6)}px`;
        e.box.style.top = `${r.top + scrollY - 3}px`;
        e.box.style.width = `${r.width + 12}px`;
        e.box.style.height = `${r.height + 6}px`;
        e.badge.style.left = `${Math.max(4, r.left + scrollX - 30)}px`;
        e.badge.style.top = `${r.top + scrollY + Math.max(0, (r.height - 20) / 2)}px`;
      }
    };

    doc.body.appendChild(layer);
    watchLayout(layer, place);
    if (ARGS.scroll !== false) {
      const firstRect = rectOf(entries[0]);
      if (firstRect) scrollTo({ top: Math.max(0, firstRect.top + scrollY - innerHeight / 3), behavior: "smooth" });
    }
  }
  return JSON.stringify({ shown, missing });
}

const range = findRange(ARGS.text);
if (!range) return "not_found";
if (highlights && window.Highlight) {
  highlights.set(NAME, new Highlight(range));
} else {
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

const first = range.getClientRects()[0] || range.getBoundingClientRect();
scrollTo({ top: Math.max(0, first.top + scrollY - innerHeight / 3), behavior: "smooth" });

// The number, at the passage's start, in a closed shadow root the page's CSS
// can't reach.
const badge = doc.createElement("div");
badge.id = "flux-cite-badge";
badge.style.cssText = "all:initial;position:absolute;z-index:2147483646;pointer-events:none;";
const root = badge.attachShadow({ mode: "closed" });
const dot = doc.createElement("span");
dot.textContent = String(ARGS.n || "");
dot.style.cssText =
  "display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#d100d1;color:#fff;font:600 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3)";
root.appendChild(dot);
doc.body.appendChild(badge);
watchLayout(badge, () => {
  const r = range.getClientRects()[0];
  if (!r) return;
  badge.style.left = `${Math.max(0, r.left + scrollX - 24)}px`;
  badge.style.top = `${r.top + scrollY + (r.height - 18) / 2}px`;
});
return "shown";
