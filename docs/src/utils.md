# `src/utils.ts` — Pure helpers

Small, dependency-free utility functions used everywhere. All are pure except the `cssColor` cache.

## Key exports

### Validation & formatting
- **`isValidIpv4`, `isValidMac`** — format validation.
- **`normaliseMacAddress`** — canonicalises MAC casing/separators.
- **`parseIpv4Token`** — parses `"192.168.1.10/24"` into `{ address, prefixLength }` (used by host/router IP commands).
- **`normaliseVlanId`** — parses/validates a VLAN id (1–4094) or returns null.
- **`clampPortCount`, `clampRouterPortCount`** — clamp port counts to allowed ranges.

### IPv4 maths
- **`ipv4ToInt`, `intToIpv4`** — IPv4 ↔ integer conversion, the basis of the subnet maths below.

### HTML
- **`escapeHtml`** — escapes a value for safe insertion into `innerHTML`. Used throughout `inspector.ts`/`terminal/` to neutralise device/interface/VLAN names.

### CSS colours (with cache)
- **`cssColor(name)`** — resolves a CSS custom property (e.g. `--pc-fill`) to its value.
- **`clearCssColorCache()`** — clears the cache.

> **Performance:** `cssColor` is called many times per device/link/frame in the render loop, and `getComputedStyle` forces a style recalc. The result is **memoised** in a `Map`; `clearCssColorCache()` is called from `setTheme` (`ui.ts`) so colours refresh when the theme changes (Warm Light / Dark / Blueprint). This avoids per-frame reflows.

### Subnet prefix maths
`sameSubnet(a, b, prefixLength)`, `networkOf(ip, prefixLength)`, `cidrContains(cidr, ip)`, `prefixLengthOfCidr(cidr)`, `clampPrefixLength(n)`, and `prefixOf(holder)` (reads a config/interface's `prefixLength`, defaulting to **/24**). All subnet decisions in the simulator go through these — there is no hardwired /24 logic.

## How it fits

A leaf module — it imports nothing from the app, so everything else can import it freely. The `cssColor` cache is the one stateful piece; its only invalidation point is the theme setter.
