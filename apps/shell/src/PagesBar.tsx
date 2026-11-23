/** Compact launcher rail. All destinations remain searchable in Launcher. */
import { For, createMemo, onMount, type Component } from "solid-js";
import { IconOrGlyph } from "./Icon";
import { SETTINGS_URL } from "./ipc";
import { openTab, openTuiPane } from "./store";
import { openSidePage, panePageUrl, tabMode } from "./tabMode";
import { hideTip, showTip } from "./RailTip";
import { PAGES } from "./launcherCatalog";
import { favorites, loadTerminalApps, terminalApps } from "./launcherData";
import { setLauncherOpen } from "./launcherOpen";
const PagesBar: Component = () => {
  onMount(() => void loadTerminalApps());
  const entries = createMemo(() =>
    favorites().flatMap((id) => {
      const page = PAGES.find((p) => `page:${p.url}` === id);
      if (page)
        return [
          {
            name: page.label,
            icon: page.icon as string,
            url: page.url,
            launch: () => {
              if (!openSidePage(page.url, { toggle: true })) {
                void openTab("browser", page.url).catch(() => setLauncherOpen(true, ">"));
              }
            },
          },
        ];
      const app = terminalApps().find((a) => `terminal:${a.id}` === id);
      return app ? [{ name: app.name, icon: app.icon, url: null as string | null, launch: () => openTuiPane({ ...app }) }] : [];
    }),
  );
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
    </div>
  );
};
export default PagesBar;
