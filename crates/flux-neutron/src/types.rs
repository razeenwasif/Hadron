use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NeutronError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("namespace error: {0}")]
    Namespace(#[from] neutron_core::NamespaceError),
    #[error("remote error: {0}")]
    Remote(#[from] neutron_remote::RemoteError),
    #[error("invalid remote path: {0}")]
    Refusal(#[from] neutron_remote::path::Refusal),
    #[error("archive error: {0}")]
    Archive(#[from] neutron_archive::ArchiveError),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("shell error: {0}")]
    Shell(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortBy {
    #[default]
    Name,
    Size,
    Modified,
    Created,
    Kind,
    Added,
}

impl From<SortBy> for neutron_core::SortColumn {
    fn from(v: SortBy) -> Self {
        match v {
            SortBy::Name => Self::Name,
            SortBy::Size => Self::Size,
            SortBy::Modified => Self::Modified,
            SortBy::Created => Self::Created,
            SortBy::Kind => Self::Kind,
            SortBy::Added => Self::Added,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    #[default]
    Asc,
    Desc,
}

impl From<SortDir> for neutron_core::SortOrder {
    fn from(v: SortDir) -> Self {
        match v {
            SortDir::Asc => Self::Ascending,
            SortDir::Desc => Self::Descending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListOptions {
    #[serde(default)]
    pub sort_by: SortBy,
    #[serde(default)]
    pub sort_dir: SortDir,
    #[serde(default = "default_true")]
    pub dirs_first: bool,
    #[serde(default)]
    pub show_hidden: bool,
    #[serde(default)]
    pub filter: String,
}

const fn default_true() -> bool {
    true
}

impl Default for ListOptions {
    fn default() -> Self {
        Self {
            sort_by: SortBy::Name,
            sort_dir: SortDir::Asc,
            dirs_first: true,
            show_hidden: false,
            filter: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeutronEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_ms: i64,
    pub created_ms: i64,
    pub hidden: bool,
    pub readonly: bool,
    pub is_alias: bool,
    pub sync: String,
    pub tag_mask: u8,
    pub ext: String,
    pub kind_label: String,
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
    pub entries: Vec<NeutronEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeutronPlace {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub site: Option<String>,
    pub capacity_total: Option<u64>,
    pub capacity_free: Option<u64>,
    pub ejectable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NeutronPlaces {
    pub known: Vec<NeutronPlace>,
    pub pins: Vec<NeutronPlace>,
    pub drives: Vec<NeutronPlace>,
    pub cloud: Vec<NeutronPlace>,
    pub servers: Vec<NeutronPlace>,
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
