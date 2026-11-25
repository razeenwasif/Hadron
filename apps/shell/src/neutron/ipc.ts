import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SortBy = "name" | "size" | "modified" | "created" | "kind" | "added";
export type SortDir = "asc" | "desc";

export interface NeutronEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "archive" | "other";
  size: number;
  modified_ms: number;
  created_ms: number;
  hidden: boolean;
  readonly: boolean;
  is_alias: boolean;
  sync: "none" | "cloud_only" | "local" | "pinned" | "syncing";
  tag_mask: number;
  ext: string;
  kind_label: string;
}

export interface NeutronListing {
  location: string;
  display_path: string;
  parent: string | null;
  scheme: "local" | "remote" | "archive";
  site: string | null;
  total_count: number;
  hidden_count: number;
  entries: NeutronEntry[];
}

export interface NeutronPlace {
  name: string;
  path: string;
  kind: "known" | "pin" | "remote_pin" | "drive" | "cloud" | "server";
  site: string | null;
  capacity_total: number | null;
  capacity_free: number | null;
  ejectable: boolean;
}

export interface NeutronPlaces {
  known: NeutronPlace[];
  pins: NeutronPlace[];
  drives: NeutronPlace[];
  cloud: NeutronPlace[];
  servers: NeutronPlace[];
}

export interface FuzzyHit {
  name: string;
  path: string;
  is_dir: boolean;
  score: number;
  positions: number[];
  parent: string;
}

export interface PreviewData {
  kind: "text" | "image" | "pdf" | "dir" | "binary" | "too_large";
  text: string | null;
  data_url: string | null;
  mime: string | null;
  size: number;
  modified_ms: number;
  created_ms: number;
  readonly: boolean;
  tags: string[];
  child_count: number | null;
  truncated: boolean;
}

export interface BatchRenamePair {
  from: string;
  to: string;
}

export interface BatchRenameResult {
  renamed: number;
  errors: string[];
}

export interface ArchiveSummaryDto {
  destination: string;
  files: number;
  bytes: number;
  refused: string[];
}

export interface RecentFile {
  name: string;
  path: string;
  parent: string;
  at_ms: number;
  exists: boolean;
  ext: string;
}

export const neutronPlaces = () => invoke<NeutronPlaces>("neutron_places");

export const neutronRecent = () => invoke<RecentFile[]>("neutron_recent");

export const neutronPinToggle = (path: string, site?: string | null) =>
  invoke<boolean>("neutron_pin_toggle", { path, site: site ?? null });

export const neutronList = (opts: {
  location: string;
  sortBy?: SortBy;
  sortDir?: SortDir;
  dirsFirst?: boolean;
  showHidden?: boolean;
  filter?: string;
}) =>
  invoke<NeutronListing>("neutron_list", {
    location: opts.location,
    sortBy: opts.sortBy ?? "name",
    sortDir: opts.sortDir ?? "asc",
    dirsFirst: opts.dirsFirst ?? true,
    showHidden: opts.showHidden ?? false,
    filter: opts.filter ?? "",
  });

export const neutronFuzzy = (root: string, query: string, limit = 60) =>
  invoke<FuzzyHit[]>("neutron_fuzzy", { root, query, limit });

export const neutronPreview = (location: string) =>
  invoke<PreviewData>("neutron_preview", { location });

export const neutronWatch = (path: string) => invoke<number>("neutron_watch", { path });

export const neutronUnwatch = (id: number) => invoke<void>("neutron_unwatch", { id });

export const neutronMkdir = (parent: string, name: string) =>
  invoke<string>("neutron_mkdir", { parent, name });

export const neutronCreateFile = (parent: string, name: string) =>
  invoke<string>("neutron_create_file", { parent, name });

export const neutronRename = (path: string, newName: string) =>
  invoke<string>("neutron_rename", { path, newName });

export const neutronBatchRename = (pairs: BatchRenamePair[]) =>
  invoke<BatchRenameResult>("neutron_batch_rename", { pairs });

export const neutronCopy = (paths: string[], dest: string) =>
  invoke<void>("neutron_copy", { paths, dest });

export const neutronMove = (paths: string[], dest: string) =>
  invoke<void>("neutron_move", { paths, dest });

export const neutronTrash = (paths: string[]) => invoke<void>("neutron_trash", { paths });

export const neutronDelete = (paths: string[]) => invoke<void>("neutron_delete", { paths });

export const neutronUndo = () => invoke<string | null>("neutron_undo");

export const neutronOpen = (path: string) => invoke<void>("neutron_open", { path });

export const neutronReveal = (paths: string[]) => invoke<void>("neutron_reveal", { paths });

export const neutronTagToggle = (paths: string[], color: number, on: boolean) =>
  invoke<void>("neutron_tag_toggle", { paths, color, on });

export const neutronArchiveExtract = (archive: string, dest?: string | null) =>
  invoke<ArchiveSummaryDto>("neutron_archive_extract", {
    archive,
    dest: dest ?? null,
  });

export const neutronArchiveCreate = (sources: string[], dest?: string | null) =>
  invoke<ArchiveSummaryDto>("neutron_archive_create", {
    sources,
    dest: dest ?? null,
  });

export const onNeutronWatch = (
  cb: (payload: { path: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ path: string }>("flux://neutron-watch", (e) => cb(e.payload));
