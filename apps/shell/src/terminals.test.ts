import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeTerminalText,
  clipBlock,
  insertInActiveTerminal,
  registerTerminal,
  runInActiveTerminal,
  setActiveTerminal,
  setTerminalOpener,
  type TerminalHandle,
  unregisterTerminal,
} from "./terminals";

const writes: [number, string][] = [];

function fakeTerm(session: number, lines: string[]): TerminalHandle {
  const dec = new TextDecoder();
  return {
    host: "local",
    blockId: `blk-${session}`,
    write: vi.fn((bytes: Uint8Array) => {
      writes.push([session, dec.decode(bytes)]);
    }),
    getLines: (maxLines = 400) => lines.slice(-maxLines),
    getCursorAbsoluteRow: () => Math.max(0, lines.length - 1),
    getLinesFrom: (startLine: number, maxLines = 200) =>
      lines.slice(Math.max(0, startLine)).slice(-maxLines),
    focus: vi.fn(),
  };
}

const SHELL = 1;
const EDITOR = 0xd000_0000;
const TUI_PANE = 0xe000_0001;
const COLUMN = 0; // PANE_SESSION

beforeEach(() => {
  writes.length = 0;
  for (const s of [SHELL, EDITOR, TUI_PANE, COLUMN]) unregisterTerminal(s);
  setTerminalOpener(() => {});
});
afterEach(() => vi.useRealTimers());

describe("terminal registry", () => {
  it("does not let an unfocused pane steal the agent's read target", () => {
    registerTerminal(
      SHELL,
      fakeTerm(SHELL, ["$ cargo test", "error[E0308]: mismatched types"]),
      true,
    );
    expect(activeTerminalText()?.session).toBe(SHELL);

    registerTerminal(EDITOR, fakeTerm(EDITOR, ["  1 fn main() {", "~", "demo.rs [+]"]), false);
    expect(activeTerminalText()?.session).toBe(SHELL);
    expect(activeTerminalText()?.text).toContain("E0308");
  });

  it("still follows focus, so an editor you click into becomes readable", () => {
    registerTerminal(SHELL, fakeTerm(SHELL, ["$ ls"]), true);
    registerTerminal(EDITOR, fakeTerm(EDITOR, ["  1 fn main() {"]), false);

    setActiveTerminal(EDITOR);
    expect(activeTerminalText()?.session).toBe(EDITOR);
    setActiveTerminal(SHELL);
    expect(activeTerminalText()?.session).toBe(SHELL);
  });

  it("a terminal the user opened still claims it", () => {
    registerTerminal(EDITOR, fakeTerm(EDITOR, ["editor"]), false);
    registerTerminal(SHELL, fakeTerm(SHELL, ["shell"]), true);
    expect(activeTerminalText()?.session).toBe(SHELL);
  });

  it("falls back to a registered terminal when nothing claimed one", () => {
    registerTerminal(EDITOR, fakeTerm(EDITOR, ["  1 fn main() {"]), false);
    expect(activeTerminalText()?.session).toBe(EDITOR);
  });

  it("closing the read target hands off rather than going silent", () => {
    registerTerminal(EDITOR, fakeTerm(EDITOR, ["editor"]), false);
    registerTerminal(SHELL, fakeTerm(SHELL, ["shell"]), true);
    unregisterTerminal(SHELL);
    expect(activeTerminalText()?.session).toBe(EDITOR);
  });
});

describe("a failed command's block, for Explain/Fix", () => {
  it("is passed whole when it fits", () => {
    expect(clipBlock(["$ ls nope", "ls: nope: No such file or directory"])).toBe(
      "$ ls nope\nls: nope: No such file or directory",
    );
  });

  it("keeps the command and the error that ends a long run", () => {
    const lines = [
      "",
      "~/proj on main",
      "❯ cargo build",
      ...Array.from({ length: 120 }, (_, i) => `warning: unused variable \`x${i}\` --> src/lib.rs:${i}:9`),
      "error[E0308]: mismatched types",
    ];
    const out = clipBlock(lines);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain("❯ cargo build");
    expect(out.endsWith("error[E0308]: mismatched types")).toBe(true);
  });
});

describe("typing a command into a terminal", () => {
  it("goes to the shell, not the editor the user last clicked into", async () => {
    registerTerminal(SHELL, fakeTerm(SHELL, ["$ "]), true);
    registerTerminal(EDITOR, fakeTerm(EDITOR, ["  1 fn main() {"]), false);
    setActiveTerminal(EDITOR);
    expect(await runInActiveTerminal("cargo test")).toBe(SHELL);
    expect(writes).toEqual([[SHELL, "cargo test\r"]]);
    expect(activeTerminalText()?.session).toBe(EDITOR);
  });

  it("never goes to a TUI pane, whose letters are its commands", async () => {
    registerTerminal(SHELL, fakeTerm(SHELL, ["$ "]), true);
    registerTerminal(TUI_PANE, fakeTerm(TUI_PANE, ["lazygit"]), true);
    expect(await insertInActiveTerminal("git status")).toBe(SHELL);
    expect(writes).toEqual([[SHELL, "git status"]]);
  });

  it("opens a terminal when only the editor is up", async () => {
    vi.useFakeTimers();
    registerTerminal(EDITOR, fakeTerm(EDITOR, ["  1 fn main() {"]), false);
    const open = vi.fn(() => registerTerminal(COLUMN, fakeTerm(COLUMN, ["$ "]), true));
    setTerminalOpener(open);
    const ran = runInActiveTerminal("ls");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await ran).toBe(COLUMN);
    expect(open).toHaveBeenCalledOnce();
    expect(writes).toEqual([[COLUMN, "ls\r"]]);
  });
});
