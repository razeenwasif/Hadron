// Right-side vertical terminal column powered by Tachyon Mux v2.
// Supports local + remote hosts, multi-session/window switching, recursive
// resizable split layouts, and live agent status dots.
import {
  type Component,
  For,
  Show,
  Suspense,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
} from "solid-js";

import { PANE_SESSION } from "./ipc";
import {
  type BlockInfo,
  type HostSummary,
  type LayoutNode,
  type ProgramState,
  type ServerSnapshot,
  onTachyonEvent,
  tachyonFocus,
  tachyonHosts,
  tachyonKill,
  tachyonResizeRatio,
  tachyonSessionNew,
  tachyonSplit,
  tachyonState,
  tachyonSubscribe,
  tachyonWindowNew,
} from "./tachyon/ipc";

const COL_PANE_BASE = 0xf000_0000;
const HOST_KEY = "flux.tachyon.host";

const TachyonView = lazy(() => import("./TachyonView"));

function countLeaves(node: LayoutNode): number {
  return node.type === "leaf" ? 1 : countLeaves(node.a) + countLeaves(node.b);
}

function firstLeaf(node: LayoutNode): string {
  return node.type === "leaf" ? node.block_id : firstLeaf(node.a);
}

function highestAgentState(blocks: BlockInfo[]): ProgramState | null {
  let rank = 0;
  let best: ProgramState | null = null;
  const order: Record<ProgramState, number> = {
    blocked: 5,
    error: 4,
    working: 3,
    done: 2,
    idle: 1,
  };
  for (const b of blocks) {
    const st = b.status?.state;
    if (!st) continue;
    const r = order[st] ?? 0;
    if (r > rank) {
      rank = r;
      best = st;
    }
  }
  return best === "idle" ? null : best;
}

const TachyonMuxColumn: Component<{ visible: boolean }> = (props) => {
  const [hosts, setHosts] = createSignal<HostSummary[]>([]);
  const [host, setHost] = createSignal<string>(localStorage.getItem(HOST_KEY) || "local");
  const [snapshot, setSnapshot] = createSignal<ServerSnapshot | null>(null);
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null);
  const [activeWindowId, setActiveWindowId] = createSignal<string | null>(null);
  const [activeBlockId, setActiveBlockId] = createSignal<string | null>(null);
  const [connError, setConnError] = createSignal<string | null>(null);
  const [dragRatio, setDragRatio] = createSignal<{ key: string; ratio: number } | null>(null);

  const blockSessions = new Map<string, number>();
  let nextPaneId = COL_PANE_BASE;
  let disposed = false;

  const sessionForBlock = (blockId: string, isPrimary: boolean): number => {
    const existing = blockSessions.get(blockId);
    if (existing !== undefined) return existing;
    const assigned = isPrimary && !([...blockSessions.values()].includes(PANE_SESSION))
      ? PANE_SESSION
      : ++nextPaneId;
    blockSessions.set(blockId, assigned);
    return assigned;
  };

  const syncSelectionFromSnapshot = (snap: ServerSnapshot) => {
    const curSess = snap.sessions.find((s) => s.id === activeSessionId())
      ?? snap.sessions.find((s) => s.name === "flux")
      ?? snap.sessions[0]
      ?? null;
    if (!curSess) {
      setActiveSessionId(null);
      setActiveWindowId(null);
      setActiveBlockId(null);
      return;
    }
    setActiveSessionId(curSess.id);

    const curWin = snap.windows.find(
      (w) => w.session_id === curSess.id && w.id === activeWindowId(),
    )
      ?? snap.windows.find((w) => w.id === curSess.active_window)
      ?? snap.windows.find((w) => w.session_id === curSess.id)
      ?? null;
    if (!curWin) {
      setActiveWindowId(null);
      setActiveBlockId(null);
      return;
    }
    setActiveWindowId(curWin.id);

    const winBlockIds = new Set(
      snap.blocks.filter((b) => b.window_id === curWin.id).map((b) => b.id),
    );
    const curBlock = activeBlockId();
    if (!curBlock || !winBlockIds.has(curBlock)) {
      const nextBlock = winBlockIds.has(curWin.focused_block)
        ? curWin.focused_block
        : firstLeaf(curWin.layout);
      setActiveBlockId(nextBlock);
    }
  };

  const refreshState = async (targetHost = host(), ensureSession = false) => {
    try {
      setConnError(null);
      let snap = await tachyonState(targetHost);
      if (disposed || targetHost !== host()) return;
      if (ensureSession && snap.sessions.length === 0) {
        await tachyonSessionNew({ host: targetHost, name: "flux" });
        snap = await tachyonState(targetHost);
        if (disposed || targetHost !== host()) return;
      }
      setSnapshot(snap);
      syncSelectionFromSnapshot(snap);
    } catch (err) {
      if (!disposed) {
        setConnError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const connectHost = async (targetHost: string) => {
    setHost(targetHost);
    localStorage.setItem(HOST_KEY, targetHost);
    setActiveSessionId(null);
    setActiveWindowId(null);
    setActiveBlockId(null);
    await refreshState(targetHost, true);
    void tachyonSubscribe(targetHost).catch(() => {});
  };

  onMount(() => {
    let refreshTimer: number | null = null;
    let unEvent: (() => void) | null = null;

    (async () => {
      try {
        const list = await tachyonHosts();
        if (!disposed) setHosts(list);
      } catch {
        // Ignore if hosts config failed to enumerate.
      }
      await refreshState(host(), true);
      void tachyonSubscribe(host()).catch(() => {});

      try {
        unEvent = await onTachyonEvent((payload) => {
          if (disposed || payload.host !== host()) return;
          if (refreshTimer !== null) clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => void refreshState(host(), false), 40);
        });
      } catch {
        // Non-Tauri preview environments may skip events.
      }
    })();

    onCleanup(() => {
      disposed = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      unEvent?.();
    });
  });

  const activeWindow = createMemo(() => {
    const snap = snapshot();
    const wid = activeWindowId();
    if (!snap || !wid) return null;
    return snap.windows.find((w) => w.id === wid) ?? null;
  });

  const leafCount = createMemo(() => {
    const w = activeWindow();
    return w ? countLeaves(w.layout) : 0;
  });

  const agentDot = createMemo(() => {
    const snap = snapshot();
    return snap ? highestAgentState(snap.blocks) : null;
  });

  const focusBlock = (blockId: string) => {
    setActiveBlockId(blockId);
    const wid = activeWindowId();
    if (wid) void tachyonFocus(host(), wid, blockId).catch(() => {});
  };

  const splitFocused = async (dir: "right" | "down") => {
    const bid = activeBlockId();
    if (!bid) return;
    const res = await tachyonSplit({ host: host(), blockId: bid, dir });
    setActiveWindowId(res.window.id);
    setActiveBlockId(res.block.id);
    await refreshState(host(), false);
  };

  const newWindow = async () => {
    let sid = activeSessionId();
    if (!sid) {
      const created = await tachyonSessionNew({ host: host(), name: "flux" });
      setActiveSessionId(created.session.id);
      setActiveWindowId(created.window.id);
      setActiveBlockId(created.block.id);
      await refreshState(host(), false);
      return;
    }
    const res = await tachyonWindowNew({ host: host(), sessionId: sid });
    setActiveWindowId(res.window.id);
    setActiveBlockId(res.block.id);
    await refreshState(host(), false);
  };

  const closeFocusedBlock = async () => {
    const bid = activeBlockId();
    if (!bid || leafCount() <= 1) return;
    await tachyonKill(host(), "block", bid);
    await refreshState(host(), false);
  };

  const startRatioDrag = (
    e: PointerEvent,
    windowId: string,
    path: boolean[],
    horizontal: boolean,
    initialRatio: number,
    containerEl: HTMLDivElement,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const total = horizontal ? containerEl.clientWidth : containerEl.clientHeight;
    if (total <= 0) return;

    const key = path.map((b) => (b ? "1" : "0")).join(",");
    const minFrac = Math.min(0.25, 60 / total);
    const startPos = horizontal ? e.clientX : e.clientY;
    const basePx = initialRatio * total;
    let latestRatio = initialRatio;
    document.body.classList.add("busy");

    const move = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX : ev.clientY;
      latestRatio = Math.max(minFrac, Math.min(1 - minFrac, (basePx + (pos - startPos)) / total));
      setDragRatio({ key, ratio: latestRatio });
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("busy");
      setDragRatio(null);
      void tachyonResizeRatio(host(), windowId, path, latestRatio).then(() =>
        refreshState(host(), false),
      );
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const renderNode = (node: LayoutNode, windowId: string, path: boolean[], firstId: string) => {
    if (node.type === "leaf") {
      const bid = node.block_id;
      return (
        <div
          classList={{ "term-pane": true, active: leafCount() > 1 && activeBlockId() === bid }}
          style={{ "flex-grow": "1", "flex-basis": "0", "flex-shrink": "1" }}
          onPointerDown={() => focusBlock(bid)}
        >
          <div class="terminal-surface">
            <Show when={bid} keyed>
              {(id) => (
                <Suspense>
                  <TachyonView
                    host={host()}
                    blockId={id}
                    session={sessionForBlock(id, id === firstId)}
                    active={props.visible && activeBlockId() === id}
                    visible={props.visible}
                    background={leafCount() === 1}
                    onFocusBlock={focusBlock}
                  />
                </Suspense>
              )}
            </Show>
          </div>
        </div>
      );
    }

    const horizontal = node.dir === "right";
    const key = path.map((b) => (b ? "1" : "0")).join(",");
    const ratio = () => {
      const d = dragRatio();
      return d && d.key === key ? d.ratio : node.ratio;
    };
    let boxEl!: HTMLDivElement;

    return (
      <div
        ref={boxEl}
        class="term-split-box"
        style={{ "flex-direction": horizontal ? "row" : "column" }}
      >
        <div
          style={{
            display: "flex",
            "min-width": 0,
            "min-height": 0,
            "flex-grow": String(ratio()),
            "flex-basis": "0",
            "flex-shrink": "1",
          }}
        >
          {renderNode(node.a, windowId, [...path, false], firstId)}
        </div>
        <div
          classList={{ "term-seam": true, vert: horizontal }}
          title="Drag to resize"
          onPointerDown={(e) => startRatioDrag(e, windowId, path, horizontal, ratio(), boxEl)}
        />
        <div
          style={{
            display: "flex",
            "min-width": 0,
            "min-height": 0,
            "flex-grow": String(1 - ratio()),
            "flex-basis": "0",
            "flex-shrink": "1",
          }}
        >
          {renderNode(node.b, windowId, [...path, true], firstId)}
        </div>
      </div>
    );
  };

  return (
    <>
      <div class="term-col-bar">
        <div class="term-col-bar-left">
          <Show when={agentDot()}>
            {(st) => <span class={`term-agent-dot ${st()}`} title={`Agent ${st()}`} />}
          </Show>

          <Show
            when={hosts().length > 1 || (snapshot()?.windows.length ?? 0) > 1}
            fallback={<span class="term-col-label">tachyon</span>}
          >
            <Show when={hosts().length > 1}>
              <select
                class="term-col-select"
                aria-label="Tachyon host"
                value={host()}
                onChange={(e) => void connectHost(e.currentTarget.value)}
              >
                <For each={hosts()}>
                  {(h) => <option value={h.alias}>{h.alias}</option>}
                </For>
              </select>
            </Show>

            <Show when={(snapshot()?.windows.length ?? 0) > 1}>
              <select
                class="term-col-select"
                aria-label="Tachyon window"
                value={activeWindowId() ?? ""}
                onChange={(e) => {
                  const wid = e.currentTarget.value;
                  const win = snapshot()?.windows.find((w) => w.id === wid);
                  if (!win) return;
                  setActiveSessionId(win.session_id);
                  setActiveWindowId(win.id);
                  setActiveBlockId(win.focused_block || firstLeaf(win.layout));
                  void tachyonFocus(host(), win.id, win.focused_block);
                }}
              >
                <For each={snapshot()?.windows ?? []}>
                  {(w, idx) => (
                    <option value={w.id}>{w.name || `win ${idx() + 1}`}</option>
                  )}
                </For>
              </select>
            </Show>
          </Show>
        </div>

        <div class="term-col-bar-right">
          <button
            class="term-col-btn"
            title="Split right"
            aria-label="Split right"
            onClick={() => void splitFocused("right")}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.35" />
              <path d="M8 2.5v11" stroke="currentColor" stroke-width="1.35" />
            </svg>
          </button>
          <button
            class="term-col-btn"
            title="Split down"
            aria-label="Split down"
            onClick={() => void splitFocused("down")}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.35" />
              <path d="M2 8h12" stroke="currentColor" stroke-width="1.35" />
            </svg>
          </button>
          <button
            class="term-col-btn"
            title="New Mux window"
            aria-label="New Mux window"
            onClick={() => void newWindow()}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
            </svg>
          </button>
          <Show when={leafCount() > 1}>
            <button
              class="term-col-btn danger"
              title="Close focused pane"
              aria-label="Close focused pane"
              onClick={() => void closeFocusedBlock()}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
              </svg>
            </button>
          </Show>
        </div>
      </div>

      <div class="term-col-panes">
        <Show
          when={!connError()}
          fallback={
            <div class="term-col-error">
              <span>Tachyon unavailable: {connError()}</span>
              <button class="term-col-btn" onClick={() => void refreshState(host(), true)}>
                ↻
              </button>
            </div>
          }
        >
          <Show when={activeWindow()}>
            {(w) => renderNode(w().layout, w().id, [], firstLeaf(w().layout))}
          </Show>
        </Show>
      </div>
    </>
  );
};

export default TachyonMuxColumn;
