import "./NeutronView.css";

import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";

import { toFileUrl } from "./filepaths";
import { isPdfUrl, pdfViewerUrl } from "./ipc";
import {
  FINDER_TAG_COLORS,
  buildBatchRenamePlan,
  formatBytes,
  formatDate,
  hasTagColor,
  highlightFuzzyName,
  parseBreadcrumbs,
} from "./neutron/format";
import {
  type FuzzyHit,
  type NeutronEntry,
  type NeutronListing,
  type NeutronPlace,
  type NeutronPlaces,
  type PreviewData,
  type RecentFile,
  type SortBy,
  type SortDir,
  neutronArchiveCreate,
  neutronArchiveExtract,
  neutronBatchRename,
  neutronCopy,
  neutronCreateFile,
  neutronDelete,
  neutronFuzzy,
  neutronList,
  neutronMkdir,
  neutronMove,
  neutronOpen,
  neutronPinToggle,
  neutronPlaces,
  neutronPreview,
  neutronRecent,
  neutronRename,
  neutronReveal,
  neutronTagToggle,
  neutronTrash,
  neutronUndo,
  neutronUnwatch,
  neutronWatch,
  onNeutronWatch,
} from "./neutron/ipc";
import { openTab } from "./store";

export interface NeutronViewProps {
  id: number;
  path: string;
  onPathChange: (path: string) => void;
  onOpenInTab?: (url: string) => void;
}

type ViewMode = "list" | "miller" | "grid";

const VIEW_KEY = "flux.neutron.view";
const HIDDEN_KEY = "flux.neutron.hidden";
const INSPECTOR_KEY = "flux.neutron.inspector";
const SIDEBAR_KEY = "flux.neutron.sidebar";
const ROW_H = 30;
const OVERSCAN = 12;

interface MenuState {
  x: number;
  y: number;
  entry: NeutronEntry | null;
}

interface PromptState {
  mode: "mkdir" | "file" | "rename";
  label: string;
  value: string;
  targetPath?: string;
}

const EntryIcon: Component<{ kind: NeutronEntry["kind"]; size?: number }> = (p) => {
  const s = () => p.size ?? 15;
  if (p.kind === "dir") {
    return (
      <svg width={s()} height={s()} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.1l1.2 1.3H13c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2Z"
          fill="rgba(118, 169, 250, 0.22)"
          stroke="#7aa8f8"
          stroke-width="1.2"
        />
      </svg>
    );
  }
  if (p.kind === "archive") {
    return (
      <svg width={s()} height={s()} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="#d4a75a" stroke-width="1.2" />
        <path d="M8 3v10M6.5 5.5h3M6.5 8h3M6.5 10.5h3" stroke="#d4a75a" stroke-width="1.2" />
      </svg>
    );
  }
  if (p.kind === "symlink") {
    return (
      <svg width={s()} height={s()} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M6.5 9.5 9.5 6.5M6 5.5H4.2a2.2 2.2 0 1 0 0 4.4H6M10 6h1.8a2.2 2.2 0 1 1 0 4.4H10"
          stroke="#8bd5ca"
          stroke-width="1.2"
          stroke-linecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width={s()} height={s()} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.8 2.2h5.5l2.9 2.9v8.7a.8.8 0 0 1-.8.8H3.8a.8.8 0 0 1-.8-.8V3a.8.8 0 0 1 .8-.8Z"
        stroke="#858b9c"
        stroke-width="1.2"
      />
      <path d="M9 2.4v3h3" stroke="#858b9c" stroke-width="1.2" />
    </svg>
  );
};

const NeutronView: Component<NeutronViewProps> = (props) => {
  let rootEl!: HTMLDivElement;
  let scrollEl!: HTMLDivElement;
  let millerEl!: HTMLDivElement;
  let filterInputEl!: HTMLInputElement;

  const [places, setPlaces] = createSignal<NeutronPlaces>({
    known: [],
    pins: [],
    drives: [],
    cloud: [],
    servers: [],
  });
  const [recentFiles, setRecentFiles] = createSignal<RecentFile[]>([]);
  const [showDashboard, setShowDashboard] = createSignal(false);
  const [listing, setListing] = createSignal<NeutronListing | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [statusNote, setStatusNote] = createSignal<string | null>(null);

  const [viewMode, setViewMode] = createSignal<ViewMode>(
    (localStorage.getItem(VIEW_KEY) as ViewMode) || "list",
  );
  const [sortBy, setSortBy] = createSignal<SortBy>("name");
  const [sortDir, setSortDir] = createSignal<SortDir>("asc");
  const [showHidden, setShowHidden] = createSignal(localStorage.getItem(HIDDEN_KEY) === "1");
  const [filter, setFilter] = createSignal("");
  const [showInspector, setShowInspector] = createSignal(
    localStorage.getItem(INSPECTOR_KEY) !== "0",
  );
  const [showSidebar, setShowSidebar] = createSignal(localStorage.getItem(SIDEBAR_KEY) !== "0");

  const [backStack, setBackStack] = createSignal<string[]>([]);
  const [fwdStack, setFwdStack] = createSignal<string[]>([]);
  const [editingPath, setEditingPath] = createSignal(false);
  const [pathDraft, setPathDraft] = createSignal("");

  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [cursorPath, setCursorPath] = createSignal<string | null>(null);
  const [anchorIdx, setAnchorIdx] = createSignal<number>(0);

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(540);

  const [millerCols, setMillerCols] = createSignal<
    { path: string; label: string; entries: NeutronEntry[] }[]
  >([]);

  const [preview, setPreview] = createSignal<PreviewData | null>(null);
  const [clipboard, setClipboard] = createSignal<{ mode: "copy" | "cut"; paths: string[] } | null>(
    null,
  );

  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [promptState, setPromptState] = createSignal<PromptState | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string[] | null>(null);

  // Fuzzy Finder (⌘P)
  const [fuzzyOpen, setFuzzyOpen] = createSignal(false);
  const [fuzzyQuery, setFuzzyQuery] = createSignal("");
  const [fuzzyHits, setFuzzyHits] = createSignal<FuzzyHit[]>([]);
  const [fuzzyIdx, setFuzzyIdx] = createSignal(0);

  // Batch Rename Modal
  const [batchOpen, setBatchOpen] = createSignal(false);
  const [batchFind, setBatchFind] = createSignal("");
  const [batchReplace, setBatchReplace] = createSignal("");
  const [batchPrefix, setBatchPrefix] = createSignal("");
  const [batchSuffix, setBatchSuffix] = createSignal("");

  let activeWatchId: number | null = null;
  let watchPath: string | null = null;
  let watchGen = 0;
  let disposed = false;
  let previewTimer: number | null = null;

  const entries = createMemo(() => listing()?.entries ?? []);
  const currentLocation = createMemo(() => listing()?.location ?? (props.path || "~"));
  const currentScheme = createMemo(() => listing()?.scheme ?? "local");
  const isLocal = createMemo(() => currentScheme() === "local");

  const breadcrumbs = createMemo(() => {
    const l = listing();
    if (!l) return [];
    return parseBreadcrumbs(l.location, l.scheme, l.site);
  });

  const primarySelected = createMemo(() => {
    const cur = cursorPath();
    const sel = selected();
    const list = entries();
    if (cur) {
      const found = list.find((e) => e.path === cur);
      if (found) return found;
    }
    if (sel.size > 0) {
      const first = sel.values().next().value;
      const found = list.find((e) => e.path === first);
      if (found) return found;
    }
    return null;
  });

  const selectedList = createMemo(() => {
    const sel = selected();
    const list = entries();
    return list.filter((e) => sel.has(e.path));
  });

  const isCurrentPinned = createMemo(() => {
    const loc = currentLocation();
    return places().pins.some((p) => p.path === loc);
  });

  const refreshPlaces = async () => {
    try {
      const next = await neutronPlaces();
      if (!disposed) setPlaces(next);
    } catch {
      // Ignore places enumeration error during preview/boot.
    }
  };

  const refreshRecent = async () => {
    try {
      const next = await neutronRecent();
      if (!disposed) setRecentFiles(next);
    } catch {
      // Ignore recent-files enumeration error during preview/boot.
    }
  };

  const syncWatch = async (loc: string, scheme: string) => {
    const gen = ++watchGen;
    if (watchPath === loc && activeWatchId !== null) return;
    if (activeWatchId !== null) {
      const staleId = activeWatchId;
      activeWatchId = null;
      watchPath = null;
      void neutronUnwatch(staleId);
    }
    if (scheme !== "local" || !loc) return;
    try {
      const id = await neutronWatch(loc);
      if (disposed || gen !== watchGen) {
        void neutronUnwatch(id);
        return;
      }
      activeWatchId = id;
      watchPath = loc;
    } catch {
      // Watching may be unsupported on virtual/unreadable paths.
    }
  };

  const openDashboard = () => {
    setMenu(null);
    setEditingPath(false);
    setErr(null);
    setShowDashboard(true);
    void syncWatch("", "dashboard");
    void refreshPlaces();
    void refreshRecent();
  };

  const loadDirectory = async (
    targetLoc: string,
    opts?: { pushHistory?: boolean; focusPath?: string },
  ) => {
    const loc = targetLoc.trim() || "~";
    const prevLoc = listing()?.location;
    setShowDashboard(false);
    setLoading(true);
    setErr(null);

    try {
      const res = await neutronList({
        location: loc,
        sortBy: sortBy(),
        sortDir: sortDir(),
        dirsFirst: true,
        showHidden: showHidden(),
        filter: filter(),
      });
      if (disposed) return;

      if (opts?.pushHistory && prevLoc && prevLoc !== res.location) {
        setBackStack((s) => [...s.slice(-49), prevLoc]);
        setFwdStack([]);
      }

      setListing(res);
      if (res.location !== props.path) {
        props.onPathChange(res.location);
      }

      if (opts?.focusPath && res.entries.some((e) => e.path === opts.focusPath)) {
        setSelected(new Set([opts.focusPath]));
        setCursorPath(opts.focusPath);
      } else {
        setSelected(new Set<string>());
        setCursorPath(null);
      }
      if (scrollEl) scrollEl.scrollTop = 0;

      void syncWatch(res.location, res.scheme);
    } catch (e) {
      if (!disposed) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!disposed) setLoading(false);
    }
  };

  const refreshCurrent = async (focusPath?: string) => {
    await loadDirectory(currentLocation(), { focusPath });
  };

  // Load Miller column chain whenever in Miller mode and listing changes.
  createEffect(() => {
    const l = listing();
    if (viewMode() !== "miller" || !l) return;
    const crumbs = parseBreadcrumbs(l.location, l.scheme, l.site);
    const tail = crumbs.slice(-4);
    let cancelled = false;
    (async () => {
      const loaded = await Promise.all(
        tail.map(async (c, idx) => {
          if (idx === tail.length - 1) {
            return { path: c.path, label: c.label, entries: l.entries };
          }
          try {
            const sub = await neutronList({
              location: c.path,
              sortBy: sortBy(),
              sortDir: sortDir(),
              dirsFirst: true,
              showHidden: showHidden(),
            });
            return { path: c.path, label: c.label, entries: sub.entries };
          } catch {
            return { path: c.path, label: c.label, entries: [] as NeutronEntry[] };
          }
        }),
      );
      if (!cancelled) {
        setMillerCols(loaded);
        requestAnimationFrame(() => {
          if (millerEl) millerEl.scrollLeft = millerEl.scrollWidth;
        });
      }
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });

  // Load preview for active item when Inspector is open.
  createEffect(() => {
    if (!showInspector()) return;
    const item = primarySelected();
    const target = item?.path ?? currentLocation();
    if (previewTimer !== null) clearTimeout(previewTimer);
    previewTimer = window.setTimeout(async () => {
      try {
        const data = await neutronPreview(target);
        if (!disposed) setPreview(data);
      } catch {
        if (!disposed) setPreview(null);
      }
    }, 60);
  });

  // React to sort / hidden / filter changes without pushing history.
  let initialized = false;
  createEffect(() => {
    sortBy();
    sortDir();
    showHidden();
    filter();
    if (!initialized || showDashboard()) return;
    void loadDirectory(currentLocation());
  });

  // React to external prop navigation (when user pastes/navigates tab URL).
  createEffect(() => {
    const nextPath = props.path?.trim();
    if (!initialized || !nextPath) return;
    if (nextPath !== listing()?.location) {
      void loadDirectory(nextPath);
    }
  });

  onMount(() => {
    initialized = true;
    void refreshPlaces();
    const initial = props.path?.trim() || places().known[0]?.path || "~";
    void loadDirectory(initial);

    let watchDebounce: number | null = null;
    let unWatch: (() => void) | null = null;
    void onNeutronWatch((payload) => {
      if (disposed || payload.path !== currentLocation()) return;
      if (watchDebounce !== null) clearTimeout(watchDebounce);
      watchDebounce = window.setTimeout(() => void refreshCurrent(), 180);
    })
      .then((fn) => {
        unWatch = fn;
      })
      .catch(() => {});

    let ro: ResizeObserver | null = null;
    if (scrollEl) {
      setViewportH(scrollEl.clientHeight || 540);
      ro = new ResizeObserver(() => {
        if (scrollEl) setViewportH(scrollEl.clientHeight || 540);
      });
      ro.observe(scrollEl);
    }

    onCleanup(() => {
      disposed = true;
      ro?.disconnect();
      unWatch?.();
      if (watchDebounce !== null) clearTimeout(watchDebounce);
      if (previewTimer !== null) clearTimeout(previewTimer);
      if (activeWatchId !== null) {
        void neutronUnwatch(activeWatchId);
        activeWatchId = null;
      }
    });
  });

  const navigate = (loc: string, pushHistory = true) => {
    setMenu(null);
    setEditingPath(false);
    void loadDirectory(loc, { pushHistory });
  };

  const goBack = () => {
    const b = backStack();
    if (!b.length) return;
    const prev = b[b.length - 1]!;
    setBackStack(b.slice(0, -1));
    setFwdStack((f) => [...f, currentLocation()]);
    void loadDirectory(prev);
  };

  const goForward = () => {
    const f = fwdStack();
    if (!f.length) return;
    const next = f[f.length - 1]!;
    setFwdStack(f.slice(0, -1));
    setBackStack((b) => [...b, currentLocation()]);
    void loadDirectory(next);
  };

  const goUp = () => {
    const p = listing()?.parent;
    if (p) navigate(p, true);
  };

  const openEntry = (entry: NeutronEntry) => {
    if (entry.kind === "dir") {
      navigate(entry.path, true);
      return;
    }
    if (entry.kind === "archive" && isLocal()) {
      navigate(`archive://${entry.path}!`, true);
      return;
    }
    if (isLocal() && entry.kind === "file") {
      const fileUrl = toFileUrl(entry.path);
      if (isPdfUrl(fileUrl) && props.onOpenInTab) {
        props.onOpenInTab(pdfViewerUrl(fileUrl));
        return;
      }
    }
    if (isLocal()) {
      void neutronOpen(entry.path).catch((e) => setErr(String(e)));
    } else {
      setStatusNote("Remote files cannot be opened in-place yet");
    }
  };

  const selectEntry = (entry: NeutronEntry, index: number, e?: MouseEvent) => {
    setMenu(null);
    if (e?.metaKey || e?.ctrlKey) {
      const next = new Set(selected());
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      setSelected(next);
      setCursorPath(entry.path);
      setAnchorIdx(index);
      return;
    }
    if (e?.shiftKey) {
      const list = entries();
      const lo = Math.min(anchorIdx(), index);
      const hi = Math.max(anchorIdx(), index);
      const next = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const it = list[i];
        if (it) next.add(it.path);
      }
      setSelected(next);
      setCursorPath(entry.path);
      return;
    }
    setSelected(new Set([entry.path]));
    setCursorPath(entry.path);
    setAnchorIdx(index);
  };

  const toggleSort = (col: SortBy) => {
    if (sortBy() === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir(col === "size" || col === "modified" ? "desc" : "asc");
    }
  };

  const switchView = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem(VIEW_KEY, mode);
  };

  const toggleHidden = () => {
    const next = !showHidden();
    setShowHidden(next);
    localStorage.setItem(HIDDEN_KEY, next ? "1" : "0");
  };

  const toggleInspector = () => {
    const next = !showInspector();
    setShowInspector(next);
    localStorage.setItem(INSPECTOR_KEY, next ? "1" : "0");
  };

  const toggleSidebar = () => {
    const next = !showSidebar();
    setShowSidebar(next);
    localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
  };

  const handlePinCurrent = async () => {
    const loc = currentLocation();
    const l = listing();
    const site = l?.scheme === "remote" ? l.site : null;
    try {
      await neutronPinToggle(loc, site);
      await refreshPlaces();
    } catch (e) {
      setErr(String(e));
    }
  };

  const openInTachyon = (targetPath?: string) => {
    const p = targetPath ?? (primarySelected()?.kind === "dir" ? primarySelected()!.path : currentLocation());
    if (p.startsWith("remote://") || p.startsWith("archive://")) {
      setStatusNote("Open in Tachyon works on local directories");
      return;
    }
    void openTab("terminal", p);
  };

  const submitPrompt = async (val: string) => {
    const p = promptState();
    const trimmed = val.trim();
    setPromptState(null);
    if (!p || !trimmed) return;
    try {
      if (p.mode === "mkdir") {
        const created = await neutronMkdir(currentLocation(), trimmed);
        await refreshCurrent(created);
      } else if (p.mode === "file") {
        const created = await neutronCreateFile(currentLocation(), trimmed);
        await refreshCurrent(created);
      } else if (p.mode === "rename" && p.targetPath) {
        const renamed = await neutronRename(p.targetPath, trimmed);
        await refreshCurrent(renamed);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const performPaste = async () => {
    const cb = clipboard();
    if (!cb || !cb.paths.length || !isLocal()) return;
    try {
      if (cb.mode === "copy") {
        await neutronCopy(cb.paths, currentLocation());
      } else {
        await neutronMove(cb.paths, currentLocation());
        setClipboard(null);
      }
      await refreshCurrent();
    } catch (e) {
      setErr(String(e));
    }
  };

  const performTrash = async (paths: string[]) => {
    if (!paths.length || !isLocal()) return;
    try {
      await neutronTrash(paths);
      setStatusNote(`Moved ${paths.length} item(s) to Trash`);
      await refreshCurrent();
    } catch (e) {
      setErr(String(e));
    }
  };

  const performPermanentDelete = async (paths: string[]) => {
    setConfirmDelete(null);
    if (!paths.length) return;
    try {
      await neutronDelete(paths);
      setStatusNote(`Deleted ${paths.length} item(s)`);
      await refreshCurrent();
    } catch (e) {
      setErr(String(e));
    }
  };

  const performUndo = async () => {
    try {
      const msg = await neutronUndo();
      if (msg) {
        setStatusNote(msg);
        await refreshCurrent();
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  // Fuzzy modal search effect
  let fuzzyDebounce: number | null = null;
  createEffect(() => {
    if (!fuzzyOpen()) return;
    const q = fuzzyQuery();
    const root = isLocal() ? currentLocation() : places().known[0]?.path || "~";
    if (fuzzyDebounce !== null) clearTimeout(fuzzyDebounce);
    fuzzyDebounce = window.setTimeout(async () => {
      try {
        const hits = await neutronFuzzy(root, q, 60);
        if (!disposed) {
          setFuzzyHits(hits);
          setFuzzyIdx(0);
        }
      } catch {
        if (!disposed) setFuzzyHits([]);
      }
    }, 35);
    onCleanup(() => {
      if (fuzzyDebounce !== null) clearTimeout(fuzzyDebounce);
    });
  });

  const acceptFuzzyHit = (hit: FuzzyHit) => {
    setFuzzyOpen(false);
    if (hit.is_dir) {
      navigate(hit.path, true);
    } else if (hit.parent) {
      void loadDirectory(hit.parent, { pushHistory: true, focusPath: hit.path });
    }
  };

  const batchPlan = createMemo(() =>
    buildBatchRenamePlan(selectedList(), {
      find: batchFind(),
      replace: batchReplace(),
      prefix: batchPrefix(),
      suffix: batchSuffix(),
    }),
  );

  const applyBatchRename = async () => {
    const pairs = batchPlan()
      .filter((r) => r.changed)
      .map((r) => {
        const slash = r.from.lastIndexOf("/");
        const dir = slash >= 0 ? r.from.slice(0, slash) : currentLocation();
        return { from: r.from, to: `${dir}/${r.newName}` };
      });
    setBatchOpen(false);
    if (!pairs.length) return;
    try {
      const res = await neutronBatchRename(pairs);
      setStatusNote(
        res.errors.length
          ? `Renamed ${res.renamed} (${res.errors.length} error)`
          : `Renamed ${res.renamed} item(s)`,
      );
      await refreshCurrent();
    } catch (e) {
      setErr(String(e));
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
    const inInput = activeTag === "INPUT" || activeTag === "TEXTAREA";

    if (e.key === "Escape") {
      if (menu()) return setMenu(null);
      if (fuzzyOpen()) return setFuzzyOpen(false);
      if (batchOpen()) return setBatchOpen(false);
      if (confirmDelete()) return setConfirmDelete(null);
      if (promptState()) return setPromptState(null);
      if (editingPath()) return setEditingPath(false);
      if (filter()) return setFilter("");
      return;
    }

    if (fuzzyOpen()) {
      const hits = fuzzyHits();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFuzzyIdx((i) => Math.min(hits.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFuzzyIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter" && hits[fuzzyIdx()]) {
        e.preventDefault();
        acceptFuzzyHit(hits[fuzzyIdx()]!);
      }
      return;
    }

    if (inInput) return;

    if (e.metaKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      setFuzzyQuery("");
      setFuzzyOpen(true);
      return;
    }
    if (e.metaKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      filterInputEl?.focus();
      return;
    }
    if (e.metaKey && e.key === ".") {
      e.preventDefault();
      toggleHidden();
      return;
    }
    if (e.metaKey && e.key === "[") {
      e.preventDefault();
      goBack();
      return;
    }
    if (e.metaKey && e.key === "]") {
      e.preventDefault();
      goForward();
      return;
    }
    if (e.metaKey && e.key === "ArrowUp") {
      e.preventDefault();
      goUp();
      return;
    }
    if (e.metaKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(entries().map((x) => x.path)));
      return;
    }
    if (e.metaKey && e.key.toLowerCase() === "c") {
      const paths = [...selected()];
      if (paths.length) {
        e.preventDefault();
        setClipboard({ mode: "copy", paths });
        setStatusNote(`Copied ${paths.length} item(s)`);
      }
      return;
    }
    if (e.metaKey && e.key.toLowerCase() === "x") {
      const paths = [...selected()];
      if (paths.length) {
        e.preventDefault();
        setClipboard({ mode: "cut", paths });
        setStatusNote(`Cut ${paths.length} item(s)`);
      }
      return;
    }
    if (e.metaKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void performPaste();
      return;
    }
    if (e.metaKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      void performUndo();
      return;
    }
    if (e.metaKey && e.key === "Backspace") {
      e.preventDefault();
      const paths = [...selected()];
      if (!paths.length) return;
      if (e.shiftKey) setConfirmDelete(paths);
      else void performTrash(paths);
      return;
    }
    if (e.key === "F2") {
      const target = primarySelected();
      if (target) {
        e.preventDefault();
        setPromptState({
          mode: "rename",
          label: "Rename",
          value: target.name,
          targetPath: target.path,
        });
      }
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      toggleInspector();
      return;
    }
    if (e.key === "Enter") {
      const target = primarySelected();
      if (target) {
        e.preventDefault();
        openEntry(target);
      }
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      goUp();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const list = entries();
      if (!list.length) return;
      e.preventDefault();
      const curIdx = list.findIndex((x) => x.path === cursorPath());
      const nextIdx =
        e.key === "ArrowDown"
          ? Math.min(list.length - 1, curIdx < 0 ? 0 : curIdx + 1)
          : Math.max(0, curIdx < 0 ? 0 : curIdx - 1);
      const item = list[nextIdx];
      if (item) {
        selectEntry(item, nextIdx);
        if (viewMode() === "list" && scrollEl) {
          const top = nextIdx * ROW_H;
          if (top < scrollEl.scrollTop) scrollEl.scrollTop = top;
          else if (top + ROW_H > scrollEl.scrollTop + viewportH()) {
            scrollEl.scrollTop = top + ROW_H - viewportH();
          }
        }
      }
    }
  };

  // Virtual slice indices for List view
  const virtualRange = createMemo(() => {
    const total = entries().length;
    const start = Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN);
    const end = Math.min(total, Math.ceil((scrollTop() + viewportH()) / ROW_H) + OVERSCAN);
    return { total, start, end };
  });

  const visibleRows = createMemo(() => {
    const { start, end } = virtualRange();
    return entries().slice(start, end).map((entry, offset) => ({
      entry,
      index: start + offset,
    }));
  });

  const renderPlaceGroup = (title: string, items: NeutronPlace[]) => (
    <Show when={items.length > 0}>
      <div class="nv-side-group">
        <div class="nv-side-head">{title}</div>
        <For each={items}>
          {(pl) => {
            const pct =
              pl.capacity_total && pl.capacity_free != null && pl.capacity_total > 0
                ? Math.min(
                    100,
                    Math.round(((pl.capacity_total - pl.capacity_free) / pl.capacity_total) * 100),
                  )
                : null;
            return (
              <button
                classList={{ "nv-place": true, active: !showDashboard() && currentLocation() === pl.path }}
                title={pl.path}
                onClick={() => navigate(pl.path, true)}
              >
                <div class="nv-place-row">
                  <span class="nv-place-name">{pl.name}</span>
                </div>
                <Show when={pct !== null}>
                  <div class="nv-cap-track">
                    <div class="nv-cap-fill" style={{ width: `${pct}%` }} />
                  </div>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );

  return (
    <div
      ref={rootEl}
      class="nv-root"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".nv-row, .nv-tile, .nv-miller-item")) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, entry: null });
      }}
    >
      {/* Top toolbar */}
      <header class="nv-bar">
        <div class="nv-nav-group">
          <button
            class="nv-icon-btn"
            classList={{ active: showSidebar() }}
            title="Toggle sidebar"
            onClick={toggleSidebar}
          >
            ◧
          </button>
          <button
            class="nv-icon-btn"
            classList={{ active: showDashboard() }}
            title="Neutron Dashboard"
            onClick={openDashboard}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2.2" y="2.2" width="4.8" height="4.8" rx="1.1" stroke="currentColor" stroke-width="1.25" />
              <rect x="9" y="2.2" width="4.8" height="4.8" rx="1.1" stroke="currentColor" stroke-width="1.25" />
              <rect x="2.2" y="9" width="4.8" height="4.8" rx="1.1" stroke="currentColor" stroke-width="1.25" />
              <rect x="9" y="9" width="4.8" height="4.8" rx="1.1" stroke="currentColor" stroke-width="1.25" />
            </svg>
          </button>
          <button
            class="nv-icon-btn"
            disabled={!backStack().length}
            title="Back (⌘[)"
            onClick={goBack}
          >
            ←
          </button>
          <button
            class="nv-icon-btn"
            disabled={!fwdStack().length}
            title="Forward (⌘])"
            onClick={goForward}
          >
            →
          </button>
          <button
            class="nv-icon-btn"
            disabled={!listing()?.parent}
            title="Up (⌘↑)"
            onClick={goUp}
          >
            ↑
          </button>
        </div>

        <Show
          when={editingPath()}
          fallback={
            <div
              class="nv-crumbs"
              onDblClick={() => {
                setPathDraft(currentLocation());
                setEditingPath(true);
              }}
            >
              <Show
                when={!showDashboard()}
                fallback={<span class="nv-crumb current">Dashboard</span>}
              >
                <For each={breadcrumbs()}>
                  {(c, i) => (
                    <>
                      <Show when={i() > 0}>
                        <span class="nv-crumb-sep">/</span>
                      </Show>
                      <button
                        classList={{
                          "nv-crumb": true,
                          current: i() === breadcrumbs().length - 1,
                        }}
                        onClick={() => navigate(c.path, true)}
                      >
                        {c.label}
                      </button>
                    </>
                  )}
                </For>
              </Show>
            </div>
          }
        >
          <input
            class="nv-path-input"
            value={pathDraft()}
            autofocus
            onInput={(e) => setPathDraft(e.currentTarget.value)}
            onBlur={() => setEditingPath(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                navigate(pathDraft(), true);
              }
            }}
          />
        </Show>

        <div class="nv-filter-wrap">
          <input
            ref={filterInputEl}
            class="nv-filter-input"
            placeholder="Filter…"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </div>

        <button
          class="nv-chip-btn"
          title="Quick Open Fuzzy Finder (⌘P)"
          onClick={() => {
            setFuzzyQuery("");
            setFuzzyOpen(true);
          }}
        >
          Find <kbd>⌘P</kbd>
        </button>

        <Show when={selectedList().length >= 2 && isLocal()}>
          <button
            class="nv-chip-btn"
            title="Batch rename selected items"
            onClick={() => setBatchOpen(true)}
          >
            Batch Rename ({selectedList().length})
          </button>
        </Show>

        <Show when={isLocal()}>
          <button
            class="nv-chip-btn"
            title="Open current directory in Tachyon terminal"
            onClick={() => openInTachyon(currentLocation())}
          >
            Tachyon
          </button>
        </Show>

        <div class="nv-seg" role="group" aria-label="View mode">
          <button
            classList={{ "nv-seg-btn": true, active: viewMode() === "list" }}
            onClick={() => switchView("list")}
          >
            List
          </button>
          <button
            classList={{ "nv-seg-btn": true, active: viewMode() === "miller" }}
            onClick={() => switchView("miller")}
          >
            Cols
          </button>
          <button
            classList={{ "nv-seg-btn": true, active: viewMode() === "grid" }}
            onClick={() => switchView("grid")}
          >
            Grid
          </button>
        </div>

        <button
          class="nv-icon-btn"
          classList={{ active: isCurrentPinned() }}
          title={isCurrentPinned() ? "Unpin location" : "Pin location"}
          onClick={() => void handlePinCurrent()}
        >
          ★
        </button>
        <button
          class="nv-icon-btn"
          classList={{ active: showHidden() }}
          title="Toggle hidden files (⌘.)"
          onClick={toggleHidden}
        >
          ◌
        </button>
        <button
          class="nv-icon-btn"
          classList={{ active: showInspector() }}
          title="Toggle Inspector (Space)"
          onClick={toggleInspector}
        >
          ◨
        </button>
      </header>

      <div class="nv-body">
        <Show when={showSidebar()}>
          <aside class="nv-side">
            <div class="nv-side-group">
              <button
                classList={{ "nv-place": true, active: showDashboard() }}
                title="Neutron Dashboard"
                onClick={openDashboard}
              >
                <div class="nv-place-row">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="2.2" y="2.2" width="4.8" height="4.8" rx="1.1" stroke="currentColor" stroke-width="1.25" />
                    <rect x="9" y="2.2" width="4.8" height="4.8" rx="1.1" stroke="currentColor" stroke-width="1.25" />
                    <rect x="2.2" y="9" width="4.8" height="4.8" rx="1.1" stroke="currentColor" stroke-width="1.25" />
                    <rect x="9" y="9" width="4.8" height="4.8" rx="1.1" stroke="currentColor" stroke-width="1.25" />
                  </svg>
                  <span class="nv-place-name">Dashboard</span>
                </div>
              </button>
            </div>
            {renderPlaceGroup("Pinned", places().pins)}
            {renderPlaceGroup("Locations", places().known)}
            {renderPlaceGroup("Servers", places().servers)}
            {renderPlaceGroup("Cloud", places().cloud)}
            {renderPlaceGroup("Drives", places().drives)}
          </aside>
        </Show>

        <main class="nv-main">
          <Show
            when={!showDashboard()}
            fallback={
              <div class="nv-dash">
                <div class="nv-dash-head">
                  <div>
                    <h2 class="nv-dash-title">Dashboard</h2>
                    <p class="nv-dash-sub">Pinned locations, storage volumes, recent files, and remote servers</p>
                  </div>
                  <button
                    class="nv-chip-btn"
                    onClick={() => {
                      setFuzzyQuery("");
                      setFuzzyOpen(true);
                    }}
                  >
                    Quick Jump <kbd>⌘P</kbd>
                  </button>
                </div>

                <Show when={places().pins.length > 0}>
                  <section class="nv-dash-section">
                    <div class="nv-dash-sec-head">Pinned</div>
                    <div class="nv-dash-cards">
                      <For each={places().pins}>
                        {(pin) => (
                          <button
                            class="nv-dash-card"
                            title={pin.path}
                            onClick={() => navigate(pin.path, true)}
                          >
                            <div class="nv-dash-card-top">
                              <EntryIcon kind="dir" size={16} />
                              <span class="nv-dash-card-name">{pin.name}</span>
                            </div>
                            <span class="nv-dash-card-sub">{pin.path}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </section>
                </Show>

                <Show when={places().drives.length > 0}>
                  <section class="nv-dash-section">
                    <div class="nv-dash-sec-head">Drives & Volumes</div>
                    <div class="nv-dash-cards">
                      <For each={places().drives}>
                        {(drv) => {
                          const total = drv.capacity_total ?? 0;
                          const free = drv.capacity_free ?? 0;
                          const pct =
                            total > 0 ? Math.min(100, Math.round(((total - free) / total) * 100)) : 0;
                          return (
                            <button
                              class="nv-dash-card"
                              title={drv.path}
                              onClick={() => navigate(drv.path, true)}
                            >
                              <div class="nv-dash-card-top">
                                <span class="nv-dash-card-name">{drv.name}</span>
                                <span class="nv-dash-badge">{pct}%</span>
                              </div>
                              <Show when={total > 0}>
                                <div class="nv-cap-track">
                                  <div class="nv-cap-fill" style={{ width: `${pct}%` }} />
                                </div>
                                <span class="nv-dash-card-sub">
                                  {formatBytes(free)} free of {formatBytes(total)}
                                </span>
                              </Show>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </section>
                </Show>

                <section class="nv-dash-section">
                  <div class="nv-dash-sec-head">Recent Files</div>
                  <Show
                    when={recentFiles().length > 0}
                    fallback={<div class="nv-dash-empty">No recent files recorded yet</div>}
                  >
                    <div class="nv-dash-recent">
                      <For each={recentFiles().slice(0, 14)}>
                        {(rf) => (
                          <div
                            class="nv-dash-recent-row"
                            classList={{ missing: !rf.exists }}
                            onClick={() => {
                              if (!rf.exists) {
                                setStatusNote("File is no longer on disk");
                                return;
                              }
                              void neutronOpen(rf.path).catch((e) => setErr(String(e)));
                            }}
                          >
                            <div class="nv-dash-recent-main">
                              <EntryIcon kind="file" size={14} />
                              <span class="nv-dash-recent-name">{rf.name}</span>
                              <span class="nv-dash-recent-path">{rf.parent}</span>
                            </div>
                            <div class="nv-dash-recent-meta">
                              <span>{rf.at_ms ? formatDate(rf.at_ms) : ""}</span>
                              <Show when={rf.parent}>
                                <button
                                  class="nv-chip-btn nv-dash-open-dir"
                                  title={`Open ${rf.parent}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void loadDirectory(rf.parent, {
                                      pushHistory: true,
                                      focusPath: rf.path,
                                    });
                                  }}
                                >
                                  Reveal
                                </button>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>

                <Show when={places().servers.length > 0}>
                  <section class="nv-dash-section">
                    <div class="nv-dash-sec-head">Remote Servers</div>
                    <div class="nv-dash-cards">
                      <For each={places().servers}>
                        {(srv) => (
                          <button
                            class="nv-dash-card"
                            title={srv.path}
                            onClick={() => navigate(srv.path, true)}
                          >
                            <div class="nv-dash-card-top">
                              <EntryIcon kind="symlink" size={16} />
                              <span class="nv-dash-card-name">{srv.name}</span>
                            </div>
                            <span class="nv-dash-card-sub">{srv.path}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </section>
                </Show>
              </div>
            }
          >
          <Show when={promptState()}>
            {(ps) => (
              <div class="nv-inline-prompt">
                <span>{ps().label}:</span>
                <input
                  class="nv-inline-input"
                  value={ps().value}
                  autofocus
                  onInput={(e) =>
                    setPromptState((cur) => (cur ? { ...cur, value: e.currentTarget.value } : null))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitPrompt(e.currentTarget.value);
                    }
                  }}
                />
                <button class="nv-chip-btn" onClick={() => void submitPrompt(ps().value)}>
                  Save
                </button>
                <button class="nv-chip-btn" onClick={() => setPromptState(null)}>
                  Cancel
                </button>
              </div>
            )}
          </Show>

          <Show when={viewMode() === "list"}>
            <div class="nv-cols-head">
              <button
                classList={{ "nv-col-btn": true, sorted: sortBy() === "name" }}
                onClick={() => toggleSort("name")}
              >
                Name {sortBy() === "name" ? (sortDir() === "asc" ? "↑" : "↓") : ""}
              </button>
              <button
                classList={{ "nv-col-btn": true, sorted: sortBy() === "modified" }}
                onClick={() => toggleSort("modified")}
              >
                Modified {sortBy() === "modified" ? (sortDir() === "asc" ? "↑" : "↓") : ""}
              </button>
              <button
                classList={{ "nv-col-btn right": true, sorted: sortBy() === "size" }}
                onClick={() => toggleSort("size")}
              >
                Size {sortBy() === "size" ? (sortDir() === "asc" ? "↑" : "↓") : ""}
              </button>
              <button
                classList={{ "nv-col-btn": true, sorted: sortBy() === "kind" }}
                onClick={() => toggleSort("kind")}
              >
                Kind {sortBy() === "kind" ? (sortDir() === "asc" ? "↑" : "↓") : ""}
              </button>
            </div>
          </Show>

          <Show
            when={!err()}
            fallback={
              <div class="nv-empty">
                <span class="nv-status-error">{err()}</span>
                <button class="nv-chip-btn" onClick={() => void refreshCurrent()}>
                  Retry
                </button>
              </div>
            }
          >
            <Show when={viewMode() === "miller"} fallback={
              <div
                ref={(el) => {
                  scrollEl = el;
                  queueMicrotask(() => el && setViewportH(el.clientHeight || 540));
                }}
                class="nv-scroll"
                onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              >
                <Show
                  when={entries().length > 0 || loading()}
                  fallback={
                    <div class="nv-empty">
                      <span>{filter() ? "No matching entries" : "Empty folder"}</span>
                    </div>
                  }
                >
                  <Show
                    when={viewMode() === "list"}
                    fallback={
                      <div class="nv-grid">
                        <For each={entries()}>
                          {(entry, idx) => (
                            <div
                              classList={{
                                "nv-tile": true,
                                selected: selected().has(entry.path),
                              }}
                              onClick={(e) => selectEntry(entry, idx(), e)}
                              onDblClick={() => openEntry(entry)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (!selected().has(entry.path)) selectEntry(entry, idx());
                                setMenu({ x: e.clientX, y: e.clientY, entry });
                              }}
                            >
                              <EntryIcon kind={entry.kind} size={28} />
                              <span class="nv-tile-name">{entry.name}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    }
                  >
                    <div
                      class="nv-spacer"
                      style={{ height: `${virtualRange().total * ROW_H}px` }}
                    >
                      <For each={visibleRows()}>
                        {(item) => (
                          <div
                            classList={{
                              "nv-row": true,
                              dir: item.entry.kind === "dir",
                              selected: selected().has(item.entry.path),
                              "hidden-entry": item.entry.hidden,
                            }}
                            style={{ top: `${item.index * ROW_H}px` }}
                            onClick={(e) => selectEntry(item.entry, item.index, e)}
                            onDblClick={() => openEntry(item.entry)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (!selected().has(item.entry.path)) {
                                selectEntry(item.entry, item.index);
                              }
                              setMenu({ x: e.clientX, y: e.clientY, entry: item.entry });
                            }}
                          >
                            <div class="nv-cell-name">
                              <EntryIcon kind={item.entry.kind} />
                              <span class="nv-name-text">{item.entry.name}</span>
                              <Show when={item.entry.tag_mask > 0}>
                                <span class="nv-tags">
                                  <For each={FINDER_TAG_COLORS}>
                                    {(c) => (
                                      <Show when={hasTagColor(item.entry.tag_mask, c.bit)}>
                                        <span
                                          class="nv-tag-dot"
                                          style={{ background: c.hex }}
                                          title={c.name}
                                        />
                                      </Show>
                                    )}
                                  </For>
                                </span>
                              </Show>
                            </div>
                            <span class="nv-cell-muted">{formatDate(item.entry.modified_ms)}</span>
                            <span class="nv-cell-muted right">
                              {item.entry.kind === "dir" ? "—" : formatBytes(item.entry.size)}
                            </span>
                            <span class="nv-cell-muted">{item.entry.kind_label}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>
            }>
              <div ref={millerEl} class="nv-miller">
                <For each={millerCols()}>
                  {(col) => (
                    <div class="nv-miller-col">
                      <For each={col.entries}>
                        {(entry) => (
                          <div
                            classList={{
                              "nv-miller-item": true,
                              active:
                                currentLocation() === entry.path ||
                                currentLocation().startsWith(entry.path + "/") ||
                                selected().has(entry.path),
                            }}
                            onClick={() => {
                              if (entry.kind === "dir") navigate(entry.path, true);
                              else {
                                setSelected(new Set([entry.path]));
                                setCursorPath(entry.path);
                              }
                            }}
                            onDblClick={() => openEntry(entry)}
                          >
                            <EntryIcon kind={entry.kind} />
                            <span class="nv-miller-name">{entry.name}</span>
                            <Show when={entry.kind === "dir"}>
                              <span style={{ color: "#5b6172", "font-size": "10px" }}>›</span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
          </Show>
        </main>

        <Show when={showInspector() && !showDashboard()}>
          <aside class="nv-inspector">
            <div class="nv-insp-head">
              <div class="nv-insp-title">
                {primarySelected()?.name ?? breadcrumbs().at(-1)?.label ?? "Folder"}
              </div>
              <div class="nv-insp-sub">
                {primarySelected()?.kind_label ?? currentScheme().toUpperCase()}
              </div>
            </div>

            <Show when={preview()}>
              {(pv) => (
                <>
                  <Show when={pv().kind === "image" && pv().data_url}>
                    <div class="nv-preview-box">
                      <img src={pv().data_url!} alt={primarySelected()?.name ?? "Preview"} />
                    </div>
                  </Show>

                  <Show when={pv().kind === "text" && pv().text !== null}>
                    <div class="nv-preview-box">
                      <pre class="nv-preview-text">{pv().text}</pre>
                    </div>
                  </Show>

                  <div class="nv-meta-grid">
                    <span class="nv-meta-k">Size</span>
                    <span class="nv-meta-v">
                      {pv().kind === "dir"
                        ? `${pv().child_count ?? 0} items`
                        : formatBytes(pv().size)}
                    </span>
                    <span class="nv-meta-k">Modified</span>
                    <span class="nv-meta-v">{formatDate(pv().modified_ms)}</span>
                    <span class="nv-meta-k">Created</span>
                    <span class="nv-meta-v">{formatDate(pv().created_ms)}</span>
                    <span class="nv-meta-k">Path</span>
                    <span class="nv-meta-v">{primarySelected()?.path ?? currentLocation()}</span>
                  </div>

                  <Show when={isLocal() && primarySelected()}>
                    {(sel) => (
                      <div class="nv-side-group">
                        <div class="nv-side-head" style={{ padding: "4px 0" }}>
                          Finder Tags
                        </div>
                        <div class="nv-tag-picker">
                          <For each={FINDER_TAG_COLORS}>
                            {(c) => {
                              const active = () => hasTagColor(sel().tag_mask, c.bit);
                              return (
                                <button
                                  classList={{ "nv-tag-swatch": true, active: active() }}
                                  style={{ background: c.hex }}
                                  title={`${c.name} tag`}
                                  onClick={() =>
                                    void neutronTagToggle([sel().path], c.bit, !active()).then(() =>
                                      refreshCurrent(sel().path),
                                    )
                                  }
                                />
                              );
                            }}
                          </For>
                        </div>
                      </div>
                    )}
                  </Show>

                  <div class="nv-insp-actions">
                    <Show when={primarySelected()}>
                      {(sel) => (
                        <>
                          <button class="nv-chip-btn" onClick={() => openEntry(sel())}>
                            Open
                          </button>
                          <Show when={isLocal()}>
                            <button
                              class="nv-chip-btn"
                              onClick={() => void neutronReveal([sel().path])}
                            >
                              Reveal
                            </button>
                          </Show>
                          <Show when={sel().kind === "dir" && isLocal()}>
                            <button class="nv-chip-btn" onClick={() => openInTachyon(sel().path)}>
                              Open in Tachyon
                            </button>
                          </Show>
                          <Show when={sel().kind === "archive" && isLocal()}>
                            <button
                              class="nv-chip-btn"
                              onClick={() =>
                                void neutronArchiveExtract(sel().path).then((r) => {
                                  setStatusNote(`Extracted ${r.files} file(s)`);
                                  return refreshCurrent();
                                })
                              }
                            >
                              Extract
                            </button>
                          </Show>
                        </>
                      )}
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </aside>
        </Show>
      </div>

      {/* Bottom status bar */}
      <footer class="nv-status">
        <span>
          {entries().length} items
          {listing()?.hidden_count && !showHidden()
            ? ` (${listing()!.hidden_count} hidden)`
            : ""}
          {selected().size ? ` · ${selected().size} selected` : ""}
        </span>
        <span classList={{ "nv-status-error": !!err() }}>
          {statusNote() || (loading() ? "Loading…" : listing()?.display_path ?? "")}
        </span>
      </footer>

      {/* Context Menu */}
      <Show when={menu()}>
        {(m) => (
          <Portal>
            <div class="nv-menu-backdrop" onClick={() => setMenu(null)} />
            <div
              class="nv-menu"
              style={{
                left: `${Math.min(m().x, window.innerWidth - 220)}px`,
                top: `${Math.min(m().y, window.innerHeight - 280)}px`,
              }}
            >
              <Show when={m().entry}>
                {(ent) => (
                  <>
                    <button
                      class="nv-menu-item"
                      onClick={() => {
                        setMenu(null);
                        openEntry(ent());
                      }}
                    >
                      <span>Open</span>
                      <span class="nv-menu-key">↵</span>
                    </button>
                    <Show when={ent().kind === "dir" && isLocal()}>
                      <button
                        class="nv-menu-item"
                        onClick={() => {
                          setMenu(null);
                          openInTachyon(ent().path);
                        }}
                      >
                        <span>Open in Tachyon</span>
                      </button>
                    </Show>
                    <Show when={isLocal()}>
                      <button
                        class="nv-menu-item"
                        onClick={() => {
                          setMenu(null);
                          void neutronReveal([ent().path]);
                        }}
                      >
                        <span>Reveal in Finder</span>
                      </button>
                    </Show>
                    <div class="nv-menu-sep" />
                    <button
                      class="nv-menu-item"
                      onClick={() => {
                        setMenu(null);
                        setClipboard({ mode: "copy", paths: [...selected()] });
                      }}
                    >
                      <span>Copy</span>
                      <span class="nv-menu-key">⌘C</span>
                    </button>
                    <button
                      class="nv-menu-item"
                      onClick={() => {
                        setMenu(null);
                        setClipboard({ mode: "cut", paths: [...selected()] });
                      }}
                    >
                      <span>Cut</span>
                      <span class="nv-menu-key">⌘X</span>
                    </button>
                    <button
                      class="nv-menu-item"
                      onClick={() => {
                        setMenu(null);
                        setPromptState({
                          mode: "rename",
                          label: "Rename",
                          value: ent().name,
                          targetPath: ent().path,
                        });
                      }}
                    >
                      <span>Rename</span>
                      <span class="nv-menu-key">F2</span>
                    </button>
                    <Show when={selected().size >= 2 && isLocal()}>
                      <button
                        class="nv-menu-item"
                        onClick={() => {
                          setMenu(null);
                          setBatchOpen(true);
                        }}
                      >
                        <span>Batch Rename…</span>
                      </button>
                    </Show>
                    <Show when={isLocal()}>
                      <button
                        class="nv-menu-item"
                        onClick={() => {
                          setMenu(null);
                          void neutronArchiveCreate([...selected()]).then((r) => {
                            setStatusNote(`Created ${r.destination}`);
                            return refreshCurrent();
                          });
                        }}
                      >
                        <span>Compress (.zip)</span>
                      </button>
                    </Show>
                    <Show when={ent().kind === "archive" && isLocal()}>
                      <button
                        class="nv-menu-item"
                        onClick={() => {
                          setMenu(null);
                          void neutronArchiveExtract(ent().path).then((r) => {
                            setStatusNote(`Extracted ${r.files} file(s)`);
                            return refreshCurrent();
                          });
                        }}
                      >
                        <span>Extract Archive</span>
                      </button>
                    </Show>
                    <div class="nv-menu-sep" />
                    <Show when={isLocal()}>
                      <button
                        class="nv-menu-item danger"
                        onClick={() => {
                          setMenu(null);
                          void performTrash([...selected()]);
                        }}
                      >
                        <span>Move to Trash</span>
                        <span class="nv-menu-key">⌘⌫</span>
                      </button>
                    </Show>
                    <button
                      class="nv-menu-item danger"
                      onClick={() => {
                        setMenu(null);
                        setConfirmDelete([...selected()]);
                      }}
                    >
                      <span>Delete Permanently</span>
                      <span class="nv-menu-key">⇧⌘⌫</span>
                    </button>
                  </>
                )}
              </Show>

              <Show when={!m().entry}>
                <button
                  class="nv-menu-item"
                  onClick={() => {
                    setMenu(null);
                    setPromptState({ mode: "mkdir", label: "New Folder", value: "" });
                  }}
                >
                  <span>New Folder</span>
                </button>
                <Show when={isLocal()}>
                  <button
                    class="nv-menu-item"
                    onClick={() => {
                      setMenu(null);
                      setPromptState({ mode: "file", label: "New File", value: "" });
                    }}
                  >
                    <span>New File</span>
                  </button>
                </Show>
                <Show when={clipboard()}>
                  <button
                    class="nv-menu-item"
                    onClick={() => {
                      setMenu(null);
                      void performPaste();
                    }}
                  >
                    <span>Paste</span>
                    <span class="nv-menu-key">⌘V</span>
                  </button>
                </Show>
                <Show when={isLocal()}>
                  <button
                    class="nv-menu-item"
                    onClick={() => {
                      setMenu(null);
                      openInTachyon(currentLocation());
                    }}
                  >
                    <span>Open in Tachyon</span>
                  </button>
                </Show>
              </Show>
            </div>
          </Portal>
        )}
      </Show>

      {/* ⌘P Fuzzy Finder Modal */}
      <Show when={fuzzyOpen()}>
        <Portal>
          <div class="nv-backdrop" onClick={() => setFuzzyOpen(false)}>
            <div class="nv-modal" onClick={(e) => e.stopPropagation()}>
              <div class="nv-modal-head">
                <input
                  class="nv-fuzzy-input"
                  placeholder="Jump to file or folder…"
                  value={fuzzyQuery()}
                  autofocus
                  onInput={(e) => setFuzzyQuery(e.currentTarget.value)}
                />
                <span class="nv-menu-key">Esc</span>
              </div>
              <div class="nv-modal-list">
                <Show
                  when={fuzzyHits().length > 0}
                  fallback={<div class="nv-empty">No matches</div>}
                >
                  <For each={fuzzyHits()}>
                    {(hit, i) => (
                      <button
                        classList={{ "nv-fuzzy-hit": true, active: i() === fuzzyIdx() }}
                        onClick={() => acceptFuzzyHit(hit)}
                      >
                        <div class="nv-cell-name">
                          <EntryIcon kind={hit.is_dir ? "dir" : "file"} />
                          <span>
                            <For each={highlightFuzzyName(hit.name, [])}>
                              {(seg) => <span>{seg.text}</span>}
                            </For>
                          </span>
                        </div>
                        <span class="nv-fuzzy-parent">{hit.parent}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </Portal>
      </Show>

      {/* Batch Rename Modal */}
      <Show when={batchOpen()}>
        <Portal>
          <div class="nv-backdrop" onClick={() => setBatchOpen(false)}>
            <div class="nv-modal" onClick={(e) => e.stopPropagation()}>
              <div class="nv-modal-head">
                <span>Batch Rename ({selectedList().length} items)</span>
              </div>
              <div class="nv-batch-fields">
                <label class="nv-batch-field">
                  Find
                  <input value={batchFind()} onInput={(e) => setBatchFind(e.currentTarget.value)} />
                </label>
                <label class="nv-batch-field">
                  Replace
                  <input
                    value={batchReplace()}
                    onInput={(e) => setBatchReplace(e.currentTarget.value)}
                  />
                </label>
                <label class="nv-batch-field">
                  Prefix (supports {"{n}"})
                  <input
                    value={batchPrefix()}
                    onInput={(e) => setBatchPrefix(e.currentTarget.value)}
                  />
                </label>
                <label class="nv-batch-field">
                  Suffix (before ext)
                  <input
                    value={batchSuffix()}
                    onInput={(e) => setBatchSuffix(e.currentTarget.value)}
                  />
                </label>
              </div>
              <div class="nv-modal-list">
                <For each={batchPlan()}>
                  {(row) => (
                    <div class="nv-fuzzy-hit">
                      <span style={{ color: "#858b9c" }}>{row.oldName}</span>
                      <span style={{ color: row.changed ? "#93c5fd" : "#6b7280" }}>
                        → {row.newName}
                      </span>
                    </div>
                  )}
                </For>
              </div>
              <div class="nv-modal-foot">
                <button class="nv-chip-btn" onClick={() => setBatchOpen(false)}>
                  Cancel
                </button>
                <button class="nv-btn-primary" onClick={() => void applyBatchRename()}>
                  Rename
                </button>
              </div>
            </div>
          </div>
        </Portal>
      </Show>

      {/* Permanent Delete Confirm Modal */}
      <Show when={confirmDelete()}>
        {(paths) => (
          <Portal>
            <div class="nv-backdrop" onClick={() => setConfirmDelete(null)}>
              <div class="nv-modal" style={{ width: "380px" }} onClick={(e) => e.stopPropagation()}>
                <div class="nv-modal-head">Delete permanently?</div>
                <div style={{ padding: "12px 14px", color: "#9ba1b2", "font-size": "12.5px" }}>
                  This removes {paths().length} item(s) permanently and cannot be undone.
                </div>
                <div class="nv-modal-foot">
                  <button class="nv-chip-btn" onClick={() => setConfirmDelete(null)}>
                    Cancel
                  </button>
                  <button
                    class="nv-btn-primary danger"
                    onClick={() => void performPermanentDelete(paths())}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
};

export default NeutronView;
