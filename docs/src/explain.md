# explain.ts — "Why?"

The *Explain, don't just show* principle, made mechanical: turn what the engine
already records into an explanation a learner can read. It composes; it never
simulates.

## What the engine records

Every decision a device makes is already a plain-language log line (`logStep`).
For an **animated** run the engine also tags each captured frame as the run
goes (`tagExplanation` in `engine.ts`, called once per step):

| Field on `CaptureEntry` | What it holds |
|---|---|
| `why` | What the **sender** logged while deciding to send this frame |
| `outcome` | What the **receiver** logged while handling it |
| `cause` | The capture number of the frame whose arrival made the sender act |

The lines a device logs while handling one frame are both that frame's
`outcome` and the `why` of every frame it sends in response, and the handled
frame's row number is their `cause`. The data rides on the transit
(`ActiveTransit.why` / `cause`) and is copied onto the row when the frame lands,
so it is kept with the entry — a **saved capture explains itself** too.

The frames a command itself puts on the wire (the run's opening frames) are
built before any device has processed anything, so no log line covers them.
`originReason(frame, waiting)` says what the origin was doing, in the voice of
a log line — "No ARP entry for 10.0.1.1, so it must learn that MAC address
before it can send its ICMP Echo (ping) — broadcasting an ARP request" — and
`startSimulation` attaches it to the seeded first leg.

Headless runs keep no capture, so none of this runs on their hot path.

## Composing it

- **`explainCapture(entry, entries, nameOf)`** → `Explanation`: follows `cause`
  back through the capture to the frame the command sent, oldest first, ending
  at the frame asked about, plus that frame's `outcome` at its receiver. Stops
  at a cause that has scrolled out of the 1000-row capture, at a cycle, and at
  `CHAIN_LIMIT` hops (the oldest are dropped and `truncated` is set). MAC-learning
  bookkeeping (`sim-learn`) is left out of a reason unless it is all the device
  said. `entry` may be a `CaptureEntry` or an `ActiveTransit` (a dot still in
  flight, which has no row number yet).
- **`explanationSummary(explanation)`** → the answer in a sentence or two, shown above the chain: what set the frame off ("R1 sent this in response to packet #5 (ARP 10.0.2.10 is at …)"), how far back the chain goes ("It traces back 5 packets to #1, where PC-A began"), and how the frame ended ("PC-B then: …", or "It stopped at R1: No route to …" — a drop leads). The chain beneath it is the evidence.
- **`explanationText(explanation)`** → the plain lines the console prints: the summary, then the chain.
- **`explainFailedRun(result)`** → why a **headless** run failed, from its own
  log: the `sim-drop` lines in the order they happened (the first is usually the
  cause, later ones its consequences), then the post-mortem's diagnosis,
  de-duplicated and capped at four. Empty for a success.

## Where it shows

- **Frame inspector** — `renderWhy(frame)` (`inspector.ts`) adds a **Why?**
  section under the field table: the chain as an ordered list, each earlier
  packet a button that jumps to it (the same selection a row click makes), the
  current frame marked, then "Then, at <receiver>:" with what happened to it. A
  drop line carries a `✕` as well as its colour. It works for a packet-list row
  of the live run or a saved one, and for a dot clicked in flight ("Still on its
  way to …").
- **Console** — `why <packet no>` prints the chain for a packet in the capture
  the Sim Log is showing; `why` alone explains the packet being inspected.
- **Scenario checks** — `CheckResult.why` (`scenarios.ts`): the check evaluator
  records why a check failed — a builder's refusal ("Network is unreachable
  (…)"), `explainFailedRun` over the headless run, or a direct statement for
  checks that run nothing (a missing cable, a field's actual value, a status
  code, a sensor that raised nothing, a Discover nobody served). The goal banner
  lists the reasons under the failed check ("Why: …") and `scenario check`
  prints them as `why:` lines. An isolation check that fails because the flow
  got through says so.

## Tests

`tests/explain.test.ts`: the composition (chain order, truncation, cycle and
missing-cause guards, in-flight frames, the bookkeeping filter), `originReason`,
`explainFailedRun`; an animated routed ping with cold ARP caches whose echo
reply reads back to the first ARP request; `why`; the frame panel's markup; a
drop filed as the dropped frame's outcome; and — over **every built-in
scenario** — that each check failing at the start carries a reason and a
passing one carries none.
