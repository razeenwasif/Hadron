//! Axion Vault companion integration — hardened, low-latency bidirectional bridge
//! between Flux's password manager/autofill and Axion (`~/.axion/axiond.sock`).
//!
//! Security & performance properties:
//! - Verifies `~/.axion/axiond.sock` is a non-symlink Unix socket owned by current
//!   UID with `0600` permissions before connecting.
//! - Uses bounded frame reading (4 MiB max) and tight timeouts (350 ms) so Flux
//!   never stalls if `axiond` is stopped.
//! - Caches read-only metadata (`status`, `list_logins`, `match_host`) for 2s to
//!   eliminate socket overhead on rapid tab navigations; invalidated on any write.
//! - Passwords from `reveal` are NEVER cached and are wrapped in `Zeroizing`.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::vault::{CredentialMeta, VaultState};

const CACHE_TTL: Duration = Duration::from_secs(2);

/// Live status of the Axion sensitive-info vault companion.
#[derive(Serialize, Deserialize, Clone, Debug, Default, specta::Type)]
pub struct AxionStatus {
    /// `Axion.app` is installed in `/Applications` or `~/Applications`.
    pub installed: bool,
    /// `axiond` answered `hello` on `~/.axion/axiond.sock`.
    pub running: bool,
    pub locked: bool,
    pub login_count: u32,
    pub total_count: u32,
    pub device_name: Option<String>,
}

/// Live TOTP 2FA code computed by Axion for a login credential.
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type)]
pub struct AxionTotp {
    pub code: String,
    pub period: u32,
    pub remaining: u32,
}

/// Result of a two-way sync between Flux's local vault and Axion.
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type)]
pub struct AxionSyncReport {
    pub imported_into_flux: u32,
    pub pushed_to_axion: u32,
    pub total_flux_logins: u32,
}

#[derive(Deserialize)]
struct FluxLoginWire {
    id: String,
    #[allow(dead_code)]
    axion_id: String,
    name: String,
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default)]
    username: String,
    #[serde(default)]
    has_totp: bool,
    #[serde(default)]
    saved_host: Option<String>,
    #[serde(default)]
    exact: Option<bool>,
}

impl From<FluxLoginWire> for CredentialMeta {
    fn from(w: FluxLoginWire) -> Self {
        Self {
            id: w.id,
            name: w.name,
            urls: w.urls,
            username: w.username,
            has_totp: w.has_totp,
            saved_host: w.saved_host,
            exact: w.exact,
        }
    }
}

#[derive(Deserialize)]
struct AxionRevealWire {
    username: String,
    password: String,
    #[serde(default)]
    totp_code: Option<TotpWire>,
}

pub(crate) struct AxionRevealData {
    pub username: String,
    pub password: Zeroizing<String>,
    pub totp_code: Option<TotpWire>,
}

#[derive(Deserialize)]
pub(crate) struct TotpWire {
    pub code: String,
    pub period: u64,
    pub remaining: u64,
}

// ─── Short-TTL metadata cache (never caches passwords or TOTP) ───────────────

#[derive(Default)]
struct MetaCache {
    status: Option<(Instant, AxionStatus)>,
    list: Option<(Instant, Option<Vec<CredentialMeta>>)>,
    hosts: HashMap<(String, Option<u16>), (Instant, Option<Vec<CredentialMeta>>)>,
}

static CACHE: LazyLock<Mutex<MetaCache>> = LazyLock::new(|| Mutex::new(MetaCache::default()));

fn invalidate_cache() {
    let mut c = CACHE.lock();
    c.status = None;
    c.list = None;
    c.hosts.clear();
}

#[cfg(unix)]
mod link {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use serde::Deserialize;

    const MAX_REPLY_BYTES: u64 = 4 * 1024 * 1024;

    pub fn socket_path() -> PathBuf {
        if let Some(p) = std::env::var_os("AXION_SOCKET") {
            return PathBuf::from(p);
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        home.join(".axion/axiond.sock")
    }

    pub fn installed() -> bool {
        if Path::new("/Applications/Axion.app").exists() {
            return true;
        }
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .is_some_and(|h| h.join("Applications/Axion.app").exists())
    }

    fn verify_socket_safety(sock: &Path) -> Result<(), String> {
        let meta = std::fs::symlink_metadata(sock).map_err(|e| e.to_string())?;
        if !meta.file_type().is_socket() {
            return Err("axiond.sock is not a Unix domain socket".into());
        }
        // Only accept sockets with strict owner-only permissions (no group/other access).
        if (meta.permissions().mode() & 0o077) != 0 {
            return Err("refusing axiond.sock with overly broad permissions".into());
        }
        // Ensure socket owner matches the owner of $HOME (same local user).
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            if let Ok(home_meta) = std::fs::metadata(&home) {
                if meta.uid() != home_meta.uid() {
                    return Err("axiond.sock owner does not match current user".into());
                }
            }
        }
        Ok(())
    }

    #[derive(Deserialize)]
    struct RpcReply {
        ok: bool,
        result: Option<serde_json::Value>,
        error: Option<String>,
    }

    pub fn rpc(method: &str, params: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        let sock = socket_path();
        verify_socket_safety(&sock)?;
        let mut stream = UnixStream::connect(&sock).map_err(|e| e.to_string())?;
        let timeout = Duration::from_millis(350);
        let _ = stream.set_read_timeout(Some(timeout));
        let _ = stream.set_write_timeout(Some(timeout));

        let req = match params {
            Some(p) => serde_json::json!({ "id": 1, "method": method, "params": p }),
            None => serde_json::json!({ "id": 1, "method": method }),
        };
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');
        stream.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        stream.flush().map_err(|e| e.to_string())?;

        let mut reader = BufReader::new(stream);
        let mut buf = Vec::with_capacity(4096);
        let n = (&mut reader)
            .take(MAX_REPLY_BYTES + 1)
            .read_until(b'\n', &mut buf)
            .map_err(|e| e.to_string())?;
        if n == 0 || buf.len() as u64 > MAX_REPLY_BYTES {
            return Err("invalid or oversized axiond reply".into());
        }
        let reply: RpcReply = serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
        if !reply.ok {
            return Err(reply.error.unwrap_or_else(|| "axiond error".into()));
        }
        Ok(reply.result.unwrap_or(serde_json::Value::Null))
    }
}

#[cfg(not(unix))]
mod link {
    pub fn installed() -> bool {
        false
    }
    pub fn rpc(
        _method: &str,
        _params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        Err("Axion bridge is only available on Unix/macOS".into())
    }
}

pub fn query_status() -> AxionStatus {
    let now = Instant::now();
    {
        let c = CACHE.lock();
        if let Some((at, ref st)) = c.status {
            if now.duration_since(at) < CACHE_TTL {
                return st.clone();
            }
        }
    }
    let installed = link::installed();
    let st = match link::rpc("hello", None) {
        Ok(val) => AxionStatus {
            installed,
            running: true,
            locked: val.get("locked").and_then(|v| v.as_bool()).unwrap_or(true),
            login_count: val.get("login_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            total_count: val.get("item_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            device_name: val
                .get("device_name")
                .and_then(|v| v.as_str())
                .map(String::from),
        },
        Err(_) => AxionStatus {
            installed,
            running: false,
            ..Default::default()
        },
    };
    CACHE.lock().status = Some((now, st.clone()));
    st
}

pub(crate) fn list_logins() -> Option<Vec<CredentialMeta>> {
    let now = Instant::now();
    {
        let c = CACHE.lock();
        if let Some((at, ref cached)) = c.list {
            if now.duration_since(at) < CACHE_TTL {
                return cached.clone();
            }
        }
    }
    let fresh = link::rpc("flux_list_logins", None)
        .ok()
        .and_then(|val| serde_json::from_value::<Vec<FluxLoginWire>>(val).ok())
        .map(|list| list.into_iter().map(CredentialMeta::from).collect::<Vec<_>>());
    CACHE.lock().list = Some((now, fresh.clone()));
    fresh
}

pub(crate) fn match_host(host: &str, port: Option<u16>) -> Option<Vec<CredentialMeta>> {
    let key = (host.to_ascii_lowercase(), port);
    let now = Instant::now();
    {
        let c = CACHE.lock();
        if let Some((at, cached)) = c.hosts.get(&key) {
            if now.duration_since(*at) < CACHE_TTL {
                return cached.clone();
            }
        }
    }
    let fresh = link::rpc(
        "flux_match_host",
        Some(serde_json::json!({ "host": host, "port": port })),
    )
    .ok()
    .and_then(|val| serde_json::from_value::<Vec<FluxLoginWire>>(val).ok())
    .map(|list| list.into_iter().map(CredentialMeta::from).collect::<Vec<_>>());

    let mut c = CACHE.lock();
    if c.hosts.len() > 64 {
        c.hosts.retain(|_, (at, _)| now.duration_since(*at) < CACHE_TTL);
    }
    c.hosts.insert(key, (now, fresh.clone()));
    fresh
}

/// Never cached: retrieves secret on demand into a `Zeroizing<String>` buffer.
pub(crate) fn reveal(id: &str) -> Option<AxionRevealData> {
    let val = link::rpc("flux_reveal", Some(serde_json::json!({ "id": id }))).ok()?;
    if val.is_null() {
        return None;
    }
    let wire: AxionRevealWire = serde_json::from_value(val).ok()?;
    Some(AxionRevealData {
        username: wire.username,
        password: Zeroizing::new(wire.password),
        totp_code: wire.totp_code,
    })
}

pub(crate) fn upsert_login(c: &flux_vault::Credential) {
    let _ = link::rpc(
        "flux_upsert_login",
        Some(serde_json::json!({ "credential": c })),
    );
    invalidate_cache();
}

pub(crate) fn remove_login(id: &str) {
    let _ = link::rpc("flux_remove_login", Some(serde_json::json!({ "id": id })));
    invalidate_cache();
}

pub(crate) fn sync_merge_with_axion(
    entries: &[flux_vault::Credential],
) -> Result<(usize, Vec<flux_vault::Credential>), String> {
    let val = link::rpc(
        "flux_sync_merge",
        Some(serde_json::json!({ "entries": entries })),
    )?;
    let imported = val.get("imported").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let out_entries: Vec<flux_vault::Credential> = val
        .get("entries")
        .cloned()
        .ok_or_else(|| "missing entries in Axion sync reply".to_string())
        .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;
    invalidate_cache();
    Ok((imported, out_entries))
}

// ─── Tauri commands exposed to Flux chrome ───────────────────────────────────

#[tauri::command]
pub fn axion_status() -> AxionStatus {
    query_status()
}

#[tauri::command]
pub fn axion_totp(id: String) -> Result<Option<AxionTotp>, String> {
    let Some(data) = reveal(&id) else {
        return Ok(None);
    };
    Ok(data.totp_code.map(|t| AxionTotp {
        code: t.code,
        period: t.period as u32,
        remaining: t.remaining as u32,
    }))
}

#[tauri::command]
pub fn axion_open() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .args(["-a", "Axion"])
            .status()
            .map_err(|e| format!("failed to launch Axion: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("Axion.app could not be opened — is it installed in /Applications?".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Axion.app launch is macOS-only".into())
    }
}

#[tauri::command]
pub fn axion_sync(state: State<'_, VaultState>) -> Result<AxionSyncReport, String> {
    state.sync_with_axion()
}
