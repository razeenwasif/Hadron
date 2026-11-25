// Binary frame decoder & packed color/attribute helpers matching
// `crates/flux-tachyon/src/frame.rs`.

export const HEADER_LEN = 24;

export const FLAG_FULL_REPAINT = 1 << 0;
export const FLAG_EXITED = 1 << 1;
export const FLAG_BELL = 1 << 2;

export const CELL_BOLD = 1 << 0;
export const CELL_DIM = 1 << 1;
export const CELL_ITALIC = 1 << 2;
export const CELL_UNDERLINE = 1 << 3;
export const CELL_DOUBLE_UNDERLINE = 1 << 4;
export const CELL_CURLY_UNDERLINE = 1 << 5;
export const CELL_DOTTED_UNDERLINE = 1 << 6;
export const CELL_DASHED_UNDERLINE = 1 << 7;
export const CELL_BLINK = 1 << 8;
export const CELL_REVERSE = 1 << 9;
export const CELL_HIDDEN = 1 << 10;
export const CELL_STRIKEOUT = 1 << 11;
export const CELL_OVERLINE = 1 << 12;
export const CELL_WIDE = 1 << 13;

export const CELL_ANY_UNDERLINE =
  CELL_UNDERLINE |
  CELL_DOUBLE_UNDERLINE |
  CELL_CURLY_UNDERLINE |
  CELL_DOTTED_UNDERLINE |
  CELL_DASHED_UNDERLINE;

export const COLOR_DEFAULT = 0;

export interface DecodedSpan {
  x: number;
  cellCount: number;
  fg: number;
  bg: number;
  flags: number;
  text: string;
}

export interface DecodedRow {
  y: number;
  spans: DecodedSpan[];
}

export interface DecodedFrame {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorShape: number; // 0 = block, 1 = underline, 2 = beam
  cursorVisible: boolean;
  altScreen: boolean;
  flags: number;
  historyLen: number;
  displayOffset: number;
  dirtyRows: DecodedRow[];
}

const utf8Decoder = new TextDecoder("utf-8");

export function decodeFrame(bytes: Uint8Array): DecodedFrame | null {
  if (bytes.byteLength < HEADER_LEN) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const cols = view.getUint16(0, true);
  const rows = view.getUint16(2, true);
  const cursorX = view.getUint16(4, true);
  const cursorY = view.getUint16(6, true);
  const cursorShape = view.getUint8(8);
  const cursorVisible = view.getUint8(9) !== 0;
  const altScreen = view.getUint8(10) !== 0;
  const flags = view.getUint8(11);
  const historyLen = view.getUint32(12, true);
  const displayOffset = view.getUint32(16, true);
  const rowCount = view.getUint16(20, true);

  let off = HEADER_LEN;
  const dirtyRows: DecodedRow[] = new Array(rowCount);

  for (let r = 0; r < rowCount; r++) {
    if (off + 4 > bytes.byteLength) break;
    const y = view.getUint16(off, true);
    const spanCount = view.getUint16(off + 2, true);
    off += 4;

    const spans: DecodedSpan[] = new Array(spanCount);
    let actualSpans = 0;
    for (let s = 0; s < spanCount; s++) {
      if (off + 16 > bytes.byteLength) break;
      const x = view.getUint16(off, true);
      const cellCount = view.getUint16(off + 2, true);
      const fg = view.getUint32(off + 4, true);
      const bg = view.getUint32(off + 8, true);
      const sFlags = view.getUint16(off + 12, true);
      const textByteLen = view.getUint16(off + 14, true);
      off += 16;

      if (off + textByteLen > bytes.byteLength) break;
      const text =
        textByteLen === 0 ? "" : utf8Decoder.decode(bytes.subarray(off, off + textByteLen));
      off += textByteLen;

      spans[actualSpans++] = { x, cellCount, fg, bg, flags: sFlags, text };
    }
    if (actualSpans < spanCount) spans.length = actualSpans;
    dirtyRows[r] = { y, spans };
  }

  return {
    cols,
    rows,
    cursorX,
    cursorY,
    cursorShape,
    cursorVisible,
    altScreen,
    flags,
    historyLen,
    displayOffset,
    dirtyRows,
  };
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

export function buildPaletteLut(ansi16: readonly string[]): string[] {
  const lut = new Array<string>(256);
  for (let i = 0; i < 16; i++) {
    lut[i] = ansi16[i] ?? "#ffffff";
  }
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        const idx = 16 + r * 36 + g * 6 + b;
        lut[idx] = `rgb(${CUBE_LEVELS[r]},${CUBE_LEVELS[g]},${CUBE_LEVELS[b]})`;
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    lut[232 + i] = `rgb(${v},${v},${v})`;
  }
  return lut;
}

const rgbCache = new Map<number, string>();

export function resolveColorCss(
  packed: number,
  defaultCss: string,
  lut: readonly string[],
): string {
  const tag = packed >>> 24;
  if (tag === 0) return defaultCss;
  if (tag === 1) return lut[packed & 0xff] ?? defaultCss;
  if (tag === 2) {
    let cached = rgbCache.get(packed);
    if (!cached) {
      if (rgbCache.size >= 1024) rgbCache.clear();
      const r = (packed >>> 16) & 0xff;
      const g = (packed >>> 8) & 0xff;
      const b = packed & 0xff;
      cached = `rgb(${r},${g},${b})`;
      rgbCache.set(packed, cached);
    }
    return cached;
  }
  return defaultCss;
}

export function rowToPlainText(row: DecodedRow | undefined, cols: number): string {
  if (!row || row.spans.length === 0) return "";
  let out = "";
  let cursor = 0;
  for (const sp of row.spans) {
    if (sp.x > cursor) {
      out += " ".repeat(Math.min(sp.x - cursor, cols));
    }
    out += sp.text;
    cursor = sp.x + sp.cellCount;
  }
  return out.replace(/\s+$/, "");
}
