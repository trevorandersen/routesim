# share-link.ts — a network in a link

`rs-web.html#net=…` carries a whole network in the URL **fragment**, so a
topology can be handed over as a link with no server. The fragment never leaves
the browser (it is not part of any request), and the page stays a single file
that makes none — the zero-request principle is intact.

`share-link.ts` is the codec only: pure, no state, no DOM. The two actions that
use it live in `io.ts`, next to the file import/export they sit beside.

## The token

The text packed is the topology JSON — exactly `buildConfigPayload()`, the same
payload File → Export → Config writes. The token says how it was packed, so a
link made in one browser opens in another:

| Token | Meaning |
|---|---|
| `z.<base64url>` | The JSON, raw-deflated with the browser's own `CompressionStream("deflate-raw")`. The normal case: a network's JSON is repetitive and shrinks to a fifth or less. |
| `j.<base64url>` | The JSON as it is — what a browser with no `CompressionStream` produces. |

- **`encodeShare(text, compress?)`** → token (async: the streams are).
- **`decodeShare(token)`** → text, or throws an `Error` whose message finishes
  the sentence *"This link could not be opened: …"* — not a RouteSim link,
  empty, damaged (bad alphabet, cut short, altered), or one that unpacks past
  **`SHARE_MAX_BYTES`** (4 MB). The cap is enforced *while* inflating, so a
  small crafted link cannot balloon in memory.
- **`shareTokenFromHash(hash)`** — the token in a location hash (`#net=…`,
  possibly among other `&`-separated parts), or `null`.
- **`shareUrl(base, settingsQuery, token)`** / **`pageBase(href)`** — the full
  link: the page's address without query or fragment (works for `file://`),
  the settings that differ from the defaults ([settings-url.md](settings-url.md)),
  then the network.

## The actions (`io.ts`)

- **`buildShareLink(base?)`** — the link for the network on the canvas.
- **`copyShareLink()`** — File → **Copy link** (`data-action="copy-link"`).
  Copies the link and says so on the status line, with its size and what it
  holds: *the whole network, any passwords and keys in it included* (WiFi
  passwords, RADIUS users, MACsec keys are part of a topology). With no
  clipboard in reach it puts the link in the address bar and says that instead.
  Past **`SHARE_LONG_LINK`** (8,000 characters) it adds that a chat or mail app
  may cut the link, and points at the JSON export. The built-in topologies and
  scenarios all come in under that.
- **`openSharedNetwork(hash, { undo })`** — decode → `parseConfig` → apply.
  Resolves `true` when a network was loaded. A fragment with no network is
  ignored; a link that cannot be read **leaves the canvas untouched** and the
  status line gives the reason. While undo is frozen (the tutorial, the port
  dialog — `undoBlockReason`) the link is not opened, for the same reason undo
  is not.

`app.ts` calls it twice: at boot (over the default network with no undo point
— or, when autosave has just restored a session, over that *as* an undo point,
so one Undo returns to the learner's own work; see [autosave.md](autosave.md)) and
on `hashchange` (a link pasted into a tab that is already open — one undo
point, so Undo returns to what was there). After a successful load the fragment
is **taken out of the address bar**: left there, a refresh would load the link's
network again over whatever the learner had built since.

## A link is untrusted input

Anyone can craft one. It gets exactly the treatment an imported file does:
`parseConfig` → `normaliseConfig` either rejects it with a reason or cleans it,
and every name it carries is escaped where it is rendered. Decoding is bounded
(above), and nothing in a link is executed.

## Not in a link

The active scenario and its goal, terminal scrollback, captures, and undo
history — a link is the *network*, like the JSON file. Settings ride in the
query string, not the fragment.

## Tests

`tests/share-link.test.ts`: the codec round-trips (compressed and plain, URL-safe
alphabet, non-ASCII names); bad tokens fail with a reason; the inflate cap
holds; fragment parsing and URL building; every built-in topology and scenario
survives link → open field for field and makes a link short enough to paste;
opening is one undo point (none at boot); an unreadable or hostile link leaves
the canvas alone; a frozen undo defers the load; and Copy link's three
outcomes (copied, address-bar fallback, long-link warning).
