# Review of `astra_review_20260908.md`

Reviewer: Claude Fable 5.1. Reviewed against the same commit Astra reviewed, `7f00c399`, on 8 September 2026.

## Method

I did not take the findings on trust. For each of the 14 I read the cited code at the cited lines, and for the six with a cheap reproduction (F02, F04, F06, F08, F11, F13) I wrote a throwaway Bun test that executes Astra's own reproduction steps against the real modules and asserts the *defective* outcome. I also re-checked every claim in Astra's "Verification performed" table.

The scratch tests were deleted afterwards; nothing in the repository was changed by this review.

## Headline

**This is a high-quality review. All 14 findings hold.** Six reproduced exactly as described; the other eight are confirmed unambiguously by the source. I found no false positives, no mis-cited locations, and no fix recommendation I'd push back on. The verification table is byte-exact: the commit hash, the `rs-web.html` SHA-256 (`d58c1d7a…`), and the full-suite count (895 tests, 43 files, 2,848 assertions) all match what I get locally.

Astra's stated method — concentrating on *boundaries between subsystems* where component tests leave gaps — is what makes it strong. Several of these are bugs where each half is individually tested and correct, and the defect lives in the seam. I'll be candid that this review is better at that than the one I produced two days ago: I had flagged the F01 input as a LOW ("`fromPort` NaN") and stopped there; Astra followed the same value one function further into `linkedPortsFor` and found an unbounded allocation. That is the difference between noting a smell and tracing a consequence.

## Finding-by-finding

| ID | Astra | My verdict | Notes |
|---|---|---|---|
| F01 | P1 | **Confirmed** (by code) | `Number()` unbounded; `while (result.length <= idx) result.push(null)` with `idx = Infinity` never terminates. `resolvePort` accepts any integer ≥ 1 from commands too, as stated. Correctly escalated from the LOW I'd assigned it. |
| F02 | P1 | **Reproduced** | Collapsing `sw-a` hides 2 links; router payload goes from `["192.168.10.1","192.168.20.1"]` to `["192.168.20.1"]`. A presentation state leaking into persistence. |
| F03 | P1 | **Confirmed** (by code) | The export loop has branches for eight device types and **none for `firewall`**; no emission of `rip`, NAT roles, filter policy/rules, `poweredOff`, or port counts anywhere. `openPorts` emitted only when non-empty, so `[]` (the "listen on nothing" state) reverts to accept-any on replay. |
| F04 | P2 | **Reproduced** | `10.0.0.1/8` first, `10.1.0.1/16` second, lookup `10.1.2.3` → egress toward the `/8`. `RouteEntry` already carries `interface`; it is simply discarded. |
| F05 | P2 | **Confirmed** (by code) | Pool is always `a.b.c.100–254`. The in-code comment justifies this for *larger* networks ("sits inside any larger network too") and is silent on smaller ones, which is exactly where it fails. |
| F06 | P2 | **Reproduced** | PC-B gateway set to nonexistent `192.168.20.254`; PC-A → PC-B still `success: true`. See calibration note below. |
| F07 | P2 | **Confirmed** (by code) | `linkedPortsFor(...).filter(port => port)` with the comment "drop null gaps from sparse port arrays", then sequential `++ethernetIndex`. A sole link on port 4 is `Ethernet1`. |
| F08 | P2 | **Reproduced** | R2 with `networks: []` learns `192.168.1.0/24`. `ripNetworks` is consulted only in `buildRipAdvertisements` (what to send), never in the send/receive loop (whether to talk). |
| F09 | P2 | **Confirmed** (by code) | Both halves: `state.devices.find(identity)` for the password, `supplicantByIdentity` (first attached host) for authorisation. Nothing correlates by session or port. |
| F10 | P2 | **Confirmed** (by code) | `startSimulation` pushes the first-leg transit directly; loss lives only in `processNextStep`'s outgoing loop. Astra scoped this correctly to *loss* — the auth gate is not bypassed, because `findFirstHop` already applies `linkAuthorizedForData` at setup time. |
| F11 | P2 | **Reproduced** | Hub `ethernetPorts: 16` → `4` after payload round-trip. Eleven type branches in `buildConfigPayload`, zero mentions of `hub` or `internet`. |
| F12 | P2 | **Confirmed** (by code) | The sharpest catch in the set. The code's own comment says the topology is validated before registering "so a malformed scenario never poisons the global registry" — and then doesn't validate `checks`, so the precise poisoning the guard names still occurs through the adjacent field. |
| F13 | P2 | **Reproduced** | After `clearNetwork()` mid-run: status `running`, 1 transit, `diagnoseState` reports 4 issues. Same defect class as the `applyConfigWithoutUndo` teardown fix merged earlier the same day — that fix closed one door; this is the other. |
| F14 | P2 | **Confirmed** (by code) | No `hostname` (Bun defaults to all interfaces), tautological `startsWith(ROOT)`, wildcard CORS, unauthenticated `/api/run`. Credit for precision: `URL.pathname` collapses `..`, so real traversal isn't possible and Astra correctly claims none. |

## Where I'd adjust calibration

Only two nudges, neither a disagreement about the facts.

**F06 is under-prioritised for *this* project.** As a generic network-model defect P2 is right. But RouteSim's first principle in `CLAUDE.md` is "Failure is a lesson — a broken network must diagnose itself, never fail silently", and the wrong-far-side-gateway is one of the canonical lessons the tool exists to teach. The model already *intends* to teach it: the `hostHasReturnRoute` check exists and correctly fails the *empty*-gateway case. It just accepts any non-empty string, so the *wrong*-gateway case — the more common real-world mistake — passes. That makes this a half-finished intent rather than a missing feature, and I'd fix it ahead of F04/F05. A learner who sets the wrong gateway and sees the ping succeed learns something false.

**F14 could be argued down to a hardening note.** The server is a development tool, never shipped, and `rs-web.html` is unaffected. Astra's own P2 definition ("exposure limited to the development server") covers it honestly, so I won't call it wrong — but it should not compete for attention with the persistence and correctness findings. A one-line `hostname: "127.0.0.1"` default captures most of the value.

## What Astra didn't cover

For completeness against the earlier review, these are real and remain open:

- The dead egress-VLAN check in `l2Reachable` (`egressIdx` searches the switch's ports for a peer equal to *itself*, always `-1`). Deliberately left because `processAtSwitch` enforces isolation on the actual path, so the outcome is right for the wrong reason. Not a contradiction of Astra's method — it's precisely the kind of "correct by accident" case a boundary-focused review would skip.
- The empty port-picker for `firewall`/`internet`/`ids` (`buildPortList` falls through to `[]`). This is the *other* face of F07 — one is the picker mislabelling router ports, the other is it offering nothing for three types. They share a fix: one stable physical-port → interface-name mapping, used directly by the picker. I'd fold it into F07.
- `clearNetwork` also fails to clear `selectedLinkId`. Adjacent to F13; the shared-teardown fix Astra proposes would absorb it.
- Roughly a dozen LOW cleanups (a `syncSimLog` double-build, import-robustness nits). Out of scope for a defect review and correctly omitted.

## On the test-strategy recommendations

All five are sound. Two are cheaper than they may look:

- **(3) Lifecycle invariants** is nearly free now — `src/diagnostics.ts` and `diagnoseState()` landed earlier the same day, and Astra already used them to demonstrate F13. A single test that runs `diagnoseState` after clear/load/delete/undo/redo *during* an active run is perhaps thirty lines and would have caught F13 and part of F02.
- **(1) Persistence properties over every `DEVICE_TYPES` entry** has an existing template: `tests/parity.test.ts` already iterates the type registry to enforce theme-variable completeness. The same shape applied to `buildConfigPayload` round-trips would have caught F11 and would catch the next type added without a branch.

I'd add a sixth: **the export's completeness claim in `docs/scripting.md:201` should be corrected in the same commit as F03**, whichever way F03 is resolved. Right now the documentation over-promises, and Astra is right that a backup format which silently drops a DROP policy is worse than one that says what it can't carry.

## On the implementation order

Astra's order (F01–F03, then F04–F08, then F09–F10, then F11–F13, F14 alongside the first group) is reasonable. I'd regroup by *shared fix and shared test harness* rather than by severity alone, because several pairs collapse into one change:

1. **Input and lifecycle safety, small and independent:** F01 (bound the ports), F13 (share the teardown with `applyConfigWithoutUndo`), F12 (validate `checks`, make registration transactional).
2. **Persistence, one theme, one round-trip harness:** F02, F11, and the exhaustive-type test; then F03 with the docs correction.
3. **Interface identity, one mapping:** F04 (use `route.interface`) and F07 together with the empty-picker gap.
4. **Teaching correctness:** F06 first, then F05, F08, F09, F10.
5. **Hardening:** F14.

## Verdict

Accept all 14. Nothing here needs re-verification before work starts — I have already done it. The three P1s are correctly P1: F01 is a freeze from a single imported field, and F02/F03 are silent configuration loss through the two persistence paths the app offers. Fix in the grouped order above, adding each finding's named regression as you go.
