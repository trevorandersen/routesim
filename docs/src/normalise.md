# `src/normalise.ts` — Config normalisation & defaults

Defensive normalisation for every config shape. Whenever config enters the app from an untrusted source (imported topology JSON, built-in topology literals), it passes through here so the rest of the code can assume well-formed data.

## Key exports

### Field normalisers
- **`normaliseArpTable`, `normaliseDhcpLeases`, `normaliseMacTable`** — coerce table entries to the canonical shape.
- **`normaliseVlans`, `normalisePortVlans`, `normalisePortModes`, `normaliseTrunkAllowedVlans`** — switch VLAN data.
- **`normaliseRouterInterfaces`** — router interfaces; a supplied MAC is upper-cased/validated (falling back to the generated one if malformed), and interfaces that lack one get an **auto-generated deterministic MAC** (`02:RR:HH:HH:II:01` — 24 bits of the router-id hash plus the interface index, so distinct router ids don't collide). **Generated MACs never collide within a router and are upper-case**: the MACs the entries already carry are collected first, and an entry without one takes its array position's ordinal when that MAC is free, else the lowest ordinal nothing uses (`freeRouterIfaceMac`). The ordinal used to be the array index alone, so after a reload had compacted the array a new interface could repeat a kept interface's MAC — one stored upper-case, the other generated lower-case (review R77).
- **`normaliseRipConfig`, `normaliseStaticRoutes`** — router routing config.

### Whole-config normalisers
- **`normaliseDeviceConfig(device)`** — dispatches by device type to produce a clean `config`.
- **`normaliseConfig(parsed)`** — normalises a full topology (`devices` + `links`).
- **`normaliseConfigName`** — sanitises a saved-config name.

### Defaults & helpers
- **`defaultDeviceConfig(type)`** — the starting config for a newly-created device of each type.
- **`ensureConfig(device)`** — if `device.config` is missing, fills in `defaultDeviceConfig(device.type)`; idempotent (won't overwrite an existing config). Returns the config. Heavily used by the terminal mutators to avoid repeated guard boilerplate.
- **`deviceSize(type)`** — the canvas footprint (width/height) per device type.

## How it fits

`config.ts` calls the config normalisers when applying a topology (built-in or imported). `devices.ts` calls `defaultDeviceConfig`/`deviceSize` when creating devices. `terminal/` and `inspector.ts` call `ensureConfig` before mutating config. The normalisers are also the implicit schema for imported topology JSON.

## Notes

- Normalisers accept untrusted `unknown` input and always return a valid shape — they never throw on bad data, they coerce or drop it.
- `ensureConfig` is the canonical "make sure config exists" helper; prefer it over inline `device.config = device.config || defaultDeviceConfig(...)`.


## Link port numbers

A physical port carries one cable: if two links claim the same port the later claim is dropped to auto-assignment. The claim is per device **and media** — a router numbers Ethernet and serial ports separately (serial = a cable to another router), so an imported `Ethernet3` and `Serial3` both keep their pins. `fromPort`/`toPort` pass through **`normalisePortNumber`** (utils.ts): a finite positive integer within `[1, MAX_PHYSICAL_PORT]`, else the field is dropped so the link auto-assigns. Previously a bare `Number()` accepted `"Infinity"` (and any huge finite value), which sent `linkedPortsFor`'s sparse-array fill into an unbounded loop the first time the topology rendered. A **second claim on the same physical port of one device** is also dropped to auto-assign rather than silently overwriting the earlier entry in the port view.
