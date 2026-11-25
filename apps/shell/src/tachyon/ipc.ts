import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface HostSummary {
  alias: string;
  kind: string;
  address: string | null;
  reachable: boolean;
}

export type ProgramState = "blocked" | "error" | "working" | "done" | "idle";

export interface ProgramStatus {
  state: ProgramState;
  app: string | null;
  kind: string | null;
  msg: string | null;
  label: string | null;
}

export type SplitDir = "right" | "down";

export type LayoutNode =
  | { type: "leaf"; block_id: string }
  | { type: "split"; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };

export interface CommandReceipt {
  cmd_seq: number | null;
  cmdline: string | null;
  exit_code: number | null;
  wall_us: number;
  cpu_us: number | null;
  pcore_bp: number | null;
  energy_mj: number | null;
  peak_bytes: number | null;
  finished_at: number;
}

export interface BlockInfo {
  id: string;
  session_id: string;
  window_id: string;
  label: string | null;
  title: string | null;
  cwd: string | null;
  command: string | null;
  command_running: boolean;
  pid: number;
  cols: number;
  rows: number;
  alive: boolean;
  exit_code: number | null;
  awake: boolean;
  attached_clients: number;
  created_at: number;
  status: ProgramStatus | null;
  status_inferred: boolean;
  last_receipt: CommandReceipt | null;
}

export interface WindowInfo {
  id: string;
  session_id: string;
  name: string | null;
  layout: LayoutNode;
  focused_block: string;
  zoomed: boolean;
  created_at: number;
}

export interface SessionInfo {
  id: string;
  name: string;
  windows: string[];
  active_window: string | null;
  created_at: number;
}

export interface HostInfo {
  hostname: string;
  os: string;
  arch: string;
  version: string;
  protocol: number;
  pid: number;
  build: string | null;
  capabilities: string[];
  auth_enabled: boolean | null;
  listen_addr: string | null;
}

export interface ServerSnapshot {
  host: HostInfo;
  sessions: SessionInfo[];
  windows: WindowInfo[];
  blocks: BlockInfo[];
  clients: { id: string; kind: string; name: string }[];
}

export interface RewindPoint {
  seq: number;
  age_ms: number;
}

export interface RewindFrame {
  seq: number;
  cols: number;
  rows: number;
  age_ms: number;
  vt: number[];
  text: string | null;
}

export interface SessionNewResult {
  session: SessionInfo;
  window: WindowInfo;
  block: BlockInfo;
}

export interface WindowOrSplitResult {
  window: WindowInfo;
  block: BlockInfo;
}

export interface TachyonEventPayload {
  host: string;
  event: Record<string, unknown>;
}

export type FramePayload = ArrayBuffer | ArrayBufferView | number[];

export function normalizeFrameBytes(raw: FramePayload): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return Uint8Array.from(raw);
}

export const tachyonHosts = () => invoke<HostSummary[]>("tachyon_hosts");

export const tachyonState = (host?: string | null) =>
  invoke<ServerSnapshot>("tachyon_state", { host: host ?? null });

export const tachyonSessionNew = (opts: {
  host?: string | null;
  name?: string | null;
  cwd?: string | null;
  cmd?: string[] | null;
  label?: string | null;
  cols?: number;
  rows?: number;
}) =>
  invoke<SessionNewResult>("tachyon_session_new", {
    host: opts.host ?? null,
    name: opts.name ?? null,
    cwd: opts.cwd ?? null,
    cmd: opts.cmd ?? null,
    label: opts.label ?? null,
    cols: opts.cols ?? null,
    rows: opts.rows ?? null,
  });

export const tachyonWindowNew = (opts: {
  host?: string | null;
  sessionId: string;
  name?: string | null;
  cwd?: string | null;
  cmd?: string[] | null;
  label?: string | null;
  cols?: number;
  rows?: number;
}) =>
  invoke<WindowOrSplitResult>("tachyon_window_new", {
    host: opts.host ?? null,
    sessionId: opts.sessionId,
    name: opts.name ?? null,
    cwd: opts.cwd ?? null,
    cmd: opts.cmd ?? null,
    label: opts.label ?? null,
    cols: opts.cols ?? null,
    rows: opts.rows ?? null,
  });

export const tachyonSplit = (opts: {
  host?: string | null;
  blockId: string;
  dir: "h" | "v" | "right" | "down";
  cwd?: string | null;
  cmd?: string[] | null;
  label?: string | null;
  cols?: number;
  rows?: number;
}) =>
  invoke<WindowOrSplitResult>("tachyon_split", {
    host: opts.host ?? null,
    blockId: opts.blockId,
    dir: opts.dir,
    cwd: opts.cwd ?? null,
    cmd: opts.cmd ?? null,
    label: opts.label ?? null,
    cols: opts.cols ?? null,
    rows: opts.rows ?? null,
  });

export const tachyonResizeRatio = (
  host: string | null | undefined,
  windowId: string,
  path: boolean[],
  ratio: number,
) => invoke<void>("tachyon_resize_ratio", { host: host ?? null, windowId, path, ratio });

export const tachyonFocus = (
  host: string | null | undefined,
  windowId: string,
  blockId?: string | null,
) => invoke<void>("tachyon_focus", { host: host ?? null, windowId, blockId: blockId ?? null });

export const tachyonRename = (
  host: string | null | undefined,
  kind: "session" | "window",
  id: string,
  name: string,
) => invoke<void>("tachyon_rename", { host: host ?? null, kind, id, name });

export const tachyonKill = (
  host: string | null | undefined,
  kind: "block" | "window" | "session",
  id: string,
) => invoke<void>("tachyon_kill", { host: host ?? null, kind, id });

export const tachyonAttach = (
  host: string | null | undefined,
  blockId: string,
  cols: number,
  rows: number,
  onFrame: (bytes: Uint8Array) => void,
) => {
  const channel = new Channel<FramePayload>();
  channel.onmessage = (payload) => onFrame(normalizeFrameBytes(payload));
  return invoke<number>("tachyon_attach", {
    host: host ?? null,
    blockId,
    cols,
    rows,
    onFrame: channel,
  });
};

export const tachyonDetach = (attachId: number) =>
  invoke<void>("tachyon_detach", { attachId });

export const tachyonWrite = (attachId: number, data: Uint8Array) =>
  invoke<void>("tachyon_write", { attachId, data: Array.from(data) });

export const tachyonSend = (
  host: string | null | undefined,
  blockId: string,
  data: Uint8Array,
) => invoke<void>("tachyon_send", { host: host ?? null, blockId, data: Array.from(data) });

export const tachyonResize = (
  attachId: number,
  cols: number,
  rows: number,
  cellW?: number,
  cellH?: number,
) =>
  invoke<void>("tachyon_resize", {
    attachId,
    cols,
    rows,
    cellW: cellW ?? null,
    cellH: cellH ?? null,
  });

export const tachyonScroll = (attachId: number, delta: number, toBottom = false) =>
  invoke<void>("tachyon_scroll", { attachId, delta, toBottom });

export const tachyonSelectText = (
  attachId: number,
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
) =>
  invoke<string>("tachyon_select_text", {
    attachId,
    startCol,
    startRow,
    endCol,
    endRow,
  });

export const tachyonCapture = (
  host: string | null | undefined,
  blockId: string,
  lines?: number,
  ansi = false,
) =>
  invoke<string>("tachyon_capture", {
    host: host ?? null,
    blockId,
    lines: lines ?? null,
    ansi,
  });

export const tachyonReceipts = (
  host: string | null | undefined,
  blockId: string,
  limit?: number,
) =>
  invoke<CommandReceipt[]>("tachyon_receipts", {
    host: host ?? null,
    blockId,
    limit: limit ?? null,
  });

export const tachyonRewindList = (host: string | null | undefined, blockId: string) =>
  invoke<RewindPoint[]>("tachyon_rewind_list", { host: host ?? null, blockId });

export const tachyonRewindFrame = (
  host: string | null | undefined,
  blockId: string,
  seq: number,
  includeText = false,
  ansi = false,
) =>
  invoke<RewindFrame>("tachyon_rewind_frame", {
    host: host ?? null,
    blockId,
    seq,
    includeText,
    ansi,
  });

export const tachyonSubscribe = (host?: string | null) =>
  invoke<void>("tachyon_subscribe", { host: host ?? null });

export const onTachyonEvent = (
  cb: (payload: TachyonEventPayload) => void,
): Promise<UnlistenFn> => listen<TachyonEventPayload>("flux://tachyon-event", (e) => cb(e.payload));
