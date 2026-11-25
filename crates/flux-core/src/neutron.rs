//! Tauri IPC bridge to the headless Neutron engine (`flux-neutron`).
//!
//! Keeps [`crate::files`] intact for existing Flux modules (`pdf`, `kb`,
//! `fsroots`, `places`, `bindings`) while powering the unified Neutron UI.

#[cfg(desktop)]
mod real {
    use std::sync::Arc;

    use flux_neutron::{
        ArchiveSummaryDto, BatchRenamePair, BatchRenameResult, FuzzyHit, ListOptions,
        NeutronEngine, NeutronError, NeutronListing, NeutronPlaces, PreviewData, RecentFile,
        SortBy, SortDir,
    };
    use tauri::{AppHandle, Emitter, State};

    pub struct NeutronManager {
        engine: Arc<NeutronEngine>,
    }

    impl Default for NeutronManager {
        fn default() -> Self {
            Self::new()
        }
    }

    impl NeutronManager {
        pub fn new() -> Self {
            Self {
                engine: Arc::new(NeutronEngine::new()),
            }
        }

        pub fn engine(&self) -> Arc<NeutronEngine> {
            Arc::clone(&self.engine)
        }
    }

    async fn run_blocking<T, F>(f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, NeutronError> + Send + 'static,
    {
        tauri::async_runtime::spawn_blocking(move || f().map_err(|e| e.to_string()))
            .await
            .map_err(|e| format!("neutron task failed: {e}"))?
    }

    #[tauri::command]
    pub async fn neutron_places(manager: State<'_, NeutronManager>) -> Result<NeutronPlaces, String> {
        let eng = manager.engine();
        tauri::async_runtime::spawn_blocking(move || eng.places())
            .await
            .map_err(|e| format!("neutron task failed: {e}"))
    }

    #[tauri::command]
    pub async fn neutron_recent(manager: State<'_, NeutronManager>) -> Result<Vec<RecentFile>, String> {
        let eng = manager.engine();
        tauri::async_runtime::spawn_blocking(move || eng.recent_files())
            .await
            .map_err(|e| format!("neutron task failed: {e}"))
    }

    #[tauri::command]
    pub async fn neutron_pin_toggle(
        manager: State<'_, NeutronManager>,
        path: String,
        site: Option<String>,
    ) -> Result<bool, String> {
        let eng = manager.engine();
        run_blocking(move || eng.pin_toggle(&path, site.as_deref())).await
    }

    #[tauri::command]
    pub async fn neutron_list(
        manager: State<'_, NeutronManager>,
        location: String,
        sort_by: Option<SortBy>,
        sort_dir: Option<SortDir>,
        dirs_first: Option<bool>,
        show_hidden: Option<bool>,
        filter: Option<String>,
    ) -> Result<NeutronListing, String> {
        let eng = manager.engine();
        let opts = ListOptions {
            sort_by: sort_by.unwrap_or_default(),
            sort_dir: sort_dir.unwrap_or_default(),
            dirs_first: dirs_first.unwrap_or(true),
            show_hidden: show_hidden.unwrap_or(false),
            filter: filter.unwrap_or_default(),
        };
        run_blocking(move || eng.list_dir(&location, opts)).await
    }

    #[tauri::command]
    pub async fn neutron_fuzzy(
        manager: State<'_, NeutronManager>,
        root: String,
        query: String,
        limit: Option<usize>,
    ) -> Result<Vec<FuzzyHit>, String> {
        let eng = manager.engine();
        run_blocking(move || eng.fuzzy_search(&root, &query, limit.unwrap_or(60))).await
    }

    #[tauri::command]
    pub async fn neutron_preview(
        manager: State<'_, NeutronManager>,
        location: String,
    ) -> Result<PreviewData, String> {
        let eng = manager.engine();
        run_blocking(move || eng.preview(&location)).await
    }

    #[tauri::command]
    pub async fn neutron_watch(
        app: AppHandle,
        manager: State<'_, NeutronManager>,
        path: String,
    ) -> Result<u64, String> {
        let eng = manager.engine();
        let dir = path.clone();
        run_blocking(move || {
            eng.watch(&dir, move || {
                let _ = app.emit(
                    "flux://neutron-watch",
                    serde_json::json!({ "path": path }),
                );
            })
        })
        .await
    }

    #[tauri::command]
    pub fn neutron_unwatch(manager: State<'_, NeutronManager>, id: u64) {
        manager.engine.unwatch(id);
    }

    #[tauri::command]
    pub async fn neutron_mkdir(
        manager: State<'_, NeutronManager>,
        parent: String,
        name: String,
    ) -> Result<String, String> {
        let eng = manager.engine();
        run_blocking(move || eng.mkdir(&parent, &name)).await
    }

    #[tauri::command]
    pub async fn neutron_create_file(
        manager: State<'_, NeutronManager>,
        parent: String,
        name: String,
    ) -> Result<String, String> {
        let eng = manager.engine();
        run_blocking(move || eng.create_file(&parent, &name)).await
    }

    #[tauri::command]
    pub async fn neutron_rename(
        manager: State<'_, NeutronManager>,
        path: String,
        new_name: String,
    ) -> Result<String, String> {
        let eng = manager.engine();
        run_blocking(move || eng.rename(&path, &new_name)).await
    }

    #[tauri::command]
    pub async fn neutron_batch_rename(
        manager: State<'_, NeutronManager>,
        pairs: Vec<BatchRenamePair>,
    ) -> Result<BatchRenameResult, String> {
        let eng = manager.engine();
        tauri::async_runtime::spawn_blocking(move || eng.batch_rename(&pairs))
            .await
            .map_err(|e| format!("neutron task failed: {e}"))
    }

    #[tauri::command]
    pub async fn neutron_copy(
        manager: State<'_, NeutronManager>,
        paths: Vec<String>,
        dest: String,
    ) -> Result<(), String> {
        let eng = manager.engine();
        run_blocking(move || eng.copy_items(&paths, &dest)).await
    }

    #[tauri::command]
    pub async fn neutron_move(
        manager: State<'_, NeutronManager>,
        paths: Vec<String>,
        dest: String,
    ) -> Result<(), String> {
        let eng = manager.engine();
        run_blocking(move || eng.move_items(&paths, &dest)).await
    }

    #[tauri::command]
    pub async fn neutron_trash(
        manager: State<'_, NeutronManager>,
        paths: Vec<String>,
    ) -> Result<(), String> {
        let eng = manager.engine();
        run_blocking(move || eng.trash_items(&paths)).await
    }

    #[tauri::command]
    pub async fn neutron_delete(
        manager: State<'_, NeutronManager>,
        paths: Vec<String>,
    ) -> Result<(), String> {
        let eng = manager.engine();
        run_blocking(move || eng.delete_permanent(&paths)).await
    }

    #[tauri::command]
    pub async fn neutron_undo(manager: State<'_, NeutronManager>) -> Result<Option<String>, String> {
        let eng = manager.engine();
        run_blocking(move || eng.undo()).await
    }

    #[tauri::command]
    pub async fn neutron_open(manager: State<'_, NeutronManager>, path: String) -> Result<(), String> {
        let eng = manager.engine();
        run_blocking(move || eng.open(&path)).await
    }

    #[tauri::command]
    pub async fn neutron_reveal(
        manager: State<'_, NeutronManager>,
        paths: Vec<String>,
    ) -> Result<(), String> {
        let eng = manager.engine();
        run_blocking(move || eng.reveal(&paths)).await
    }

    #[tauri::command]
    pub async fn neutron_tag_toggle(
        manager: State<'_, NeutronManager>,
        paths: Vec<String>,
        color: u8,
        on: bool,
    ) -> Result<(), String> {
        let eng = manager.engine();
        run_blocking(move || eng.tag_toggle(&paths, color, on)).await
    }

    #[tauri::command]
    pub async fn neutron_archive_extract(
        manager: State<'_, NeutronManager>,
        archive: String,
        dest: Option<String>,
    ) -> Result<ArchiveSummaryDto, String> {
        let eng = manager.engine();
        run_blocking(move || eng.archive_extract(&archive, dest.as_deref())).await
    }

    #[tauri::command]
    pub async fn neutron_archive_create(
        manager: State<'_, NeutronManager>,
        sources: Vec<String>,
        dest: Option<String>,
    ) -> Result<ArchiveSummaryDto, String> {
        let eng = manager.engine();
        run_blocking(move || eng.archive_create(&sources, dest.as_deref())).await
    }
}
#[cfg(desktop)]
pub use real::*;

/// Mobile stub: exposes identical `NeutronManager` + `neutron_*` commands so
/// mobile target checks build without `flux-neutron`.
#[cfg(mobile)]
mod stub {
    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, State};

    const UNAVAILABLE: &str = "neutron explorer is desktop-only";

    #[derive(Default)]
    pub struct NeutronManager;
    impl NeutronManager {
        pub fn new() -> Self {
            Self
        }
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum SortBy {
        Name,
        Size,
        Modified,
        Created,
        Kind,
        Added,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum SortDir {
        Asc,
        Desc,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct NeutronListing {
        pub location: String,
        pub display_path: String,
        pub parent: Option<String>,
        pub scheme: String,
        pub site: Option<String>,
        pub total_count: usize,
        pub hidden_count: usize,
        pub entries: Vec<serde_json::Value>,
    }

    #[derive(Debug, Clone, Default, Serialize, Deserialize)]
    pub struct NeutronPlaces {
        pub known: Vec<serde_json::Value>,
        pub pins: Vec<serde_json::Value>,
        pub drives: Vec<serde_json::Value>,
        pub cloud: Vec<serde_json::Value>,
        pub servers: Vec<serde_json::Value>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct FuzzyHit {
        pub name: String,
        pub path: String,
        pub is_dir: bool,
        pub score: u32,
        pub positions: Vec<u32>,
        pub parent: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct PreviewData {
        pub kind: String,
        pub text: Option<String>,
        pub data_url: Option<String>,
        pub mime: Option<String>,
        pub size: u64,
        pub modified_ms: i64,
        pub created_ms: i64,
        pub readonly: bool,
        pub tags: Vec<String>,
        pub child_count: Option<usize>,
        pub truncated: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct BatchRenamePair {
        pub from: String,
        pub to: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct BatchRenameResult {
        pub renamed: usize,
        pub errors: Vec<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ArchiveSummaryDto {
        pub destination: String,
        pub files: u64,
        pub bytes: u64,
        pub refused: Vec<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct RecentFile {
        pub name: String,
        pub path: String,
        pub parent: String,
        pub at_ms: i64,
        pub exists: bool,
        pub ext: String,
    }

    #[tauri::command]
    pub async fn neutron_places(_manager: State<'_, NeutronManager>) -> Result<NeutronPlaces, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_recent(_manager: State<'_, NeutronManager>) -> Result<Vec<RecentFile>, String> {
        Ok(Vec::new())
    }

    #[tauri::command]
    pub async fn neutron_pin_toggle(
        _manager: State<'_, NeutronManager>,
        _path: String,
        _site: Option<String>,
    ) -> Result<bool, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_list(
        _manager: State<'_, NeutronManager>,
        _location: String,
        _sort_by: Option<SortBy>,
        _sort_dir: Option<SortDir>,
        _dirs_first: Option<bool>,
        _show_hidden: Option<bool>,
        _filter: Option<String>,
    ) -> Result<NeutronListing, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_fuzzy(
        _manager: State<'_, NeutronManager>,
        _root: String,
        _query: String,
        _limit: Option<usize>,
    ) -> Result<Vec<FuzzyHit>, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_preview(
        _manager: State<'_, NeutronManager>,
        _location: String,
    ) -> Result<PreviewData, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_watch(
        _app: AppHandle,
        _manager: State<'_, NeutronManager>,
        _path: String,
    ) -> Result<u64, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub fn neutron_unwatch(_manager: State<'_, NeutronManager>, _id: u64) {}

    #[tauri::command]
    pub async fn neutron_mkdir(
        _manager: State<'_, NeutronManager>,
        _parent: String,
        _name: String,
    ) -> Result<String, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_create_file(
        _manager: State<'_, NeutronManager>,
        _parent: String,
        _name: String,
    ) -> Result<String, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_rename(
        _manager: State<'_, NeutronManager>,
        _path: String,
        _new_name: String,
    ) -> Result<String, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_batch_rename(
        _manager: State<'_, NeutronManager>,
        _pairs: Vec<BatchRenamePair>,
    ) -> Result<BatchRenameResult, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_copy(
        _manager: State<'_, NeutronManager>,
        _paths: Vec<String>,
        _dest: String,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_move(
        _manager: State<'_, NeutronManager>,
        _paths: Vec<String>,
        _dest: String,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_trash(
        _manager: State<'_, NeutronManager>,
        _paths: Vec<String>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_delete(
        _manager: State<'_, NeutronManager>,
        _paths: Vec<String>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_undo(_manager: State<'_, NeutronManager>) -> Result<Option<String>, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_open(_manager: State<'_, NeutronManager>, _path: String) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_reveal(
        _manager: State<'_, NeutronManager>,
        _paths: Vec<String>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_tag_toggle(
        _manager: State<'_, NeutronManager>,
        _paths: Vec<String>,
        _color: u8,
        _on: bool,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_archive_extract(
        _manager: State<'_, NeutronManager>,
        _archive: String,
        _dest: Option<String>,
    ) -> Result<ArchiveSummaryDto, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn neutron_archive_create(
        _manager: State<'_, NeutronManager>,
        _sources: Vec<String>,
        _dest: Option<String>,
    ) -> Result<ArchiveSummaryDto, String> {
        Err(UNAVAILABLE.into())
    }
}
#[cfg(mobile)]
pub use stub::*;
