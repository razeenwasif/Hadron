import { crumbs } from "../filepaths";

export interface Breadcrumb {
  label: string;
  path: string;
}

export interface TagColorDef {
  name: string;
  bit: number;
  hex: string;
}

export const FINDER_TAG_COLORS: readonly TagColorDef[] = [
  { name: "Red", bit: 6, hex: "#f87171" },
  { name: "Orange", bit: 7, hex: "#fb923c" },
  { name: "Yellow", bit: 5, hex: "#facc15" },
  { name: "Green", bit: 2, hex: "#4ade80" },
  { name: "Blue", bit: 4, hex: "#60a5fa" },
  { name: "Purple", bit: 3, hex: "#c084fc" },
  { name: "Gray", bit: 1, hex: "#94a3b8" },
] as const;

export function hasTagColor(tagMask: number, bit: number): boolean {
  return (tagMask & (1 << (bit - 1))) !== 0;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = bytes;
  let unit = 0;
  while (val >= 1024 && unit < units.length - 1) {
    val /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(val)} B` : `${val.toFixed(val < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDate(ms: number, nowMs = Date.now()): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  const now = new Date(nowMs);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (ms >= startToday && ms < startToday + 86_400_000) {
    return `Today ${hhmm}`;
  }
  if (ms >= startToday - 86_400_000 && ms < startToday) {
    return `Yesterday ${hhmm}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  }
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function parseBreadcrumbs(
  location: string,
  scheme: "local" | "remote" | "archive" | string,
  site?: string | null,
): Breadcrumb[] {
  if (scheme === "remote" || location.startsWith("remote://")) {
    const rest = location.replace(/^remote:\/\//, "").replace(/^\/+/, "");
    const slash = rest.indexOf("/");
    const siteId = site || (slash >= 0 ? rest.slice(0, slash) : rest);
    const posix = slash >= 0 ? rest.slice(slash) : "/";
    const out: Breadcrumb[] = [{ label: siteId || "remote", path: `remote://${siteId}/` }];
    let acc = "";
    for (const seg of posix.split("/").filter(Boolean)) {
      acc += `/${seg}`;
      out.push({ label: seg, path: `remote://${siteId}${acc}` });
    }
    return out;
  }

  if (scheme === "archive" || location.startsWith("archive://")) {
    const rest = location.replace(/^archive:\/\//, "");
    const bang = rest.indexOf("!");
    const archPath = bang >= 0 ? rest.slice(0, bang) : rest;
    const inner = bang >= 0 ? rest.slice(bang + 1).replace(/^\/+|\/+$/g, "") : "";
    const hostCrumbs = crumbs(archPath).map((c, idx, arr) => ({
      label: c.name,
      path: idx === arr.length - 1 ? `archive://${archPath}!` : c.path,
    }));
    let acc = "";
    for (const seg of inner.split("/").filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      hostCrumbs.push({ label: seg, path: `archive://${archPath}!${acc}` });
    }
    return hostCrumbs;
  }

  return crumbs(location).map((c) => ({ label: c.name, path: c.path }));
}

export interface BatchRenamePlanRow {
  from: string;
  oldName: string;
  newName: string;
  changed: boolean;
}

export function buildBatchRenamePlan(
  entries: readonly { name: string; path: string }[],
  opts: {
    find: string;
    replace: string;
    prefix: string;
    suffix: string;
    startNum?: number;
  },
): BatchRenamePlanRow[] {
  const start = opts.startNum ?? 1;
  const padLen = String(start + Math.max(0, entries.length - 1)).length;

  return entries.map((entry, idx) => {
    const dot = entry.name.lastIndexOf(".");
    const hasExt = dot > 0 && dot < entry.name.length - 1;
    let stem = hasExt ? entry.name.slice(0, dot) : entry.name;
    const ext = hasExt ? entry.name.slice(dot) : "";

    if (opts.find) {
      stem = stem.split(opts.find).join(opts.replace);
    }
    const seq = String(start + idx).padStart(Math.max(2, padLen), "0");
    const applySeq = (s: string) => s.replace(/\{n\}/g, seq);
    const nextStem = `${applySeq(opts.prefix)}${stem}${applySeq(opts.suffix)}`;
    const newName = `${nextStem}${ext}`;

    return {
      from: entry.path,
      oldName: entry.name,
      newName,
      changed: newName.length > 0 && newName !== entry.name,
    };
  });
}

export function highlightFuzzyName(
  text: string,
  positions: readonly number[],
): { text: string; hit: boolean }[] {
  if (!text) return [];
  if (!positions.length) return [{ text, hit: false }];

  const posSet = new Set(positions);
  const segs: { text: string; hit: boolean }[] = [];
  let curHit = posSet.has(0);
  let buf = "";

  for (let i = 0; i < text.length; i++) {
    const hit = posSet.has(i);
    if (hit !== curHit && buf) {
      segs.push({ text: buf, hit: curHit });
      buf = "";
    }
    curHit = hit;
    buf += text[i];
  }
  if (buf) segs.push({ text: buf, hit: curHit });
  return segs;
}
