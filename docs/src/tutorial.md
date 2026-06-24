# `src/tutorial.ts` — Tutorial mode (faux cursor)

An auto-playing, hands-off demo. A faux cursor glides over the real UI — ribbon tools, then canvas positions — and on each "click" fires the **real** action through the console command engine, so what the learner watches is exactly what they would build by hand. A caption explains each step; a control bar offers **pause / skip / replay / exit** (Esc also exits). Launched from the **Tutorial** button on the Help ribbon tab.

## How it drives the UI

Every action runs through `runConsoleCommand` (the same verbs the command console exposes) rather than importing `ui.ts` — `commands.ts` already owns `setTool`/`setTheme`, so routing through it keeps `tutorial.ts` free of import cycles. The launch + control wiring lives in [app.ts](app.md) (`setupTutorial`), so `ui.ts` never imports `tutorial.ts`.

The cursor is purely visual: it moves to a target's viewport position, plays a click pulse, and then the underlying console command does the actual work (place a device, cable two together, set an address, ping). Targets come from two helpers — `elPoint(selector)` for a ribbon button's `getBoundingClientRect`, and `worldPoint`/`devicePoint` which map a world coordinate (or a placed device's position) to the screen via `worldToScreen` ([canvas.ts](canvas.md)) plus the canvas rect offset.

## The demo

Builds **two LANs joined by a router** and pings across it: place R1 / SW1 / SW2 / PC-A / PC-B, cable them, give R1 an address on each LAN (the two gateways), configure each PC's IP + default gateway, then run an animated `ping PC-A PC-B` so the ARP/ICMP frames hop through the router. `startTutorial` pins a stable, centred view (and closes the bottom dock) so the world coordinates land on screen and the cursor maths stay valid for the whole run; the topology is placed in the upper canvas area so the caption bar and the (transient) dock never cover it.

## Player

A small async player walks the `Step[]` (`buildSteps()`): for each step it sets the caption, glides the cursor to `step.point()` (lazy, so it can read positions of devices placed by earlier steps), pulses, fires `step.action()`, and dwells. A `runToken` is bumped on skip/replay/exit to abort the in-flight run; `pause` is honoured at step boundaries via a resume gate; `waitForSim` polls `state.simulation.status` so the run waits out the animated ping before the outro. A full-screen transparent **catcher** swallows stray clicks while the demo plays (the control bar sits above it).

## Exports

- **`startTutorial()`** — clear, pin the view, and play from the top.
- **`setupTutorial()`** — wire the launch button + control bar (called once from app.ts).
- **`buildSteps()`** / **`Step`** — the step script, exported so `tests/tutorial.test.ts` can run the actions headlessly and assert the demo still builds a routable topology that pings across the gateway.

## How it fits

The tutorial reads `state` and drives `runConsoleCommand` + `closeDock` + `render`; it owns its overlay (`#tutorialLayer` in `template.html`) and styles (`.tutorial-*` in `styles.css`). It adds no simulation behaviour of its own — it's a thin presentation layer over the existing build/configure/simulate commands.
