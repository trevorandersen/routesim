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
- `requestAnimationFrame(cb)` calls `cb(0)` **synchronously**, so **`startSimulation` must not run against the stub as-is** — its rAF animation loop would recurse. Two sanctioned patterns:
  - **Default:** test the engine by calling `processAtComputer`/`processAtSwitch`/`processAtRouter` directly, or via `runSimulationHeadless`/`runTraceroute`; test terminal `ping`/`dhcp` via their validation-error paths.
  - **Animated behaviour** (the packet capture, dock auto-open): replace rAF with a no-op (`(globalThis as any).requestAnimationFrame = () => 0` in `beforeEach`, restored in `afterEach`) and pump the loop manually — `startSimulation(...)` then `while (state.simulation.status !== "done") stepOnce()`. See `tests/capture.test.ts`.

### `resetState()` and `registerNoopCallbacks()`

Call `registerNoopCallbacks()` once in a top-level `beforeAll` (so `sync().render()` etc. are no-ops), and `resetState()` in `beforeEach` for isolation. `resetState` clears devices/links/selection/undo and resets the `simulation`, terminal session/dock, and `console` sub-states to baselines. Tests that register **device** callbacks for real (e.g. `openTerminal` in `dock.test.ts`) must clear them in `afterAll` — bun shares module state across test files.

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
| `tests/engine.test.ts` | `processAtComputer/Switch/Router`, routing, sub-interfaces, traceroute, headless runs |
| `tests/firewall.test.ts` | Firewall rule matching/evaluation, the iptables CLI, filtering in the sim |
| `tests/nat.test.ts` | NAT/PAT: translation table, return-path restore, router netfilter INPUT/FORWARD chains |
| `tests/tcp.test.ts` | The TCP three-way handshake, the `openPorts` listener model, RST refusal, port filtering |
| `tests/dns.test.ts` | DNS + the server device: A-records, resolv/dnsmasq conf handling, resolve-then-act flows, server DHCP |
| `tests/prefix.test.ts` | Real subnet prefixes: longest-prefix behaviour and the display/export surfaces |
| `tests/capture.test.ts` | The packet list: `packetColumns` mapping (incl. 802.11/EAPOL) + per-wire capture recording (cap, headless preservation), and the silent-protocol toggles (an ARP/DHCP/DNS frame resolves but is kept out of the capture) |
| `tests/dock.test.ts` | The bottom dock: terminal sessions/tabs, console `cli` session sharing, configure-opens-terminal |
| `tests/links.test.ts` | Link naming (derived default + override), link deletion, the single-NIC host guard, admin status (shut blocks traffic; `shut`/`noshut`; round-trip), bandwidth/latency/loss round-trip |
| `tests/firstboot.test.ts` | Network boot: cabling/power no longer auto-configures; Play (`startNetworkBoot`) boots unconfigured hosts via animated DHCP → APIPA (rAF-stub harness); the global Auto-DHCP / APIPA toggles |
| `tests/terminal.test.ts` | Terminal display + mutator helpers (host/router/switch, VLAN, trunk) |
| `tests/terminal-commands.test.ts` | The command **dispatchers**, router mode machine, abbreviation + `?`, the host inspector-set commands (`ip link set`/`ip route del`/`rm resolv.conf`), and `runDeviceCommand` (injected) |
| `tests/commands.test.ts` | The console command engine (verbs, headless runs, script round-trip) |
| `tests/simulation.test.ts` | `l2Reachable`, `getVlanForDevice`, `buildPing/DhcpEvents` |
| `tests/scenarios.test.ts` | Scenario loading/goal checks + positive-coordinate invariants |
| `tests/io.test.ts` | JSON import/export round-trips |
| `tests/settings-url.test.ts` | URL query-string settings: `parseSettingsFromUrl` (bool spellings incl. the silent-protocol params, theme/speed validation + clamping, ignored params) and the `buildSettingsQuery` inverse (diff-only emit + round-trip) |
| `tests/macsec.test.ts` | MACsec (802.1AE): the per-peer CAK config, `macsecState` (secured / failed / open), the must-secure data gate, should-secure plaintext fallback, encrypted-frame capture, config round-trip, and the **802.1X-derived keying** (Phase 3 / MKA — a derive link secures only after `dot1x` authenticates, derive-vs-PSK is incompatible, JSON + script round-trip) |
| `tests/dot1x.test.ts` | 802.1X: the EAPOL/EAP ↔ RADIUS exchange across supplicant/authenticator/RADIUS-server, the port-authorization data gate (auto blocks until EAP-Success; force-authorized/unauthorized), Access-Reject → EAP-Failure, and config (supplicant/portauth/radius) JSON + script round-trip |
| `tests/wifi.test.ts` | WiFi: the laptop (WiFi-only host) + access point (single-uplink L2 bridge) device types, the wireless association (`classifyLink`/`linkBlockReason` — laptop↔AP only, single NIC, SSID + password matching), forwarding through an AP onto the wired LAN, SSID/password serialisation round-trips, and the **802.11 association handshake** (probe/auth/assoc + WPA2 4-way for a secured AP, the wrong-password failure path — link forms unauthenticated, deauth, data blocked — `run associate`, the Silent WiFi toggle) |
| `tests/frame.test.ts` | Frame factories, `frameLabel`/`frameColor` |
| `tests/normalise.test.ts` | All normalisers, `ensureConfig`, `defaultDeviceConfig`, `deviceSize` |
| `tests/devices.test.ts` | CRUD, hit-testing, lookup indexes + invalidation |
| `tests/inspector.test.ts` | `renderSwitchPorts` / `renderSwitchVlans` HTML |
| `tests/ui.test.ts` | `handleGlobalKeydown` (Escape + tool shortcuts), theme registry |
| `tests/parity.test.ts` | Theme CSS-var parity; ribbon `data-action`/tool/theme-button ↔ code parity |
| `tests/utils.test.ts` | Pure helpers |
| `tests/bench.test.ts` | Hot-path benchmarks with p99 budgets |

When you change behaviour, extend or add a `tests/*.test.ts` suite. When you add a hot path, add a benchmark too — see [benchmarking.md](benchmarking.md).
