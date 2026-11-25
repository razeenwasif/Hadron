import { describe, expect, it } from "vitest";

import { encodeKeyEvent, encodePaste } from "./input";
import {
  buildPaletteLut,
  CELL_BOLD,
  CELL_WIDE,
  decodeFrame,
  FLAG_EXITED,
  FLAG_FULL_REPAINT,
  HEADER_LEN,
  resolveColorCss,
  rowToPlainText,
} from "./protocol";

function packFrame(opts: {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  flags: number;
  dirtyRows: {
    y: number;
    spans: { x: number; cellCount: number; fg: number; bg: number; flags: number; text: string }[];
  }[];
}): Uint8Array {
  const enc = new TextEncoder();
  const bodyChunks: Uint8Array[] = [];
  let bodyLen = 0;

  for (const row of opts.dirtyRows) {
    const rowHeader = new ArrayBuffer(4);
    const rv = new DataView(rowHeader);
    rv.setUint16(0, row.y, true);
    rv.setUint16(2, row.spans.length, true);
    bodyChunks.push(new Uint8Array(rowHeader));
    bodyLen += 4;

    for (const sp of row.spans) {
      const txt = enc.encode(sp.text);
      const spBuf = new ArrayBuffer(16);
      const sv = new DataView(spBuf);
      sv.setUint16(0, sp.x, true);
      sv.setUint16(2, sp.cellCount, true);
      sv.setUint32(4, sp.fg, true);
      sv.setUint32(8, sp.bg, true);
      sv.setUint16(12, sp.flags, true);
      sv.setUint16(14, txt.byteLength, true);
      bodyChunks.push(new Uint8Array(spBuf), txt);
      bodyLen += 16 + txt.byteLength;
    }
  }

  const out = new Uint8Array(HEADER_LEN + bodyLen);
  const hv = new DataView(out.buffer);
  hv.setUint16(0, opts.cols, true);
  hv.setUint16(2, opts.rows, true);
  hv.setUint16(4, opts.cursorX, true);
  hv.setUint16(6, opts.cursorY, true);
  hv.setUint8(8, 2); // Beam
  hv.setUint8(9, 1); // visible
  hv.setUint8(10, 0); // not alt screen
  hv.setUint8(11, opts.flags);
  hv.setUint32(12, 42, true); // historyLen
  hv.setUint32(16, 0, true); // displayOffset
  hv.setUint16(20, opts.dirtyRows.length, true);
  hv.setUint16(22, 0, true);

  let off = HEADER_LEN;
  for (const ch of bodyChunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

describe("tachyon binary protocol", () => {
  it("decodes header, ANSI/truecolor spans, and wide CJK glyphs", () => {
    const raw = packFrame({
      cols: 80,
      rows: 24,
      cursorX: 5,
      cursorY: 1,
      flags: FLAG_FULL_REPAINT,
      dirtyRows: [
        {
          y: 0,
          spans: [
            { x: 0, cellCount: 3, fg: 0x0100_0002, bg: 0, flags: CELL_BOLD, text: "ok " },
            { x: 3, cellCount: 4, fg: 0x02ff_8010, bg: 0, flags: CELL_WIDE, text: "日本" },
          ],
        },
      ],
    });

    const frame = decodeFrame(raw)!;
    expect(frame).not.toBeNull();
    expect(frame.cols).toBe(80);
    expect(frame.rows).toBe(24);
    expect(frame.cursorX).toBe(5);
    expect(frame.cursorY).toBe(1);
    expect(frame.cursorShape).toBe(2);
    expect(frame.flags & FLAG_FULL_REPAINT).toBe(FLAG_FULL_REPAINT);
    expect(frame.historyLen).toBe(42);
    expect(frame.dirtyRows).toHaveLength(1);
    expect(rowToPlainText(frame.dirtyRows[0], 80)).toBe("ok 日本");

    const lut = buildPaletteLut(["#000000", "#ff0000", "#00ff00"]);
    expect(resolveColorCss(0x0100_0002, "#eee", lut)).toBe("#00ff00");
    expect(resolveColorCss(0x02ff_8010, "#eee", lut)).toBe("rgb(255,128,16)");
    expect(resolveColorCss(0, "#eee", lut)).toBe("#eee");
  });

  it("decodes exited sentinel frame cleanly", () => {
    const raw = packFrame({
      cols: 80,
      rows: 24,
      cursorX: 0,
      cursorY: 0,
      flags: FLAG_EXITED,
      dirtyRows: [],
    });
    const frame = decodeFrame(raw)!;
    expect(frame.flags & FLAG_EXITED).toBe(FLAG_EXITED);
    expect(frame.dirtyRows).toEqual([]);
  });
});

describe("tachyon keyboard encoder", () => {
  const key = (init: KeyboardEventInit) =>
    ({
      key: "",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...init,
    }) as KeyboardEvent;

  it("encodes Ctrl+C, Shift+Tab, arrows, UTF-8, and bracketed paste", () => {
    expect(encodeKeyEvent(key({ key: "c", ctrlKey: true }))).toEqual(new Uint8Array([0x03]));
    expect(encodeKeyEvent(key({ key: "Tab", shiftKey: true }))).toEqual(
      new TextEncoder().encode("\x1b[Z"),
    );
    expect(encodeKeyEvent(key({ key: "ArrowUp", ctrlKey: true }))).toEqual(
      new TextEncoder().encode("\x1b[1;5A"),
    );
    expect(encodeKeyEvent(key({ key: "ü" }))).toEqual(new TextEncoder().encode("ü"));
    expect(encodeKeyEvent(key({ key: "k", metaKey: true }))).toBeNull();
    expect(encodePaste("ls\n")).toEqual(new TextEncoder().encode("\x1b[200~ls\n\x1b[201~"));
  });
});
