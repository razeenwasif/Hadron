import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  type Component,
  type JSX,
} from "solid-js";

const NAV_GROUPS: { label: string; items: string[] }[] = [
  {
    label: "Browser",
    items: ["Appearance", "Search", "Navigation", "Privacy & security", "Memory", "Browsing data"],
  },
  {
    label: "Work",
    items: ["Terminal", "Indexer", "Integrations", "Form help", "Phone link"],
  },
  {
    label: "App",
    items: ["Keyboard", "Updates", "Data"],
  },
];

const NavIcon: Component<{ name: string }> = (props) => {
  const icon = () => {
    switch (props.name) {
      case "Appearance":
        return (
          <>
            <path d="M8 2.2a5.8 5.8 0 1 0 0 11.6c.9 0 1.4-.6 1.4-1.3 0-.4-.2-.7-.2-1.1 0-.6.5-1.1 1.1-1.1h1.3a2.2 2.2 0 0 0 2.2-2.2A5.9 5.9 0 0 0 8 2.2Z" />
            <circle cx="5.5" cy="7.5" r=".7" fill="currentColor" stroke="none" />
            <circle cx="7.4" cy="5.1" r=".7" fill="currentColor" stroke="none" />
            <circle cx="10.3" cy="5.8" r=".7" fill="currentColor" stroke="none" />
          </>
        );
      case "Search":
        return (
          <>
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.4 10.4 3.4 3.4" />
          </>
        );
      case "Navigation":
        return (
          <>
            <circle cx="8" cy="8" r="5.8" />
            <path d="m10.4 5.6-1.3 3.5-3.5 1.3 1.3-3.5z" />
          </>
        );
      case "Privacy & security":
        return <path d="M8 2.1 3.2 4v3.8c0 3 2 5 4.8 6 2.8-1 4.8-3 4.8-6V4z" />;
      case "Memory":
        return (
          <>
            <path d="M3.1 11.7a5.6 5.6 0 1 1 9.8 0" />
            <path d="m8 8.8 2.6-2.7" />
            <circle cx="8" cy="8.8" r=".9" />
          </>
        );
      case "Browsing data":
        return (
          <>
            <ellipse cx="8" cy="4.4" rx="4.5" ry="1.7" />
            <path d="M3.5 4.4v7.2c0 1 2 1.7 4.5 1.7s4.5-.7 4.5-1.7V4.4" />
            <path d="M3.5 8c0 .9 2 1.7 4.5 1.7s4.5-.8 4.5-1.7" />
          </>
        );
      case "Terminal":
        return (
          <>
            <rect x="2.2" y="3" width="11.6" height="10" rx="2" />
            <path d="m5 6.4 2.1 1.7L5 9.8M8.6 9.8h2.4" />
          </>
        );
      case "Indexer":
        return (
          <>
            <path d="M2.8 4.5h10.4M2.8 8h5.2M2.8 11.5h4.2" />
            <circle cx="11.3" cy="10.4" r="2.1" />
            <path d="m12.8 12 1.4 1.4" />
          </>
        );
      case "Integrations":
        return <path d="M6 2.4v3M10 2.4v3M4.4 5.4h7.2v2a3.6 3.6 0 0 1-7.2 0zM8 11v2.6" />;
      case "Form help":
        return (
          <>
            <rect x="2.5" y="3" width="11" height="10" rx="1.8" />
            <path d="M5 6.5h6M5 9.5h3.5" />
          </>
        );
      case "Phone link":
        return (
          <>
            <rect x="4.5" y="2" width="7" height="12" rx="1.5" />
            <path d="M7 11.6h2" />
          </>
        );
      case "Keyboard":
        return (
          <>
            <rect x="2" y="4.2" width="12" height="7.6" rx="1.6" />
            <path d="M4.6 6.9h.9M7.55 6.9h.9M10.5 6.9h.9M5.2 9.4h5.6" />
          </>
        );
      case "Updates":
        return (
          <>
            <path d="M13 5.4A5.5 5.5 0 0 0 3.7 4.7M3 2.5v2.6h2.6" />
            <path d="M3 10.6a5.5 5.5 0 0 0 9.3.7M13 13.5v-2.6h-2.6" />
          </>
        );
      case "Data":
        return (
          <path d="M2.3 4.6a1.4 1.4 0 0 1 1.4-1.4h2.5L7.5 4.6h4.8a1.4 1.4 0 0 1 1.4 1.4v5.6a1.4 1.4 0 0 1-1.4 1.4H3.7a1.4 1.4 0 0 1-1.4-1.4z" />
        );
      default:
        return (
          <>
            <rect x="2.6" y="2.6" width="4.4" height="4.4" rx="1.1" />
            <rect x="9" y="2.6" width="4.4" height="4.4" rx="1.1" />
            <rect x="2.6" y="9" width="4.4" height="4.4" rx="1.1" />
            <rect x="9" y="9" width="4.4" height="4.4" rx="1.1" />
          </>
        );
    }
  };
  return (
    <svg
      class="set-nav-ico"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {icon()}
    </svg>
  );
};

export const Section: Component<{ title: string; sub?: string; children: JSX.Element }> = (props) => {
  const id = createUniqueId();
  return (
    <section class="set-section" aria-labelledby={id} data-section={props.title}>
      <div class="set-section-head">
        <h2 id={id}>{props.title}</h2>
        <Show when={props.sub}>
          <span class="set-section-sub">{props.sub}</span>
        </Show>
      </div>
      {/* data-legend: Velvet Paper (design.ts) sets the title into the card's edge. */}
      <div class="set-card" data-legend={props.title}>
        {props.children}
      </div>
    </section>
  );
};

/** Hide, rather than remount, sections so searching preserves unsaved form values. */
const SettingsNavigator: Component<{ inPane?: boolean; children: JSX.Element }> = (props) => {
  let body!: HTMLDivElement;
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal("Appearance");
  const [drilled, setDrilled] = createSignal<string | null>(null);
  const [sections, setSections] = createSignal<HTMLElement[]>([]);
  const [matches, setMatches] = createSignal(0);
  const normalize = (s: string) =>
    s
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");

  const navGroups = createMemo(() => {
    const present = new Set(sections().map((s) => s.dataset.section!).filter(Boolean));
    const known = new Set(NAV_GROUPS.flatMap((g) => g.items));
    const extras = Array.from(present).filter((t) => !known.has(t));
    return NAV_GROUPS.map((g, idx) => {
      const items = g.items.filter((t) => present.has(t));
      if (idx === NAV_GROUPS.length - 1) {
        items.push(...extras, "All settings");
      }
      return { label: g.label, items };
    }).filter((g) => g.items.length > 0);
  });

  const filter = () => {
    const terms = normalize(query().trim()).split(/\s+/).filter(Boolean);
    const matchesText = (s: string) => terms.every((term) => normalize(s).includes(term));
    let count = 0;
    let shown = 0;
    for (const section of sections()) {
      const title = section.dataset.section ?? "";
      const inCategory = terms.length > 0 || selected() === "All settings" || selected() === title;
      let visibleRows = 0;
      for (const row of section.querySelectorAll<HTMLElement>(".set-row")) {
        // Index labels and explanations, never a password, API key or typed value.
        const text = Array.from(row.querySelectorAll(".set-row-label, .set-row-hint"))
          .map((el) => el.textContent ?? "")
          .join(" ");
        row.hidden = !inCategory || !matchesText(`${title} ${text}`);
        if (!row.hidden) visibleRows++;
      }
      section.hidden = !inCategory || (terms.length > 0 && visibleRows === 0);
      if (!section.hidden) count += visibleRows;
      if (!section.hidden) shown++;
    }
    setMatches(count);
    // How many sections are on screen, for the layout: one gets the width.
    body.dataset.shown = String(shown);
  };
  createEffect(filter);
  onMount(() => {
    const list = Array.from(body.querySelectorAll<HTMLElement>(".set-section"));
    setSections(list);
    if (list.length > 0 && selected() !== "All settings" && !list.some((s) => s.dataset.section === selected())) {
      setSelected(list[0]?.dataset.section ?? "All settings");
    }
    // Desktop full-page Velvet Paper lays sections in a two-column grid.
    if (!props.inPane) {
      const ROW = 4;
      const GAP = 36;
      const spans = new ResizeObserver((entries) => {
        for (const { target } of entries) {
          const el = target as HTMLElement;
          el.style.gridRowEnd = el.offsetHeight ? `span ${Math.ceil((el.offsetHeight + GAP) / ROW)}` : "";
        }
      });
      for (const s of list) spans.observe(s);
      onCleanup(() => spans.disconnect());
    }
    // Conditional provider controls can appear while the page is filtered.
    const observer = new MutationObserver(filter);
    observer.observe(body, { childList: true, subtree: true });
    onCleanup(() => observer.disconnect());
  });
  /** Back to the top. The body scrolls in Classic; Velvet Paper lays the cards
   *  out in columns, so there the results column scrolls instead. */
  const toTop = () => {
    body.scrollTop = 0;
    if (body.parentElement) body.parentElement.scrollTop = 0;
  };
  const select = (title: string) => {
    setQuery("");
    setSelected(title);
    if (props.inPane) setDrilled(title);
    toTop();
  };
  const showResults = () => !props.inPane || !!query().trim() || drilled() !== null;
  const showNav = () => !props.inPane || (!query().trim() && drilled() === null);
  return (
    <div classList={{ "set-layout": true, "has-results": showResults() }}>
      <aside class="set-rail">
        <div class="set-search-bar">
          <div class="set-search-box">
            <svg
              class="set-search-ico"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.4 10.4 3.4 3.4" />
            </svg>
            <input
              ref={input}
              type="search"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                toTop();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query()) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
            />
          </div>
          <Show when={query()}>
            <button
              class="set-link-btn"
              onClick={() => {
                setQuery("");
                input.focus();
              }}
            >
              Clear
            </button>
          </Show>
        </div>
        <nav class="set-nav" aria-label="Settings categories" data-legend="Settings" hidden={!showNav()}>
          <For each={navGroups()}>
            {(group) => (
              <div class="set-nav-group">
                <div class="set-nav-group-label">{group.label}</div>
                <For each={group.items}>
                  {(title) => (
                    <button
                      class="set-nav-btn"
                      aria-current={!query() && selected() === title ? "page" : undefined}
                      onClick={() => select(title)}
                    >
                      <NavIcon name={title} />
                      <span>{title}</span>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </nav>
      </aside>
      <div class="set-results" hidden={!showResults()}>
        <Show when={props.inPane && drilled() && !query().trim()}>
          <div class="set-pane-subhead">
            <button class="set-back-btn" type="button" onClick={() => setDrilled(null)}>
              ← Settings
            </button>
            <span class="set-pane-cat">{drilled()}</span>
          </div>
        </Show>
        <Show when={query()}>
          <div class="set-search-status" role="status">
            {matches() ? `${matches()} matching settings` : "No settings found. Try another search."}
          </div>
        </Show>
        <div ref={body} class="set-body">
          {props.children}
        </div>
      </div>
    </div>
  );
};
export default SettingsNavigator;
