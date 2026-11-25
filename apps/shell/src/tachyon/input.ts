// Keyboard & paste encoder targeting xterm/VT sequences expected by Tachyon.

const enc = new TextEncoder();

function xtermModParam(e: KeyboardEvent): number {
  const mod = (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0);
  return mod === 0 ? 0 : mod + 1;
}

function csiKey(code: string, e: KeyboardEvent, defaultPrefix = "["): string {
  const m = xtermModParam(e);
  return m ? `\x1b[1;${m}${code}` : `\x1b${defaultPrefix}${code}`;
}

function tildeKey(num: number, e: KeyboardEvent): string {
  const m = xtermModParam(e);
  return m ? `\x1b[${num};${m}~` : `\x1b[${num}~`;
}

export interface KeyEncodeOptions {
  appCursorKeys?: boolean;
}

export function encodeKeyEvent(e: KeyboardEvent, opts?: KeyEncodeOptions): Uint8Array | null {
  // Reserve macOS Command chords for the Flux host (tab management, copy/paste,
  // zoom, command palette).
  if (e.metaKey) return null;

  const appPrefix = opts?.appCursorKeys ? "O" : "[";

  // Ctrl combinations (ASCII control range)
  if (e.ctrlKey && !e.altKey && e.key.length === 1) {
    const ch = e.key;
    const upper = ch.toUpperCase().charCodeAt(0);
    if (upper >= 65 && upper <= 90) {
      return new Uint8Array([upper - 64]);
    }
    if (ch === " " || ch === "@") return new Uint8Array([0x00]);
    if (ch === "[") return new Uint8Array([0x1b]);
    if (ch === "\\") return new Uint8Array([0x1c]);
    if (ch === "]") return new Uint8Array([0x1d]);
    if (ch === "^" || ch === "6") return new Uint8Array([0x1e]);
    if (ch === "_" || ch === "-") return new Uint8Array([0x1f]);
  }

  let seq: string | null = null;
  switch (e.key) {
    case "Enter":
      seq = e.altKey ? "\x1b\r" : "\r";
      break;
    case "Backspace":
      seq = e.altKey ? "\x1b\x7f" : "\x7f";
      break;
    case "Tab":
      seq = e.shiftKey ? "\x1b[Z" : "\t";
      break;
    case "Escape":
      seq = "\x1b";
      break;
    case "ArrowUp":
      seq = csiKey("A", e, appPrefix);
      break;
    case "ArrowDown":
      seq = csiKey("B", e, appPrefix);
      break;
    case "ArrowRight":
      seq = csiKey("C", e, appPrefix);
      break;
    case "ArrowLeft":
      seq = csiKey("D", e, appPrefix);
      break;
    case "Home":
      seq = csiKey("H", e, appPrefix);
      break;
    case "End":
      seq = csiKey("F", e, appPrefix);
      break;
    case "Insert":
      seq = tildeKey(2, e);
      break;
    case "Delete":
      seq = tildeKey(3, e);
      break;
    case "PageUp":
      seq = tildeKey(5, e);
      break;
    case "PageDown":
      seq = tildeKey(6, e);
      break;
    case "F1":
      seq = xtermModParam(e) ? `\x1b[1;${xtermModParam(e)}P` : "\x1bOP";
      break;
    case "F2":
      seq = xtermModParam(e) ? `\x1b[1;${xtermModParam(e)}Q` : "\x1bOQ";
      break;
    case "F3":
      seq = xtermModParam(e) ? `\x1b[1;${xtermModParam(e)}R` : "\x1bOR";
      break;
    case "F4":
      seq = xtermModParam(e) ? `\x1b[1;${xtermModParam(e)}S` : "\x1bOS";
      break;
    case "F5":
      seq = tildeKey(15, e);
      break;
    case "F6":
      seq = tildeKey(17, e);
      break;
    case "F7":
      seq = tildeKey(18, e);
      break;
    case "F8":
      seq = tildeKey(19, e);
      break;
    case "F9":
      seq = tildeKey(20, e);
      break;
    case "F10":
      seq = tildeKey(21, e);
      break;
    case "F11":
      seq = tildeKey(23, e);
      break;
    case "F12":
      seq = tildeKey(24, e);
      break;
    default:
      if (e.key.length === 1 && !e.ctrlKey) {
        seq = e.altKey ? `\x1b${e.key}` : e.key;
      }
      break;
  }

  return seq === null ? null : enc.encode(seq);
}

export function encodePaste(text: string): Uint8Array {
  return enc.encode(`\x1b[200~${text}\x1b[201~`);
}
