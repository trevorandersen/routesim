# `src/help.ts` — the in-app reference (Help → Guide)

The single source of truth for the user-facing documentation of **every device
type and every simulation setting**, rendered into the Help → Guide modal. It's
what a learner opens to find out what a device does or what a toggle changes,
without leaving the app.

## Content

- **`DEVICE_DOCS: DeviceDoc[]`** — one entry per **user-addable** device type
  (`{ type, body }`), ordered roughly by the ribbon tool groups. Only the prose
  lives here; the **title and icon come from `DEVICE_SPECS`** at render time, so
  they can never drift from the canvas. Tool *variants* (Managed switch, Border
  router, the `*-server` presets) fold into their parent device's blurb rather
  than getting their own card.
- **`SETTING_GROUPS: SettingGroup[]`** — the simulation settings, grouped to
  mirror the Settings pane (Network boot, Name resolution, Silent protocols) plus
  a **Running a simulation** group for the ribbon transport (Play/Step/Stop/
  Speed). Each `SettingDoc` carries an `id`: for a pane toggle it is the
  checkbox's `id` (e.g. `optAutoDhcp`), which is how the coverage test pairs every
  toggle with its doc; transport controls use a descriptive key (`sim-play`, …).

## Render

**`buildHelpHtml()`** builds the modal body from the content above: an intro, a
**Devices** grid (each card = the device's palette-coloured icon + label +
blurb), and a **Simulation settings** section (each group = title + blurb + a
`<dl>` of rows). `deviceIcon(type)` composes an inline 24×24 SVG from
`DEVICE_SPECS[type].iconPaths`, coloured with the device's `--<paletteVar>-icon`
custom property so it matches the canvas and adapts to the theme. All prose is
`escapeHtml`'d. `ui.ts` calls `buildHelpHtml` on every open (`openHelp`), so the
guide always reflects the current registries.

## Keep fresh

`tests/help.test.ts` is the enforcement, not a suggestion:

- Every `USER_ADDABLE_TYPES` entry has exactly one `DEVICE_DOCS` entry (and no
  doc exists for a non-placeable type) — add a device, and the suite fails until
  it's documented.
- Every `id="opt…"` toggle scraped from `template.html` has a matching
  `SettingDoc` id — add a settings toggle, same deal.

So adding a device or a setting **must** touch `help.ts`; see the "Adding a
device type" checklist in [CLAUDE.md](../../CLAUDE.md).

## How it fits

Content module with one UI entry point. Depends only on `device-registry.ts`
(icons/labels) and `utils.ts` (`escapeHtml`); imported by `ui.ts` for the modal
and by the test for coverage. No engine or state coupling — it's pure
documentation data plus a renderer.
