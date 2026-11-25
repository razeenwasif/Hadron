//! Attached Mux v2 stream workers and active VT state per mounted view.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tachyon::mux::client::{AttachedStream, MuxClient, StreamChunk};
use tachyon::term::{Processor, Term};

use crate::frame::{encode_exited_frame, FrameEncoder};
use crate::TachyonError;

const SCROLLBACK_LINES: usize = 5000;
const COALESCE_WINDOW: Duration = Duration::from_millis(8);

pub type FrameSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

struct AttachedBlock {
    host: String,
    block_id: String,
    stream: Arc<AttachedStream>,
    term: Arc<Mutex<Term>>,
    encoder: Arc<Mutex<FrameEncoder>>,
    on_frame: FrameSink,
    detached: Arc<AtomicBool>,
}

pub struct AttachManager {
    next_id: AtomicU64,
    active: Arc<Mutex<HashMap<u64, Arc<AttachedBlock>>>>,
}

impl Default for AttachManager {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl AttachManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn attach(
        &self,
        client: &Arc<MuxClient>,
        host: String,
        block_id: String,
        cols: u16,
        rows: u16,
        on_frame: FrameSink,
    ) -> Result<u64, TachyonError> {
        let stream = Arc::new(
            client
                .attach(&block_id, true, true)
                .map_err(|e| TachyonError::Rpc(e.to_string()))?,
        );

        let init_cols = (cols.max(2) as usize).max(2);
        let init_rows = (rows.max(1) as usize).max(1);
        let term = Arc::new(Mutex::new(Term::new(
            (stream.cols as usize).max(init_cols).max(2),
            (stream.rows as usize).max(init_rows).max(1),
            SCROLLBACK_LINES,
        )));
        if stream.cols != init_cols as u16 || stream.rows != init_rows as u16 {
            term.lock().resize(init_cols, init_rows);
            let _ = stream.resize(init_cols as u16, init_rows as u16, 0, 0);
        }

        let encoder = Arc::new(Mutex::new(FrameEncoder::new()));
        let detached = Arc::new(AtomicBool::new(false));
        let attach_id = self.next_id.fetch_add(1, Ordering::Relaxed);

        let block = Arc::new(AttachedBlock {
            host,
            block_id: block_id.clone(),
            stream: Arc::clone(&stream),
            term: Arc::clone(&term),
            encoder: Arc::clone(&encoder),
            on_frame: Arc::clone(&on_frame),
            detached: Arc::clone(&detached),
        });
        self.active.lock().insert(attach_id, Arc::clone(&block));

        let active = Arc::clone(&self.active);
        std::thread::Builder::new()
            .name(format!("tachyon-attach-{attach_id}"))
            .spawn(move || {
                run_reader_loop(attach_id, active, block, block_id);
            })
            .map_err(TachyonError::Io)?;

        Ok(attach_id)
    }

    pub fn write(&self, attach_id: u64, bytes: &[u8]) -> Result<(), TachyonError> {
        let block = self.get(attach_id)?;
        block
            .stream
            .write(bytes)
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    pub fn resize(
        &self,
        attach_id: u64,
        cols: u16,
        rows: u16,
        cell_w: u16,
        cell_h: u16,
    ) -> Result<(), TachyonError> {
        let block = self.get(attach_id)?;
        let c = cols.max(2);
        let r = rows.max(1);
        let _ = block.stream.resize(c, r, cell_w, cell_h);

        let frame = {
            let mut t = block.term.lock();
            t.resize(c as usize, r as usize);
            block.encoder.lock().encode(&t, true)
        };
        if let Some(bytes) = frame {
            (block.on_frame)(bytes);
        }
        Ok(())
    }

    pub fn scroll(&self, attach_id: u64, delta: isize, to_bottom: bool) -> Result<(), TachyonError> {
        let block = self.get(attach_id)?;
        let frame = {
            let mut t = block.term.lock();
            if to_bottom {
                t.scroll_to_bottom();
            } else {
                t.scroll_display(delta);
            }
            block.encoder.lock().encode(&t, false)
        };
        if let Some(bytes) = frame {
            (block.on_frame)(bytes);
        }
        Ok(())
    }

    pub fn select_text(
        &self,
        attach_id: u64,
        start_col: usize,
        start_row: usize,
        end_col: usize,
        end_row: usize,
    ) -> Result<String, TachyonError> {
        let block = self.get(attach_id)?;
        let t = block.term.lock();
        let grid = t.grid();
        let total = grid.total_lines();
        let rows = t.rows();
        let view_top = total.saturating_sub(rows + grid.display_offset());

        let a_line = view_top + start_row.min(rows.saturating_sub(1));
        let b_line = view_top + end_row.min(rows.saturating_sub(1));
        let ((sl, sc), (el, ec)) = if (a_line, start_col) <= (b_line, end_col) {
            ((a_line, start_col), (b_line, end_col))
        } else {
            ((b_line, end_col), (a_line, start_col))
        };
        Ok(t.text_range(sl, sc, el, ec))
    }

    pub fn target(&self, attach_id: u64) -> Result<(String, String), TachyonError> {
        let block = self.get(attach_id)?;
        Ok((block.host.clone(), block.block_id.clone()))
    }

    pub fn detach(&self, attach_id: u64) {
        if let Some(block) = self.active.lock().remove(&attach_id) {
            block.detached.store(true, Ordering::Release);
            block.stream.detach();
        }
    }

    fn get(&self, attach_id: u64) -> Result<Arc<AttachedBlock>, TachyonError> {
        self.active
            .lock()
            .get(&attach_id)
            .cloned()
            .ok_or(TachyonError::NotAttached(attach_id))
    }
}

fn run_reader_loop(
    attach_id: u64,
    active: Arc<Mutex<HashMap<u64, Arc<AttachedBlock>>>>,
    block: Arc<AttachedBlock>,
    block_id: String,
) {
    let mut processor = Processor::new();

    while let Ok(first) = block.stream.recv() {
        if block.detached.load(Ordering::Acquire) {
            break;
        }

        let mut saw_snapshot = false;
        let deadline = Instant::now() + COALESCE_WINDOW;
        let mut replies = Vec::new();

        {
            let mut term = block.term.lock();
            apply_chunk(&mut processor, &mut term, first, &mut saw_snapshot);

            while let Some(rem) = deadline.checked_duration_since(Instant::now()) {
                if block.detached.load(Ordering::Acquire) {
                    break;
                }
                match block.stream.recv_timeout(rem) {
                    Ok(chunk) => apply_chunk(&mut processor, &mut term, chunk, &mut saw_snapshot),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        let _ = term.take_replies();
                        break;
                    }
                }
            }
            if term.has_replies() {
                replies = term.take_replies();
            }
            let frame = block.encoder.lock().encode(&term, saw_snapshot);
            drop(term);

            if !replies.is_empty() {
                let _ = block.stream.write(&replies);
            }
            if let Some(bytes) = frame {
                (block.on_frame)(bytes);
            }
        }
    }

    if !block.detached.load(Ordering::Acquire) {
        let (cols, rows) = {
            let t = block.term.lock();
            (t.cols() as u16, t.rows() as u16)
        };
        tracing::debug!(attach_id, %block_id, "tachyon stream closed");
        (block.on_frame)(encode_exited_frame(cols, rows));
    }
    active.lock().remove(&attach_id);
}

fn apply_chunk(processor: &mut Processor, term: &mut Term, chunk: StreamChunk, saw_snapshot: &mut bool) {
    match chunk {
        StreamChunk::Snapshot(vt) => {
            *saw_snapshot = true;
            if !vt.is_empty() {
                processor.advance(term, &vt);
            }
        }
        StreamChunk::Output(bytes) => {
            if !bytes.is_empty() {
                processor.advance(term, &bytes);
            }
        }
    }
}
