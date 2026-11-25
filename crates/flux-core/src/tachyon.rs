//! Tauri IPC bridge to the Tachyon Mux v2 terminal backend (`flux-tachyon`).
//!
//! Keeps [`crate::terminal`] intact until the Phase 2 frontend swap; both can
//! coexist cleanly during rollout.

#[cfg(desktop)]
mod real {
    use std::path::Path;
    use std::sync::Arc;

    use flux_tachyon::{CommandReceipt, HostSummary, RewindFrameData, TachyonBridge};
    use serde::Serialize;
    use serde_json::Value;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::{AppHandle, Emitter, State};

    use crate::state::{FluxState, TabKind};

    /// Managed Tauri state owning the shared `TachyonBridge` connection pool
    /// and live binary-frame `AttachManager`.
    pub struct TachyonManager {
        bridge: Arc<TachyonBridge>,
    }

    impl Default for TachyonManager {
        fn default() -> Self {
            Self::new()
        }
    }

    impl TachyonManager {
        pub fn new() -> Self {
            Self {
                bridge: Arc::new(TachyonBridge::new()),
            }
        }

        pub fn bridge(&self) -> Arc<TachyonBridge> {
            Arc::clone(&self.bridge)
        }
    }

    #[derive(Serialize)]
    pub struct RewindPointDto {
        pub seq: u64,
        pub age_ms: u64,
    }

    #[derive(Serialize)]
    pub struct RewindFrameDto {
        pub seq: u64,
        pub cols: usize,
        pub rows: usize,
        pub age_ms: u64,
        pub vt: Vec<u8>,
        pub text: Option<String>,
    }

    impl From<RewindFrameData> for RewindFrameDto {
        fn from(f: RewindFrameData) -> Self {
            Self {
                seq: f.seq,
                cols: f.cols,
                rows: f.rows,
                age_ms: f.age_ms,
                vt: f.vt,
                text: f.text,
            }
        }
    }

    #[derive(Serialize)]
    pub struct CommandReceiptDto {
        pub cmd_seq: Option<u32>,
        pub cmdline: Option<String>,
        pub exit_code: Option<i32>,
        pub wall_us: u64,
        pub cpu_us: Option<u64>,
        pub pcore_bp: Option<u16>,
        pub energy_mj: Option<u64>,
        pub peak_bytes: Option<u64>,
        pub finished_at: u64,
    }

    impl From<CommandReceipt> for CommandReceiptDto {
        fn from(r: CommandReceipt) -> Self {
            Self {
                cmd_seq: r.cmd_seq,
                cmdline: r.cmdline,
                exit_code: r.exit_code,
                wall_us: r.wall_us,
                cpu_us: r.cpu_us,
                pcore_bp: r.pcore_bp,
                energy_mj: r.energy_mj,
                peak_bytes: r.peak_bytes,
                finished_at: r.finished_at,
            }
        }
    }

    fn is_local_host(host: Option<&str>) -> bool {
        match host.map(str::trim).filter(|s| !s.is_empty()) {
            None => true,
            Some(h) => h.eq_ignore_ascii_case("local"),
        }
    }

    fn resolve_cwd(state: &FluxState, host: Option<&str>, explicit: Option<String>) -> Option<String> {
        let explicit = explicit.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if explicit.is_some() {
            return explicit;
        }
        if !is_local_host(host) {
            return None;
        }
        let id = state.active_tab()?;
        let tab = state.tabs.get(&id)?;
        let raw = if tab.kind == TabKind::Terminal || tab.kind == TabKind::Files {
            tab.url.trim()
        } else {
            return None;
        };
        let path_str = if let Some(rest) = raw.strip_prefix("file://") {
            rest.to_string()
        } else if let Some(rest) = raw.strip_prefix('~') {
            let home = std::env::var("HOME").ok()?;
            format!("{home}{rest}")
        } else {
            raw.to_string()
        };
        if Path::new(&path_str).is_dir() {
            Some(path_str)
        } else {
            None
        }
    }

    async fn run_blocking<T, F>(f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, flux_tachyon::TachyonError> + Send + 'static,
    {
        tauri::async_runtime::spawn_blocking(move || f().map_err(|e| e.to_string()))
            .await
            .map_err(|e| format!("tachyon task failed: {e}"))?
    }

    #[tauri::command]
    pub async fn tachyon_hosts(manager: State<'_, TachyonManager>) -> Result<Vec<HostSummary>, String> {
        let bridge = manager.bridge();
        tauri::async_runtime::spawn_blocking(move || bridge.hosts())
            .await
            .map_err(|e| format!("tachyon task failed: {e}"))
    }

    #[tauri::command]
    pub async fn tachyon_state(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
    ) -> Result<Value, String> {
        let bridge = manager.bridge();
        run_blocking(move || bridge.state(host.as_deref()).map(|s| s.to_json())).await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn tachyon_session_new(
        app: AppHandle,
        state: State<'_, FluxState>,
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        name: Option<String>,
        cwd: Option<String>,
        cmd: Option<Vec<String>>,
        label: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, String> {
        crate::rpc::publish_active(&app);
        let cwd = resolve_cwd(&state, host.as_deref(), cwd);
        let bridge = manager.bridge();
        let (session, window, block) = run_blocking(move || {
            bridge.session_new(
                host.as_deref(),
                name.as_deref(),
                cwd.as_deref(),
                cmd.as_deref(),
                label.as_deref(),
                cols.unwrap_or(100),
                rows.unwrap_or(30),
            )
        })
        .await?;
        Ok(serde_json::json!({
            "session": session.to_json(),
            "window": window.to_json(),
            "block": block.to_json(),
        }))
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn tachyon_window_new(
        app: AppHandle,
        state: State<'_, FluxState>,
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        session_id: String,
        name: Option<String>,
        cwd: Option<String>,
        cmd: Option<Vec<String>>,
        label: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, String> {
        crate::rpc::publish_active(&app);
        let cwd = resolve_cwd(&state, host.as_deref(), cwd);
        let bridge = manager.bridge();
        let (window, block) = run_blocking(move || {
            bridge.window_new(
                host.as_deref(),
                &session_id,
                name.as_deref(),
                cwd.as_deref(),
                cmd.as_deref(),
                label.as_deref(),
                cols.unwrap_or(100),
                rows.unwrap_or(30),
            )
        })
        .await?;
        Ok(serde_json::json!({
            "window": window.to_json(),
            "block": block.to_json(),
        }))
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn tachyon_split(
        app: AppHandle,
        state: State<'_, FluxState>,
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        block_id: String,
        dir: String,
        cwd: Option<String>,
        cmd: Option<Vec<String>>,
        label: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, String> {
        crate::rpc::publish_active(&app);
        let cwd = resolve_cwd(&state, host.as_deref(), cwd);
        let bridge = manager.bridge();
        let (window, block) = run_blocking(move || {
            bridge.split(
                host.as_deref(),
                &block_id,
                &dir,
                cwd.as_deref(),
                cmd.as_deref(),
                label.as_deref(),
                cols.unwrap_or(80),
                rows.unwrap_or(24),
            )
        })
        .await?;
        Ok(serde_json::json!({
            "window": window.to_json(),
            "block": block.to_json(),
        }))
    }

    #[tauri::command]
    pub async fn tachyon_resize_ratio(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        window_id: String,
        path: Vec<bool>,
        ratio: f32,
    ) -> Result<(), String> {
        let bridge = manager.bridge();
        run_blocking(move || bridge.resize_ratio(host.as_deref(), &window_id, &path, ratio)).await
    }

    #[tauri::command]
    pub async fn tachyon_focus(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        window_id: String,
        block_id: Option<String>,
    ) -> Result<(), String> {
        let bridge = manager.bridge();
        run_blocking(move || bridge.focus(host.as_deref(), &window_id, block_id.as_deref())).await
    }

    #[tauri::command]
    pub async fn tachyon_rename(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        kind: String,
        id: String,
        name: String,
    ) -> Result<(), String> {
        let bridge = manager.bridge();
        run_blocking(move || bridge.rename(host.as_deref(), &kind, &id, &name)).await
    }

    #[tauri::command]
    pub async fn tachyon_kill(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        kind: String,
        id: String,
    ) -> Result<(), String> {
        let bridge = manager.bridge();
        run_blocking(move || bridge.kill(host.as_deref(), &kind, &id)).await
    }

    #[tauri::command]
    pub async fn tachyon_attach(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        block_id: String,
        cols: u16,
        rows: u16,
        on_frame: Channel<InvokeResponseBody>,
    ) -> Result<u64, String> {
        let bridge = manager.bridge();
        let sink = Arc::new(move |frame: Vec<u8>| {
            let _ = on_frame.send(InvokeResponseBody::Raw(frame));
        });
        run_blocking(move || bridge.attach(host.as_deref(), &block_id, cols, rows, sink)).await
    }

    #[tauri::command]
    pub fn tachyon_detach(manager: State<'_, TachyonManager>, attach_id: u64) {
        manager.bridge.detach(attach_id);
    }

    #[tauri::command]
    pub fn tachyon_write(
        manager: State<'_, TachyonManager>,
        attach_id: u64,
        data: Vec<u8>,
    ) -> Result<(), String> {
        manager.bridge.write(attach_id, &data).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn tachyon_send(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        block_id: String,
        data: Vec<u8>,
    ) -> Result<(), String> {
        let bridge = manager.bridge();
        run_blocking(move || bridge.send(host.as_deref(), &block_id, &data)).await
    }

    #[tauri::command]
    pub fn tachyon_resize(
        manager: State<'_, TachyonManager>,
        attach_id: u64,
        cols: u16,
        rows: u16,
        cell_w: Option<u16>,
        cell_h: Option<u16>,
    ) -> Result<(), String> {
        manager
            .bridge
            .resize(
                attach_id,
                cols,
                rows,
                cell_w.unwrap_or(0),
                cell_h.unwrap_or(0),
            )
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn tachyon_scroll(
        manager: State<'_, TachyonManager>,
        attach_id: u64,
        delta: isize,
        to_bottom: Option<bool>,
    ) -> Result<(), String> {
        manager
            .bridge
            .scroll(attach_id, delta, to_bottom.unwrap_or(false))
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn tachyon_select_text(
        manager: State<'_, TachyonManager>,
        attach_id: u64,
        start_col: usize,
        start_row: usize,
        end_col: usize,
        end_row: usize,
    ) -> Result<String, String> {
        manager
            .bridge
            .select_text(attach_id, start_col, start_row, end_col, end_row)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn tachyon_capture(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        block_id: String,
        lines: Option<usize>,
        ansi: Option<bool>,
    ) -> Result<String, String> {
        let bridge = manager.bridge();
        run_blocking(move || bridge.capture(host.as_deref(), &block_id, lines, ansi.unwrap_or(false)))
            .await
    }

    #[tauri::command]
    pub async fn tachyon_receipts(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        block_id: String,
        limit: Option<usize>,
    ) -> Result<Vec<CommandReceiptDto>, String> {
        let bridge = manager.bridge();
        let list = run_blocking(move || bridge.receipts(host.as_deref(), &block_id, limit)).await?;
        Ok(list.into_iter().map(CommandReceiptDto::from).collect())
    }

    #[tauri::command]
    pub async fn tachyon_rewind_list(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        block_id: String,
    ) -> Result<Vec<RewindPointDto>, String> {
        let bridge = manager.bridge();
        let pts = run_blocking(move || bridge.rewind_list(host.as_deref(), &block_id)).await?;
        Ok(pts
            .into_iter()
            .map(|(seq, age_ms)| RewindPointDto { seq, age_ms })
            .collect())
    }

    #[tauri::command]
    pub async fn tachyon_rewind_frame(
        manager: State<'_, TachyonManager>,
        host: Option<String>,
        block_id: String,
        seq: u64,
        include_text: Option<bool>,
        ansi: Option<bool>,
    ) -> Result<RewindFrameDto, String> {
        let bridge = manager.bridge();
        let frame = run_blocking(move || {
            bridge.rewind_frame(
                host.as_deref(),
                &block_id,
                seq,
                include_text.unwrap_or(false),
                ansi.unwrap_or(false),
            )
        })
        .await?;
        Ok(RewindFrameDto::from(frame))
    }

    #[tauri::command]
    pub async fn tachyon_subscribe(
        app: AppHandle,
        manager: State<'_, TachyonManager>,
        host: Option<String>,
    ) -> Result<(), String> {
        let bridge = manager.bridge();
        run_blocking(move || {
            bridge.subscribe(host.as_deref(), move |h, ev| {
                let _ = app.emit(
                    "flux://tachyon-event",
                    serde_json::json!({ "host": h, "event": ev }),
                );
            })
        })
        .await
    }
}
#[cfg(desktop)]
pub use real::*;

/// Mobile stub: same public surface (`TachyonManager` and all `tachyon_*` commands)
/// so mobile check builds stay clean without linking `flux-tachyon`.
#[cfg(mobile)]
mod stub {
    use serde::Serialize;
    use serde_json::Value;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::{AppHandle, State};

    use crate::state::FluxState;

    const UNAVAILABLE: &str = "tachyon terminal is desktop-only";

    #[derive(Default)]
    pub struct TachyonManager;
    impl TachyonManager {
        pub fn new() -> Self {
            Self
        }
    }

    #[derive(Serialize)]
    pub struct HostSummary {
        pub alias: String,
        pub kind: String,
        pub address: Option<String>,
        pub reachable: bool,
    }

    #[derive(Serialize)]
    pub struct RewindPointDto {
        pub seq: u64,
        pub age_ms: u64,
    }

    #[derive(Serialize)]
    pub struct RewindFrameDto {
        pub seq: u64,
        pub cols: usize,
        pub rows: usize,
        pub age_ms: u64,
        pub vt: Vec<u8>,
        pub text: Option<String>,
    }

    #[derive(Serialize)]
    pub struct CommandReceiptDto {
        pub cmd_seq: Option<u32>,
        pub cmdline: Option<String>,
        pub exit_code: Option<i32>,
        pub wall_us: u64,
        pub cpu_us: Option<u64>,
        pub pcore_bp: Option<u16>,
        pub energy_mj: Option<u64>,
        pub peak_bytes: Option<u64>,
        pub finished_at: u64,
    }

    #[tauri::command]
    pub async fn tachyon_hosts(_manager: State<'_, TachyonManager>) -> Result<Vec<HostSummary>, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_state(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
    ) -> Result<Value, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn tachyon_session_new(
        _app: AppHandle,
        _state: State<'_, FluxState>,
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _name: Option<String>,
        _cwd: Option<String>,
        _cmd: Option<Vec<String>>,
        _label: Option<String>,
        _cols: Option<u16>,
        _rows: Option<u16>,
    ) -> Result<Value, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn tachyon_window_new(
        _app: AppHandle,
        _state: State<'_, FluxState>,
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _session_id: String,
        _name: Option<String>,
        _cwd: Option<String>,
        _cmd: Option<Vec<String>>,
        _label: Option<String>,
        _cols: Option<u16>,
        _rows: Option<u16>,
    ) -> Result<Value, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn tachyon_split(
        _app: AppHandle,
        _state: State<'_, FluxState>,
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _block_id: String,
        _dir: String,
        _cwd: Option<String>,
        _cmd: Option<Vec<String>>,
        _label: Option<String>,
        _cols: Option<u16>,
        _rows: Option<u16>,
    ) -> Result<Value, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_resize_ratio(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _window_id: String,
        _path: Vec<bool>,
        _ratio: f32,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_focus(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _window_id: String,
        _block_id: Option<String>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_rename(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _kind: String,
        _id: String,
        _name: String,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_kill(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _kind: String,
        _id: String,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_attach(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _block_id: String,
        _cols: u16,
        _rows: u16,
        _on_frame: Channel<InvokeResponseBody>,
    ) -> Result<u64, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub fn tachyon_detach(_manager: State<'_, TachyonManager>, _attach_id: u64) {}

    #[tauri::command]
    pub fn tachyon_write(
        _manager: State<'_, TachyonManager>,
        _attach_id: u64,
        _data: Vec<u8>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_send(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _block_id: String,
        _data: Vec<u8>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub fn tachyon_resize(
        _manager: State<'_, TachyonManager>,
        _attach_id: u64,
        _cols: u16,
        _rows: u16,
        _cell_w: Option<u16>,
        _cell_h: Option<u16>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub fn tachyon_scroll(
        _manager: State<'_, TachyonManager>,
        _attach_id: u64,
        _delta: isize,
        _to_bottom: Option<bool>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub fn tachyon_select_text(
        _manager: State<'_, TachyonManager>,
        _attach_id: u64,
        _start_col: usize,
        _start_row: usize,
        _end_col: usize,
        _end_row: usize,
    ) -> Result<String, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_capture(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _block_id: String,
        _lines: Option<usize>,
        _ansi: Option<bool>,
    ) -> Result<String, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_receipts(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _block_id: String,
        _limit: Option<usize>,
    ) -> Result<Vec<CommandReceiptDto>, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_rewind_list(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _block_id: String,
    ) -> Result<Vec<RewindPointDto>, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_rewind_frame(
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
        _block_id: String,
        _seq: u64,
        _include_text: Option<bool>,
        _ansi: Option<bool>,
    ) -> Result<RewindFrameDto, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn tachyon_subscribe(
        _app: AppHandle,
        _manager: State<'_, TachyonManager>,
        _host: Option<String>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
}
#[cfg(mobile)]
pub use stub::*;
