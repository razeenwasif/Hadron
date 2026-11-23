/**
 * Time & Focus — the tabs pane's Time mode (matches Screenshot 1, lazy chunk).
 * Reuses `timeReport` and `focusStore` so counts and active focus timers stay
 * in step with `flux://time` and the new-tab strip.
 */
import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";

import { askConfirm } from "./ask";
import { focusEnd, focusPause, focusSet, focusStart, timeForget, timeReport } from "./focusIpc";
import { clockOf, focus, focusLeft, refreshFocus } from "./focusStore";
import { TIME_URL, type TimeReport } from "./ipc";
import { visibleInterval } from "./poll";
import { openTab } from "./store";
import { openSidePage } from "./tabMode";

const formatDur = (secs: number): string => {
  const m = Math.round(secs / 60);
  if (m < 1) return secs > 0 ? "<1m" : "0m";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
};

const LENGTHS = [15, 25, 50, 90] as const;

const TimePane: Component = () => {
  const [week, setWeek] = createSignal(false);
  const [report, setReport] = createSignal<TimeReport | null>(null);
  const [minutes, setMinutes] = createSignal(25);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [editingSites, setEditingSites] = createSignal(false);
  const [siteInput, setSiteInput] = createSignal("");

  const load = () =>
    void timeReport(week())
      .then(setReport)
      .catch(() => {});

  onMount(() => {
    load();
    void refreshFocus();
  });
  visibleInterval(load, 30_000);

  const pickPeriod = (isWeek: boolean) => {
    setWeek(isWeek);
    load();
  };

  const now = new Date();
  const maxBar = createMemo(() => Math.max(1, ...(report()?.bars.map((b) => b.secs) ?? [0])));
  const topSite = createMemo(() => Math.max(1, ...(report()?.sites.map((s) => s.secs) ?? [0])));
  const isCurrentBar = (i: number) => (week() ? i === 6 : i === now.getHours());

  const cycleMinutes = () => {
    const idx = LENGTHS.indexOf(minutes() as (typeof LENGTHS)[number]);
    setMinutes(LENGTHS[(idx + 1) % LENGTHS.length]!);
  };

  const sites = () => focus()?.sites ?? [];
  const updateSites = (next: string[]) =>
    void focusSet(next)
      .then(refreshFocus)
      .catch(() => {});

  const addSite = (e: Event) => {
    e.preventDefault();
    const s = siteInput().trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!s || sites().includes(s)) return;
    updateSites([...sites(), s]);
    setSiteInput("");
  };

  const start = () =>
    void focusStart("", minutes(), sites())
      .then(refreshFocus)
      .catch(() => {});

  const forget = async () => {
    setMenuOpen(false);
    const ok = await askConfirm({
      title: "Forget web time data?",
      hint: "Clears all site-time totals stored on this device.",
      confirm: "Forget all",
    });
    if (!ok) return;
    await timeForget().catch(() => {});
    load();
  };

  const R = 33;
  const CIRC = 2 * Math.PI * R;
  const progress = () => {
    const f = focus();
    if (!f?.running || !f.minutes) return 0;
    return Math.min(1, Math.max(0, 1 - focusLeft() / (f.minutes * 60_000)));
  };

  return (
    <div class="time-pane">
      <div class="time-head">
        <h3 class="time-title">Time</h3>
        <div class="time-menu-wrap">
          <button
            type="button"
            class="mode-btn time-more"
            aria-label="Time options"
            aria-expanded={menuOpen()}
            onClick={() => setMenuOpen(!menuOpen())}
          >
            ···
          </button>
          <Show when={menuOpen()}>
            <div class="time-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setEditingSites(!editingSites());
                }}
              >
                {editingSites() ? "Hide blocked sites" : "Edit blocked sites"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  if (!openSidePage(TIME_URL)) void openTab("browser", TIME_URL);
                }}
              >
                See all of Time
              </button>
              <button type="button" role="menuitem" class="danger" onClick={() => void forget()}>
                Forget time data
              </button>
            </div>
          </Show>
        </div>
      </div>

      <div class="mail-filter" role="tablist" aria-label="Time period">
        <button
          role="tab"
          aria-selected={!week()}
          classList={{ on: !week() }}
          onClick={() => pickPeriod(false)}
        >
          Today
        </button>
        <button
          role="tab"
          aria-selected={week()}
          classList={{ on: week() }}
          onClick={() => pickPeriod(true)}
        >
          This week
        </button>
      </div>

      <div class="time-summary">
        <div class="time-total">{formatDur(report()?.total_secs ?? 0)}</div>
        <div class="time-sub">on the web</div>
      </div>

      <figure class="time-chart">
        <div class="time-bars" classList={{ week: week() }} aria-hidden="true">
          <For each={report()?.bars ?? []}>
            {(b, i) => (
              <span
                class="time-bar"
                classList={{ now: isCurrentBar(i()), active: b.secs > 0 }}
                style={{ height: `${Math.max(b.secs ? 6 : 2, (b.secs / maxBar()) * 100)}%` }}
                title={`${b.label}: ${formatDur(b.secs)}`}
              />
            )}
          </For>
        </div>
        <div class="time-axis" aria-hidden="true">
          <Show
            when={week()}
            fallback={<For each={["12 AM", "6 AM", "12 PM", "6 PM"]}>{(l) => <span>{l}</span>}</For>}
          >
            <For each={report()?.bars ?? []}>{(b) => <span>{b.label}</span>}</For>
          </Show>
        </div>
      </figure>

      <section class="time-focus-card" aria-label="Focus timer">
        <div class="time-focus-top">
          <div class="time-ring">
            <svg viewBox="0 0 80 80" aria-hidden="true">
              <circle class="time-ring-track" cx="40" cy="40" r={R} />
              <Show when={focus()?.running}>
                <circle
                  class="time-ring-fill"
                  cx="40"
                  cy="40"
                  r={R}
                  stroke-dasharray={String(CIRC)}
                  stroke-dashoffset={String(CIRC * (1 - progress()))}
                />
              </Show>
            </svg>
            <Show
              when={focus()?.running}
              fallback={
                <button
                  type="button"
                  class="time-ring-inner"
                  title="Change focus duration"
                  onClick={cycleMinutes}
                >
                  <span class="time-ring-num">{minutes()}</span>
                  <span class="time-ring-unit">min ▾</span>
                </button>
              }
            >
              <div class="time-ring-inner">
                <span class="time-ring-clock">{clockOf(focusLeft())}</span>
                <span class="time-ring-unit">{focus()?.paused ? "paused" : "left"}</span>
              </div>
            </Show>
          </div>

          <div class="time-focus-meta">
            <div class="time-focus-title">Focus</div>
            <button
              type="button"
              class="time-focus-sites"
              onClick={() => setEditingSites(!editingSites())}
              title="Edit sites blocked during focus"
            >
              Shuts {sites().length} {sites().length === 1 ? "site" : "sites"}
            </button>
          </div>
        </div>
        <Show
          when={focus()?.running}
          fallback={
            <button type="button" class="time-focus-btn primary" onClick={start}>
              Start focus
            </button>
          }
        >
          <div class="time-focus-actions">
            <button
              type="button"
              class="time-focus-btn"
              onClick={() => void focusPause(!focus()?.paused).then(refreshFocus).catch(() => {})}
            >
              {focus()?.paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              class="time-focus-btn muted"
              onClick={() => void focusEnd().then(refreshFocus).catch(() => {})}
            >
              End
            </button>
          </div>
        </Show>
      </section>

      <Show when={editingSites()}>
        <div class="time-sites-edit">
          <form class="mode-add" onSubmit={addSite}>
            <span aria-hidden="true">＋</span>
            <input
              aria-label="Block site during focus"
              placeholder="youtube.com, reddit.com…"
              value={siteInput()}
              onInput={(e) => setSiteInput(e.currentTarget.value)}
            />
          </form>
          <div class="time-site-chips">
            <For each={sites()} fallback={<span class="mode-empty">No sites blocked yet.</span>}>
              {(s) => (
                <span class="time-site-chip">
                  {s}
                  <button
                    type="button"
                    aria-label={`Remove ${s}`}
                    onClick={() => updateSites(sites().filter((x) => x !== s))}
                  >
                    ✕
                  </button>
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>

      <div class="time-sites-head">SITES</div>
      <div class="time-sites-list">
        <For
          each={(report()?.sites ?? []).slice(0, 5)}
          fallback={<p class="mode-empty">Nothing counted yet {week() ? "this week" : "today"}.</p>}
        >
          {(s) => (
            <div class="time-site-row">
              <div class="time-site-top">
                <span class="time-site-fav" aria-hidden="true">
                  {s.host[0]?.toUpperCase() ?? "?"}
                </span>
                <span class="time-site-host" title={s.host}>
                  {s.host}
                </span>
                <span class="time-site-dur">{formatDur(s.secs)}</span>
              </div>
              <span class="time-site-track" aria-hidden="true">
                <span style={{ width: `${Math.max(4, (s.secs / topSite()) * 100)}%` }} />
              </span>
            </div>
          )}
        </For>
      </div>

      <button
        type="button"
        class="time-see-all"
        onClick={() => {
          if (!openSidePage(TIME_URL)) void openTab("browser", TIME_URL);
        }}
      >
        See all of Time
      </button>

      <p class="time-foot">Counted on this device only</p>
    </div>
  );
};

export default TimePane;
