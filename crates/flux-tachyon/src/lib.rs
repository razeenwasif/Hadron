//! Flux bridge to the Tachyon Mux v2 daemon and terminal engine.

pub mod frame;
pub mod pool;
pub mod session;

use std::sync::Arc;

use serde_json::Value;
pub use tachyon::mux::client::RewindFrameData;
pub use tachyon::mux::model::{
    BlockInfo, CommandReceipt, ServerSnapshot, SessionInfo, SplitDir, WindowInfo,
};
use thiserror::Error;

pub use pool::HostSummary;
use pool::TachyonPool;
use session::{AttachManager, FrameSink};

#[derive(Debug, Error)]
pub enum TachyonError {
    #[error("connection error: {0}")]
    Connect(String),
    #[error("rpc error: {0}")]
    Rpc(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid argument: {0}")]
    Invalid(String),
    #[error("attach stream {0} is not active")]
    NotAttached(u64),
}

pub struct TachyonBridge {
    pool: Arc<TachyonPool>,
    sessions: AttachManager,
}

impl Default for TachyonBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl TachyonBridge {
    pub fn new() -> Self {
        Self {
            pool: Arc::new(TachyonPool::new()),
            sessions: AttachManager::new(),
        }
    }

    pub fn hosts(&self) -> Vec<HostSummary> {
        self.pool.hosts()
    }

    pub fn state(&self, host: Option<&str>) -> Result<ServerSnapshot, TachyonError> {
        let client = self.pool.client(host)?;
        client.state().map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn session_new(
        &self,
        host: Option<&str>,
        name: Option<&str>,
        cwd: Option<&str>,
        cmd: Option<&[String]>,
        label: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<(SessionInfo, WindowInfo, BlockInfo), TachyonError> {
        let client = self.pool.client(host)?;
        client
            .create_session(name, cwd, cmd, label, cols.max(2), rows.max(1))
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn window_new(
        &self,
        host: Option<&str>,
        session_id: &str,
        name: Option<&str>,
        cwd: Option<&str>,
        cmd: Option<&[String]>,
        label: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<(WindowInfo, BlockInfo), TachyonError> {
        let client = self.pool.client(host)?;
        client
            .create_window(session_id, name, cwd, cmd, label, cols.max(2), rows.max(1))
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn split(
        &self,
        host: Option<&str>,
        block_id: &str,
        dir: &str,
        cwd: Option<&str>,
        cmd: Option<&[String]>,
        label: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<(WindowInfo, BlockInfo), TachyonError> {
        let split_dir = SplitDir::parse(dir)
            .ok_or_else(|| TachyonError::Invalid(format!("invalid split dir `{dir}`")))?;
        let client = self.pool.client(host)?;
        client
            .split_block(block_id, split_dir, cwd, cmd, label, cols.max(2), rows.max(1))
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    pub fn resize_ratio(
        &self,
        host: Option<&str>,
        window_id: &str,
        path: &[bool],
        ratio: f32,
    ) -> Result<(), TachyonError> {
        let client = self.pool.client(host)?;
        client
            .set_window_ratio(window_id, path, ratio)
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    pub fn focus(
        &self,
        host: Option<&str>,
        window_id: &str,
        block_id: Option<&str>,
    ) -> Result<(), TachyonError> {
        let client = self.pool.client(host)?;
        client
            .focus_window(window_id, block_id)
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    pub fn rename(
        &self,
        host: Option<&str>,
        kind: &str,
        id: &str,
        name: &str,
    ) -> Result<(), TachyonError> {
        let client = self.pool.client(host)?;
        match kind {
            "session" => {
                client
                    .rename_session(id, name)
                    .map_err(|e| TachyonError::Rpc(e.to_string()))?;
            }
            "window" => {
                client
                    .rename_window(id, name)
                    .map_err(|e| TachyonError::Rpc(e.to_string()))?;
            }
            _ => return Err(TachyonError::Invalid(format!("unsupported rename kind `{kind}`"))),
        }
        Ok(())
    }

    pub fn kill(&self, host: Option<&str>, kind: &str, id: &str) -> Result<(), TachyonError> {
        let client = self.pool.client(host)?;
        match kind {
            "block" => client.kill_block(id),
            "window" => client.kill_window(id),
            "session" => client.kill_session(id),
            _ => return Err(TachyonError::Invalid(format!("unsupported kill kind `{kind}`"))),
        }
        .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    pub fn attach(
        &self,
        host: Option<&str>,
        block_id: &str,
        cols: u16,
        rows: u16,
        on_frame: FrameSink,
    ) -> Result<u64, TachyonError> {
        let alias = pool::normalize_host(host);
        let client = self.pool.client(Some(&alias))?;
        self.sessions
            .attach(&client, alias, block_id.to_string(), cols, rows, on_frame)
    }

    pub fn detach(&self, attach_id: u64) {
        self.sessions.detach(attach_id);
    }

    pub fn write(&self, attach_id: u64, bytes: &[u8]) -> Result<(), TachyonError> {
        self.sessions.write(attach_id, bytes)
    }

    pub fn send(&self, host: Option<&str>, block_id: &str, bytes: &[u8]) -> Result<(), TachyonError> {
        let client = self.pool.client(host)?;
        client
            .send_input(block_id, bytes)
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
        self.sessions.resize(attach_id, cols, rows, cell_w, cell_h)
    }

    pub fn scroll(&self, attach_id: u64, delta: isize, to_bottom: bool) -> Result<(), TachyonError> {
        self.sessions.scroll(attach_id, delta, to_bottom)
    }

    pub fn select_text(
        &self,
        attach_id: u64,
        start_col: usize,
        start_row: usize,
        end_col: usize,
        end_row: usize,
    ) -> Result<String, TachyonError> {
        self.sessions
            .select_text(attach_id, start_col, start_row, end_col, end_row)
    }

    pub fn capture(
        &self,
        host: Option<&str>,
        block_id: &str,
        lines: Option<usize>,
        ansi: bool,
    ) -> Result<String, TachyonError> {
        let client = self.pool.client(host)?;
        client
            .capture(block_id, lines, ansi)
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    pub fn receipts(
        &self,
        host: Option<&str>,
        block_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<CommandReceipt>, TachyonError> {
        let client = self.pool.client(host)?;
        client
            .block_receipts(block_id, limit)
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    pub fn rewind_list(
        &self,
        host: Option<&str>,
        block_id: &str,
    ) -> Result<Vec<(u64, u64)>, TachyonError> {
        let client = self.pool.client(host)?;
        client
            .rewind_list(block_id)
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    pub fn rewind_frame(
        &self,
        host: Option<&str>,
        block_id: &str,
        seq: u64,
        include_text: bool,
        ansi: bool,
    ) -> Result<RewindFrameData, TachyonError> {
        let client = self.pool.client(host)?;
        client
            .rewind_frame(block_id, seq, include_text, ansi)
            .map_err(|e| TachyonError::Rpc(e.to_string()))
    }

    pub fn subscribe<F>(&self, host: Option<&str>, on_event: F) -> Result<(), TachyonError>
    where
        F: Fn(String, Value) + Send + Sync + 'static,
    {
        self.pool.subscribe(host, on_event)
    }
}

#[cfg(test)]
mod tests {
    use super::frame::{FrameEncoder, FLAG_FULL_REPAINT, HEADER_LEN};
    use super::session::AttachManager;
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};
    use tachyon::mux::client::MuxClient;
    use tachyon::mux::model::SplitDir;
    use tachyon::mux::Target;
    use tachyon::term::{Processor, Term};

    fn decode_spans(frame: &[u8]) -> (u8, u16, Vec<(u16, String)>) {
        let flags = frame[11];
        let row_count = u16::from_le_bytes([frame[20], frame[21]]);
        let mut pos = HEADER_LEN;
        let mut rows = Vec::new();
        for _ in 0..row_count {
            let y = u16::from_le_bytes([frame[pos], frame[pos + 1]]);
            let span_count = u16::from_le_bytes([frame[pos + 2], frame[pos + 3]]);
            pos += 4;
            let mut text = String::new();
            for _ in 0..span_count {
                let text_len = u16::from_le_bytes([frame[pos + 14], frame[pos + 15]]) as usize;
                pos += 16;
                text.push_str(std::str::from_utf8(&frame[pos..pos + text_len]).unwrap());
                pos += text_len;
            }
            rows.push((y, text));
        }
        assert_eq!(pos, frame.len());
        (flags, row_count, rows)
    }

    #[test]
    fn frame_encoder_diffs_and_handles_ansi_and_cjk() {
        let mut proc = Processor::new();
        let mut term = Term::new(40, 10, 100);
        let mut enc = FrameEncoder::new();

        // Initial blank frame triggers full repaint with 0 rows.
        let f0 = enc.encode(&term, false).unwrap();
        let (flags0, rc0, rows0) = decode_spans(&f0);
        assert_ne!(flags0 & FLAG_FULL_REPAINT, 0);
        assert_eq!(rc0, 0);
        assert!(rows0.is_empty());

        // Write ANSI truecolor + CJK on row 0; only row 0 is emitted on diff frame.
        proc.advance(&mut term, b"\x1b[38;2;255;120;0mHi\x1b[0m \xe4\xb8\xad\xe6\x96\x87\r\nsecond");
        let f1 = enc.encode(&term, false).unwrap();
        let (flags1, rc1, rows1) = decode_spans(&f1);
        assert_eq!(flags1 & FLAG_FULL_REPAINT, 0);
        assert_eq!(rc1, 2);
        assert_eq!(rows1[0], (0, "Hi 中文".to_string()));
        assert_eq!(rows1[1], (1, "second".to_string()));

        // No new output -> no frame emitted.
        assert!(enc.encode(&term, false).is_none());

        // Text selection reads logical grid cleanly.
        assert_eq!(term.text_range(0, 0, 1, 5), "Hi 中文\nsecond");
    }

    #[test]
    fn mux_v2_end_to_end_session_split_attach_write_capture() {
        let dir = std::env::temp_dir().join(format!("flux-tachyon-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("server.sock");

        let s_sock = sock.clone();
        std::thread::spawn(move || {
            let _ = tachyon::server::run(&s_sock);
        });

        let target = Target::Local { socket: sock.clone() };
        let deadline = Instant::now() + Duration::from_secs(4);
        let client = loop {
            match MuxClient::connect(&target, false, "test", "Test") {
                Ok(c) => break c,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => panic!("failed to connect to test mux server: {e}"),
            }
        };

        let (sess, win, blk) = client
            .create_session(Some("flux-test"), None, None, None, 80, 24)
            .unwrap();
        assert!(!sess.id.is_empty());

        let (win2, blk2) = client
            .split_block(&blk.id, SplitDir::Right, None, None, None, 40, 24)
            .unwrap();
        assert_eq!(win2.id, win.id);
        assert_ne!(blk2.id, blk.id);

        let mgr = AttachManager::new();
        let (tx, rx) = mpsc::channel();
        let attach_id = mgr
            .attach(
                &client,
                "local".into(),
                blk2.id.clone(),
                40,
                24,
                Arc::new(move |bytes| {
                    let _ = tx.send(bytes);
                }),
            )
            .unwrap();

        mgr.write(attach_id, b"echo flux_tachyon_ok\n").unwrap();

        let wait_until = Instant::now() + Duration::from_secs(5);
        let mut saw_marker = false;
        while Instant::now() < wait_until {
            if let Ok(frame) = rx.recv_timeout(Duration::from_millis(200)) {
                let (_, _, rows) = decode_spans(&frame);
                if rows.iter().any(|(_, txt)| txt.contains("flux_tachyon_ok")) {
                    saw_marker = true;
                    break;
                }
            }
        }
        assert!(saw_marker, "did not see echo marker in binary frames");

        mgr.resize(attach_id, 60, 20, 8, 16).unwrap();
        let captured = client.capture(&blk2.id, Some(50), false).unwrap();
        assert!(captured.contains("flux_tachyon_ok"));

        mgr.detach(attach_id);
        client.kill_session(&sess.id).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
