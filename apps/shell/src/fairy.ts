/**
 * Fairy, your assistant app (the Lyra repo), in the agent panel (fairy.rs).
 * Loaded when you first ask her something: nothing here is needed to paint.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Setter } from "solid-js";

export type FairyReply = { text: string; with_page: boolean };
export type FairyAskOpts = { model?: string; effort?: string };

/** Ask Fairy `question` about tab `tab`'s page. `onText` gets her reply so far
 *  (each call replaces the last). A private or Tor tab's page isn't sent. */
export function fairyAsk(
  question: string,
  tab: number | null,
  onText: (soFar: string) => void,
  opts?: FairyAskOpts,
): Promise<FairyReply> {
  const ch = new Channel<string>();
  ch.onmessage = onText;
  return invoke<FairyReply>("fairy_ask", {
    question,
    tab,
    model: opts?.model,
    effort: opts?.effort,
    onText: ch,
  });
}
export const fairyStop = () => invoke<void>("fairy_stop");
export const fairyNew = () => invoke<void>("fairy_new");

/** `asking` marks the bubble Fairy is answering in, until she's done: the
 *  steps she takes meanwhile go above it, in the order they happened. */
type Item = { role: string; text: string; from?: string; asking?: boolean };

/** Ask `name` and stream her reply into one new bubble at the end of the
 *  feed, labelled with her name (and that she read the page, when she did).
 *  `live()` turns false when the panel stopped listening (Stop, a new chat). */
export async function askInFeed<T extends Item>(
  q: string,
  name: string,
  tab: number | null,
  setFeed: Setter<T[]>,
  live: () => boolean,
  opts?: FairyAskOpts,
): Promise<string> {
  // Found by identity, not position: step lines are inserted above it.
  const bubble = { role: "assistant", text: "", from: name, asking: true } as T;
  let mine: T = bubble;
  let replyText = "";
  setFeed((f) => [...f, { role: "user", text: q } as T, bubble]);
  const put = (patch: Partial<Item>) =>
    setFeed((f) =>
      f.map((it) => {
        if (it !== mine) return it;
        mine = { ...it, ...patch } as T;
        return mine;
      }),
    );
  try {
    const r = await fairyAsk(
      q,
      tab,
      (soFar) => {
        if (live()) put({ text: soFar });
      },
      opts,
    );
    if (live()) {
      replyText = r.text.trim();
      put({ text: replyText || "(no response)", from: r.with_page ? `${name} · read this page` : name });
    }
  } catch (err) {
    if (live()) put({ role: "error", text: `${name}: ${String(err)}`, from: undefined });
  } finally {
    put({ asking: false });
  }
  return replyText;
}
