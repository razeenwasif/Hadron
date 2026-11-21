# Flux Status & Plan (Local & Antigravity Hub)

Canonical local replacement for the migrated Claude artifact (`https://claude.ai/artifact/8W7gV7pJXSk9jn5Bo12cjR`, v20).

## Files

- `steps.json` — Canonical statuses, notes, and timestamps for all 33 run-order steps. Edit this file whenever a step starts, changes, or lands.
- `template.html` — Source HTML template (Opal palette, Plan, Guide, Cheatsheet, Architecture, Dev docs, and Flux Next Designs gallery).
- `boards/next-*.html` — Standalone HTML copies of all 12 Flux Next design boards.
- `build.mjs` — Zero-dependency builder that refreshes the Backlog section from `BACKLOG.md`, pulls current repo HEAD metadata, bakes `steps.json`, and outputs `index.html`.
- `index.html` — Generated standalone local copy. Open directly in Flux or any browser (`open docs/status-plan/index.html`).

## Updating & Syncing

1. Edit `docs/status-plan/steps.json` (or `BACKLOG.md` / `docs/status-plan/template.html`).
2. Rebuild the local repo copy:
   ```bash
   node docs/status-plan/build.mjs
   ```
3. Also sync a self-contained Antigravity artifact copy (CSP-safe, inline images & gzip-embedded boards):
   ```bash
   node docs/status-plan/build.mjs --artifact /path/to/brain/<conversation-id>/flux-status-plan.html
   ```

Status or note changes made directly inside `index.html` or the Antigravity artifact save to `localStorage` and expose **Copy steps.json** / **Download JSON** buttons in the progress header so browser edits can be saved back into `docs/status-plan/steps.json`.
