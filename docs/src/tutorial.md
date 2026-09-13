# `src/tutorial.ts` — Tutorial mode (faux cursor)

An auto-playing, hands-off demo. A faux cursor glides over the real UI — ribbon tools, then canvas positions — and on each "click" fires the **real** action through the console command engine, so what the learner watches is exactly what they would build by hand. A caption explains each step; a control bar offers **back / pause / forward / replay / exit** (Esc exits, the arrow keys step). Launched from the **Tutorial** button on the Help ribbon tab — which is why the player forces the **Main ribbon tab active** for the run: an inactive `.ribbon-panel` is `display:none`, so the tool buttons would have an all-zero `getBoundingClientRect()` and the cursor would streak to the top-left corner.

## How it drives the UI

Every action runs through `runConsoleCommand` (the same verbs the command console exposes) rather than importing `ui.ts` — `commands.ts` already owns `setTool`/`setTheme`, so routing through it keeps `tutorial.ts` free of import cycles. The launch + control wiring lives in [app.ts](app.md) (`setupTutorial`), so `ui.ts` never imports `tutorial.ts`.

The cursor is purely visual: it moves to a target's viewport position, plays a click pulse, and then the underlying action does the actual work (place a device, cable two together, set an address, ping). Targets come from a few helpers — `elPoint(selector)` for a ribbon button / inspector field / the terminal input (it returns `null` for a missing or zero-rect element so the cursor stays put), `fieldPoint(id)` (= `elPoint('#id')`), and `worldPoint`/`devicePoint` which map a world coordinate (or a placed device's position) to the screen via `worldToScreen` ([canvas.ts](canvas.md)) plus the canvas rect offset.

## The demo

Builds **two LANs joined by a router** and pings across it: place R1 / SW1 / SW2 / PC-A / PC-B, cable them, then configure and test **through the real UI**. The addressing steps `inspect()` a device (`select` + `setNetworkPanel(true)` + `syncPanel`, so the inspector opens) and point the cursor at the IP/gateway field while the console command sets the value — `syncPanel` then shows the field fill. The finale `openTerminalFor` PC-A (the dock terminal) and runs the animated ping via `runTerminalCommand("ping PC-B")`, so the ARP/ICMP frames hop through the router. `startTutorial` pins a stable, centred view (and closes the bottom dock) so the world coordinates land on screen and the cursor maths stay valid for the whole run; the topology is placed in the upper canvas area so the caption bar, the inspector (on the right), and the terminal dock never cover the devices.

## Player

A small async player walks the `Step[]` (`buildSteps()`): for each step it sets the caption, glides the cursor to `step.point()` (lazy, so it can read positions of devices placed by earlier steps), pulses, fires `step.action()`, dwells, and then **gates** (so `stepIndex` tracks the last *completed* step, and pausing halts after a step). A `runToken` is bumped (via `abortRun`, which also releases the resume gate) on any back/forward/replay/exit to abort the in-flight run; `waitForSim` polls `state.simulation.status` so the run waits out the animated ping before the outro. **Back/forward** call `goToStep(target)`: it aborts, replays every action `0..target` instantly to **rebuild the topology deterministically** (so Back drops the undone step, Forward applies the next), repositions the cursor (instantly), and leaves the run paused — resume continues auto-play from `stepIndex + 1`. A full-screen transparent **catcher** swallows stray clicks while the demo plays (the control bar sits above it).

## Exports

- **`startTutorial()`** — clear, pin the view, and play from the top.
- **`setupTutorial()`** — wire the launch button + control bar (called once from app.ts).
- **`buildSteps()`** / **`Step`** — the step script, exported so `tests/tutorial.test.ts` can run the actions headlessly and assert the demo still builds a routable topology that pings across the gateway.

## How it fits

The tutorial reads `state` and drives `runConsoleCommand` + `closeDock` + `render`; it owns its overlay (`#tutorialLayer` in `template.html`) and styles (`.tutorial-*` in `styles.css`). It adds no simulation behaviour of its own — it's a thin presentation layer over the existing build/configure/simulate commands.


## One undo point

`startTutorial` takes one undo snapshot before it clears the canvas and then runs the whole demo — including every Back/Forward rebuild — under `isApplyingCompositeChange`, so nothing the tutorial does pushes an entry of its own; `exitTutorial` clears the flag. A single Undo after exiting restores whatever the learner had built. Previously the launch pushed ~20 entries and each rebuild another ~20, so three Back/Forward presses left the original 64 undos away and the fourth pushed it off the 80-entry cap.
