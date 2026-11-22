/**
 * The cited-answer, callout, and restyle cards' calls (cite.rs, boosts.rs),
 * loaded with the cards and Fairy's tools (CitedAnswer.tsx, RestyleCard.tsx,
 * fairyTools.ts). Kept separate from ipc.ts to stay off the eager bundle.
 */
import { invoke } from "@tauri-apps/api/core";
import type { BoostDraft, CiteCallout } from "./bindings.gen";

/** Scroll `tab` to a cited passage and highlight it: "shown", "not_found",
 *  "moved" (the tab left `url`) or "unavailable". */
export const agentCiteShow = (tab: number, url: string, text: string, n: number) =>
  invoke<string>("agent_cite_show", { tab, url, text, n });

/** Highlight and badge multiple items/passages on `tab`; returns matched `n` values. */
export const agentCiteShowMany = (tab: number, items: CiteCallout[], url?: string, scroll = true) =>
  invoke<number[]>("agent_cite_show_many", { tab, url: url ?? null, items, scroll });

export const agentCiteClear = (tab: number) => invoke<void>("agent_cite_clear", { tab });

/** An answer as up to six to-do lines (none when there's nothing to do). */
export const agentTasksFrom = (text: string) => invoke<string[]>("agent_tasks_from", { text });

/** Validate inert CSS against `tab` and preview it live without saving yet. */
export const boostPreviewCss = (tab: number, name: string, css: string) =>
  invoke<BoostDraft>("boost_preview_css", { tab, name, css });

export const boostPreviewClear = (tab: number) => invoke<void>("boost_preview_clear", { tab });
