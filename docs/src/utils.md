# `src/utils.ts` — Pure helpers

Small, dependency-free utility functions used everywhere. All are pure except the `cssColor` cache.

## Key exports

### Validation & formatting
- **`isValidIpv4`, `isValidMac`** — format validation.
- **`normaliseMacAddress`** — canonicalises MAC casing/separators.
- **`parseIpv4Token`** — parses `"192.168.1.10/24"` into `{ address, prefixLength }` (used by host/router IP commands).
- **`normaliseVlanId`** — parses/validates a VLAN id (1–4094) or returns null.
- **`clampPortCount`, `clampRouterPortCount`, `clampApPortCount`, `clampFirewallPortCount`** — clamp port counts to allowed ranges (switch-like 4–24, router 0–12, access point 1–4, firewall 2–8 — `FIREWALL_PORT_RANGE`). The firewall's is the one clamp the inspector, the `portcount` command, the normaliser and `wiredPortCapacity` share: they used to allow 2–8, 1–8 and the switch's 4–24 respectively, so a default two-port firewall came back from a save with four ports (review R92).

### IPv4 maths
- **`ipv4ToInt`, `intToIpv4`** — IPv4 ↔ integer conversion, the basis of the subnet maths below.
- **`parseIpv4(s)`** — validate *and* convert in one allocation-free pass (no regex, no split): the unsigned 32-bit value, or `null` when `s` isn't a valid address. Its rules are exactly the old string checks (four 1–3 digit decimal octets ≤ 255, no leading zeros) — `isValidIpv4` is now defined as `parseIpv4(s) !== null`, and `tests/utils.test.ts` fuzzes both against the original regex implementation.

### Integer CIDR (hot path)
A `Cidr` (`types.ts`: `{ net, mask, prefix }`, the network already masked) is a CIDR parsed once. The routing table, RIP convergence, and the firewall hold these, so a per-frame decision is an AND and a compare rather than re-validating and re-splitting the same strings per route per frame (R62/R63/R109 — `routingLookup` over 15 routes fell from ~27 µs to well under 1 µs).
- **`parseCidr(text)`** — `"a.b.c.d/len"` (or a bare address, read as /24) → `Cidr`, or `null` for a bad address; an unparseable length falls back to /24 exactly as `prefixLengthOfCidr` does, so the integer and string paths agree on every input.
- **`cachedCidr(text)`** — memoised `parseCidr`, keyed by the text (route networks and RIP `network` statements are a small, stable set), so a lookup after the first is a Map hit with no allocation. Keyed by value, never by the route/rule object, so an edited config can't read a stale parse; bounded (dropped wholesale at 4096 entries). Every caller shares the returned object — treat it as immutable.
- **`cidrHas(cidr, ip)`** — does the parsed CIDR contain the address integer?
- **`cidrOf(ip, prefixLength)`** / **`cidrText(cidr)`** — build a `Cidr` from an integer + length; print it as `networkOf` would (`"10.1.0.0/16"`).

### HTML
- **`escapeHtml`** — escapes a value for safe insertion into `innerHTML`. Used throughout `inspector.ts`/`terminal/` to neutralise device/interface/VLAN names.

### CSS colours (with cache)
- **`cssColor(name)`** — resolves a CSS custom property (e.g. `--pc-fill`) to its value.
- **`clearCssColorCache()`** — clears the cache.

> **Performance:** `cssColor` is called many times per device/link/frame in the render loop, and `getComputedStyle` forces a style recalc. The result is **memoised** in a `Map`; `clearCssColorCache()` is called from `setTheme` (`ui.ts`) so colours refresh when the theme changes (Warm Light / Dark / Blueprint). This avoids per-frame reflows.

### Subnet prefix maths
`sameSubnet(a, b, prefixLength)`, `networkOf(ip, prefixLength)`, `cidrContains(cidr, ip)`, `prefixLengthOfCidr(cidr)`, `clampPrefixLength(n)`, and `prefixOf(holder)` (reads a config/interface's `prefixLength`, defaulting to **/24**). All subnet decisions in the simulator go through these (or their integer forms above) — there is no hardwired /24 logic. `sameSubnet` and `cidrContains` are built on `parseIpv4`/`cachedCidr`, so even the string-level callers parse each address once.

- **`internetGatewayIp(routerIp, prefixLength)`** — the address the **Internet cloud** presents as the gateway on a router's WAN subnet: the subnet's highest usable host (e.g. `.254` of a `/24`, or the other usable address of a `/30`), never colliding with the router's own address; `null` for a subnet too small to spare one (`/31`/`/32`) or an invalid router address (validated and converted in one `parseIpv4` pass, so callers need not pre-check it). The cloud answers ARP for it and `buildRoutingTable` (routing.ts) points the router's implicit default route at it. See [engine.md](engine.md).

## How it fits

A leaf module — it imports nothing from the app, so everything else can import it freely. The `cssColor` cache is the one stateful piece; its only invalidation point is the theme setter.
