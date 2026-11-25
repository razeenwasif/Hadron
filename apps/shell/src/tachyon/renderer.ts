import { design } from "../design";
import { hex, palette as pal, rgba } from "../palette";
import { theme } from "../themes";
import {
  buildPaletteLut,
  CELL_ANY_UNDERLINE,
  CELL_BOLD,
  CELL_CURLY_UNDERLINE,
  CELL_DASHED_UNDERLINE,
  CELL_DIM,
  CELL_DOTTED_UNDERLINE,
  CELL_DOUBLE_UNDERLINE,
  CELL_HIDDEN,
  CELL_ITALIC,
  CELL_OVERLINE,
  CELL_REVERSE,
  CELL_STRIKEOUT,
  COLOR_DEFAULT,
  type DecodedFrame,
  type DecodedRow,
  FLAG_FULL_REPAINT,
  resolveColorCss,
  rowToPlainText,
} from "./protocol";

export interface TermPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  lut: string[];
}

export function buildFluxTermPalette(): TermPalette {
  const p = pal();
  if (theme() === "gruvbox" && design() === "classic") {
    const ansi16 = [
      "#282828",
      "#ffffff",
      "#b8bb26",
      "#fabd2f",
      "#83a598",
      "#d3869b",
      "#8ec07c",
      "#ebdbb2",
      "#928374",
      "#ffffff",
      "#b8bb26",
      "#fabd2f",
      "#83a598",
      "#d3869b",
      "#8ec07c",
      "#fbf1c7",
    ];
    return {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "rgba(146, 131, 116, 0.4)",
      lut: buildPaletteLut(ansi16),
    };
  }

  const ansi16 = [
    "#1a1640",
    "#ffffff",
    "#7cf5b0",
    "#f5d76e",
    hex(p.ai),
    hex(p.hot),
    hex(p.accent),
    "#c9cde8",
    "#6a6f96",
    "#ffffff",
    "#9affc9",
    "#ffe9a3",
    hex(p.ai2),
    hex(p.hot),
    hex(p.accent),
    "#eef0fb",
  ];

  return {
    background: hex(p.bg),
    foreground: hex(p.text),
    cursor: hex(p.accent),
    cursorAccent: hex(p.bg),
    selectionBackground: rgba(p.ai, 0.35),
    lut: buildPaletteLut(ansi16),
  };
}

export interface GridMetrics {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
}

export interface SelectionRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

const MAX_SCROLL_TAIL = 500;

export class TachyonCanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private termPalette: TermPalette;
  private transparentBg: boolean;
  private fontFamily: string;
  private fontSize: number;
  private lineHeightFactor = 1.28;

  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  private cellW = 8;
  private cellH = 17;
  private ascent = 13;

  private cols = 80;
  private rows = 24;
  private cursorX = 0;
  private cursorY = 0;
  private cursorShape = 0;
  private cursorVisible = true;
  private prevCursorY = 0;
  private altScreen = false;
  private focused = false;
  private historyLen = 0;
  private displayOffset = 0;

  private rowBuffer: (DecodedRow | undefined)[] = [];
  private rowStrings: string[] = [];
  private scrolledHistory: string[] = [];
  private dirtyRows = new Set<number>();
  private needsFullRedraw = true;
  private rafId: number | null = null;
  private selection: SelectionRange | null = null;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    opts?: {
      transparentBg?: boolean;
      fontFamily?: string;
      fontSize?: number;
    },
  ) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.canvas = canvas;
    this.ctx = ctx;
    this.transparentBg = opts?.transparentBg ?? true;
    this.fontFamily =
      opts?.fontFamily ??
      '"JetBrains Mono", "SF Mono", "Fira Code", Menlo, Consolas, monospace';
    this.fontSize = opts?.fontSize ?? 13;
    this.termPalette = buildFluxTermPalette();
    this.measureFont();
  }

  get currentCols(): number {
    return this.cols;
  }

  get currentRows(): number {
    return this.rows;
  }

  get currentCellW(): number {
    return this.cellW;
  }

  get currentCellH(): number {
    return this.cellH;
  }

  get isAltScreen(): boolean {
    return this.altScreen;
  }

  get currentHistoryLen(): number {
    return this.historyLen;
  }

  get currentDisplayOffset(): number {
    return this.displayOffset;
  }

  setFontSize(size: number): GridMetrics {
    const clamped = Math.max(9, Math.min(28, size));
    if (clamped !== this.fontSize) {
      this.fontSize = clamped;
      this.measureFont();
      this.needsFullRedraw = true;
      this.schedulePaint();
    }
    return this.measureGrid(this.cssWidth, this.cssHeight);
  }

  getFontSize(): number {
    return this.fontSize;
  }

  setPalette(palette: TermPalette): void {
    this.termPalette = palette;
    this.needsFullRedraw = true;
    this.schedulePaint();
  }

  setTransparentBg(transparent: boolean): void {
    if (this.transparentBg !== transparent) {
      this.transparentBg = transparent;
      this.needsFullRedraw = true;
      this.schedulePaint();
    }
  }

  setFocused(focused: boolean): void {
    if (this.focused !== focused) {
      this.focused = focused;
      this.dirtyRows.add(this.cursorY);
      this.schedulePaint();
    }
  }

  setSelection(sel: SelectionRange | null): void {
    this.selection = sel;
    this.needsFullRedraw = true;
    this.schedulePaint();
  }

  pixelToCell(offsetX: number, offsetY: number): { col: number; row: number } {
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor(offsetX / this.cellW)));
    const row = Math.max(0, Math.min(this.rows - 1, Math.floor(offsetY / this.cellH)));
    return { col, row };
  }

  private measureFont(): void {
    this.ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    const m = this.ctx.measureText("M");
    this.cellW = Math.max(4, Math.ceil(m.width * 100) / 100);
    this.cellH = Math.max(10, Math.ceil(this.fontSize * this.lineHeightFactor));
    const fontAscent = m.actualBoundingBoxAscent || Math.round(this.fontSize * 0.78);
    const leading = Math.max(0, (this.cellH - this.fontSize) / 2);
    this.ascent = Math.round(leading + fontAscent);
  }

  measureGrid(widthPx: number, heightPx: number): GridMetrics {
    this.dpr = window.devicePixelRatio || 1;
    if (widthPx > 0 && heightPx > 0) {
      const targetW = Math.round(widthPx * this.dpr);
      const targetH = Math.round(heightPx * this.dpr);
      if (
        this.cssWidth !== widthPx ||
        this.cssHeight !== heightPx ||
        this.canvas.width !== targetW ||
        this.canvas.height !== targetH
      ) {
        this.cssWidth = widthPx;
        this.cssHeight = heightPx;
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        this.canvas.style.width = `${widthPx}px`;
        this.canvas.style.height = `${heightPx}px`;
        this.needsFullRedraw = true;
        this.schedulePaint();
      }
    }
    const cols = Math.max(2, Math.floor((widthPx || 320) / this.cellW));
    const rows = Math.max(1, Math.floor((heightPx || 200) / this.cellH));
    return {
      cols,
      rows,
      cellW: Math.round(this.cellW),
      cellH: Math.round(this.cellH),
    };
  }

  applyFrame(frame: DecodedFrame): void {
    if (this.disposed) return;

    const fullRepaint = (frame.flags & FLAG_FULL_REPAINT) !== 0;
    const prevTopLine = this.rowStrings[0];
    const prevSecondLine = this.rowStrings[1];

    if (
      fullRepaint ||
      frame.cols !== this.cols ||
      frame.rows !== this.rows ||
      frame.altScreen !== this.altScreen
    ) {
      this.cols = frame.cols;
      this.rows = frame.rows;
      this.altScreen = frame.altScreen;
      this.rowBuffer = new Array(frame.rows);
      this.rowStrings = new Array(frame.rows).fill("");
      this.needsFullRedraw = true;
      this.dirtyRows.clear();
    }

    this.prevCursorY = this.cursorY;
    this.cursorX = frame.cursorX;
    this.cursorY = frame.cursorY;
    this.cursorShape = frame.cursorShape;
    this.cursorVisible = frame.cursorVisible;
    this.historyLen = frame.historyLen;
    this.displayOffset = frame.displayOffset;

    if (!this.altScreen && !fullRepaint && frame.displayOffset === 0 && prevTopLine !== undefined) {
      const row0Update = frame.dirtyRows.find((r) => r.y === 0);
      if (row0Update) {
        const nextTop = rowToPlainText(row0Update, frame.cols);
        if (prevSecondLine !== undefined && nextTop === prevSecondLine && prevTopLine.length > 0) {
          this.scrolledHistory.push(prevTopLine);
          if (this.scrolledHistory.length > MAX_SCROLL_TAIL) {
            this.scrolledHistory.splice(0, this.scrolledHistory.length - MAX_SCROLL_TAIL);
          }
        }
      }
    }

    for (const row of frame.dirtyRows) {
      if (row.y >= 0 && row.y < this.rows) {
        this.rowBuffer[row.y] = row;
        this.rowStrings[row.y] = rowToPlainText(row, this.cols);
        if (!this.needsFullRedraw) {
          this.dirtyRows.add(row.y);
        }
      }
    }

    if (!this.needsFullRedraw) {
      if (this.prevCursorY >= 0 && this.prevCursorY < this.rows) {
        this.dirtyRows.add(this.prevCursorY);
      }
      if (this.cursorY >= 0 && this.cursorY < this.rows) {
        this.dirtyRows.add(this.cursorY);
      }
    }

    this.schedulePaint();
  }

  getLines(maxLines = 400): string[] {
    const combined = this.altScreen
      ? [...this.rowStrings]
      : [...this.scrolledHistory, ...this.rowStrings];
    while (combined.length && !combined[combined.length - 1]?.trim()) {
      combined.pop();
    }
    return combined.length > maxLines ? combined.slice(-maxLines) : combined;
  }

  getCursorAbsoluteRow(): number {
    return (this.altScreen ? 0 : this.scrolledHistory.length) + this.cursorY;
  }

  getLinesFrom(startRow: number, maxLines = 200): string[] {
    const combined = this.altScreen
      ? [...this.rowStrings]
      : [...this.scrolledHistory, ...this.rowStrings];
    const from = Math.max(0, Math.max(startRow, combined.length - maxLines));
    const slice = combined.slice(from);
    while (slice.length && !slice[slice.length - 1]?.trim()) {
      slice.pop();
    }
    return slice;
  }

  private schedulePaint(): void {
    if (this.disposed || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.paint();
    });
  }

  private paint(): void {
    if (this.disposed || this.cssWidth <= 0 || this.cssHeight <= 0) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    if (this.needsFullRedraw) {
      if (this.transparentBg) {
        ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
      } else {
        ctx.fillStyle = this.termPalette.background;
        ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
      }
      for (let y = 0; y < this.rows; y++) {
        this.paintRow(y, false);
      }
      this.needsFullRedraw = false;
      this.dirtyRows.clear();
    } else if (this.dirtyRows.size > 0) {
      for (const y of this.dirtyRows) {
        if (y >= 0 && y < this.rows) {
          this.paintRow(y, true);
        }
      }
      this.dirtyRows.clear();
    }

    this.paintCursor();
    ctx.restore();
  }

  private paintRow(y: number, clearFirst: boolean): void {
    const ctx = this.ctx;
    const py = Math.floor(y * this.cellH);
    const rh = Math.ceil(this.cellH);

    if (clearFirst) {
      if (this.transparentBg) {
        ctx.clearRect(0, py, this.cssWidth, rh);
      } else {
        ctx.fillStyle = this.termPalette.background;
        ctx.fillRect(0, py, this.cssWidth, rh);
      }
    }

    // Highlight active drag selection if this row is inside range.
    this.paintRowSelection(y, py, rh);

    const row = this.rowBuffer[y];
    if (!row) return;

    let currentFont = "";
    ctx.textBaseline = "alphabetic";

    for (const sp of row.spans) {
      const px = sp.x * this.cellW;
      const pw = sp.cellCount * this.cellW;

      const reverse = (sp.flags & CELL_REVERSE) !== 0;
      const dim = (sp.flags & CELL_DIM) !== 0;
      const hidden = (sp.flags & CELL_HIDDEN) !== 0;
      const bold = (sp.flags & CELL_BOLD) !== 0;
      const italic = (sp.flags & CELL_ITALIC) !== 0;

      let fg = resolveColorCss(sp.fg, this.termPalette.foreground, this.termPalette.lut);
      let bg =
        sp.bg === COLOR_DEFAULT
          ? null
          : resolveColorCss(sp.bg, this.termPalette.background, this.termPalette.lut);

      if (reverse) {
        const tmpFg = fg;
        fg = bg ?? this.termPalette.background;
        bg = tmpFg;
      }

      if (bg !== null) {
        ctx.fillStyle = bg;
        ctx.fillRect(px, py, Math.ceil(pw), rh);
      }

      if (!hidden && sp.text.length > 0 && sp.text.trim().length > 0) {
        const stylePrefix = `${italic ? "italic " : ""}${bold ? "600 " : ""}`;
        const font = `${stylePrefix}${this.fontSize}px ${this.fontFamily}`;
        if (font !== currentFont) {
          ctx.font = font;
          currentFont = font;
        }
        ctx.globalAlpha = dim ? 0.55 : 1;
        ctx.fillStyle = fg;
        ctx.fillText(sp.text, px, py + this.ascent);
        ctx.globalAlpha = 1;
      }

      if ((sp.flags & CELL_ANY_UNDERLINE) !== 0) {
        const uy = py + this.ascent + 2;
        ctx.strokeStyle = fg;
        ctx.lineWidth = 1;
        if (sp.flags & CELL_DOTTED_UNDERLINE) ctx.setLineDash([1, 2]);
        else if (sp.flags & CELL_DASHED_UNDERLINE) ctx.setLineDash([4, 2]);
        else ctx.setLineDash([]);

        ctx.beginPath();
        if (sp.flags & CELL_CURLY_UNDERLINE) {
          const step = 3;
          ctx.moveTo(px, uy);
          for (let wx = px; wx < px + pw; wx += step) {
            ctx.lineTo(wx + step * 0.5, uy + 1.5);
            ctx.lineTo(Math.min(px + pw, wx + step), uy);
          }
        } else {
          ctx.moveTo(px, uy);
          ctx.lineTo(px + pw, uy);
          if (sp.flags & CELL_DOUBLE_UNDERLINE) {
            ctx.moveTo(px, uy + 2);
            ctx.lineTo(px + pw, uy + 2);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if ((sp.flags & CELL_STRIKEOUT) !== 0) {
        const sy = Math.round(py + this.cellH * 0.52);
        ctx.strokeStyle = fg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, sy);
        ctx.lineTo(px + pw, sy);
        ctx.stroke();
      }

      if ((sp.flags & CELL_OVERLINE) !== 0) {
        ctx.strokeStyle = fg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, py + 1);
        ctx.lineTo(px + pw, py + 1);
        ctx.stroke();
      }
    }
  }

  private paintRowSelection(y: number, py: number, rh: number): void {
    const sel = this.selection;
    if (!sel) return;
    let sRow = sel.startRow;
    let sCol = sel.startCol;
    let eRow = sel.endRow;
    let eCol = sel.endCol;
    if (sRow > eRow || (sRow === eRow && sCol > eCol)) {
      [sRow, sCol, eRow, eCol] = [eRow, eCol, sRow, sCol];
    }
    if (y < sRow || y > eRow) return;
    const fromCol = y === sRow ? sCol : 0;
    const toCol = y === eRow ? eCol : this.cols - 1;
    if (toCol < fromCol) return;
    this.ctx.fillStyle = this.termPalette.selectionBackground;
    this.ctx.fillRect(
      fromCol * this.cellW,
      py,
      (toCol - fromCol + 1) * this.cellW,
      rh,
    );
  }

  private paintCursor(): void {
    if (!this.cursorVisible || this.displayOffset > 0) return;
    if (this.cursorX < 0 || this.cursorX >= this.cols) return;
    if (this.cursorY < 0 || this.cursorY >= this.rows) return;

    const ctx = this.ctx;
    const px = Math.floor(this.cursorX * this.cellW);
    const py = Math.floor(this.cursorY * this.cellH);
    const cw = Math.ceil(this.cellW);
    const ch = Math.ceil(this.cellH);

    ctx.fillStyle = this.termPalette.cursor;
    ctx.strokeStyle = this.termPalette.cursor;

    if (!this.focused) {
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
      return;
    }

    if (this.cursorShape === 1) {
      // Underline
      ctx.fillRect(px, py + ch - 2, cw, 2);
    } else if (this.cursorShape === 2) {
      // Beam
      ctx.fillRect(px, py + 1, 2, ch - 2);
    } else {
      // Block
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillRect(px, py, cw, ch);
      ctx.restore();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
