/**
 * Minimal modern Shields popover (#57) — split from Shields.tsx so the toggle
 * UI loads on first open (ADR 0001). Keeps the primary view focused on site
 * status, top blocked domains, and quick actions, while tucking extra &
 * platform-specific controls into "More controls".
 */
import { For, Show, createEffect, createSignal, on, onMount, type Component } from "solid-js";

import { visibleInterval } from "./poll";
import {
  cookiesClearAll,
  cookiesClearSite,
  cookiesSetClearOnClose,
  cookiesStatus,
  httpsAllowSite,
  httpsSetEnabled,
  httpsStatus,
  leanSetSite,
  leanStatus,
  PERMISSIONS_URL,
  permissionsSetBlock,
  permissionsStatus,
  shieldsPickElement,
  shieldsRefresh,
  shieldsSetEnabled,
  shieldsSetSite,
  shieldsStatus,
  shieldsUnhideSite,
  trackingSetLevel,
  trackingStatus,
  webviewReload,
  type CookieStatus,
  type HttpsStatus,
  type LeanStatus,
  type ShieldsStatus,
} from "./ipc";
import { settingsWriter } from "./settingsWriter";
import { protectionStatus, protectionMetrics, requestControlsHint } from "./protectionStatus";
import { isWindows } from "./platform";
import { activeId, activeTab } from "./store";
import "./ShieldsPop.css";

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname || null : null;
  } catch {
    return null;
  }
}

const Switch: Component<{
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}> = (props) => (
  <button
    type="button"
    role="switch"
    aria-label={props.label}
    aria-checked={props.checked}
    disabled={props.disabled}
    classList={{ "sp-switch": true, on: props.checked }}
    onClick={props.onToggle}
  >
    <span class="sp-thumb" aria-hidden="true" />
  </button>
);

const ShieldsPop: Component<{ onNavigate: (url: string) => void; onClose: () => void }> = (props) => {
  const [status, setStatus] = createSignal<ShieldsStatus | null>(null);
  const [https, setHttps] = createSignal<HttpsStatus | null>(null);
  const [tracking, setTracking] = createSignal(2);
  const [cookies, setCookies] = createSignal<CookieStatus | null>(null);
  const [blockPerms, setBlockPerms] = createSignal(false);
  const [lean, setLean] = createSignal<LeanStatus | null>(null);
  const [showAllDomains, setShowAllDomains] = createSignal(false);

  const writer = settingsWriter();
  const [loadError, setLoadError] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  let version = 0;

  const poll = () => {
    if (writer.pending()) return;
    const request = ++version;
    const tabId = activeId();
    void Promise.all([
      shieldsStatus(tabId),
      httpsStatus(),
      trackingStatus(),
      cookiesStatus(),
      permissionsStatus(),
      leanStatus(),
    ])
      .then(([shields, https, tracking, cookies, permissions, lean]) => {
        if (request !== version || tabId !== activeId() || writer.pending()) return;
        setStatus(shields);
        setHttps(https);
        setTracking(tracking);
        setCookies(cookies);
        setBlockPerms(permissions);
        setLean(lean);
        setLoadError(false);
      })
      .catch(() => {
        if (request === version) {
          setStatus(null);
          setLoadError(true);
        }
      });
  };
  onMount(() => visibleInterval(poll, 2000));
  createEffect(
    on(activeId, () => {
      setStatus(null);
      setShowAllDomains(false);
      poll();
    }),
  );

  const save = async (label: string, action: () => Promise<unknown>) => {
    version++;
    await writer.run(label, action);
    poll();
  };

  const requestControls = () => status()?.request_controls === true;
  const siteControls = () => status()?.site_controls === true;
  const host = () => {
    const t = activeTab();
    return t && t.kind === "browser" ? hostOf(t.url) : null;
  };
  const siteOn = () => {
    const h = host();
    const s = status();
    return h && s ? !s.sites_off.includes(h) : true;
  };
  const reloadPage = () => {
    const t = activeTab();
    if (t && t.kind === "browser" && host()) void webviewReload(t.id).catch(() => {});
  };
  const toggleGlobal = () => {
    const s = status();
    if (s) void save("Shields", () => shieldsSetEnabled(!s.enabled)).then(reloadPage);
  };
  const toggleSite = () => {
    const h = host();
    const value = !siteOn();
    if (h) void save("site protection", () => shieldsSetSite(h, value)).then(reloadPage);
  };
  const pickElement = () => {
    const tab = activeId();
    props.onClose();
    if (tab != null) void shieldsPickElement(tab).catch(() => {});
  };
  const unhide = () => {
    const h = host();
    if (h) void save("hidden elements", () => shieldsUnhideSite(h)).then(reloadPage);
  };
  const hiddenCount = () => status()?.site_hidden ?? 0;
  const httpsOn = () => !!https()?.enabled;
  const siteAllowsHttp = () => {
    const h = host();
    const s = https();
    return !!(h && s && s.sites_allow_http.includes(h));
  };
  const toggleHttps = () => {
    const value = !httpsOn();
    void save("HTTPS-only", () => httpsSetEnabled(value));
  };
  const toggleSiteHttp = () => {
    const h = host();
    const value = !siteAllowsHttp();
    if (h) void save("HTTP exception", () => httpsAllowSite(h, value));
  };
  const togglePerms = () => {
    const value = !blockPerms();
    void save("site permissions", () => permissionsSetBlock(value));
  };
  const leanOn = () => {
    const h = host();
    const l = lean();
    return !!(h && l && l.sites_on.includes(h));
  };
  const toggleLean = () => {
    const h = host();
    const value = !leanOn();
    if (h) void save("Lean mode", () => leanSetSite(h, value));
  };
  const clearOnClose = () => {
    const h = host();
    const c = cookies();
    return !!(h && c && c.clear_on_close.includes(h));
  };
  const toggleClearOnClose = () => {
    const h = host();
    const value = !clearOnClose();
    if (h) void save("cookie preference", () => cookiesSetClearOnClose(h, value));
  };

  const domains = () => status()?.page_domains ?? [];
  const visibleDomains = () => (showAllDomains() ? domains() : domains().slice(0, 3));
  const blockedCount = () => status()?.page_blocked ?? 0;

  return (
    <>
      <div class="shield-backdrop" onClick={() => props.onClose()} />
      <div class="glass popover shields-pop footer-pop">
        <Show when={loadError()}>
          <div role="alert" class="settings-feedback">
            Couldn't load Shields.<button onClick={poll}>Retry</button>
          </div>
        </Show>
        <Show when={writer.error()}>
          <div role="alert" class="settings-feedback">
            {writer.error()}
            <button onClick={() => void Promise.resolve(writer.retry()).then(poll)}>Retry</button>
          </div>
        </Show>

        <fieldset
          class="sp-fields"
          disabled={writer.pending() || !status()}
          aria-label="Protection controls"
        >
          <div class="sp-head">
            <div class="sp-head-meta">
              <div class="sp-host" title={host() ?? "Shields"}>
                {host() ?? "Shields"}
              </div>
              <div class="sp-sub" role="status">
                {writer.pending()
                  ? "Saving…"
                  : host() && status()?.request_metrics
                    ? status()?.enabled && siteOn()
                      ? `${blockedCount().toLocaleString()} blocked on page`
                      : "Shields paused here"
                    : protectionStatus(status(), host() != null, host())}
              </div>
            </div>
            <Show
              when={siteControls()}
              fallback={
                <span class="sp-badge">{status()?.backend === "webkit" ? "Native rules" : "Off"}</span>
              }
            >
              <Switch
                label={host() ? `Shields for ${host()}` : "Global Shields"}
                checked={host() ? !!status()?.enabled && siteOn() : !!status()?.enabled}
                onToggle={host() && status()?.enabled ? toggleSite : toggleGlobal}
              />
            </Show>
          </div>

          <Show when={status()?.request_metrics && host() && siteOn() && status()?.enabled && domains().length > 0}>
            <div class="sp-section">
              <ul class="shields-domains" aria-label="Blocked domains">
                <For each={visibleDomains()}>
                  {(d) => (
                    <li>
                      <span class="shields-domain" title={d.domain}>
                        {d.domain}
                      </span>
                      <span class="shields-domain-n">{d.count}</span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={domains().length > 3}>
                <button
                  type="button"
                  class="sp-link"
                  onClick={() => setShowAllDomains(!showAllDomains())}
                >
                  {showAllDomains() ? "Show fewer" : `Show all (${domains().length})`}
                </button>
              </Show>
            </div>
          </Show>

          <Show when={host()}>
            <div class="sp-actions">
              <Show when={status()?.element_picker}>
                <button type="button" class="sp-pill-btn" onClick={pickElement}>
                  Hide element…
                </button>
                <Show when={hiddenCount() > 0}>
                  <button type="button" class="sp-pill-btn" onClick={unhide}>
                    Show {hiddenCount()} hidden
                  </button>
                </Show>
              </Show>
              <button
                type="button"
                class="sp-pill-btn"
                onClick={() => {
                  const h = host();
                  if (h) void save("site cookie cleanup", () => cookiesClearSite(h));
                }}
              >
                Clear cookies
              </button>
            </div>
          </Show>

          <details class="sp-more">
            <summary>More controls</summary>
            <div class="sp-more-body">
              <Show when={host() && siteControls()}>
                <div class="sp-row">
                  <span class="sp-row-label">Global Shields</span>
                  <Switch label="Global Shields" checked={!!status()?.enabled} onToggle={toggleGlobal} />
                </div>
              </Show>
              <Show when={host()}>
                <div class="sp-row">
                  <span class="sp-row-label">Clear cookies on close</span>
                  <Switch
                    label="Clear cookies on close"
                    checked={clearOnClose()}
                    onToggle={toggleClearOnClose}
                  />
                </div>
              </Show>
              <Show when={requestControls()}>
                <div class="sp-row">
                  <span class="sp-row-label">Trackers</span>
                  <select
                    class="shields-select"
                    aria-label="Tracking prevention"
                    value={String(tracking())}
                    onChange={(e) => {
                      const v = Number(e.currentTarget.value);
                      void save("tracking prevention", () => trackingSetLevel(v));
                      e.currentTarget.value = String(tracking());
                    }}
                  >
                    <option value="0">Off</option>
                    <option value="1">Basic</option>
                    <option value="2">Balanced</option>
                    <option value="3">Strict</option>
                  </select>
                </div>
                <div class="sp-row">
                  <span class="sp-row-label">HTTPS-only</span>
                  <Switch label="HTTPS-only" checked={httpsOn()} onToggle={toggleHttps} />
                </div>
                <Show when={httpsOn() && host()}>
                  <div class="sp-row">
                    <span class="sp-row-label">Allow HTTP here</span>
                    <Switch label="Allow HTTP on this site" checked={siteAllowsHttp()} onToggle={toggleSiteHttp} />
                  </div>
                </Show>
                <Show when={host()}>
                  <div class="sp-row">
                    <span class="sp-row-label">Lean mode here</span>
                    <Switch label="Lean mode for this site" checked={leanOn()} onToggle={toggleLean} />
                  </div>
                </Show>
              </Show>
              <Show when={isWindows}>
                <div class="sp-row">
                  <span class="sp-row-label">Block camera/mic/geo</span>
                  <Switch label="Block camera, microphone and location" checked={blockPerms()} onToggle={togglePerms} />
                </div>
              </Show>
              <Show when={status() && !requestControls()}>
                <div class="sp-hint">{requestControlsHint(status())}</div>
              </Show>
              <div class="sp-hint">{protectionMetrics(status())}</div>
              <div class="sp-links">
                <button
                  type="button"
                  class="sp-link"
                  onClick={() => {
                    props.onClose();
                    props.onNavigate(PERMISSIONS_URL);
                  }}
                >
                  Permissions…
                </button>
                <button
                  type="button"
                  class="sp-link"
                  onClick={() =>
                    void save("filter update", async () => {
                      await shieldsRefresh();
                      setNotice(
                        status()?.backend === "webkit"
                          ? "Update requested — restart Flux to refresh rules."
                          : "Filter update requested.",
                      );
                    })
                  }
                >
                  Update filters
                </button>
                <button
                  type="button"
                  class="sp-link"
                  onClick={() => void save("cookie cleanup", cookiesClearAll)}
                >
                  Clear all cookies
                </button>
              </div>
              <Show when={notice()}>
                <div class="sp-hint" role="status">
                  {notice()}
                </div>
              </Show>
            </div>
          </details>
        </fieldset>
      </div>
    </>
  );
};

export default ShieldsPop;
