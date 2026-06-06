# Scenarios

A **scenario** is a guided challenge: an initial topology + config and a **goal** (a set of checks). The learner edits the network to satisfy the goal, then verifies it. Scenarios build on the topology system, the command engine, and the headless simulation runner.

## Using scenarios

- **GUI**: the **Scenarios** toolbar button (flag icon) opens a chooser. Loading a scenario resets the canvas to its initial state and shows a **goal banner** (top-left) with the objective and a checklist. Edit the network, then click **Check goal** — each check turns ✓/✗ and a "Scenario complete 🎉" message appears when all pass. The × dismisses the scenario.
- **Console / API**: `scenario list`, `scenario load <id>`, `scenario goal`, `scenario check` — available in the console panel, `window.routesim`, and scripts. `scenario check`'s `data` is the `ScenarioResult`.

> Checking the goal runs the real headless simulation, so a `ping` check populates ARP/MAC tables and the Simulation Log — useful feedback on *how* the packet flowed.

## Data model (`src/scenarios.ts`)

```ts
interface Scenario {
  id: string;
  name: string;
  objective: string;          // shown in the banner
  topology: any;              // { version, devices, links } — same shape as built-in topologies
  checks: ScenarioCheck[];    // the goal
}

type ScenarioCheck =
  | { kind: "link";   a: string; b: string; label: string }                 // a non-hidden link exists between a and b
  | { kind: "config"; device: string; field: string; equals: unknown; label: string }  // device.config[field] === equals
  | { kind: "ping";   from: string; to: string; label: string }             // a ping from→to succeeds (headless)
  | { kind: "dhcp";   host: string; label: string };                        // a DHCP request from host succeeds (headless)
```

Device references in checks/topology resolve by **name or id**. `checkScenario(scenario)` returns `{ id, name, passed, checks: [{ label, passed }] }` — `passed` is true when every check passes.

- `loadScenario(id)` → `applyConfig(normaliseConfig(topology))` + sets `state.activeScenarioId` + refreshes the banner. Loading a plain topology or clearing the network drops the active scenario.
- `ping`/`dhcp` checks reuse `buildPingEvents`/`buildDhcpEvents` (simulation.ts) + `runSimulationHeadless` (engine.ts).

## Adding a scenario

Append a `Scenario` to the `SCENARIOS` array in `src/scenarios.ts`:

```ts
{
  id: "my-scenario",
  name: "My Scenario",
  objective: "Do the thing.",
  topology: { version: 1, devices: [ /* {id,type,name,x,y,config} */ ], links: [ /* {from,to} */ ] },
  checks: [
    { kind: "link", a: "PC-A", b: "Switch-1", label: "PC-A linked to Switch-1" },
    { kind: "ping", from: "PC-A", to: "PC-B", label: "PC-A can ping PC-B" },
  ],
}
```

It automatically appears in the chooser, the console (`scenario list/load`), and is checkable. Use distinct device ids (e.g. a per-scenario prefix) to avoid clashes. Give intermediate `link`/`config` checks before the final `ping` so the learner gets step-by-step feedback.

## Built-in scenarios

| id | Name | Goal |
|----|------|------|
| `connect-lan` | Connect a LAN | Link PC-A and PC-B to Switch-1 (both pre-addressed in `192.168.1.0/24`), then ping PC-B from PC-A. |
