import "./TachyonView.css";

import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";

import { type TermPersist, termPersist } from "./ipc";
import LiquidBackground from "./LiquidBackground";
import { encodeKeyEvent, encodePaste } from "./tachyon/input";
import {
  tachyonAttach,
  tachyonDetach,
  tachyonKill,
  tachyonResize,
  tachyonScroll,
  tachyonSelectText,
  tachyonSessionNew,
  tachyonState,
  tachyonWrite,
} from "./tachyon/ipc";
import { decodeFrame, FLAG_EXITED } from "./tachyon/protocol";
import {
  buildFluxTermPalette,
  type SelectionRange,
  TachyonCanvasRenderer,
} from "./tachyon/renderer";
import {
  registerTerminal,
  setActiveTerminal,
  takePendingCommand,
  unregisterTerminal,
} from "./terminals";

export interface TachyonViewProps {
  session: number;
  host?: string;
  blockId?: string;
  active?: boolean;
  visible?: boolean;
  background?: boolean;
  persist?: TermPersist;
  autoFocus?: boolean;
  onExit?: () => void;
  onFocusBlock?: (blockId: string) => void;
}

const FONT_SIZE_KEY = "flux.tachyon.fontSize";
const DEFAULT_FONT_SIZE = 13;

function savedFontSize(): number {
  const n = Number(localStorage.getItem(FONT_SIZE_KEY));
  return Number.isFinite(n) && n >= 9 && n <= 28 ? n : DEFAULT_FONT_SIZE;
}

const TachyonView: Component<TachyonViewProps> = (props) => {
  let rootEl!: HTMLDivElement;
  let surfaceEl!: HTMLDivElement;
  let canvasEl!: HTMLCanvasElement;

  const [displayOffset, setDisplayOffset] = createSignal(0);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
  const [exited, setExited] = createSignal(false);

  let renderer: TachyonCanvasRenderer | null = null;
  let attachId: number | null = null;
  let activeHost = "local";
  let activeBlockId = "";
  let ownedEphemeralSessionId: string | null = null;
  let disposed = false;
  let exitSignaled = false;
  let draggingSel = false;
  let selAnchor: { col: number; row: number } | null = null;
  let currentSel: SelectionRange | null = null;

  const transparentBg = () => (props.background ?? true) || props.persist === "off";

  const focusView = () => {
    rootEl?.focus({ preventScroll: true });
    renderer?.setFocused(true);
    setActiveTerminal(props.session);
    if (activeBlockId) props.onFocusBlock?.(activeBlockId);
  };

  createEffect(() => {
    const p = buildFluxTermPalette();
    renderer?.setPalette(p);
  });

  createEffect(() => {
    renderer?.setTransparentBg(transparentBg());
  });

  createEffect(() => {
    if (props.active && props.visible !== false && (props.autoFocus ?? true)) {
      queueMicrotask(() => focusView());
    } else if (!props.active) {
      renderer?.setFocused(false);
    }
  });

  const clearSelection = () => {
    currentSel = null;
    selAnchor = null;
    draggingSel = false;
    renderer?.setSelection(null);
  };

  const copySelection = async (): Promise<boolean> => {
    if (!currentSel || attachId == null) return false;
    let { startCol, startRow, endCol, endRow } = currentSel;
    if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
      [startRow, startCol, endRow, endCol] = [endRow, endCol, startRow, startCol];
    }
    try {
      const text = await tachyonSelectText(attachId, startCol, startRow, endCol, endRow);
      if (text) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback to rendered line slice if RPC fails.
    }
    return false;
  };

  const handleWheel = (e: WheelEvent) => {
    if (attachId == null || !renderer) return;
    e.preventDefault();
    const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / Math.max(8, renderer.currentCellH)));
    const delta = e.deltaY < 0 ? lines : -lines;
    if (renderer.isAltScreen) {
      const arrow = e.deltaY < 0 ? "\x1b[A" : "\x1b[B";
      void tachyonWrite(attachId, new TextEncoder().encode(arrow.repeat(Math.min(lines, 5))));
    } else {
      void tachyonScroll(attachId, delta, false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (attachId == null || !renderer) return;

    // Copy/paste & local font zoom shortcuts on macOS Command key.
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      const low = e.key.toLowerCase();
      if (low === "c" && currentSel) {
        e.preventDefault();
        void copySelection().then(() => clearSelection());
        return;
      }
      if (low === "v") {
        e.preventDefault();
        void navigator.clipboard.readText().then((txt) => {
          if (txt && attachId != null) {
            clearSelection();
            void tachyonWrite(attachId, encodePaste(txt));
          }
        });
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        const next = renderer.getFontSize() + 1;
        localStorage.setItem(FONT_SIZE_KEY, String(next));
        const m = renderer.setFontSize(next);
        void tachyonResize(attachId, m.cols, m.rows, m.cellW, m.cellH);
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        const next = renderer.getFontSize() - 1;
        localStorage.setItem(FONT_SIZE_KEY, String(next));
        const m = renderer.setFontSize(next);
        void tachyonResize(attachId, m.cols, m.rows, m.cellW, m.cellH);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        localStorage.setItem(FONT_SIZE_KEY, String(DEFAULT_FONT_SIZE));
        const m = renderer.setFontSize(DEFAULT_FONT_SIZE);
        void tachyonResize(attachId, m.cols, m.rows, m.cellW, m.cellH);
        return;
      }
      return;
    }

    const bytes = encodeKeyEvent(e);
    if (!bytes) return;
    e.preventDefault();
    e.stopPropagation();
    clearSelection();
    if (displayOffset() > 0) {
      void tachyonScroll(attachId, 0, true);
    }
    void tachyonWrite(attachId, bytes);
  };

  const handlePaste = (e: ClipboardEvent) => {
    if (attachId == null) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    clearSelection();
    void tachyonWrite(attachId, encodePaste(text));
  };

  const handlePointerDown = (e: PointerEvent) => {
    focusView();
    if (e.button !== 0 || !renderer) return;
    const rect = canvasEl.getBoundingClientRect();
    const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
    selAnchor = cell;
    currentSel = null;
    draggingSel = true;
    renderer.setSelection(null);
    canvasEl.setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!draggingSel || !selAnchor || !renderer) return;
    const rect = canvasEl.getBoundingClientRect();
    const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
    if (cell.col !== selAnchor.col || cell.row !== selAnchor.row) {
      currentSel = {
        startCol: selAnchor.col,
        startRow: selAnchor.row,
        endCol: cell.col,
        endRow: cell.row,
      };
      renderer.setSelection(currentSel);
    }
  };

  const handlePointerUp = () => {
    if (!draggingSel) return;
    draggingSel = false;
    if (currentSel) {
      void copySelection();
    }
  };

  onMount(() => {
    let ro: ResizeObserver | null = null;
    let resizeTimer: number | null = null;

    renderer = new TachyonCanvasRenderer(canvasEl, {
      transparentBg: transparentBg(),
      fontSize: savedFontSize(),
    });
    renderer.setPalette(buildFluxTermPalette());

    const initMetrics = renderer.measureGrid(
      surfaceEl.clientWidth - 16,
      surfaceEl.clientHeight - 16,
    );

    const resolveBlock = async (
      cols: number,
      rows: number,
    ): Promise<{ host: string; blockId: string; ephemeralSessionId?: string }> => {
      const host = props.host?.trim() || "local";
      if (props.blockId) {
        return { host, blockId: props.blockId };
      }

      const mode = props.persist ?? termPersist();
      if (mode !== "off") {
        const name = `flux-${props.session}`;
        try {
          const snap = await tachyonState(host);
          const existing = snap.sessions.find((s) => s.name === name);
          if (existing) {
            const win =
              snap.windows.find((w) => w.id === existing.active_window) ??
              snap.windows.find((w) => w.session_id === existing.id);
            const blk = win
              ? snap.blocks.find((b) => b.id === win.focused_block) ??
                snap.blocks.find((b) => b.window_id === win.id)
              : snap.blocks.find((b) => b.session_id === existing.id);
            if (blk && blk.alive) {
              return { host, blockId: blk.id };
            }
          }
        } catch {
          // Fall through to creating a fresh session.
        }
        const created = await tachyonSessionNew({ host, name, cols, rows });
        return { host, blockId: created.block.id };
      }

      const created = await tachyonSessionNew({
        host,
        name: `flux-ephemeral-${props.session}-${Date.now().toString(36)}`,
        cols,
        rows,
      });
      return {
        host,
        blockId: created.block.id,
        ephemeralSessionId: created.session.id,
      };
    };

    (async () => {
      try {
        const target = await resolveBlock(initMetrics.cols, initMetrics.rows);
        if (disposed) {
          if (target.ephemeralSessionId) {
            void tachyonKill(target.host, "session", target.ephemeralSessionId);
          }
          return;
        }

        activeHost = target.host;
        activeBlockId = target.blockId;
        ownedEphemeralSessionId = target.ephemeralSessionId ?? null;

        const id = await tachyonAttach(
          activeHost,
          activeBlockId,
          initMetrics.cols,
          initMetrics.rows,
          (bytes) => {
            if (disposed || !renderer) return;
            const frame = decodeFrame(bytes);
            if (!frame) return;
            if ((frame.flags & FLAG_EXITED) !== 0) {
              setExited(true);
              if (!exitSignaled) {
                exitSignaled = true;
                props.onExit?.();
              }
              return;
            }
            setDisplayOffset(frame.displayOffset);
            renderer.applyFrame(frame);
          },
        );

        if (disposed) {
          void tachyonDetach(id);
          if (ownedEphemeralSessionId) {
            void tachyonKill(activeHost, "session", ownedEphemeralSessionId);
          }
          return;
        }

        attachId = id;
        registerTerminal(
          props.session,
          {
            host: activeHost,
            blockId: activeBlockId,
            write: (bytes) => tachyonWrite(id, bytes),
            getLines: (maxLines) => renderer?.getLines(maxLines) ?? [],
            getCursorAbsoluteRow: () => renderer?.getCursorAbsoluteRow() ?? 0,
            getLinesFrom: (start, maxLines) => renderer?.getLinesFrom(start, maxLines) ?? [],
            focus: () => focusView(),
          },
          (props.autoFocus ?? true) && props.persist !== "off",
        );

        const initCmd = takePendingCommand(props.session);
        if (initCmd) {
          void tachyonWrite(id, new TextEncoder().encode(initCmd + "\r"));
        }

        const syncSize = () => {
          if (disposed || !renderer || attachId == null) return;
          if (props.visible === false || surfaceEl.clientWidth <= 0 || surfaceEl.clientHeight <= 0) {
            return;
          }
          const m = renderer.measureGrid(
            Math.max(0, surfaceEl.clientWidth - 16),
            Math.max(0, surfaceEl.clientHeight - 16),
          );
          if (m.cols !== renderer.currentCols || m.rows !== renderer.currentRows) {
            void tachyonResize(attachId, m.cols, m.rows, m.cellW, m.cellH);
          }
        };

        syncSize();
        ro = new ResizeObserver(() => {
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(syncSize, 16);
        });
        ro.observe(surfaceEl);

        if (props.active && (props.autoFocus ?? true)) {
          focusView();
        }
      } catch (err) {
        if (!disposed) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    onCleanup(() => {
      disposed = true;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      ro?.disconnect();
      unregisterTerminal(props.session);
      if (attachId !== null) {
        void tachyonDetach(attachId);
        attachId = null;
      }
      if (ownedEphemeralSessionId) {
        void tachyonKill(activeHost, "session", ownedEphemeralSessionId);
        ownedEphemeralSessionId = null;
      }
      renderer?.dispose();
      renderer = null;
    });
  });

  return (
    <div
      ref={rootEl}
      class="tachyon-root"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onWheel={handleWheel}
      onFocusIn={() => {
        renderer?.setFocused(true);
        setActiveTerminal(props.session);
        if (activeBlockId) props.onFocusBlock?.(activeBlockId);
      }}
      onFocusOut={() => renderer?.setFocused(false)}
    >
      <Show when={props.background ?? true}>
        <div class="tachyon-backdrop">
          <LiquidBackground active={() => props.active ?? true} glass={true} />
        </div>
      </Show>

      <div ref={surfaceEl} class="tachyon-surface">
        <canvas
          ref={canvasEl}
          class="tachyon-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      </div>

      <Show when={displayOffset() > 0}>
        <button
          class="tachyon-scroll-pill"
          onClick={() => attachId != null && void tachyonScroll(attachId, 0, true)}
          title="Jump to bottom"
        >
          ↑ {displayOffset()} lines · Jump to bottom
        </button>
      </Show>

      <Show when={exited() || errorMsg()}>
        <div class="tachyon-status-banner">
          <span>{errorMsg() ? `Tachyon: ${errorMsg()}` : "Process exited"}</span>
        </div>
      </Show>
    </div>
  );
};

export default TachyonView;
