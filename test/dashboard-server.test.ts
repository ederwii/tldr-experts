import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DASHBOARD_MODEL_VERSION, hostnameOfHeader, isAllowedHost, LOOPBACK,
  startDashboardServer, type DashboardServer,
} from "../src/core/dashboard/index.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { makeViewsWorkspace, VIEWS_RUN, type TempViews } from "./fixtures/views/tempViews.ts";

/**
 * The live server, exercised for real: a socket, a page, a model, a stream and a
 * file that changes. Every test binds port 0, so nothing here depends on a port
 * being free, and every server is closed — a leaked listener would hang the run.
 */
let workspace: TempViews;
let server: DashboardServer;

beforeAll(async () => {
  workspace = makeViewsWorkspace();
  // 20 ms rather than 300: the debounce is the product's, the wait is the test's.
  server = await startDashboardServer({ root: workspace.root, port: 0, debounceMs: 20 });
});

afterAll(async () => {
  await server.close();
  workspace.dispose();
});

/**
 * Open the stream, drain the greeting, change a file, and say whether a `reload`
 * arrived inside two seconds.
 */
async function reloadAfterTouch(target: DashboardServer, temp: TempViews): Promise<boolean> {
  const response = await fetch(`${target.url}/events`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("event: hello")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
  }
  seen = "";

  writeFileSync(join(temp.runDir, "events.jsonl"), `{"seq":99,"type":"stage.started","at":"${new Date().toISOString()}"}\n`, { flag: "a" });

  const deadline = Date.now() + 2_000;
  while (!seen.includes("event: reload") && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
      ),
    ]);
    if (chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return seen.includes("event: reload");
}

describe("tldrx dashboard (live)", () => {
  test("binds an ephemeral port on the loopback interface only", () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}`);
  });

  test("GET / serves the page, with the run on it", async () => {
    const response = await fetch(`${server.url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    // The page ships the model as data and draws it in the browser.
    expect(page).toContain(VIEWS_RUN);
    expect(page).toContain("Player scoreboard");
    expect(page).toContain('<script type="application/json" id="model-data">');
    // Live, so it carries the renderer and the listener.
    expect(page).toContain("function dashMain(");
    expect(page).toContain("EventSource");
  });

  test("GET /model.json parses, and is the same model the page was drawn from", async () => {
    const response = await fetch(`${server.url}/model.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const model = (await response.json()) as {
      modelVersion: number; live: boolean; workspaceFound: boolean;
      runs: { id: string; stagesTotal: number }[];
    };
    expect(model.modelVersion).toBe(DASHBOARD_MODEL_VERSION);
    expect(model.live).toBe(true);
    expect(model.workspaceFound).toBe(true);
    expect(model.runs.map((run) => run.id)).toEqual([VIEWS_RUN]);
    expect(model.runs[0]!.stagesTotal).toBe(2);
  });

  test("touching a file under tldrx-work/ pushes a reload down the SSE stream", async () => {
    expect(await reloadAfterTouch(server, workspace)).toBe(true);
  }, 10_000);

  /**
   * Recursive `fs.watch` is not available everywhere — Linux got it late, and
   * each runtime ships its own coverage — so the server falls back to an mtime
   * sweep. That fallback is the one CI might actually take, and an untested
   * fallback is a dashboard that quietly stops being live.
   */
  test("the polling fallback delivers the same reload, within the same 2 s", async () => {
    const polled = await startDashboardServer({
      root: workspace.root, port: 0, debounceMs: 20, watch: "poll",
    });
    try {
      expect(polled.watchMode).toBe("poll");
      expect(await reloadAfterTouch(polled, workspace)).toBe(true);
    } finally {
      await polled.close();
    }
  }, 10_000);

  test("it answers nothing else, and refuses anything that is not a GET", async () => {
    const missing = await fetch(`${server.url}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("/model.json");

    const written = await fetch(`${server.url}/`, { method: "POST", body: "x" });
    expect(written.status).toBe(405);
    expect(await written.text()).toContain("read-only");
  });

  test("a directory with no .tldrx/ still serves a page that says what to do", async () => {
    const bare = await startDashboardServer({ root: join(FRAMEWORK_ROOT, "test"), port: 0, debounceMs: 20 });
    try {
      const page = await (await fetch(`${bare.url}/`)).text();
      expect(page).toContain("No workspace here");
      expect(page).toContain("tldrx init");
    } finally {
      await bare.close();
    }
  });

  /**
   * Gap 10 of the gates/money/safety audit (2026-08-29): loopback bind is not a
   * boundary a browser respects. A page on `evil.example` can point that name at
   * 127.0.0.1 and read `/model.json` from our origin; the socket looks local
   * because the browser opened it. The `Host` header is the one part of such a
   * request that still carries the attacker's name, so it is what we check.
   */
  test("a rebound Host is refused with 403 before any route runs", async () => {
    for (const host of ["evil.example", "evil.example:1234", "attacker.localhost.evil.com"]) {
      for (const path of ["/", "/model.json", "/events"]) {
        const response = await fetch(`${server.url}${path}`, { headers: { host } });
        expect(response.status, `${host} ${path}`).toBe(403);
        const body = await response.text();
        expect(body).toContain("is not this machine");
        expect(body).not.toContain(VIEWS_RUN);
      }
    }
    // Not a GET either — the Host check runs first, so this is 403, not 405.
    const written = await fetch(`${server.url}/`, { method: "POST", body: "x", headers: { host: "evil.example" } });
    expect(written.status).toBe(403);
  });

  test("the loopback names still work, on whatever port a tunnel gives them", async () => {
    for (const host of [`127.0.0.1:${String(server.port)}`, "localhost", "localhost:5000", "[::1]:9", "127.0.0.1"]) {
      const response = await fetch(`${server.url}/model.json`, { headers: { host } });
      expect(response.status, host).toBe(200);
    }
  });

  test("close() releases the port", async () => {
    const first = await startDashboardServer({ root: workspace.root, port: 0, debounceMs: 20 });
    const port = first.port;
    await first.close();
    const second = await startDashboardServer({ root: workspace.root, port, debounceMs: 20 });
    try {
      expect(second.port).toBe(port);
    } finally {
      await second.close();
    }
  });
});

/**
 * The portability contract again (`Bun to build, Node or Bun to run`): the
 * server is `node:http` and `node:fs`, so the built CLI has to serve too. This
 * runs the real `dist/tldrx.js` under `node`, on a real port.
 */
describe("the built CLI serves it under node", () => {
  const DIST = join(FRAMEWORK_ROOT, "dist", "tldrx.js");

  beforeAll(async () => {
    if (existsSync(DIST)) return;
    const built = Bun.spawn(["bun", "scripts/build.ts"], { cwd: FRAMEWORK_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(await built.exited).toBe(0);
  }, 120_000);

  test("`node dist/tldrx.js dashboard --port 0` listens, serves and stops cleanly", async () => {
    const proc = Bun.spawn(["node", DIST, "dashboard", "--port", "0", "--root", workspace.root], {
      cwd: FRAMEWORK_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    const deadline = Date.now() + 15_000;
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(out) && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      out += decoder.decode(chunk.value, { stream: true });
    }

    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(out)?.[0];
    expect(url, `no URL in: ${out}`).toBeDefined();
    expect(out).toContain("read-only");

    const page = await (await fetch(`${url!}/`)).text();
    expect(page).toContain(VIEWS_RUN);
    const model = (await (await fetch(`${url!}/model.json`)).json()) as { modelVersion: number };
    expect(model.modelVersion).toBe(DASHBOARD_MODEL_VERSION);

    proc.kill("SIGINT");
    expect(await proc.exited).toBe(0);
    await reader.cancel();
  }, 60_000);
});

/**
 * The header parser on its own, including the shapes `fetch` will not produce:
 * an absent `Host` (HTTP/1.0, or a hand-rolled socket) and a bracketed IPv6.
 */
describe("Host header parsing", () => {
  test("the hostname is taken without its port, lowercased", () => {
    expect(hostnameOfHeader("127.0.0.1:4477")).toBe("127.0.0.1");
    expect(hostnameOfHeader("LocalHost:5000")).toBe("localhost");
    expect(hostnameOfHeader("[::1]:4477")).toBe("::1");
    expect(hostnameOfHeader("[::1]")).toBe("::1");
    expect(hostnameOfHeader("::1")).toBe("::1"); // bare, as some clients send it
    expect(hostnameOfHeader("evil.example")).toBe("evil.example");
  });

  test("absent, blank and unterminated headers parse to null and are refused", () => {
    for (const header of [undefined, "", "   ", "[::1"]) {
      expect(hostnameOfHeader(header)).toBeNull();
      expect(isAllowedHost(header, LOOPBACK)).toBe(false);
    }
  });

  test("the three loopback names pass; a lookalike does not", () => {
    for (const name of ["127.0.0.1", "localhost", "::1", "[::1]:4477", "LOCALHOST:80"]) {
      expect(isAllowedHost(name, LOOPBACK), name).toBe(true);
    }
    for (const name of ["localhost.evil.com", "127.0.0.1.evil.com", "0.0.0.0", "10.0.0.5"]) {
      expect(isAllowedHost(name, LOOPBACK), name).toBe(false);
    }
  });

  test("a server bound elsewhere on purpose still answers to that name", () => {
    expect(isAllowedHost("dev.box.internal:4477", "dev.box.internal")).toBe(true);
    expect(isAllowedHost("other.box.internal", "dev.box.internal")).toBe(false);
  });
});
