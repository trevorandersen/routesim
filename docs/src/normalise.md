# `src/normalise.ts` — Config normalisation & defaults

Defensive normalisation for every config shape. Whenever config enters the app from an untrusted source (loaded `config.json`, embedded store, built-in topology literals), it passes through here so the rest of the code can assume well-formed data.

## Key exports

### Field normalisers
- **`normaliseArpTable`, `normaliseDhcpLeases`, `normaliseMacTable`** — coerce table entries to the canonical shape.
- **`normaliseVlans`, `normalisePortVlans`, `normalisePortModes`, `normaliseTrunkAllowedVlans`** — switch VLAN data.
- **`normaliseRouterInterfaces`** — router interfaces; **auto-generates deterministic MACs** (`02:RR:00:00:II:01`) for interfaces that lack one.
- **`normaliseRipConfig`, `normaliseStaticRoutes`** — router routing config.

### Whole-config normalisers
- **`normaliseDeviceConfig(device)`** — dispatches by device type to produce a clean `config`.
- **`normaliseConfig(parsed)`** — normalises a full topology (`devices` + `links`).
- **`normaliseConfigStore(store)`** — normalises the `{ version, configs }` store, used when loading `config.json`.
- **`normaliseConfigName`** — sanitises a saved-config name.

### Defaults & helpers
- **`defaultDeviceConfig(type)`** — the starting config for a newly-created device of each type.
- **`ensureConfig(device)`** — if `device.config` is missing, fills in `defaultDeviceConfig(device.type)`; idempotent (won't overwrite an existing config). Returns the config. Heavily used by the terminal mutators to avoid repeated guard boilerplate.
- **`deviceSize(type)`** — the canvas footprint (width/height) per device type.

## How it fits

`config.ts` calls the store/config normalisers on every load. `devices.ts` calls `defaultDeviceConfig`/`deviceSize` when creating devices. `terminal.ts` and `inspector.ts` call `ensureConfig` before mutating config. The normalisers are also the implicit schema for `config.json`.

## Notes

- Normalisers accept untrusted `unknown` input and always return a valid shape — they never throw on bad data, they coerce or drop it.
- `ensureConfig` is the canonical "make sure config exists" helper; prefer it over inline `device.config = device.config || defaultDeviceConfig(...)`.
