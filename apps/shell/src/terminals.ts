// Registry of live Tachyon terminal panes by session id, so the agent can
// read scrollback ("read the terminal") and type commands into an active shell.

export interface TerminalHandle {
  host: string;
  blockId: string;
  write(bytes: Uint8Array): Promise<void> | void;
  getLines(maxLines?: number): string[];
  getCursorAbsoluteRow(): number;
  getLinesFrom(startLine: number, maxLines?: number): string[];
  focus(): void;
}

const registry = new Map<number, TerminalHandle>();
let activeSession: number | null = null;

// App registers how to open/show the terminal column, so the agent can bring a
// terminal up before running a command in it (without AgentPanel importing App).
let openTerminalFn: (() => void) | null = null;
export function setTerminalOpener(fn: () => void): void {
  openTerminalFn = fn;
}

// A command to auto-run once a freshly-opened terminal attaches (TUI app
// launcher). Set before the tab mounts; TachyonView consumes it after attach so
// there is no race against the shell being ready.
const pendingCommand = new Map<number, string>();
export function setPendingCommand(session: number, cmd: string): void {
  pendingCommand.set(session, cmd);
}
export function takePendingCommand(session: number): string | null {
  const cmd = pendingCommand.get(session) ?? null;
  pendingCommand.delete(session);
  return cmd;
}

/**
 * Add a terminal handle to the registry.
 *
 * `claimActive` controls whether mounting makes this the agent's "read the
 * terminal" target so background/auto-booted panes (e.g. EditorColumn) do not
 * steal focus from the user's active shell.
 */
export function registerTerminal(
  session: number,
  handle: TerminalHandle,
  claimActive = true,
): void {
  registry.set(session, handle);
  if (claimActive) activeSession = session;
}

export function unregisterTerminal(session: number): void {
  registry.delete(session);
  if (activeSession === session) {
    activeSession = registry.size ? [...registry.keys()].pop()! : null;
  }
}

export function setActiveTerminal(session: number): void {
  if (registry.has(session)) activeSession = session;
}

function targetSession(): number | null {
  return activeSession ?? (registry.size ? [...registry.keys()].pop()! : null);
}

/** Sessions that run a program rather than an interactive prompt: the nvim
 *  column (0xd0000000+, editorboot) and floating TUI panes (0xe0000000+, store).
 *  TerminalColumn splits start at 0xf0000000 and remain writable shells. */
const runsProgram = (s: number) => s >= 0xd000_0000 && s < 0xf000_0000;

function shellSession(): number | null {
  const s = targetSession();
  if (s != null && !runsProgram(s)) return s;
  const shells = [...registry.keys()].filter((k) => !runsProgram(k));
  return shells.length ? shells[shells.length - 1]! : null;
}

/** Recent scrollback of the active terminal (trailing blank lines trimmed). */
export function activeTerminalText(maxLines = 400): { session: number; text: string } | null {
  const session = targetSession();
  if (session == null) return null;
  const handle = registry.get(session);
  if (!handle) return null;
  const lines = [...handle.getLines(maxLines)];
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return { session, text: lines.join("\n") };
}

/** Absolute row of the cursor in the active shell for incremental reads. */
export function activeTerminalCursorLine(): number {
  const s = shellSession();
  const handle = s != null ? registry.get(s) : null;
  return handle ? handle.getCursorAbsoluteRow() : 0;
}

/** Active shell lines from `startLine` to the end (capped, trailing blanks trimmed). */
export function activeTerminalLinesFrom(startLine: number, maxLines = 200): string {
  const s = shellSession();
  const handle = s != null ? registry.get(s) : null;
  if (!handle) return "";
  const lines = [...handle.getLinesFrom(startLine, maxLines)];
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join("\n");
}

/** Format a finished command block within `max` characters, keeping the prompt
 *  head and decisive tail errors when truncated. */
export function clipBlock(lines: string[], max = 4000): string {
  const text = lines.join("\n");
  if (text.length <= max) return text;
  const head = lines.slice(0, 3).join("\n").slice(0, 600);
  return `${head}\n…\n${text.slice(-(max - head.length - 3))}`;
}

/** Type a command into the active shell and press Enter (`\r`). */
export async function runInActiveTerminal(cmd: string): Promise<number | null> {
  const wasOpen = shellSession() != null;
  if (!wasOpen) openTerminalFn?.();
  for (let i = 0; i < 30 && shellSession() == null; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = shellSession();
  if (s == null) return null;
  if (!wasOpen) await new Promise((r) => setTimeout(r, 500));
  const handle = registry.get(s);
  if (!handle) return null;
  await handle.write(new TextEncoder().encode(cmd + "\r"));
  return s;
}

/** Insert a command at the active shell prompt without pressing Enter. */
export async function insertInActiveTerminal(cmd: string): Promise<number | null> {
  const wasOpen = shellSession() != null;
  if (!wasOpen) openTerminalFn?.();
  for (let i = 0; i < 30 && shellSession() == null; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = shellSession();
  if (s == null) return null;
  if (!wasOpen) await new Promise((r) => setTimeout(r, 500));
  const handle = registry.get(s);
  if (!handle) return null;
  await handle.write(new TextEncoder().encode(cmd));
  return s;
}

export function hasTerminal(): boolean {
  return registry.size > 0;
}
