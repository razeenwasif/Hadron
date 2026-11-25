//! Multi-host `MuxClient` connection pool and safe local daemon startup.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tachyon::mux::client::MuxClient;
use tachyon::mux::{default_local_uri, default_socket_path, load_hosts, resolve_target, Target};

use crate::TachyonError;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostSummary {
    pub alias: String,
    pub uri: String,
    pub color: Option<String>,
    pub is_local: bool,
}

#[derive(Default)]
pub struct TachyonPool {
    clients: Mutex<HashMap<String, Arc<MuxClient>>>,
    subscribed: Mutex<HashSet<String>>,
}

static EMBEDDED_SERVER_STARTED: OnceLock<Mutex<bool>> = OnceLock::new();

impl TachyonPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// List configured Tachyon hosts, always including `"local"` first.
    pub fn hosts(&self) -> Vec<HostSummary> {
        let mut out = vec![HostSummary {
            alias: "local".into(),
            uri: default_local_uri(),
            color: None,
            is_local: true,
        }];
        for h in load_hosts() {
            if h.alias.eq_ignore_ascii_case("local") {
                continue;
            }
            out.push(HostSummary {
                alias: h.alias,
                uri: h.uri,
                color: h.color,
                is_local: false,
            });
        }
        out
    }

    /// Return a live `MuxClient` for `host` (defaulting to `"local"`).
    pub fn client(&self, host: Option<&str>) -> Result<Arc<MuxClient>, TachyonError> {
        let alias = normalize_host(host);
        {
            let guard = self.clients.lock();
            if let Some(c) = guard.get(&alias) {
                if !c.is_closed() {
                    return Ok(Arc::clone(c));
                }
            }
        }

        let client = if alias == "local" {
            connect_local_safe()?
        } else {
            let hosts = load_hosts();
            let target = resolve_target(Some(&alias), &hosts)
                .map_err(|e| TachyonError::Connect(e.to_string()))?;
            MuxClient::connect(&target, false, "flux", "Flux")
                .map_err(|e| TachyonError::Connect(format!("{alias}: {e}")))?
        };

        self.clients.lock().insert(alias, Arc::clone(&client));
        Ok(client)
    }

    /// Subscribe to live server events on `host` once per active connection;
    /// cleans up the subscription slot if the stream disconnects.
    pub fn subscribe<F>(self: &Arc<Self>, host: Option<&str>, on_event: F) -> Result<(), TachyonError>
    where
        F: Fn(String, Value) + Send + Sync + 'static,
    {
        let alias = normalize_host(host);
        let client = self.client(Some(&alias))?;
        {
            let mut subs = self.subscribed.lock();
            if subs.contains(&alias) {
                return Ok(());
            }
            subs.insert(alias.clone());
        }

        let rx = match client.subscribe_events() {
            Ok(rx) => rx,
            Err(e) => {
                self.subscribed.lock().remove(&alias);
                return Err(TachyonError::Rpc(e.to_string()));
            }
        };

        let pool = Arc::clone(self);
        std::thread::Builder::new()
            .name(format!("tachyon-events-{alias}"))
            .spawn(move || {
                while let Ok(ev) = rx.recv() {
                    on_event(alias.clone(), ev);
                }
                pool.subscribed.lock().remove(&alias);
            })
            .map_err(TachyonError::Io)?;
        Ok(())
    }

    pub fn invalidate(&self, host: Option<&str>) {
        let alias = normalize_host(host);
        self.clients.lock().remove(&alias);
        self.subscribed.lock().remove(&alias);
    }
}

pub fn normalize_host(host: Option<&str>) -> String {
    match host.map(str::trim).filter(|s| !s.is_empty()) {
        None => "local".into(),
        Some(h) if h.eq_ignore_ascii_case("local") => "local".into(),
        Some(h) => h.to_string(),
    }
}

/// Never pass `auto_start = true` for `local` when running inside Flux:
/// Tachyon's built-in `spawn_local_daemon` re-execs `current_exe()`, which
/// would launch a second Flux GUI instead of `tachyon server`.
fn connect_local_safe() -> Result<Arc<MuxClient>, TachyonError> {
    let socket = default_socket_path();
    let target = Target::Local { socket: socket.clone() };
    match MuxClient::connect(&target, false, "flux", "Flux") {
        Ok(c) => return Ok(c),
        Err(e) if !should_autostart(&e) => {
            return Err(TachyonError::Connect(e.to_string()));
        }
        Err(_) => {}
    }

    if let Some(bin) = find_tachyon_bin() {
        spawn_tachyon_daemon(&bin, &socket)?;
    } else {
        ensure_embedded_daemon(&socket)?;
    }

    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match MuxClient::connect(&target, false, "flux", "Flux") {
            Ok(c) => return Ok(c),
            Err(e) if Instant::now() >= deadline => {
                return Err(TachyonError::Connect(format!(
                    "timed out waiting for local tachyon server at {}: {e}",
                    socket.display()
                )));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn should_autostart(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::NotFound
            | io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::BrokenPipe
    )
}

fn find_tachyon_bin() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from("/Applications/Tachyon.app/Contents/MacOS/tachyon"));
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        let h = PathBuf::from(home);
        candidates.push(h.join(".local/bin/tachyon"));
        #[cfg(windows)]
        candidates.push(h.join(".local/bin/tachyon.exe"));
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        let name = if cfg!(windows) { "tachyon.exe" } else { "tachyon" };
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join(name));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn spawn_tachyon_daemon(bin: &Path, socket: &Path) -> Result<(), TachyonError> {
    if let Some(parent) = socket.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut cmd = Command::new(bin);
    cmd.args(["server", "run", "--socket"])
        .arg(socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map_err(TachyonError::Io)?;
    Ok(())
}

fn ensure_embedded_daemon(socket: &Path) -> Result<(), TachyonError> {
    let lock = EMBEDDED_SERVER_STARTED.get_or_init(|| Mutex::new(false));
    let mut started = lock.lock();
    if *started {
        return Ok(());
    }
    if let Some(parent) = socket.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let sock = socket.to_path_buf();
    std::thread::Builder::new()
        .name("tachyon-embedded-server".into())
        .spawn(move || {
            if let Err(e) = tachyon::server::run(&sock) {
                tracing::warn!(error = %e, "embedded tachyon server exited");
            }
        })
        .map_err(TachyonError::Io)?;
    *started = true;
    Ok(())
}
