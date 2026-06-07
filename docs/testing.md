# Testing

Tests run on **Bun's** native test runner — no extra dependencies. The source is TypeScript and Bun executes it directly (no esbuild step), so tests exercise the real modules.

## Commands

```bash
bun test                          # all tests
bun test tests/engine.test.ts     # one file
bun test -t "processAtRouter"     # by name pattern
bun test tests/bench.test.ts      # the benchmark suite (see benchmarking.md)
```

There is also a browser UI for running tests, served by `test-server.ts`:

```bash
bun test-server.ts                # then open http://localhost:8767/test.html
```

`test.html` lists each file and `describe` block and runs them on click via the server's API:

- `GET /api/tests` — lists test files and their `describe` blocks (parsed from source).
- `GET /api/run?file=<f>&pattern=<p>` — runs `bun test` with optional file/pattern filters and returns `{ ok, output, code }` (ANSI-stripped).

## Infrastructure

| File | Purpose |
|------|---------|
| `bunfig.toml` | Registers `tests/preload.ts` as a preload for every test |
| `tests/preload.ts` | Stubs browser globals (`document`, `window`, `requestAnimationFrame`) and mocks `dom.ts` so importing DOM-touching modules doesn't crash |
| `tests/helpers.ts` | `registerNoopCallbacks()` and `resetState()` |
| `tests/fixtures.ts` | Reusable topologies: `basicTopology`, `routedTopology`, `vlanTopology`, `trunkTopology` |

### DOM mocking (`preload.ts`)

The app reads `document.getElementById` at module load (`dom.ts`) and draws to a canvas. `preload.ts` provides a minimal element stub and a `dom.ts` mock (a `Proxy` returning the stub for any property). Consequences worth knowing when writing tests:

- `getComputedStyle().getPropertyValue()` returns `""`, so `cssColor` resolves to empty strings — colour output isn't meaningfully testable.
- `dom.ctx` is `null`; `canvas.render()` early-returns on a null context, so calling `setTool` (which renders) is safe in tests.
- `requestAnimationFrame(cb)` calls `cb(0)` **synchronously**. This means **`startSimulation` must not be invoked in unit tests** — its rAF animation loop would recurse infinitely. Test the engine by calling `processAtComputer`/`processAtSwitch`/`processAtRouter` directly, and test terminal `ping`/`dhcp` via their validation-error paths.

### `resetState()` and `registerNoopCallbacks()`

Call `registerNoopCallbacks()` once in a top-level `beforeAll` (so `sync().render()` etc. are no-ops), and `resetState()` in `beforeEach` for isolation. `resetState` clears devices/links/selection/undo and resets `state.simulation` and `state.terminal` to baselines.

## Testing style

The standard pattern: load a fixture into `state`, call the function, assert on `state` / `device.config` / `state.terminal.lines`.

```ts
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { setSwitchPortVlan } from "../src/terminal";
import { registerNoopCallbacks, resetState } from "./helpers";
import { vlanTopology } from "./fixtures";

beforeAll(() => registerNoopCallbacks());

describe("setSwitchPortVlan", () => {
  beforeEach(() => resetState());
  it("assigns a port to a VLAN", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw")!;
    setSwitchPortVlan(sw, "Ethernet4", "20");
    expect(sw.config.portVlans!.Ethernet4).toBe(20);
  });
});
```

> **Fixture ordering matters.** `linkedPortsFor()` derives port numbers from the order links appear in `state.links` — the first link to a switch is `Ethernet1`, the second `Ethernet2`, etc. The fixtures arrange links intentionally; preserve that order.

## Coverage map

| Test file | Covers |
|-----------|--------|
| `tests/engine.test.ts` | `processAtComputer/Switch/Router`, routing, sub-interfaces, self-destined frames |
| `tests/terminal.test.ts` | Terminal display + mutator helpers (host/router/switch, VLAN, trunk) |
| `tests/terminal-commands.test.ts` | The command **dispatchers** + router mode state machine |
| `tests/simulation.test.ts` | `l2Reachable`, `getVlanForDevice`, `buildPing/DhcpEvents` |
| `tests/frame.test.ts` | Frame factories, `frameLabel`/`frameColor` |
| `tests/normalise.test.ts` | All normalisers, `ensureConfig`, `defaultDeviceConfig`, `deviceSize` |
| `tests/devices.test.ts` | CRUD, hit-testing, lookup indexes + invalidation |
| `tests/inspector.test.ts` | `renderSwitchPorts` / `renderSwitchVlans` HTML |
| `tests/config.test.ts` | `readEmbeddedConfigStore` |
| `tests/ui.test.ts` | `handleGlobalKeydown` (Escape + tool shortcuts) |
| `tests/utils.test.ts` | Pure helpers |

When you change behaviour, extend or add a `tests/*.test.ts` suite. When you add a hot path, add a benchmark too — see [benchmarking.md](benchmarking.md).
