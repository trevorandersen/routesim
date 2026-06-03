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
const ROOT = import.meta.dir;

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

function runTests(
  file: string | null,
  pattern: string | null,
): Promise<{ ok: boolean; output: string; code: number }> {
  const args = ["bun", "test"];
  if (file) args.push(`tests/${file}`);
  if (pattern) args.push("-t", pattern);
  return runCommand(args);
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
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/tests") {
      return json(await listTests());
    }

    if (path === "/api/run") {
      const file = url.searchParams.get("file");
      const pattern = url.searchParams.get("pattern");
      return json(await runTests(file, pattern));
    }

    // Static file serving
    const filePath = path === "/" ? "/rs-main.html" : path;
    const resolved = `${ROOT}${filePath}`;

    // Prevent directory traversal
    if (!resolved.startsWith(ROOT)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(resolved);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": mimeFor(resolved) },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`\n  RouteSim Test Runner`);
console.log(`  http://localhost:${PORT}/test.html`);
console.log(`  http://localhost:${PORT}/benchmark.html\n`);
