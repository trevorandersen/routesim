# autosave.ts — the network survives a refresh

The network on the canvas is kept in this browser's `localStorage` and brought
back on the next visit, so a refresh or a closed tab does not lose the work.
On by default; opt out in **Settings → This browser → Autosave**.

It is storage, not network: the page still makes no request and nothing leaves
the machine (the zero-request principle is about the network). To hand a
network to someone else, use File → Copy link ([share-link.md](share-link.md))
or File → Export.

## What is kept

One record under `routesim.autosave`:

```json
{ "v": 1, "savedAt": "<ISO time>", "scenarioId": "<id>|null", "instantDns": true, "config": { …buildConfigPayload()… } }
```

`config` is exactly the topology payload a file export writes. `scenarioId` and
`instantDns` are the two things a load changes along with the network — the
same pair the undo snapshot carries, and the `session` a shared link carries
(`sessionContext` / `resumeSession` in scenarios.ts, one implementation for
both) — so a scenario in progress comes back with
its goal banner and its name-resolution mode. `savedAt` is only for the
"restored" message. Terminal scrollback, captures and the undo history are not
kept.

`routesim.autosave.off` holds `"1"` when the learner has opted out.

## Saving

**`saveNow(now?)`** compares the session (as text, without the timestamp) with
what was last written and writes only a difference. It returns what it did:

| Outcome | When |
|---|---|
| `saved` | The network differs from the stored copy — written. |
| `unchanged` | Nothing to do. |
| `cleared` | The canvas is back at the built-in network the page boots with, so the stored copy is removed: there is nothing to restore. |
| `skipped` | The tutorial is playing — its network is the demo's; the learner's own is in the tutorial's undo snapshot. |
| `off` | Autosave is off, or there is no store. |
| `failed` | The store refused the write (full, blocked). Said **once** on the status line, with the remedy (File → Export → Config), not every poll. |

`startAutosave()` calls it from a slow poll (`AUTOSAVE_INTERVAL_MS`, 3 s) and
flushes on `pagehide` and when the page becomes hidden, so the last few seconds
of work are not left waiting for a poll that never comes. A poll rather than a
hook in every mutator: there are four front doors and dozens of mutators, and
one comparison every few seconds cannot miss any of them. No timers are started
when there is no store.

## Restoring

`initialiseApp` (app.ts) loads the built-in network, calls **`initAutosave`**
(which notes that network as the baseline and reads the stored preference),
then **`restoreAutosave`**. A stored session goes through `parseConfig` like any
file, is applied **without an undo point** (it is where the visit starts, not an
edit), and the status line says `Restored your last session (N devices, saved
at 14:02). File → Topologies loads a fresh network.` A scenario id this page
does not know (an imported scenario) restores as a plain network.

A stored session that cannot be read — damaged, or written by a version this
one cannot parse — is **discarded with a reason** (`The autosaved session could
not be read, so it was discarded.`) and the page opens on the built-in network.

**A shared link beats the restore.** When the address bar carries `#net=…`, the
link's network is opened *over* the restored session as one undo point: the
link wins, and one Undo returns to the learner's own work. The canvas is what
gets saved, so the link's network then replaces the stored copy.

## The preference

- **`setAutosave(on)`** — the Settings switch (wired in `startAutosave`). Off
  removes the stored session and remembers the choice; on remembers that and
  saves straight away. Each says what it did on the status line; with no store
  it says autosave is unavailable and why.
- **`?autosave=0`** (or `1`) in the page's query holds **for that visit only**:
  no restore, no saving, and neither the stored session nor the stored
  preference is touched — a lab bookmark that always starts fresh and leaves no
  trace. It is *parsed* by `settings-url.ts` but never *emitted* by
  `buildSettingsQuery`: a shared link must not carry the sender's choice about
  their own browser to whoever opens it.

## Storage is not guaranteed

`localStorage` can be missing (a private window), blocked (site data off), or
full, and reading the property can itself throw. Every access is guarded, the
page works identically without it, and the store is injectable
(`initAutosave({ store })`, a `KeyValueStore`) so the tests run every path
against one that misbehaves.

Two tabs on the same page share one stored copy: the last to write wins.

## Tests

`tests/autosave.test.ts`: the built-in network is not kept and a change is;
only differences are written; returning to the built-in network clears the
copy; the tutorial is skipped; a refused write is reported once; a visit
restores the network (and an emptied canvas, and a scenario with its goal and
Instant DNS, with the URL's Instant DNS winning); an unknown scenario restores
as a plain network; unreadable records are discarded with a reason; the opt-out
removes and remembers; `?autosave=0` touches nothing; the choice never rides in
a shared link; a missing store and one that throws on every access; and a link
opened over a restored session.
