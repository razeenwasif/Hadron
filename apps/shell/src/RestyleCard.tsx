/**
 * Interactive agent-feed cards (restyle previews, numbered page callouts, and
 * grouped opened-tab lists). Bundled into the existing lazy RestyleCard chunk
 * so AgentPanel and the boot entry gain zero extra lazy imports.
 */
import { For, Show, createSignal, type Component } from "solid-js";
import "./CitedAnswer.css";
import { boostSave, type BoostDraft } from "./ipc";
import { agentCiteClear, agentCiteShowMany, boostPreviewClear } from "./citeCardIpc";
import { activeId, focusTab, isLoading } from "./store";

export type FeedCallout = {
  n: number;
  text: string;
  title?: string;
  detail?: string;
  url?: string;
  selector?: string;
};

export type FeedCalloutGroup = {
  tab: number;
  url: string;
  items: FeedCallout[];
};

export type FeedOpenedTab = {
  tab: number;
  url: string;
  host: string;
};

const RestyleCard: Component<{
  draft?: BoostDraft;
  summary?: string;
  callouts?: FeedCalloutGroup;
  openedTabs?: FeedOpenedTab[];
}> = (props) => {
  const [state, setState] = createSignal<"open" | "applied" | "discarded">("open");
  const [error, setError] = createSignal("");
  const [marksCleared, setMarksCleared] = createSignal(false);

  const apply = async () => {
    const d = props.draft;
    if (!d) return;
    try {
      await boostSave(null, d.host, d.name, d.css, true);
      setState("applied");
    } catch (e) {
      setError(String(e));
      return;
    }
    void boostPreviewClear(d.tab).catch(() => {});
  };

  const discard = () => {
    const d = props.draft;
    if (!d) return;
    setState("discarded");
    void boostPreviewClear(d.tab).catch(() => {});
  };

  const focusCallout = async (c: FeedCallout) => {
    const group = props.callouts;
    if (!group) return;
    setMarksCleared(false);
    if (activeId() !== group.tab) await focusTab(group.tab).catch(() => {});
    await agentCiteShowMany(
      group.tab,
      [{ n: c.n, text: c.text, selector: c.selector ?? null }],
      group.url || undefined,
      true,
    ).catch(() => {});
  };

  const clearMarks = () => {
    const group = props.callouts;
    if (!group) return;
    setMarksCleared(true);
    void agentCiteClear(group.tab).catch(() => {});
  };

  return (
    <>
      <Show when={props.callouts}>
        {(g) => (
          <div class="ca-callouts">
            <For each={g().items}>
              {(c) => (
                <button type="button" class="ca-callout" onClick={() => void focusCallout(c)}>
                  <span class="ca-callout-head">
                    <span class="ca-callout-badge">{c.n}</span>
                    <span class="ca-callout-title">{c.title || c.text}</span>
                  </span>
                  <Show when={c.detail}>
                    <span class="ca-callout-detail">{c.detail}</span>
                  </Show>
                </button>
              )}
            </For>
            <div class="ca-actions">
              <button type="button" class="ca-btn" disabled={marksCleared()} onClick={clearMarks}>
                {marksCleared() ? "Marks cleared" : "Clear marks"}
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.openedTabs?.length}>
        <div class="ca-opened" role="list" aria-label="Opened tabs">
          <For each={props.openedTabs}>
            {(t) => (
              <button
                type="button"
                class="ca-opened-row"
                role="listitem"
                title={t.url}
                onClick={() => void focusTab(t.tab)}
              >
                <span class="ca-opened-ico" aria-hidden="true">
                  {(t.host[0] || "•").toUpperCase()}
                </span>
                <span class="ca-opened-host">{t.host}</span>
                <span
                  class={isLoading(t.tab) ? "ca-opened-spin" : "ca-opened-ok"}
                  aria-label={isLoading(t.tab) ? "Loading" : "Loaded"}
                >
                  {isLoading(t.tab) ? "" : "✓"}
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.draft}>
        {(d) => (
          <div class="ca-card ca-restyle">
            <span class="ca-legend">Restyle</span>
            <div class="ca-restyle-title">
              {props.summary || `Restyle ${d().host}: ${d().name}`}
            </div>
            <Show when={d().dropped > 0}>
              <div class="ca-note">
                {d().dropped} unused rule{d().dropped === 1 ? "" : "s"} left out.
              </div>
            </Show>
            <Show
              when={state() === "open"}
              fallback={
                <div class="ca-note">
                  {state() === "applied"
                    ? `Kept on ${d().host} — applies on every visit.`
                    : "Undone; the page is back as it was."}
                </div>
              }
            >
              <div class="ca-actions">
                <button type="button" class="ca-pill-keep" onClick={() => void apply()}>
                  Keep on this site
                </button>
                <button type="button" class="ca-pill-undo" onClick={discard}>
                  Undo
                </button>
              </div>
            </Show>
            <details class="ca-css-fold">
              <summary>View CSS</summary>
              <pre class="ca-css">{d().css}</pre>
            </details>
            <Show when={error()}>
              <div class="ca-note">{error()}</div>
            </Show>
          </div>
        )}
      </Show>
    </>
  );
};

export default RestyleCard;
