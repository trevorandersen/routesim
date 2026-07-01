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
| `tests/engine.test.ts` | `processAtComputer/Switch/Router`, routing, sub-interfaces, traceroute, headless runs; RIP learned routes as **derived state** (cleared + recomputed each convergence — a removed link takes its route with it; excluded from the config payload) |
| `tests/firewall.test.ts` | Firewall rule matching/evaluation, the iptables CLI, filtering in the sim |
| `tests/firewall-stateful.test.ts` | The stateful firewall (inline PC1—FW1—SW1—PC2, headless flows): connection tracking (`-m state`/`--ctstate`) and REJECT — an ESTABLISHED,RELATED rule lets the reply back without an inbound rule (allowing only the outbound isn't enough — the reply drops), an outside-initiated NEW is blocked while the inside host still reaches out, `connectionState` classifies the echo NEW and its reply ESTABLISHED, REJECT `--reject-with tcp-reset` refuses a TCP connect with a RST (vs DROP timing out), and the `states`/`--reject-with` JSON config round-trip |
| `tests/router-role.test.ts` | Router roles: the `border-router` tool variant (a `router` flagged `role:"border"` with a `Border-N` name; the plain `router` tool has no role), the `role <router> border\|internal` console command (set/clear, non-router/bad-value rejection), the JSON config + script-export round-trips, and the normalise keep-valid/drop-bogus rule |
| `tests/internet.test.ts` | The Internet cloud (`type: "internet"`) as an **L3 transit**: placement/normalise (ports only, no MAC table), the L3-boundary semantics (it does **not** bridge two hosts onto one segment), routing between two routers on **different** public subnets with an auto-provided default route + cloud gateway, the RIP **default origination** (a router two hops from the edge learns a way out; dual-edge topologies stay symmetric — each edge originates, neither learns the other's default), the ICMP **Time-Exceeded** on TTL expiry (the cloud is a real traceroute hop — even from behind NAT, via the embedded-original restore), dropping unroutable destinations, the JSON config round-trip, and the multi-site capstone (a private host behind R1's NAT reaching WEB published by R2's port-forward, across the cloud → HTTP 200) |
| `tests/nat.test.ts` | NAT/PAT: translation table, return-path restore, **ICMP-error restore** (a Time-Exceeded from beyond the edge is matched on its embedded original datagram and delivered inside, quoted header rewritten; an error naming no known flow stays router-destined), **DNAT / port-forwarding** (a published outside IP:port reaches an inside web server with 200, fails without the rule, the `ip nat inside source static tcp` CLI add/remove, config round-trip), router netfilter INPUT/FORWARD chains |
| `tests/tcp.test.ts` | The TCP three-way handshake, the `openPorts` listener model, RST refusal, port filtering |
| `tests/http.test.ts` | The HTTP service (the GET/200 over the handshake): a 200 from a web-enabled server, the connected-but-no-service path (open port, `httpEnabled` off → no reply), the closed-port RST, an unreachable host, by-name resolution (instant DNS and a real query → `then:"http"`), `parseHttpTarget` (host/port/path + URL), the `packetColumns` HTTP rows, and the `web` command + httpEnabled/title config + script round-trips |
| `tests/dns.test.ts` | DNS + the server device: A-records, resolv/dnsmasq conf handling, resolve-then-act flows, server DHCP, the **device-hostname auto-zone** (a server resolves any device name with no manual record) and the **Instant DNS setting** (instant name→IP match vs. requiring a real query; on for topologies, off for scenarios) |
| `tests/prefix.test.ts` | Real subnet prefixes: longest-prefix behaviour and the display/export surfaces |
| `tests/capture.test.ts` | The packet list: `packetColumns` mapping (incl. 802.11/EAPOL) + per-wire capture recording (cap, headless preservation), and the silent-protocol toggles (an ARP/DHCP/DNS frame resolves but is kept out of the capture) |
| `tests/packet-filter.test.ts` | The packet-list display filter (`src/packet-filter.ts`): the protocol-token classifier (incl. `udp`/`eapol`/`dot1x`/`wlan`/`macsec` family edges), `presentTokens`, the expression grammar (`compileFilter` — boolean precedence, parens, `ip.addr` exact/CIDR, `tcp.port` numeric comparators, `eth.addr`/`device` strings, `!=` field-presence, parse errors incl. a relational op on a string field, the non-throwing backstop), and the three-dimension `applyLogFilter` combinator + `isFilterActive` |
| `tests/captures.test.ts` | Multi-run capture history: a finished animated run archived to `state.savedCaptures` (label + ✓/✗ outcome, monotonic index/id), the 12-entry ring, the `captureView` pointer (set on save, reset to live on a new run, falls back to the latest saved on stop), `captureEntriesFor` (live/saved/unknown), and the topology-load reset |
| `tests/dock.test.ts` | The bottom dock: terminal sessions/tabs, console `cli` session sharing, configure-opens-terminal |
| `tests/links.test.ts` | Link naming (derived default + override), link deletion, the single-NIC host guard, admin status (shut blocks traffic; `shut`/`noshut`; round-trip), bandwidth/latency/loss round-trip, and the headless loss note (loss is animated-only; a headless run logs one note per lossy link crossed) |
| `tests/firstboot.test.ts` | Network boot: cabling/power no longer auto-configures; Play (`startNetworkBoot`) boots unconfigured hosts via animated DHCP → APIPA (rAF-stub harness); the global Auto-DHCP / APIPA toggles |
| `tests/terminal.test.ts` | Terminal display + mutator helpers (host/router/switch, VLAN, trunk) |
| `tests/terminal-commands.test.ts` | The command **dispatchers**, router mode machine, abbreviation + `?`, the host inspector-set commands (`ip link set`/`ip route del`/`rm resolv.conf`), `runDeviceCommand` (injected), and the **hostname** commands (host `hostname`/`hostnamectl`/`/etc/hostname`, router `hostname` in config mode, switch `config hostname` — each renames the device, with RFC-1123 validation) |
| `tests/commands.test.ts` | The console command engine (verbs, headless runs, script round-trip) |
| `tests/simulation.test.ts` | `l2Reachable`, `getVlanForDevice`, `buildPing/DhcpEvents` |
| `tests/scenarios.test.ts` | Scenario loading/goal checks, positive-coordinate invariants, and the **curriculum solvability** proof (every entry starts unsolved and passes after its reference solution in `SOLUTIONS`) |
| `tests/io.test.ts` | JSON import/export round-trips |
| `tests/settings-url.test.ts` | URL query-string settings: `parseSettingsFromUrl` (bool spellings incl. the silent-protocol params, theme/speed validation + clamping, ignored params) and the `buildSettingsQuery` inverse (diff-only emit + round-trip) |
| `tests/macsec.test.ts` | MACsec (802.1AE): the per-peer CAK config, `macsecState` (secured / failed / open), the must-secure data gate, should-secure plaintext fallback, encrypted-frame capture, config round-trip, and the **802.1X-derived keying** (Phase 3 / MKA — a derive link secures only after `dot1x` authenticates, derive-vs-PSK is incompatible, JSON + script round-trip) |
| `tests/dot1x.test.ts` | 802.1X: the EAPOL/EAP ↔ RADIUS exchange across supplicant/authenticator/RADIUS-server, the port-authorization data gate (auto blocks until EAP-Success; force-authorized/unauthorized), Access-Reject → EAP-Failure, and config (supplicant/portauth/radius) JSON + script round-trip |
| `tests/wifi.test.ts` | WiFi: the laptop (WiFi-only host) + access point (single-uplink L2 bridge) device types, the wireless association (`classifyLink`/`linkBlockReason` — laptop↔AP only, single NIC, SSID + password matching), forwarding through an AP onto the wired LAN, SSID/password serialisation round-trips, and the **802.11 association handshake** (probe/auth/assoc + WPA2 4-way for a secured AP, the wrong-password failure path — link forms unauthenticated, deauth, data blocked — `run associate`, the Silent WiFi toggle) |
| `tests/stp.test.ts` | STP (802.1D): `runStpConvergence` single-root election, one blocked port on a triangle (none on a tree), cross-switch ping without storm, the broadcast storm when disabled, re-convergence on change, priority forces root, the console/CLI mutators + SONiC `show spanning_tree`, JSON + script round-trip (default switch serialises no `stp` block), and the sparse-port regression (gapped switch/router/firewall don't crash the render/routing paths) |
| `tests/ids.test.ts` | The Snort IDS + SPAN port mirroring: `parseSnortRule`/`matchSnortRule`/`runIdsRules` (header + the `msg`/`sid`/`itype`/`flags`/`content` options, non-IP frames never matching), the SPAN copy in `processAtSwitch` raising an alert at the sensor (telnet detection; no SPAN → no alert), `processAtIds` as a passive sink (alerts logged to `config.alerts`, no outgoing), the console/CLI mutators (`mirror`, `idsrule`, the `terminal/ids.ts` `local.rules`/alert-log commands), and JSON + script round-trip (switch mirror + ids `idsRules`) |
| `tests/attacker.test.ts` | The offensive hosts (**Kali PC** + **Red Team actor**) sharing one Kali attack engine: the simulated attacks and their detection — a SYN scan finding the target's open ports (the rest closed) and tripping an IDS Telnet rule via the port-23 probe (red vs blue); a ping sweep discovering live hosts; ARP-cache poisoning (gateway → attacker MAC); `buildAttackEvents` merging the enabled attacks (success flag); the console + Kali terminal flows pumped via `stepOnce` with rAF stubbed (`redteam` config setters for target/attacks/spoof, `attack` rejects a non-attacker, an end-to-end `attack <node> scan <target>` reporting open ports via the nmap report on `config.attackLog`, the Kali terminal's version/help, `nmap -sS`/`nmap -sn` launching a scan/sweep) plus the **host-shell fall-through** (`ip addr add` works) and a Kali-PC hand-issued scan; the **Kali PC vs Red Team actor** distinctions (single NIC + MAC; autonomy — `launchRedTeam` fires for the actor but not the Kali PC; the Kali PC serialises as a plain host); **cross-subnet sweep routing** (a remote-subnet sweep ARPs the gateway once; "nothing to sweep" with no gateway); and JSON config + script-export round-trips preserving attacks/target/spoof, including a non-/24 prefix regression |
| `tests/tutorial.test.ts` | Tutorial mode: running the demo's own step actions (`buildSteps`, minus the animated ping) builds the intended two-LAN + router topology that pings across the gateway |
| `tests/frame.test.ts` | Frame factories, `frameLabel`/`frameColor` |
| `tests/normalise.test.ts` | All normalisers, `ensureConfig`, `defaultDeviceConfig`, `deviceSize` |
| `tests/devices.test.ts` | CRUD, hit-testing, lookup indexes + invalidation; router interface entries are fully formed at creation with per-router deterministic MACs (two routers never share an interface MAC), and the re-cabling identity invariant (names are positional and renumber; peer-keyed config follows the peer) |
| `tests/inspector.test.ts` | `renderSwitchPorts` / `renderSwitchVlans` HTML |
| `tests/ui.test.ts` | `handleGlobalKeydown` (Escape + tool shortcuts), theme registry |
| `tests/parity.test.ts` | Theme CSS-var parity; ribbon `data-action`/tool/theme-button ↔ code parity |
| `tests/utils.test.ts` | Pure helpers |
| `tests/bench.test.ts` | Hot-path benchmarks with p99 budgets |

When you change behaviour, extend or add a `tests/*.test.ts` suite. When you add a hot path, add a benchmark too — see [benchmarking.md](benchmarking.md).
