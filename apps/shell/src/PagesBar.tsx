/** Compact launcher rail. All destinations remain searchable in Launcher. */
import { For, createMemo, onMount, type Component } from "solid-js";
import { IconOrGlyph } from "./Icon";
import { SETTINGS_URL } from "./ipc";
import { openTab, openTuiPane } from "./store";
import { openSidePage, panePageUrl, tabMode } from "./tabMode";
import { hideTip, showTip } from "./RailTip";
import { PAGES } from "./launcherCatalog";
import { loadTerminalApps, terminalApps } from "./launcherData";
import { setLauncherOpen } from "./launcherOpen";
import VerticalCarousel from "./VerticalCarousel";
const PagesBar: Component = () => {
  onMount(() => void loadTerminalApps());
  const entries = createMemo(() => [
    ...PAGES.map((page) => ({
      name: page.label,
      icon: page.icon as string,
      url: page.url as string | null,
      launch: () => {
        if (!openSidePage(page.url, { toggle: true })) {
          void openTab("browser", page.url).catch(() => setLauncherOpen(true, ">"));
        }
      },
    })),
    ...terminalApps().map((app) => ({
      name: app.name,
      icon: app.icon,
      url: null as string | null,
      launch: () => openTuiPane({ ...app }),
    })),
  ]);
  const isEntryActive = (url: string | null) =>
    !!url && (url === SETTINGS_URL ? tabMode() === "settings" : tabMode() === "page" && panePageUrl() === url);
  return (
    <div class="pages-bar launcher-rail">
      <button
        class="pages-chip"
        aria-label="Open launcher"
        title="Open launcher"
        onClick={() => {
          hideTip();
          setLauncherOpen(true, ">");
        }}
      >
        ⌕
      </button>
      <div class="launcher-rail-sep" />
      <VerticalCarousel class="pages-carousel" itemHeight={32} gap={6} speed={18} count={entries().length} onScroll={hideTip}>
        <For each={entries()}>
          {(entry) => (
            <button
              classList={{ "pages-chip": true, active: isEntryActive(entry.url) }}
              title={`Open ${entry.name}`}
              aria-label={`Open ${entry.name}`}
              onClick={() => {
                hideTip();
                entry.launch();
              }}
              onMouseEnter={(e) => showTip(e.currentTarget, entry.name)}
              onMouseLeave={hideTip}
              onFocus={(e) => showTip(e.currentTarget, entry.name)}
              onBlur={hideTip}
            >
              <IconOrGlyph icon={entry.icon} size={17} />
            </button>
          )}
        </For>
      </VerticalCarousel>
    </div>
  );
};
export default PagesBar;
