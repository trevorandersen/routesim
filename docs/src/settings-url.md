# `src/settings-url.ts` — URL query-string settings

Reads (and writes) app settings via the page's query string, so a link can carry a pre-configured state, e.g. `rs-web.html?names=0&autodhcp=on&theme=dark&speed=400`. The list of URL-controllable settings lives in one place (`BOOL_PARAMS` plus the `theme`/`speed` special cases) — adding one is a one-row change.

## Key exports

- **`parseSettingsFromUrl(search)`** — pure parser. Takes a query string (typically `window.location.search`; a leading `?` is fine) and returns a `ParsedSettings`: `{ options, theme?, speed?, applied, ignored }`. It mutates nothing. Booleans accept `1/0`, `true/false`, `yes/no`, `on/off` (case-insensitive, as are the param keys); the theme is validated against the `THEMES` registry (`light` aliases `warm-light`); speed is coerced to a number and clamped to `SPEED_MIN`–`SPEED_MAX` (200–3000). Anything unknown or unparseable is collected in `ignored` rather than silently dropped, so a typo'd link is debuggable.
- **`buildSettingsQuery()`** — the inverse: reads the live `state` and returns a query string (no leading `?`) of only the settings that differ from their defaults — a shareable-link tail. Empty when everything is at default. `parseSettingsFromUrl(buildSettingsQuery())` round-trips. One row is **parse-only** (`parseOnly: true`): `autosave` is read from a URL (`?autosave=0` — a visit that neither restores nor saves, see [autosave.md](autosave.md)) but never emitted, because a shared link must not carry the sender's choice about their own browser's storage.
- **`SPEED_MIN` / `SPEED_MAX` / `SPEED_DEFAULT`** — the ms/hop bounds (match the `#simSpeed` slider) and default.

## How it fits

`app.ts`'s `initialiseApp` calls `parseSettingsFromUrl(window.location.search)` **first**, before any UI sync: it merges `options` into `state.options`, applies `speed` to `state.simulation.speed`, and passes `theme ?? DEFAULT_THEME` to `setTheme`. The subsequent `syncOptionControls()` / slider sync / `render()` then reflect the requested state in the controls. The module imports only `state` (for `THEMES`/defaults and the live read) — no DOM or UI deps — so the parser is trivially unit-tested.

Both directions are also exposed on the scripting API: `routesim.urlSettings()` (what the current URL would apply) and `routesim.settingsQuery()` (a link from the live settings). See [scripting.md](../scripting.md#url-settings).
