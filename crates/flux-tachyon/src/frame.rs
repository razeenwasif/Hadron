//! Compact binary frame encoder for `tachyon::term::Term`.
//!
//! Sends only rows that changed since the previous frame unless dimensions,
//! scrollback offset, or alternate screen state changed (`full_repaint`), keeping
//! high-frequency typing to a few dozen bytes per frame.

use tachyon::term::{Cell, CellFlags, Color, CursorShape, Term, CLUSTER_TAG};

/// Binary frame header size in bytes (little-endian).
pub const HEADER_LEN: usize = 24;

pub const FLAG_FULL_REPAINT: u8 = 1 << 0;
pub const FLAG_EXITED: u8 = 1 << 1;
pub const FLAG_BELL: u8 = 1 << 2;

const SPAN_ATTR_MASK: CellFlags = CellFlags::from_bits_truncate(
    CellFlags::BOLD.bits()
        | CellFlags::DIM.bits()
        | CellFlags::ITALIC.bits()
        | CellFlags::ANY_UNDERLINE.bits()
        | CellFlags::BLINK.bits()
        | CellFlags::REVERSE.bits()
        | CellFlags::HIDDEN.bits()
        | CellFlags::STRIKEOUT.bits()
        | CellFlags::OVERLINE.bits(),
);

const STYLE_VISIBLE_BLANK: CellFlags = CellFlags::from_bits_truncate(
    CellFlags::REVERSE.bits()
        | CellFlags::ANY_UNDERLINE.bits()
        | CellFlags::STRIKEOUT.bits()
        | CellFlags::OVERLINE.bits(),
);

#[derive(Default)]
pub struct FrameEncoder {
    last_cols: usize,
    last_rows: usize,
    last_display_offset: usize,
    last_alt_screen: bool,
    last_bell: u64,
    prev_rows: Vec<Vec<Cell>>,
}

impl FrameEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn invalidate(&mut self) {
        self.prev_rows.clear();
    }

    /// Encode either dirty rows or a full frame from `term`.
    /// Returns `None` when `force` is false and nothing visible changed.
    pub fn encode(&mut self, term: &Term, force: bool) -> Option<Vec<u8>> {
        let cols = term.cols();
        let rows = term.rows();
        let grid = term.grid();
        let history_len = grid.history_len().min(u32::MAX as usize) as u32;
        let display_offset = grid.display_offset();
        let alt_screen = term.in_alt_screen();
        let cursor = term.cursor_state();

        let bell = term.bell_revision != self.last_bell;
        self.last_bell = term.bell_revision;

        let geometry_changed = force
            || cols != self.last_cols
            || rows != self.last_rows
            || display_offset != self.last_display_offset
            || alt_screen != self.last_alt_screen
            || self.prev_rows.len() != rows;

        if geometry_changed {
            self.last_cols = cols;
            self.last_rows = rows;
            self.last_display_offset = display_offset;
            self.last_alt_screen = alt_screen;
            self.prev_rows.resize_with(rows, Vec::new);
        }

        let mut dirty_rows: Vec<usize> = Vec::with_capacity(if geometry_changed { rows } else { 8 });
        for y in 0..rows {
            let cells = grid.row(y).cells();
            if geometry_changed || self.prev_rows[y].as_slice() != cells {
                self.prev_rows[y].clear();
                self.prev_rows[y].extend_from_slice(cells);
                // On full repaint, the client clears the entire canvas first so empty
                // rows do not need to be transmitted.
                if !geometry_changed || !row_is_default_blank(cells) {
                    dirty_rows.push(y);
                }
            }
        }

        if dirty_rows.is_empty() && !geometry_changed && !bell {
            return None;
        }

        let mut flags = if geometry_changed { FLAG_FULL_REPAINT } else { 0 };
        if bell {
            flags |= FLAG_BELL;
        }

        let cursor_shape = match cursor.shape {
            CursorShape::Block => 0u8,
            CursorShape::Underline => 1u8,
            CursorShape::Beam => 2u8,
        };

        let mut out = Vec::with_capacity(HEADER_LEN + dirty_rows.len() * 64);
        write_header(
            &mut out,
            cols as u16,
            rows as u16,
            cursor.x as u16,
            cursor.y as u16,
            cursor_shape,
            u8::from(cursor.visible),
            u8::from(alt_screen),
            flags,
            history_len,
            display_offset as u32,
            dirty_rows.len() as u16,
        );

        let mut span_buf = Vec::with_capacity(32);
        for y in dirty_rows {
            let cells = &self.prev_rows[y];
            encode_row(term, y as u16, cells, &mut span_buf, &mut out);
        }

        Some(out)
    }
}

/// Encode a compact terminal-exited sentinel frame.
pub fn encode_exited_frame(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN);
    write_header(&mut out, cols, rows, 0, 0, 0, 0, 0, FLAG_EXITED, 0, 0, 0);
    out
}

#[allow(clippy::too_many_arguments)]
fn write_header(
    out: &mut Vec<u8>,
    cols: u16,
    rows: u16,
    cursor_x: u16,
    cursor_y: u16,
    cursor_shape: u8,
    cursor_visible: u8,
    alt_screen: u8,
    flags: u8,
    history_len: u32,
    display_offset: u32,
    row_count: u16,
) {
    out.extend_from_slice(&cols.to_le_bytes());
    out.extend_from_slice(&rows.to_le_bytes());
    out.extend_from_slice(&cursor_x.to_le_bytes());
    out.extend_from_slice(&cursor_y.to_le_bytes());
    out.push(cursor_shape);
    out.push(cursor_visible);
    out.push(alt_screen);
    out.push(flags);
    out.extend_from_slice(&history_len.to_le_bytes());
    out.extend_from_slice(&display_offset.to_le_bytes());
    out.extend_from_slice(&row_count.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
}

#[inline]
fn cell_is_default_blank(c: &Cell) -> bool {
    c.is_empty()
        && c.fg == Color::DEFAULT
        && c.bg == Color::DEFAULT
        && !c.flags.intersects(STYLE_VISIBLE_BLANK)
}

#[inline]
fn row_is_default_blank(cells: &[Cell]) -> bool {
    cells.iter().all(cell_is_default_blank)
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct SpanStyle {
    fg: u32,
    bg: u32,
    flags: u16,
}

struct PendingSpan {
    x: u16,
    cell_count: u16,
    style: SpanStyle,
    text: String,
}

fn push_cell_text(term: &Term, c: &Cell, dst: &mut String) {
    if c.ch & CLUSTER_TAG != 0 {
        if let Some(cl) = term.cluster(c.ch) {
            for &ch in cl {
                dst.push(ch);
            }
            return;
        }
    }
    dst.push(c.scalar().unwrap_or(' '));
}

fn encode_row(
    term: &Term,
    y: u16,
    cells: &[Cell],
    spans: &mut Vec<PendingSpan>,
    out: &mut Vec<u8>,
) {
    spans.clear();
    let mut current: Option<PendingSpan> = None;

    for (x, c) in cells.iter().enumerate() {
        if c.flags.contains(CellFlags::WIDE_SPACER) {
            continue;
        }
        if cell_is_default_blank(c) {
            if let Some(sp) = current.take() {
                spans.push(sp);
            }
            continue;
        }

        let is_wide = c.flags.contains(CellFlags::WIDE);
        let cell_w = if is_wide { 2u16 } else { 1u16 };
        let style = SpanStyle {
            fg: c.fg.0,
            bg: c.bg.0,
            flags: (c.flags & SPAN_ATTR_MASK).bits() | if is_wide { CellFlags::WIDE.bits() } else { 0 },
        };

        let append = current
            .as_ref()
            .is_some_and(|sp| sp.style == style && sp.x + sp.cell_count == x as u16);

        if append {
            if let Some(sp) = current.as_mut() {
                sp.cell_count = sp.cell_count.saturating_add(cell_w);
                push_cell_text(term, c, &mut sp.text);
            }
        } else {
            if let Some(sp) = current.take() {
                spans.push(sp);
            }
            let mut text = String::with_capacity(8);
            push_cell_text(term, c, &mut text);
            current = Some(PendingSpan {
                x: x as u16,
                cell_count: cell_w,
                style,
                text,
            });
        }
    }
    if let Some(sp) = current.take() {
        spans.push(sp);
    }

    out.extend_from_slice(&y.to_le_bytes());
    out.extend_from_slice(&(spans.len() as u16).to_le_bytes());
    for sp in spans.iter() {
        let bytes = sp.text.as_bytes();
        let byte_len = bytes.len().min(u16::MAX as usize);
        out.extend_from_slice(&sp.x.to_le_bytes());
        out.extend_from_slice(&sp.cell_count.to_le_bytes());
        out.extend_from_slice(&sp.style.fg.to_le_bytes());
        out.extend_from_slice(&sp.style.bg.to_le_bytes());
        out.extend_from_slice(&sp.style.flags.to_le_bytes());
        out.extend_from_slice(&(byte_len as u16).to_le_bytes());
        out.extend_from_slice(&bytes[..byte_len]);
    }
}
