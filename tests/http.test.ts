/**
 * HTTP service (the application layer riding the TCP handshake): a client's GET
 * after the three-way handshake, the server's 200 OK when its web service is on,
 * the connected-but-no-service and closed-port paths, by-name resolution, the
 * packet-list mapping, the `web` command, and config/script round-trips.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless } from "../src/engine";
import { buildHttpEvents, parseHttpTarget } from "../src/simulation";
import { packetColumns, createHttpRequest, createHttpResponse } from "../src/frame";
import { runConsoleScript, runConsoleCommand as exec, exportTopologyScript } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const dev = (name: string) => state.devices.find(d => d.name === name)!;

// PC1 — SW — { WEB (web service on), NOSVC (listens :80, no service), CLOSED (:22 only) }
function lan() {
  runConsoleScript(`
    add computer PC1 at 0 0
    add switch SW at 160 0
    add server WEB at 320 0
    add server NOSVC at 320 160
    add server CLOSED at 320 320
    link PC1 SW
    link WEB SW
    link NOSVC SW
    link CLOSED SW
    ip PC1 10.0.0.10/24
    ip WEB 10.0.0.80/24
    ip NOSVC 10.0.0.81/24
    ip CLOSED 10.0.0.82/24
    web WEB on Welcome to WEB
    ports NOSVC 80
    ports CLOSED 22
  `);
  return dev("PC1");
}

function httpGet(src: any, target: string, port = 80, path = "/") {
  const setup = buildHttpEvents(src, target, port, path);
  expect(typeof setup).not.toBe("string");
  return runSimulationHeadless(setup as any, src.id, target, "http", port);
}

describe("HTTP service — request/response over the handshake", () => {
  it("a GET to a web server returns 200 OK", () => {
    const pc1 = lan();
    const r = httpGet(pc1, "10.0.0.80");
    expect(r.success).toBe(true);
    expect(r.httpStatus).toBe(200);
    // the handshake + GET + response all appear in the log
    const kinds = state.simulation.log.map(l => l.action);
    expect(kinds.some(a => a.includes("SYN-ACK"))).toBe(true);
    expect(kinds.some(a => a.includes("HTTP GET /"))).toBe(true);
    expect(kinds.some(a => a.includes("200 OK"))).toBe(true);
  });

  it("a listening port with no web service connects but gets no response", () => {
    const pc1 = lan();
    const r = httpGet(pc1, "10.0.0.81"); // NOSVC listens on 80 but httpEnabled is off
    expect(r.success).toBe(false);       // no 200
    expect(r.httpStatus).toBeNull();
    expect(r.refused).toBe(false);       // the handshake DID complete (SYN-ACK), just no HTTP
    expect(state.simulation.log.some(l => l.action.includes("no web service"))).toBe(true);
  });

  it("a closed web port is refused with a RST", () => {
    const pc1 = lan();
    const r = httpGet(pc1, "10.0.0.82"); // CLOSED listens only on 22 → :80 RST
    expect(r.success).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.httpStatus).toBeNull();
  });

  it("an unreachable host yields no response", () => {
    const pc1 = lan();
    const r = httpGet(pc1, "10.0.0.200"); // nobody
    expect(r.success).toBe(false);
    expect(r.refused).toBe(false);
    expect(r.httpStatus).toBeNull();
  });

  it("resolves a host name (instant DNS) then GETs", () => {
    const pc1 = lan();
    const r = httpGet(pc1, "WEB"); // instant DNS on by default → name resolves to 10.0.0.80
    expect(r.httpStatus).toBe(200);
  });

  it("the web service only answers on port 80, not other open ports", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 160 0
      add server WEB at 320 0
      link PC1 SW
      link WEB SW
      ip PC1 10.0.0.10/24
      ip WEB 10.0.0.80/24
      web WEB on
      ports WEB 80,8080
    `);
    const pc1 = dev("PC1");
    expect(httpGet(pc1, "10.0.0.80", 80).httpStatus).toBe(200);   // :80 → served
    const alt = httpGet(pc1, "10.0.0.80", 8080);                  // :8080 → connects, no web service
    expect(alt.httpStatus).toBeNull();
    expect(alt.refused).toBe(false);
  });

  it("by-name with instant DNS off issues a real query then GETs", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 160 0
      add server WEB at 320 0
      add server DNS at 320 160
      link PC1 SW
      link WEB SW
      link DNS SW
      ip PC1 10.0.0.10/24
      ip WEB 10.0.0.80/24
      ip DNS 10.0.0.53/24
      nameserver PC1 10.0.0.53
      web WEB on
    `);
    state.options.instantDns = false;
    const pc1 = dev("PC1");
    const setup = buildHttpEvents(pc1, "WEB");
    expect(typeof setup).not.toBe("string");
    expect((setup as any).dns?.then).toBe("http"); // by-name → resolve, then HTTP
    const r = runSimulationHeadless(setup as any, pc1.id, "WEB", "http", 80);
    expect(r.resolvedIp).toBe("10.0.0.80");
    expect(r.httpStatus).toBe(200);
    expect(r.success).toBe(true);
  });
});

describe("parseHttpTarget", () => {
  it("parses bare host, host:port, and full URLs with paths", () => {
    expect(parseHttpTarget("WEB")).toEqual({ host: "WEB", port: 80, path: "/" });
    expect(parseHttpTarget("10.0.0.80")).toEqual({ host: "10.0.0.80", port: 80, path: "/" });
    expect(parseHttpTarget("http://WEB/index.html")).toEqual({ host: "WEB", port: 80, path: "/index.html" });
    expect(parseHttpTarget("https://web.corp:8443/a/b")).toEqual({ host: "web.corp", port: 8443, path: "/a/b" });
    expect(parseHttpTarget("WEB:8080")).toEqual({ host: "WEB", port: 8080, path: "/" });
    // a separate path argument is used only when the target carries none
    expect(parseHttpTarget("WEB", "/page")).toEqual({ host: "WEB", port: 80, path: "/page" });
    expect(parseHttpTarget("WEB/has-path", "/ignored")).toEqual({ host: "WEB", port: 80, path: "/has-path" });
  });

  it("a present-but-invalid port yields NaN (not a silent 80)", () => {
    for (const bad of ["WEB:99999", "WEB:0", "WEB:-5", "WEB:abc"]) {
      const t = parseHttpTarget(bad);
      expect(t.host).toBe("WEB");
      expect(Number.isNaN(t.port)).toBe(true);
    }
  });
});

describe("http command guards", () => {
  it("rejects an empty host and an invalid port", () => {
    runConsoleScript(`add computer PC1 at 0 0\nip PC1 10.0.0.10/24`);
    expect(exec("http PC1 http://").ok).toBe(false);     // empty host
    expect(exec("http PC1 WEB:99999").ok).toBe(false);   // bad port — not silently 80
  });
});

describe("packetColumns — HTTP rows", () => {
  it("renders the GET request and the response", () => {
    const req = packetColumns(createHttpRequest("aa:aa:aa:aa:aa:aa", "bb:bb:bb:bb:bb:bb", "10.0.0.10", "10.0.0.80", 40000, 80, "/index.html", "web.corp"));
    expect(req.protocol).toBe("HTTP");
    expect(req.info).toContain("GET /index.html");
    expect(req.info).toContain("web.corp");
    const res = packetColumns(createHttpResponse("bb:bb:bb:bb:bb:bb", "aa:aa:aa:aa:aa:aa", "10.0.0.80", "10.0.0.10", 80, 40000, 200, "OK", "It works!"));
    expect(res.protocol).toBe("HTTP");
    expect(res.info).toBe("HTTP/1.1 200 OK");
    expect(res.tone).toBe("http");
    // a 4xx reads red
    const notFound = packetColumns(createHttpResponse("bb:bb:bb:bb:bb:bb", "aa:aa:aa:aa:aa:aa", "10.0.0.80", "10.0.0.10", 80, 40000, 404, "Not Found", ""));
    expect(notFound.tone).toBe("bad");
  });
});

describe("web command + round-trips", () => {
  it("`web <host> on|off` toggles the service, validated", () => {
    runConsoleScript(`add server WEB at 0 0\nip WEB 10.0.0.80/24`);
    expect(exec("web WEB on My Site").ok).toBe(true);
    expect(dev("WEB").config!.httpEnabled).toBe(true);
    expect(dev("WEB").config!.httpTitle).toBe("My Site");
    expect(exec("web WEB off").ok).toBe(true);
    expect(dev("WEB").config!.httpEnabled).toBe(false);
    // only a server can run the web service → switch and computer are rejected
    runConsoleScript(`add switch SW at 200 0\nadd computer PC1 at 400 0`);
    expect(exec("web SW on").ok).toBe(false);
    expect(exec("web PC1 on").ok).toBe(false);
  });

  it("httpEnabled + title round-trip through the script export", () => {
    runConsoleScript(`add server WEB at 0 0\nip WEB 10.0.0.80/24\nweb WEB on Hello`);
    const script = exportTopologyScript();
    expect(script).toContain("web WEB on Hello");
    // replay into a fresh state reproduces the service
    resetState();
    runConsoleScript(script);
    expect(dev("WEB").config!.httpEnabled).toBe(true);
    expect(dev("WEB").config!.httpTitle).toBe("Hello");
  });
});
