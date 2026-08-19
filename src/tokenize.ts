/**
 * Quote-aware tokenizer for the console command language.
 *
 * The command engine used to split on bare whitespace, which meant any value
 * containing a space was unrepresentable: a device named "My PC", an SSID of
 * "Guest WiFi", a link name, an HTTP title. Handlers worked around it by
 * joining the trailing arguments — which only ever works for the *last* field,
 * never for a device name in the first position — and `exportTopologyScript`
 * emitted such names raw, producing a script that re-parsed into the wrong
 * thing. Quoting fixes both halves: `add computer "My PC" at 0 0` parses, and
 * the export quotes anything that needs it so the round-trip holds.
 *
 * Grammar: tokens separate on whitespace; `"…"` or `'…'` groups one token;
 * inside double quotes `\"` and `\\` escape; single quotes are literal (shell
 * convention). An unterminated quote is an error, not a silent truncation.
 */

export interface Tokenized {
  /** The parsed tokens, with quotes removed and escapes resolved. */
  args: string[];
  /** `ends[i]` is the offset in the source just past token `i`. */
  ends: number[];
  /** Set when the line could not be tokenized; `args` is then empty. */
  error?: string;
}

export function tokenizeCommand(line: string): Tokenized {
  const args: string[] = [];
  const ends: number[] = [];
  const src = line || "";
  let i = 0;

  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;

    let token = "";
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\" && quote === '"' && (src[i + 1] === '"' || src[i + 1] === "\\")) {
          token += src[++i];
        } else if (ch === quote) {
          quote = null;
        } else {
          token += ch;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (/\s/.test(ch)) {
        break;
      } else {
        token += ch;
      }
    }
    if (quote) return { args: [], ends: [], error: `Unterminated ${quote === '"' ? "double" : "single"} quote.` };
    args.push(token);
    ends.push(i);
  }

  return { args, ends };
}

/**
 * The inverse, for script export: quote `value` when it would not survive a
 * round-trip bare (empty, or containing whitespace, a quote, or a backslash).
 */
export function quoteArg(value: string): string {
  const s = String(value ?? "");
  if (s !== "" && !/[\s"'\\]/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
