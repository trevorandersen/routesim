/**
 * Shareable links — a whole network carried in the URL's fragment
 * (`rs-web.html#net=…`), so a topology can be handed over as a link with no
 * server: the fragment never leaves the browser, and the app stays a single
 * file that makes no requests.
 *
 * This module is the codec only (pure: no state, no DOM): text in, a
 * URL-safe token out, and back. The token says how it was packed —
 *
 *   z.<base64url>   the JSON, deflated (the browser's own CompressionStream)
 *   j.<base64url>   the JSON as it is (a browser with no CompressionStream)
 *
 * — so a link made in one browser opens in another. A link is input from
 * anywhere: decoding is bounded (`SHARE_MAX_BYTES`) and every failure is a
 * plain sentence the caller can show. What the JSON *means* is the config
 * layer's business (`parseConfig`), exactly as for an imported file.
 */

export const SHARE_PARAM = "net";
// The most a link may unpack to. A real network is a few kilobytes of JSON;
// this only stops a crafted link inflating without bound.
export const SHARE_MAX_BYTES = 4 * 1024 * 1024;

// ── base64url ────────────────────────────────────────────────────────────────

type Bytes = Uint8Array<ArrayBuffer>;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // In chunks: String.fromCharCode(...bytes) overflows the stack on a large array.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("the link is damaged (it holds characters a link cannot)");
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new Error("the link is damaged (it was cut short or altered)");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── deflate, through the browser's own streams ───────────────────────────────

const canCompress = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

async function through(bytes: Bytes, stream: CompressionStream | DecompressionStream, cap: number): Promise<Bytes> {
  const writer = stream.writable.getWriter();
  // Feed and drain together; a failure surfaces on the reading side.
  void writer.write(bytes).then(() => writer.close()).catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      void reader.cancel().catch(() => {});
      throw new Error("the link unpacks to more than a network could need");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

// ── The token ────────────────────────────────────────────────────────────────

// Pack text into a token. `compress: false` forces the plain form (what a
// browser without CompressionStream produces).
export async function encodeShare(text: string, compress = canCompress()): Promise<string> {
  const bytes: Bytes = new TextEncoder().encode(text);
  if (!compress) return `j.${toBase64Url(bytes)}`;
  return `z.${toBase64Url(await through(bytes, new CompressionStream("deflate-raw"), Infinity))}`;
}

// Unpack a token. Throws an Error whose message finishes the sentence "This
// link could not be opened: …".
export async function decodeShare(token: string): Promise<string> {
  const dot = token.indexOf(".");
  const kind = dot > 0 ? token.slice(0, dot) : "";
  const body = token.slice(dot + 1);
  if (kind !== "z" && kind !== "j") throw new Error("it is not a RouteSim network link");
  if (!body) throw new Error("the link is empty");
  let bytes = fromBase64Url(body);
  if (kind === "z") {
    if (!canCompress()) throw new Error("this browser cannot unpack a compressed link — open it in a current browser");
    try {
      bytes = await through(bytes, new DecompressionStream("deflate-raw"), SHARE_MAX_BYTES);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("the link unpacks")) throw error;
      throw new Error("the link is damaged (it was cut short or altered)");
    }
  } else if (bytes.length > SHARE_MAX_BYTES) {
    throw new Error("the link unpacks to more than a network could need");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("the link is damaged (it was cut short or altered)");
  }
}

// ── The URL around it ────────────────────────────────────────────────────────

// The token in a location hash ("#net=z.abc", possibly among other
// `&`-separated parts), or null when the hash carries no network.
export function shareTokenFromHash(hash: string): string | null {
  for (const part of hash.replace(/^#/, "").split("&")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === SHARE_PARAM) return part.slice(eq + 1);
  }
  return null;
}

// The page's address without its query or fragment (works for file:// too,
// where `location.origin` is the string "null").
export const pageBase = (href: string) => href.split("#")[0].split("?")[0];

// A full link: the page, the settings that differ from the defaults
// (settings-url.ts), and the network.
export function shareUrl(base: string, settingsQuery: string, token: string): string {
  return `${base}${settingsQuery ? `?${settingsQuery}` : ""}#${SHARE_PARAM}=${token}`;
}

// Past this a link still opens in a browser, but chat and mail apps start to
// cut it; the caller says so and points at the JSON export.
export const SHARE_LONG_LINK = 8000;
