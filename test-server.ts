/**
 * Lightweight test runner server for RouteSim.
 *
 * Serves test.html, benchmark.html, and the main app, and provides
 * API endpoints to execute bun test commands and return results.
 *
 * Usage:
 *     bun test-server.ts [port]
 *
 * Default port is 8767.
 */

const PORT = parseInt(Bun.argv[2] ?? "8767");
// Loopback by default: this server runs unauthenticated test execution and
// serves repository files, which is fine on your own machine and not fine on a
// shared network. Pass a host explicitly (`bun test-server.ts 8767 0.0.0.0`)
// when you mean to share it.
const HOST = Bun.argv[3] ?? "127.0.0.1";
const ROOT = import.meta.dir;
const MAX_CONCURRENT_RUNS = 2;
let runsInFlight = 0;

/** Static paths we will serve: no dotfiles / `.git`, no `..`, a known type only. */
export function isServablePath(pathname: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some(seg => seg === ".." || seg.startsWith("."))) return false;
  const ext = decoded.slice(decoded.lastIndexOf("."));
  return ext !== decoded && ext in MIME;
}

/** `file` must name one of the enumerated test files — never an arbitrary path. */
export function isAllowedTestFile(file: string | null, known: string[]): boolean {
  return !!file && /^[A-Za-z0-9_-]+\.test\.ts$/.test(file) && known.includes(file);
}

// ── Who may talk to this server ───────────────────────────────────────────────
// It runs `bun test` on request, so two browser-borne attacks matter even on
// loopback: a page on another site making your browser call it (cross-site
// request), and DNS rebinding, where an attacker's domain is re-pointed at
// 127.0.0.1 so their page becomes "same-origin" with it. Both are refused by
// looking at what the browser cannot forge for a page: Host, Origin and
// Sec-Fetch-Site.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The hostname of a Host header or origin, without the port ("[::1]:8767" → "[::1]").
function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  return value.split(":")[0];
}

/**
 * Whether a Host header names this server. A rebinding attack arrives with the
 * attacker's own domain in Host, so a name is accepted only if it is loopback,
 * an IP literal, or the host the server was deliberately bound to. Bound to
 * loopback (the default), only loopback names are accepted.
 */
export function isAllowedHost(hostHeader: string | null, boundTo: string): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (LOOPBACK_HOSTS.has(name)) return true;
  const bound = boundTo.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(bound) || bound === "::1") return false;      // loopback-only server: nothing else is us
  if (name === bound) return true;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
  const isIpv6 = /^\[[0-9a-f:.]+\]$/.test(name);
  return isIpv4 || isIpv6;                                              // shared on the LAN: reached by address, never by a foreign name
}

/**
 * Whether a request to the API may run. Beyond the Host check: `/api/run`
 * starts a test run, so it must be a POST (a cross-site <img> or link can only
 * GET), and a request the browser marks as coming from another site — an
 * Origin that is not this server, or Sec-Fetch-Site other than same-origin /
 * none — is refused. Returns the reason, or null when allowed.
 */
export function apiRequestBlockReason(
  request: { method: string; path: string; host: string | null; origin: string | null; secFetchSite: string | null },
  boundTo: string,
): string | null {
  if (!isAllowedHost(request.host, boundTo)) return "This server only answers to its own address (unexpected Host header).";
  if (request.path === "/api/run" && request.method !== "POST") return "/api/run starts a test run and must be a POST.";
  if (request.origin && request.origin !== "null") {
    // An origin is scheme://host[:port] — read the host[:port] directly.
    const parsed = request.origin.trim().toLowerCase().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)$/);
    if (!parsed) return "Malformed Origin header.";
    if (parsed[1] !== (request.host || "").trim().toLowerCase()) return "Cross-site requests are refused.";
  } else if (request.origin === "null") {
    return "Cross-site requests are refused.";                            // a sandboxed or file:// page
  }
  const site = request.secFetchSite;
  if (site && site !== "same-origin" && site !== "none") return "Cross-site requests are refused.";
  return null;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

async function runCommand(
  args: string[],
  timeout = 120_000,
): Promise<{ ok: boolean; output: string; code: number }> {
  try {
    const proc = Bun.spawn(args, {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), timeout);

    const stdout = await Bun.readableStreamToText(proc.stdout as ReadableStream);
    const stderr = await Bun.readableStreamToText(proc.stderr as ReadableStream);
    const code = await proc.exited;
    clearTimeout(timer);
    return { ok: code === 0, output: stripAnsi(stdout + stderr), code };
  } catch {
    return { ok: false, output: "Command failed or timed out", code: -1 };
  }
}

async function listTests(): Promise<{
  tests: Record<string, string[]>;
}> {
  const tests: Record<string, string[]> = {};
  const glob = new Bun.Glob("*.test.ts");

  const names: string[] = [];
  for await (const name of glob.scan({ cwd: `${ROOT}/tests` })) {
    names.push(name);
  }
  names.sort();

  for (const name of names) {
    const text = await Bun.file(`${ROOT}/tests/${name}`).text();
    const describes: string[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*describe\("(.+?)"/);
      if (m) describes.push(m[1]);
    }
    tests[name] = describes;
  }

  return { tests };
}

async function runTests(
  file: string | null,
  pattern: string | null,
): Promise<{ ok: boolean; output: string; code: number }> {
  const args = ["bun", "test"];
  if (file) {
    const known = Object.keys((await listTests()).tests);
    if (!isAllowedTestFile(file, known)) return { ok: false, output: `Unknown test file: ${file}`, code: -1 };
    args.push(`tests/${file}`);
  }
  if (pattern) args.push("-t", pattern.slice(0, 200));   // an argv element, never a shell string
  if (runsInFlight >= MAX_CONCURRENT_RUNS) return { ok: false, output: "Too many test runs in flight — try again shortly.", code: -1 };
  runsInFlight++;
  try { return await runCommand(args); } finally { runsInFlight--; }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return MIME[ext] ?? "application/octet-stream";
}

function json(data: unknown): Response {
  // Same-origin only: test.html / benchmark.html are served by this process.
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

if (import.meta.main) Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 120,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Every request must be addressed to this server (DNS-rebinding guard); the
    // API additionally refuses cross-site callers and a non-POST run.
    if (!isAllowedHost(req.headers.get("host"), HOST)) return new Response("Forbidden", { status: 403 });
    if (path.startsWith("/api/")) {
      const blocked = apiRequestBlockReason({
        method: req.method, path,
        host: req.headers.get("host"), origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site"),
      }, HOST);
      if (blocked) {
        return new Response(JSON.stringify({ ok: false, output: blocked, code: -1 }), {
          status: req.method !== "POST" && path === "/api/run" ? 405 : 403,
          headers: { "Content-Type": "application/json", ...(path === "/api/run" ? { Allow: "POST" } : {}) },
        });
      }
    }

    if (path === "/api/tests") {
      return json(await listTests());
    }

    if (path === "/api/run") {
      const file = url.searchParams.get("file");
      const pattern = url.searchParams.get("pattern");
      return json(await runTests(file, pattern));
    }

    // Static file serving — repository files of known types only; dotfiles
    // (`.git`, editor state) and anything with a `..` segment are refused.
    const filePath = path === "/" ? "/rs-web.html" : path;
    if (!isServablePath(filePath)) return new Response("Forbidden", { status: 403 });
    const resolved = `${ROOT}${filePath}`;

    const file = Bun.file(resolved);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": mimeFor(resolved) },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

if (import.meta.main) {
  console.log(`\n  RouteSim Test Runner (bound to ${HOST})`);
  console.log(`  http://localhost:${PORT}/test.html`);
  console.log(`  http://localhost:${PORT}/benchmark.html\n`);
}
