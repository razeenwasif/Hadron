/**
 * Zoxide-style frecency URL jump IPC (jump.rs) — lazy-loaded on first omnibox
 * input so it adds nothing to the eager chrome entry or desktop-preloads budget.
 */
import { invoke } from "@tauri-apps/api/core";

import type { JumpMatch } from "./bindings.gen";

export type { JumpMatch };

export const isJumpToken = (q: string): boolean =>
  q.length >= 2 && !/\s|[./:?#]|^[!@>]/.test(q);

export const jumpMatch = (query: string) =>
  isJumpToken(query) ? invoke<JumpMatch | null>("jump_match", { query }).catch(() => null) : Promise.resolve(null);

export const jumpRecord = (query: string, url: string) => {
  if (isJumpToken(query)) void invoke<void>("jump_record", { query, url }).catch(() => {});
};

export const jumpDemote = (query: string, url: string) => {
  if (isJumpToken(query)) void invoke<void>("jump_demote", { query, url }).catch(() => {});
};
