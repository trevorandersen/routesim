# `src/tokenize.ts` — the command language's tokenizer

Splits a console command line into arguments, **quote-aware**, and provides the
inverse used by the script export.

## Why it exists

The engine used to split on bare whitespace (`line.split(/\s+/)`), so any value
containing a space was unrepresentable. That bit in three places:

- a device named `My PC` — every command taking a device reference saw two
  arguments, and the name is the *first* argument, so no trailing-join
  workaround could reach it;
- an SSID or WiFi password with a space (`ssid AP1 Guest WiFi secret` read the
  SSID as `Guest` and the password as `WiFi`);
- `exportTopologyScript()` emitted such values raw, so the "reproducible"
  script re-parsed into a *different* topology — a silent round-trip break.

Handlers that could paper over it did (`web`'s title and `linkset`'s name join
their trailing arguments), which works only for the last field and hid how
broad the gap was.

## API

- **`tokenizeCommand(line)`** → `{ args, ends, error? }`. `args` are the parsed
  tokens with quotes removed and escapes resolved; `ends[i]` is the offset just
  past token `i`, so a handler can recover the **raw source tail** after any
  argument; `error` is set (and `args` empty) for an unterminated quote —
  rejected, never silently truncated.
- **`quoteArg(value)`** — the inverse: returns `value` bare when it would
  survive a round-trip, else double-quoted with `\` and `"` escaped. An empty
  string quotes to `""`.

Grammar: whitespace separates; `"…"` and `'…'` each group one token; inside
double quotes `\"` and `\\` escape (single quotes are literal, shell
convention). Quoting can start mid-token — `pre"fix post"fix` is one argument.

## How it fits

A leaf module with no dependencies. `commands.ts` tokenizes in
`runConsoleCommand` and hands each handler `(args, rest, tail)`, where
`tail(n)` is the raw source after token `n` — used by the two handlers whose
remainder is **free text that must not be re-split**: `cli <device> <shell
line>` and `idsrule <ids> <snort rule>` (a Snort rule contains its own quotes).
`exportTopologyScript` applies `quoteArg` to device and link names, SSIDs and
passwords, HTTP titles, and 802.1X/RADIUS identities, so the export→replay
round-trip holds for awkward values. Tested in `tests/tokenize.test.ts` (the
grammar) and `tests/commands.test.ts` (the end-to-end round-trip).
