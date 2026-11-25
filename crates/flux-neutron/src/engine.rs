use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine as _;
use neutron_archive::browse::Index as ArchiveIndex;
use neutron_archive::create::zip as archive_zip;
use neutron_archive::extract::extract as archive_extract_all;
use neutron_archive::{destination_for, format_of, Continue as ArchiveContinue};
use neutron_core::entry::{attr, SyncState};
use neutron_core::places::Place;
use neutron_core::{Entry, EntryKind, EntryList, Namespace, NodeId, SortSpec};
use neutron_fuzzy::FuzzyMatcher;
use neutron_remote::path::{join as remote_join, parent as remote_parent};
use neutron_remote::{connect as remote_connect, site as remote_site, Transport};
use neutron_shell::fileops::{delete, rename as shell_rename, transfer, trash, Disposal, Transfer};
use neutron_shell::fs::FsNamespace;
use neutron_shell::open::{reveal as shell_reveal, shell_execute, Verb};
use neutron_shell::places::{cloud_folders, drives, known_folders};
use neutron_shell::tags::{read as read_tags, toggle_color as toggle_tag_color};
use neutron_shell::watch::{watch as fs_watch, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::types::{
    ArchiveSummaryDto, BatchRenamePair, BatchRenameResult, FuzzyHit, ListOptions, NeutronEntry,
    NeutronError, NeutronListing, NeutronPlace, NeutronPlaces, PreviewData, RecentFile,
};

const MAX_ARCHIVE_CACHE: usize = 8;
const MAX_WATCHERS: usize = 8;
const MAX_WALK_ENTRIES: usize = 25_000;
const MAX_WALK_DEPTH: usize = 6;
const WALK_CACHE_TTL: Duration = Duration::from_secs(15);
const PREVIEW_TEXT_LIMIT: usize = 64 * 1024;
const PREVIEW_IMAGE_LIMIT: u64 = 4 * 1024 * 1024;
const MAX_UNDO: usize = 50;
const MAX_RECENT_FILES: usize = 50;

#[derive(Clone)]
struct WalkItem {
    rel_path: String,
    full_path: String,
    name: String,
    parent: String,
    is_dir: bool,
}

enum UndoAction {
    Rename { from: PathBuf, to: PathBuf },
    Trashed(Vec<(PathBuf, PathBuf)>),
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct PinsFile {
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    remote: Vec<RemotePin>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RemotePin {
    site: String,
    path: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct RecentFileDisk {
    #[serde(default)]
    files: Vec<RecentEntryDisk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecentEntryDisk {
    path: String,
    at: i64,
}

enum ParsedLocation {
    Local(PathBuf),
    Remote { site: String, path: String },
    Archive { archive: PathBuf, inner: String },
}

pub fn neutron_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Application Support/Neutron");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(app) = std::env::var_os("APPDATA") {
            return PathBuf::from(app).join("Neutron");
        }
    }
    if let Some(cfg) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(cfg).join("neutron");
    }
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".config/neutron"))
        .unwrap_or_else(|| PathBuf::from(".neutron"))
}

fn expand_local(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return home_path();
    }
    if trimmed == "~" {
        return home_path();
    }
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        return home_path().join(rest);
    }
    PathBuf::from(trimmed)
}

fn home_path() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn parse_location(raw: &str) -> Result<ParsedLocation, NeutronError> {
    let s = raw.trim();
    if let Some(rest) = s.strip_prefix("remote://") {
        let trimmed = rest.trim_start_matches('/');
        let (site, path) = match trimmed.split_once('/') {
            Some((host, tail)) => (host.to_string(), format!("/{}", tail.trim_start_matches('/'))),
            None => (trimmed.to_string(), "/".to_string()),
        };
        if site.is_empty() {
            return Err(NeutronError::Invalid("missing remote site id".into()));
        }
        return Ok(ParsedLocation::Remote { site, path });
    }
    if let Some(rest) = s.strip_prefix("archive://") {
        let (arch_str, inner) = match rest.split_once('!') {
            Some((a, b)) => (a, b.trim_matches('/').to_string()),
            None => (rest, String::new()),
        };
        let archive = expand_local(arch_str);
        if archive.as_os_str().is_empty() {
            return Err(NeutronError::Invalid("missing archive path".into()));
        }
        return Ok(ParsedLocation::Archive { archive, inner });
    }
    Ok(ParsedLocation::Local(expand_local(s)))
}

fn place_to_dto(place: Place, kind: &str) -> NeutronPlace {
    let path_str = place
        .id
        .as_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| place.id.to_string());
    let ejectable = if kind == "drive" {
        place
            .id
            .as_path()
            .is_some_and(neutron_shell::places::ejectable)
    } else {
        false
    };
    NeutronPlace {
        name: place.name,
        path: path_str,
        kind: kind.to_string(),
        site: None,
        capacity_total: place.capacity.map(|c| c.total),
        capacity_free: place.capacity.map(|c| c.free),
        ejectable,
    }
}

fn format_sync(s: SyncState) -> &'static str {
    match s {
        SyncState::None => "none",
        SyncState::CloudOnly => "cloud_only",
        SyncState::Local => "local",
        SyncState::Pinned => "pinned",
        SyncState::Syncing => "syncing",
    }
}

fn split_ext_and_label(name: &str, kind: &str) -> (String, String) {
    if kind == "dir" {
        return (String::new(), "Folder".to_string());
    }
    if kind == "symlink" {
        return (String::new(), "Symlink".to_string());
    }
    let ext = match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => name[dot + 1..].to_ascii_lowercase(),
        _ => String::new(),
    };
    let label = if kind == "archive" {
        "Archive".to_string()
    } else if !ext.is_empty() {
        neutron_core::kinds::name_of(&ext).unwrap_or_else(|| format!("{} file", ext.to_uppercase()))
    } else {
        "File".to_string()
    };
    (ext, label)
}

fn entry_from_list<F>(list: &EntryList, i: usize, build_path: F) -> NeutronEntry
where
    F: FnOnce(&str) -> String,
{
    let name = list.name(i);
    let attrs = list.attrs(i);
    let entry_kind = list.kind(i);
    let kind_str = if entry_kind == EntryKind::Directory {
        "dir"
    } else if entry_kind == EntryKind::Symlink {
        "symlink"
    } else if entry_kind == EntryKind::File && format_of(Path::new(name)).is_some() {
        "archive"
    } else if entry_kind == EntryKind::File {
        "file"
    } else {
        "other"
    };
    let (ext, kind_label) = split_ext_and_label(name, kind_str);
    NeutronEntry {
        name: name.to_string(),
        path: build_path(name),
        kind: kind_str.to_string(),
        size: list.size(i),
        modified_ms: list.modified(i),
        created_ms: list.created(i),
        hidden: list.is_hidden(i),
        readonly: attrs & attr::READONLY != 0,
        is_alias: list.is_alias(i),
        sync: format_sync(list.sync(i)).to_string(),
        tag_mask: list.tag_colors(i),
        ext,
        kind_label,
    }
}

fn build_sort_spec(opts: &ListOptions) -> SortSpec {
    SortSpec {
        column: opts.sort_by.into(),
        order: opts.sort_dir.into(),
        dirs_first: opts.dirs_first,
        group: neutron_core::GroupBy::None,
    }
}

pub struct NeutronEngine {
    remotes: Mutex<HashMap<String, Box<dyn Transport>>>,
    archives: Mutex<HashMap<(PathBuf, i64), Arc<ArchiveIndex>>>,
    walk_cache: Mutex<HashMap<PathBuf, (Instant, Vec<WalkItem>)>>,
    watchers: Mutex<HashMap<u64, (PathBuf, Watcher)>>,
    next_watch_id: AtomicU64,
    undo_stack: Mutex<Vec<UndoAction>>,
}

impl Default for NeutronEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl NeutronEngine {
    pub fn new() -> Self {
        Self {
            remotes: Mutex::new(HashMap::new()),
            archives: Mutex::new(HashMap::new()),
            walk_cache: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
            next_watch_id: AtomicU64::new(1),
            undo_stack: Mutex::new(Vec::new()),
        }
    }

    fn pins_path(&self) -> PathBuf {
        neutron_data_dir().join("pins.json")
    }

    fn load_pins(&self) -> PinsFile {
        let p = self.pins_path();
        let Ok(raw) = fs::read_to_string(p) else {
            return PinsFile::default();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    fn save_pins(&self, pins: &PinsFile) -> Result<(), NeutronError> {
        let path = self.pins_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(pins)
            .map_err(|e| NeutronError::Invalid(e.to_string()))?;
        fs::write(&tmp, text)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    fn recent_path(&self) -> PathBuf {
        neutron_data_dir().join("recent.json")
    }

    fn load_recent_disk(&self) -> RecentFileDisk {
        let p = self.recent_path();
        let Ok(raw) = fs::read_to_string(p) else {
            return RecentFileDisk::default();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    pub fn recent_files(&self) -> Vec<RecentFile> {
        let mut disk = self.load_recent_disk();
        disk.files.sort_by_key(|b| std::cmp::Reverse(b.at));
        disk.files
            .into_iter()
            .take(30)
            .map(|entry| {
                let pb = PathBuf::from(&entry.path);
                let name = pb
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| entry.path.clone());
                let parent = pb
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let ext = pb
                    .extension()
                    .map(|e| e.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default();
                RecentFile {
                    name,
                    exists: pb.exists(),
                    path: entry.path,
                    parent,
                    at_ms: entry.at,
                    ext,
                }
            })
            .collect()
    }

    fn record_recent(&self, pb: &Path) {
        let path_str = pb.to_string_lossy().into_owned();
        if path_str.is_empty() {
            return;
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        let mut disk = self.load_recent_disk();
        disk.files.retain(|e| e.path != path_str);
        disk.files.insert(
            0,
            RecentEntryDisk {
                path: path_str,
                at: now_ms,
            },
        );
        disk.files.truncate(MAX_RECENT_FILES);
        let dest = self.recent_path();
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string(&disk) {
            let tmp = dest.with_extension("json.tmp");
            if fs::write(&tmp, text).is_ok() {
                let _ = fs::rename(&tmp, &dest);
            }
        }
    }

    pub fn places(&self) -> NeutronPlaces {
        let pins_file = self.load_pins();
        let known = known_folders()
            .into_iter()
            .map(|p| place_to_dto(p, "known"))
            .collect();
        let drives_list = drives()
            .into_iter()
            .map(|p| place_to_dto(p, "drive"))
            .collect();
        let cloud = cloud_folders()
            .into_iter()
            .map(|p| place_to_dto(p, "cloud"))
            .collect();

        let mut pins: Vec<NeutronPlace> = Vec::new();
        for folder in pins_file.folders {
            let pb = PathBuf::from(&folder);
            let name = pb
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| folder.clone());
            pins.push(NeutronPlace {
                name,
                path: folder,
                kind: "pin".to_string(),
                site: None,
                capacity_total: None,
                capacity_free: None,
                ejectable: false,
            });
        }
        for rp in pins_file.remote {
            let trimmed = rp.path.trim_end_matches('/');
            let name = trimmed
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(&rp.site);
            pins.push(NeutronPlace {
                name: format!("{name} ({})", rp.site),
                path: format!("remote://{}{}", rp.site, rp.path),
                kind: "remote_pin".to_string(),
                site: Some(rp.site),
                capacity_total: None,
                capacity_free: None,
                ejectable: false,
            });
        }

        let servers = match remote_site::load() {
            Ok(sites) => sites
                .sites
                .into_iter()
                .map(|s| {
                    let start = s.start_path();
                    let label = s.display().to_string();
                    let id = s.id;
                    NeutronPlace {
                        name: label,
                        path: format!("remote://{id}{start}"),
                        kind: "server".to_string(),
                        site: Some(id),
                        capacity_total: None,
                        capacity_free: None,
                        ejectable: false,
                    }
                })
                .collect(),
            Err(e) => {
                tracing::warn!(error = %e, "failed to load neutron remote sites");
                Vec::new()
            }
        };

        NeutronPlaces {
            known,
            pins,
            drives: drives_list,
            cloud,
            servers,
        }
    }

    pub fn pin_toggle(&self, path: &str, site: Option<&str>) -> Result<bool, NeutronError> {
        let mut pins = self.load_pins();
        let now_pinned = if let Some(site_id) = site.map(str::trim).filter(|s| !s.is_empty()) {
            let clean = path
                .strip_prefix(&format!("remote://{site_id}"))
                .unwrap_or(path)
                .to_string();
            if let Some(pos) = pins
                .remote
                .iter()
                .position(|r| r.site == site_id && r.path == clean)
            {
                pins.remote.remove(pos);
                false
            } else {
                pins.remote.push(RemotePin {
                    site: site_id.to_string(),
                    path: clean,
                });
                true
            }
        } else {
            let norm = path.trim().to_string();
            if let Some(pos) = pins.folders.iter().position(|f| f == &norm) {
                pins.folders.remove(pos);
                false
            } else {
                pins.folders.push(norm);
                true
            }
        };
        self.save_pins(&pins)?;
        Ok(now_pinned)
    }

    pub fn list_dir(&self, location: &str, opts: ListOptions) -> Result<NeutronListing, NeutronError> {
        match parse_location(location)? {
            ParsedLocation::Local(dir) => self.list_local(&dir, opts),
            ParsedLocation::Remote { site, path } => self.list_remote(&site, &path, opts),
            ParsedLocation::Archive { archive, inner } => self.list_archive(&archive, &inner, opts),
        }
    }

    fn list_local(&self, dir: &Path, opts: ListOptions) -> Result<NeutronListing, NeutronError> {
        let id = NodeId::path(dir);
        let mut list = FsNamespace.enumerate(&id)?;
        let total_count = list.len();
        let hidden_count = (0..total_count).filter(|&i| list.is_hidden(i)).count();

        neutron_core::sort::apply_filtered(&mut list, build_sort_spec(&opts), opts.show_hidden, &opts.filter);

        let entries = list
            .order()
            .iter()
            .map(|&idx| {
                let i = idx as usize;
                entry_from_list(&list, i, |name| dir.join(name).to_string_lossy().into_owned())
            })
            .collect();

        let location_str = dir.to_string_lossy().into_owned();
        let parent = dir
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| !p.is_empty() && p != &location_str);

        Ok(NeutronListing {
            display_path: location_str.clone(),
            location: location_str,
            parent,
            scheme: "local".to_string(),
            site: None,
            total_count,
            hidden_count,
            entries,
        })
    }

    fn list_remote(
        &self,
        site_id: &str,
        remote_path: &str,
        opts: ListOptions,
    ) -> Result<NeutronListing, NeutronError> {
        let raw_entries = self.with_remote(site_id, |tr| {
            let mut refused = Vec::new();
            tr.list(remote_path, &mut refused)
        })?;

        let mut list = EntryList::with_capacity(raw_entries.len());
        for re in &raw_entries {
            let mut entry = re.to_entry();
            if entry.name.starts_with('.') {
                entry.attrs |= attr::HIDDEN;
            }
            list.push(&entry);
        }

        let total_count = list.len();
        let hidden_count = (0..total_count).filter(|&i| list.is_hidden(i)).count();
        neutron_core::sort::apply_filtered(&mut list, build_sort_spec(&opts), opts.show_hidden, &opts.filter);

        let entries = list
            .order()
            .iter()
            .map(|&idx| {
                let i = idx as usize;
                entry_from_list(&list, i, |name| {
                    let joined = remote_join(remote_path, name)
                        .unwrap_or_else(|_| format!("{}/{}", remote_path.trim_end_matches('/'), name));
                    format!("remote://{site_id}{joined}")
                })
            })
            .collect();

        let parent = remote_parent(remote_path).map(|p| format!("remote://{site_id}{p}"));

        Ok(NeutronListing {
            location: format!("remote://{site_id}{remote_path}"),
            display_path: format!("{site_id}:{remote_path}"),
            parent,
            scheme: "remote".to_string(),
            site: Some(site_id.to_string()),
            total_count,
            hidden_count,
            entries,
        })
    }

    fn list_archive(
        &self,
        archive: &Path,
        inner: &str,
        opts: ListOptions,
    ) -> Result<NeutronListing, NeutronError> {
        let meta = fs::metadata(archive)?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as i64);

        let key = (archive.to_path_buf(), mtime);
        let index = {
            let cache = self.archives.lock();
            if let Some(found) = cache.get(&key) {
                Arc::clone(found)
            } else {
                drop(cache);
                let parsed = Arc::new(ArchiveIndex::read(archive)?);
                let mut cache = self.archives.lock();
                if cache.len() >= MAX_ARCHIVE_CACHE {
                    if let Some(first_key) = cache.keys().next().cloned() {
                        cache.remove(&first_key);
                    }
                }
                cache.insert(key, Arc::clone(&parsed));
                parsed
            }
        };

        let items = index
            .list(inner)
            .ok_or_else(|| NeutronError::Invalid(format!("archive path `{inner}` not found")))?;

        let mut list = EntryList::with_capacity(items.len());
        for item in &items {
            let mut attrs = if item.is_dir { attr::DIRECTORY } else { 0 };
            if item.name.starts_with('.') {
                attrs |= attr::HIDDEN;
            }
            list.push(&Entry {
                name: item.name.clone(),
                kind: if item.is_dir {
                    EntryKind::Directory
                } else {
                    EntryKind::File
                },
                size: item.size,
                modified: item.modified,
                created: 0,
                attrs,
                sync: SyncState::None,
            });
        }

        let total_count = list.len();
        let hidden_count = (0..total_count).filter(|&i| list.is_hidden(i)).count();
        neutron_core::sort::apply_filtered(&mut list, build_sort_spec(&opts), opts.show_hidden, &opts.filter);

        let archive_str = archive.to_string_lossy();
        let clean_inner = inner.trim_matches('/');
        let entries = list
            .order()
            .iter()
            .map(|&idx| {
                let i = idx as usize;
                entry_from_list(&list, i, |name| {
                    let sub = if clean_inner.is_empty() {
                        name.to_string()
                    } else {
                        format!("{clean_inner}/{name}")
                    };
                    format!("archive://{archive_str}!{sub}")
                })
            })
            .collect();

        let parent = if clean_inner.is_empty() {
            archive.parent().map(|p| p.to_string_lossy().into_owned())
        } else {
            let up = clean_inner.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            Some(format!("archive://{archive_str}!{up}"))
        };

        Ok(NeutronListing {
            location: format!("archive://{archive_str}!{clean_inner}"),
            display_path: if clean_inner.is_empty() {
                archive_str.into_owned()
            } else {
                format!("{archive_str}/{clean_inner}")
            },
            parent,
            scheme: "archive".to_string(),
            site: None,
            total_count,
            hidden_count,
            entries,
        })
    }

    fn with_remote<T, F>(&self, site_id: &str, mut f: F) -> Result<T, NeutronError>
    where
        F: FnMut(&mut dyn Transport) -> Result<T, neutron_remote::RemoteError>,
    {
        let mut guard = self.remotes.lock();
        if let Some(tr) = guard.get_mut(site_id) {
            match f(tr.as_mut()) {
                Ok(v) => return Ok(v),
                Err(neutron_remote::RemoteError::Io(_))
                | Err(neutron_remote::RemoteError::Connect { .. }) => {
                    guard.remove(site_id);
                }
                Err(e) => return Err(NeutronError::Remote(e)),
            }
        }
        drop(guard);

        let sites = remote_site::load().map_err(NeutronError::Shell)?;
        let site = sites
            .get(site_id)
            .cloned()
            .ok_or_else(|| NeutronError::Invalid(format!("unknown remote site `{site_id}`")))?;
        let mut tr = remote_connect(&site)?;
        let res = f(tr.as_mut())?;
        self.remotes.lock().insert(site_id.to_string(), tr);
        Ok(res)
    }

    pub fn fuzzy_search(
        &self,
        root: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<FuzzyHit>, NeutronError> {
        let root_path = expand_local(root);
        if !root_path.is_dir() {
            return Err(NeutronError::Invalid(format!(
                "`{}` is not a directory",
                root_path.display()
            )));
        }

        let items = self.cached_walk(&root_path)?;
        let cap = limit.clamp(1, 200);
        let q = query.trim();

        if q.is_empty() {
            return Ok(items
                .iter()
                .take(cap)
                .map(|it| FuzzyHit {
                    name: it.name.clone(),
                    path: it.full_path.clone(),
                    is_dir: it.is_dir,
                    score: 0,
                    positions: Vec::new(),
                    parent: it.parent.clone(),
                })
                .collect());
        }

        let mut matcher = FuzzyMatcher::new();
        let mut scored: Vec<(u32, &WalkItem, Vec<u32>)> = Vec::new();
        for it in &items {
            if let Some(m) = matcher.score(&it.rel_path, q) {
                scored.push((m.score, it, m.positions));
            }
        }
        scored.sort_unstable_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.rel_path.len().cmp(&b.1.rel_path.len()))
                .then_with(|| a.1.rel_path.cmp(&b.1.rel_path))
        });

        Ok(scored
            .into_iter()
            .take(cap)
            .map(|(score, it, positions)| FuzzyHit {
                name: it.name.clone(),
                path: it.full_path.clone(),
                is_dir: it.is_dir,
                score,
                positions,
                parent: it.parent.clone(),
            })
            .collect())
    }

    fn cached_walk(&self, root: &Path) -> Result<Vec<WalkItem>, NeutronError> {
        {
            let cache = self.walk_cache.lock();
            if let Some((at, items)) = cache.get(root) {
                if at.elapsed() < WALK_CACHE_TTL {
                    return Ok(items.clone());
                }
            }
        }

        let mut out = Vec::new();
        let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
        let mut idx = 0;

        while idx < queue.len() && out.len() < MAX_WALK_ENTRIES {
            let (dir, depth) = queue[idx].clone();
            idx += 1;
            let Ok(rd) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in rd.flatten() {
                if out.len() >= MAX_WALK_ENTRIES {
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | ".Trash") {
                    continue;
                }
                let p = entry.path();
                let Ok(meta) = fs::symlink_metadata(&p) else {
                    continue;
                };
                let is_dir = meta.is_dir();
                let rel = p
                    .strip_prefix(root)
                    .map(|r| r.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| name.clone());
                let parent = p
                    .parent()
                    .map(|pp| pp.to_string_lossy().into_owned())
                    .unwrap_or_default();

                out.push(WalkItem {
                    rel_path: rel,
                    full_path: p.to_string_lossy().into_owned(),
                    name,
                    parent,
                    is_dir,
                });

                if is_dir && depth + 1 < MAX_WALK_DEPTH {
                    queue.push((p, depth + 1));
                }
            }
        }

        self.walk_cache
            .lock()
            .insert(root.to_path_buf(), (Instant::now(), out.clone()));
        Ok(out)
    }

    pub fn preview(&self, location: &str) -> Result<PreviewData, NeutronError> {
        let path = match parse_location(location)? {
            ParsedLocation::Local(p) => p,
            ParsedLocation::Remote { .. } | ParsedLocation::Archive { .. } => {
                return Ok(PreviewData {
                    kind: "binary".into(),
                    text: None,
                    data_url: None,
                    mime: None,
                    size: 0,
                    modified_ms: 0,
                    created_ms: 0,
                    readonly: true,
                    tags: Vec::new(),
                    child_count: None,
                    truncated: false,
                });
            }
        };

        let meta = fs::symlink_metadata(&path)?;
        let modified_ms = to_millis(meta.modified());
        let created_ms = to_millis(meta.created());
        let readonly = meta.permissions().readonly();
        let tags = read_tags(&path).into_iter().map(|t| t.name).collect();

        if meta.is_dir() {
            let count = fs::read_dir(&path)
                .map(|rd| rd.take(5000).count())
                .unwrap_or(0);
            return Ok(PreviewData {
                kind: "dir".into(),
                text: None,
                data_url: None,
                mime: None,
                size: 0,
                modified_ms,
                created_ms,
                readonly,
                tags,
                child_count: Some(count),
                truncated: false,
            });
        }

        let size = meta.len();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();

        if ext == "pdf" {
            return Ok(PreviewData {
                kind: "pdf".into(),
                text: None,
                data_url: None,
                mime: Some("application/pdf".into()),
                size,
                modified_ms,
                created_ms,
                readonly,
                tags,
                child_count: None,
                truncated: false,
            });
        }

        if let Some(mime) = image_mime(&ext) {
            if size <= PREVIEW_IMAGE_LIMIT {
                let bytes = fs::read(&path)?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                return Ok(PreviewData {
                    kind: "image".into(),
                    text: None,
                    data_url: Some(format!("data:{mime};base64,{b64}")),
                    mime: Some(mime.to_string()),
                    size,
                    modified_ms,
                    created_ms,
                    readonly,
                    tags,
                    child_count: None,
                    truncated: false,
                });
            }
            return Ok(PreviewData {
                kind: "too_large".into(),
                text: None,
                data_url: None,
                mime: Some(mime.to_string()),
                size,
                modified_ms,
                created_ms,
                readonly,
                tags,
                child_count: None,
                truncated: false,
            });
        }

        let mut f = File::open(&path)?;
        let cap = (size as usize).min(PREVIEW_TEXT_LIMIT);
        let mut buf = vec![0u8; cap];
        let n = f.read(&mut buf)?;
        buf.truncate(n);

        let scan_len = n.min(8192);
        if buf[..scan_len].contains(&0) {
            return Ok(PreviewData {
                kind: "binary".into(),
                text: None,
                data_url: None,
                mime: None,
                size,
                modified_ms,
                created_ms,
                readonly,
                tags,
                child_count: None,
                truncated: false,
            });
        }

        match String::from_utf8(buf) {
            Ok(text) => Ok(PreviewData {
                kind: "text".into(),
                text: Some(text),
                data_url: None,
                mime: Some("text/plain".into()),
                size,
                modified_ms,
                created_ms,
                readonly,
                tags,
                child_count: None,
                truncated: size as usize > PREVIEW_TEXT_LIMIT,
            }),
            Err(_) => Ok(PreviewData {
                kind: "binary".into(),
                text: None,
                data_url: None,
                mime: None,
                size,
                modified_ms,
                created_ms,
                readonly,
                tags,
                child_count: None,
                truncated: false,
            }),
        }
    }

    pub fn mkdir(&self, parent: &str, name: &str) -> Result<String, NeutronError> {
        validate_leaf_name(name)?;
        match parse_location(parent)? {
            ParsedLocation::Local(dir) => {
                let target = dir.join(name);
                fs::create_dir(&target)?;
                self.walk_cache.lock().clear();
                Ok(target.to_string_lossy().into_owned())
            }
            ParsedLocation::Remote { site, path } => {
                let target = remote_join(&path, name)?;
                self.with_remote(&site, |tr| tr.create_dir(&target))?;
                Ok(format!("remote://{site}{target}"))
            }
            ParsedLocation::Archive { .. } => {
                Err(NeutronError::Invalid("archives are read-only".into()))
            }
        }
    }

    pub fn create_file(&self, parent: &str, name: &str) -> Result<String, NeutronError> {
        validate_leaf_name(name)?;
        match parse_location(parent)? {
            ParsedLocation::Local(dir) => {
                let target = dir.join(name);
                OpenOptions::new().write(true).create_new(true).open(&target)?;
                self.walk_cache.lock().clear();
                Ok(target.to_string_lossy().into_owned())
            }
            _ => Err(NeutronError::Invalid(
                "creating empty files is only supported on local folders".into(),
            )),
        }
    }

    pub fn rename(&self, location: &str, new_name: &str) -> Result<String, NeutronError> {
        validate_leaf_name(new_name)?;
        match parse_location(location)? {
            ParsedLocation::Local(from) => {
                let parent = from
                    .parent()
                    .ok_or_else(|| NeutronError::Invalid("cannot rename filesystem root".into()))?;
                let to = parent.join(new_name);
                if to.exists() {
                    return Err(NeutronError::Invalid(format!(
                        "`{}` already exists",
                        to.display()
                    )));
                }
                if fs::rename(&from, &to).is_err() {
                    shell_rename(&from, new_name, 0).map_err(NeutronError::Shell)?;
                }
                self.push_undo(UndoAction::Rename {
                    from: from.clone(),
                    to: to.clone(),
                });
                self.walk_cache.lock().clear();
                Ok(to.to_string_lossy().into_owned())
            }
            ParsedLocation::Remote { site, path } => {
                let parent = remote_parent(&path).unwrap_or_else(|| "/".to_string());
                let to = remote_join(&parent, new_name)?;
                self.with_remote(&site, |tr| tr.rename(&path, &to))?;
                Ok(format!("remote://{site}{to}"))
            }
            ParsedLocation::Archive { .. } => {
                Err(NeutronError::Invalid("archives are read-only".into()))
            }
        }
    }

    pub fn batch_rename(&self, pairs: &[BatchRenamePair]) -> BatchRenameResult {
        let mut renamed = 0usize;
        let mut errors = Vec::new();
        for pair in pairs {
            let new_name = Path::new(&pair.to)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&pair.to);
            match self.rename(&pair.from, new_name) {
                Ok(_) => renamed += 1,
                Err(e) => errors.push(format!("{}: {e}", pair.from)),
            }
        }
        BatchRenameResult { renamed, errors }
    }

    pub fn copy_items(&self, paths: &[String], dest: &str) -> Result<(), NeutronError> {
        let ParsedLocation::Local(dest_dir) = parse_location(dest)? else {
            return Err(NeutronError::Invalid("destination must be a local folder".into()));
        };
        let srcs: Vec<PathBuf> = paths.iter().map(|s| expand_local(s)).collect();
        transfer(&srcs, &dest_dir, Transfer::Copy, 0).map_err(NeutronError::Shell)?;
        self.walk_cache.lock().clear();
        Ok(())
    }

    pub fn move_items(&self, paths: &[String], dest: &str) -> Result<(), NeutronError> {
        let ParsedLocation::Local(dest_dir) = parse_location(dest)? else {
            return Err(NeutronError::Invalid("destination must be a local folder".into()));
        };
        let srcs: Vec<PathBuf> = paths.iter().map(|s| expand_local(s)).collect();
        transfer(&srcs, &dest_dir, Transfer::Move, 0).map_err(NeutronError::Shell)?;
        self.walk_cache.lock().clear();
        Ok(())
    }

    pub fn trash_items(&self, paths: &[String]) -> Result<(), NeutronError> {
        let local_paths: Vec<PathBuf> = paths.iter().map(|s| expand_local(s)).collect();
        let trashed = trash(&local_paths).map_err(NeutronError::Shell)?;
        let pairs: Vec<(PathBuf, PathBuf)> = local_paths
            .into_iter()
            .zip(trashed)
            .filter_map(|(orig, dst)| dst.map(|d| (orig, d)))
            .collect();
        if !pairs.is_empty() {
            self.push_undo(UndoAction::Trashed(pairs));
        }
        self.walk_cache.lock().clear();
        Ok(())
    }

    pub fn delete_permanent(&self, paths: &[String]) -> Result<(), NeutronError> {
        let mut local = Vec::new();
        for p in paths {
            match parse_location(p)? {
                ParsedLocation::Local(pb) => local.push(pb),
                ParsedLocation::Remote { site, path } => {
                    self.with_remote(&site, |tr| {
                        tr.remove_file(&path).or_else(|_| tr.remove_dir(&path))
                    })?;
                }
                ParsedLocation::Archive { .. } => {
                    return Err(NeutronError::Invalid("archives are read-only".into()));
                }
            }
        }
        if !local.is_empty() {
            delete(&local, Disposal::Permanent, 0).map_err(NeutronError::Shell)?;
            self.walk_cache.lock().clear();
        }
        Ok(())
    }

    pub fn undo(&self) -> Result<Option<String>, NeutronError> {
        let action = self.undo_stack.lock().pop();
        let Some(action) = action else {
            return Ok(None);
        };
        let summary = match action {
            UndoAction::Rename { from, to } => {
                if !to.exists() || from.exists() {
                    return Err(NeutronError::Invalid("cannot undo rename safely".into()));
                }
                fs::rename(&to, &from)?;
                format!("Restored `{}`", from.display())
            }
            UndoAction::Trashed(pairs) => {
                let mut count = 0usize;
                for (orig, in_trash) in pairs {
                    if in_trash.exists() && !orig.exists() {
                        fs::rename(&in_trash, &orig)?;
                        count += 1;
                    }
                }
                format!("Restored {count} item(s) from Trash")
            }
        };
        self.walk_cache.lock().clear();
        Ok(Some(summary))
    }

    pub fn open(&self, path: &str) -> Result<(), NeutronError> {
        let pb = expand_local(path);
        shell_execute(&pb, Verb::Open, 0).map_err(NeutronError::Shell)?;
        if pb.is_file() {
            self.record_recent(&pb);
        }
        Ok(())
    }

    pub fn reveal(&self, paths: &[String]) -> Result<(), NeutronError> {
        let pbs: Vec<PathBuf> = paths.iter().map(|s| expand_local(s)).collect();
        shell_reveal(&pbs).map_err(NeutronError::Shell)
    }

    pub fn tag_toggle(&self, paths: &[String], color: u8, on: bool) -> Result<(), NeutronError> {
        let pbs: Vec<PathBuf> = paths.iter().map(|s| expand_local(s)).collect();
        toggle_tag_color(&pbs, color, on).map_err(NeutronError::Shell)
    }

    pub fn archive_extract(
        &self,
        archive_path: &str,
        dest_dir: Option<&str>,
    ) -> Result<ArchiveSummaryDto, NeutronError> {
        let archive = expand_local(archive_path);
        let fmt = format_of(&archive)
            .ok_or(NeutronError::Archive(neutron_archive::ArchiveError::UnknownFormat))?;
        let destination = match dest_dir.map(str::trim).filter(|s| !s.is_empty()) {
            Some(d) => expand_local(d),
            None => destination_for(&archive, |p| p.exists())
                .ok_or_else(|| NeutronError::Invalid("could not determine extract folder".into()))?,
        };
        let summary = archive_extract_all(&archive, &destination, fmt, |_| ArchiveContinue::Yes)?;
        self.walk_cache.lock().clear();
        Ok(ArchiveSummaryDto {
            destination: destination.to_string_lossy().into_owned(),
            files: summary.files,
            bytes: summary.bytes,
            refused: summary.refused,
        })
    }

    pub fn archive_create(
        &self,
        sources: &[String],
        dest_zip: Option<&str>,
    ) -> Result<ArchiveSummaryDto, NeutronError> {
        if sources.is_empty() {
            return Err(NeutronError::Invalid("no sources selected to compress".into()));
        }
        let src_paths: Vec<PathBuf> = sources.iter().map(|s| expand_local(s)).collect();
        let base = src_paths[0]
            .parent()
            .ok_or_else(|| NeutronError::Invalid("source has no parent directory".into()))?
            .to_path_buf();

        let output = match dest_zip.map(str::trim).filter(|s| !s.is_empty()) {
            Some(d) => expand_local(d),
            None => {
                let suggested = neutron_archive::create::suggested_name(&src_paths, &base);
                let mut candidate = base.join(suggested);
                let stem = candidate
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Archive")
                    .to_string();
                let mut idx = 2usize;
                while candidate.exists() {
                    candidate = base.join(format!("{stem} ({idx}).zip"));
                    idx += 1;
                }
                candidate
            }
        };

        let summary = archive_zip(&src_paths, &base, &output, |_| ArchiveContinue::Yes)?;
        self.walk_cache.lock().clear();
        Ok(ArchiveSummaryDto {
            destination: output.to_string_lossy().into_owned(),
            files: summary.files,
            bytes: summary.bytes,
            refused: summary.refused,
        })
    }

    pub fn watch<F>(&self, dir: &str, on_change: F) -> Result<u64, NeutronError>
    where
        F: Fn() + Send + 'static,
    {
        let ParsedLocation::Local(pb) = parse_location(dir)? else {
            return Err(NeutronError::Invalid("only local directories can be watched".into()));
        };
        let watcher = fs_watch(&pb, on_change)
            .ok_or_else(|| NeutronError::Shell(format!("cannot watch `{}`", pb.display())))?;
        let id = self.next_watch_id.fetch_add(1, Ordering::Relaxed);
        let mut map = self.watchers.lock();
        // Replace any existing watcher on the same directory and cap total
        // active watchers so rapid navigation cannot exhaust macOS kqueue FDs.
        let stale: Vec<u64> = map
            .iter()
            .filter_map(|(&wid, (p, _))| if p == &pb { Some(wid) } else { None })
            .collect();
        for wid in stale {
            map.remove(&wid);
        }
        while map.len() >= MAX_WATCHERS {
            let Some(&oldest) = map.keys().min() else {
                break;
            };
            map.remove(&oldest);
        }
        map.insert(id, (pb, watcher));
        Ok(id)
    }

    pub fn unwatch(&self, watch_id: u64) {
        self.watchers.lock().remove(&watch_id);
    }

    fn push_undo(&self, act: UndoAction) {
        let mut stack = self.undo_stack.lock();
        stack.push(act);
        if stack.len() > MAX_UNDO {
            let drain = stack.len() - MAX_UNDO;
            stack.drain(0..drain);
        }
    }
}

fn validate_leaf_name(name: &str) -> Result<(), NeutronError> {
    if let Some(reason) = neutron_core::naming::rejection(name) {
        return Err(NeutronError::Invalid(reason.to_string()));
    }
    Ok(())
}

fn to_millis(res: std::io::Result<std::time::SystemTime>) -> i64 {
    res.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}
