# RouteSim

A portable, single-file network topology simulator. Build a network of PCs, switches, and routers on an interactive canvas, then open device terminals to run CLI commands like `ping`, `arp -n`, and `show ip interface brief`. The simulator models L2/L3 reachability with VLAN enforcement, ARP/MAC learning, and subnet-aware routing.

The entire app ships as one self-contained `index.html` — no server, no runtime dependencies, just open the file in a browser.

## Quick start

```bash
# Build (requires esbuild + python3, no npm)
./build.sh            # dev build  (~133 KB)
./build.sh --minify   # prod build (~88 KB)

# Preview
open index.html
# or serve locally:
python3 -m http.server 8765
```

### Prerequisites

- **esbuild** — `brew install esbuild` (standalone binary, no Node.js required)
- **python3** — used by the build script for template assembly

## Project structure

```
routesim/
├── build.sh            # Build script: esbuild bundle + python3 template assembly
├── tsconfig.json       # TypeScript config (strict, ES2022, no emit)
├── template.html       # HTML shell with {{STYLES}} and {{SCRIPT}} placeholders
├── styles.css          # All CSS (~940 lines, dark/light theme via custom properties)
├── config.json         # Default sample topology (loaded on first visit)
├── index.html          # Build output — the single portable file
├── index.backup.html   # Backup of original pre-refactor version
├── IMPROVEMENTS.md     # Notes on improvements made during refactor
└── src/
    ├── app.ts          # Entry point — wires callbacks, initializes the app
    ├── types.ts        # Interfaces and type definitions
    ├── dom.ts          # Typed references to DOM elements
    ├── utils.ts        # Pure utility functions (IP validation, MAC formatting)
    ├── normalize.ts    # Data normalization (ARP tables, MAC tables, VLANs, configs)
    ├── state.ts        # Global state singleton, undo system, callback registry
    ├── devices.ts      # Device/link CRUD, LAN collapse/expand
    ├── simulation.ts   # Ping simulation, L2 reachability, ARP/MAC learning
    ├── terminal.ts     # CLI emulation (Linux-style, IOS-style, switch CLI)
    ├── canvas.ts       # Canvas rendering (devices, links, labels, pan/zoom)
    ├── inspector.ts    # Right-side panel (device details, metrics, options)
    ├── config.ts       # Config persistence via File System Access API
    └── ui.ts           # Event handlers, toolbar, keyboard shortcuts
```

## How the build works

The build avoids Node.js entirely:

1. **esbuild** bundles all TypeScript modules in `src/` into a single IIFE (`.bundle.js`)
2. **python3** reads `template.html`, injects the CSS from `styles.css` and the JS bundle, and writes `index.html`
3. The temporary `.bundle.js` is deleted

The result is a single HTML file with everything inlined — styles in a `<style>` tag, script in a `<script>` tag.

## Module architecture

Modules are organized to keep concerns separate while producing a flat IIFE bundle:

| Module | Responsibility |
|---|---|
| `types.ts` | Shared interfaces (`Device`, `Link`, `AppState`, etc.) |
| `dom.ts` | Cached `getElementById` references, typed |
| `utils.ts` | Pure functions — IP/MAC validation, subnet math |
| `normalize.ts` | Sanitize and normalize device configs, ARP/MAC/VLAN tables |
| `state.ts` | The single `state` object, undo stack, and a **callback registry** for breaking circular deps |
| `devices.ts` | Add/remove/move devices and links, LAN group logic |
| `simulation.ts` | `pingFromHost`, L2 BFS reachability, VLAN checks, ARP/MAC learning |
| `terminal.ts` | Per-device-type CLI emulation (PC: Linux commands, Router: IOS-style, Switch: basic CLI) |
| `canvas.ts` | `<canvas>` rendering loop — device icons, link lines, labels, selection highlight, grid |
| `inspector.ts` | Right panel DOM — device details, interface tables, MAC/ARP table views |
| `config.ts` | Save/load topologies via the File System Access API, config store management |
| `ui.ts` | Mouse/keyboard event wiring, tool switching, drag, zoom, undo shortcuts |
| `app.ts` | Boots everything — registers cross-module callbacks, loads config, starts render loop |

### Circular dependency pattern

Several modules need to call each other (e.g., `terminal` needs `simulation.pingFromHost`, `simulation` needs `inspector.syncPanel`). Instead of circular imports, `state.ts` exposes a **callback registry**:

```typescript
// state.ts
const callbacks = { syncPanel: () => {}, redraw: () => {}, ... };
export function registerCallbacks(cbs) { Object.assign(callbacks, cbs); }
export function sync() { return callbacks; }

// app.ts — wires everything at startup
registerCallbacks({ syncPanel: buildInspector, redraw: draw, ... });

// simulation.ts — calls without importing inspector
sync().syncPanel();
```

## Features

- **Canvas editor** — pan, zoom, drag devices, auto-grid snapping
- **Device types** — computers, switches (managed/unmanaged), routers
- **Connections** — click-to-connect tool with link visualization
- **PC terminal** — `ip addr`, `ip route`, `ping`, `arp -n`, `clear`
- **Router terminal** — `show ip interface brief`, `show arp`, interface configuration
- **Switch terminal** — `show mac-address-table`, managed VLAN support
- **Subnet-aware ping** — same-subnet uses L2 BFS; cross-subnet routes through a gateway router
- **VLAN enforcement** — managed switches enforce VLAN membership on L2 paths
- **ARP/MAC learning** — ping populates ARP tables on hosts and routers, MAC tables on switches
- **Undo** — single-level undo for topology and config changes
- **Persistence** — save/load topologies to JSON files via File System Access API
- **Dark/light theme** — toggle via toolbar, implemented with CSS custom properties
- **LAN grouping** — collapse multiple devices into a LAN cloud
