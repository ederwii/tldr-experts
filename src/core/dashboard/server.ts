/**
 * `tldrx dashboard` — a live, read-only local server (concept §12).
 *
 * Deliberately small: `node:http` and `node:fs`, nothing else. No framework, no
 * runtime dependency, and it runs unchanged on Bun and Node. The runtime seam
 * (`src/core/runtime/`) offers no server or watcher primitive — checked, not
 * assumed — so those come from the Node built-ins both runtimes implement, and
 * the seam is still used for the one thing it does cover: spawning `--open`.
 *
 * Three routes, all GET:
 *   `/`            the page (the same renderer the static export uses)
 *   `/model.json`  the model that page was rendered from
 *   `/events`      Server-Sent Events; one `reload` per debounced file change
 *
 * It binds to 127.0.0.1 and nothing else — a dashboard that shows a team's
 * unshipped plans has no business on a LAN by default. It never writes: no route
 * accepts a body, and no code path here opens a file for writing.
 *
 * Binding to loopback is necessary and not sufficient. Any page the developer
 * happens to open can point a name it controls at 127.0.0.1 (DNS rebinding) and
 * then read `/model.json` from our origin — the socket is loopback either way,
 * because the browser makes the connection. What separates that request from a
 * real one is the `Host` header, which carries the attacker's name rather than
 * ours. So every request must name a loopback host (or the host we were asked to
 * bind); anything else gets 403 before a route is chosen.
 *
 * `[assumption]` `fs.watch(dir, { recursive: true })` is the watcher, with a
 * 500 ms mtime sweep as the fallback. Recursive watching is not available on
 * every platform/runtime pair (it landed late on Linux, and Bun's coverage is
 * its own matter), and a dashboard that silently stops updating is worse than
 * one that polls. Which one is in use is reported on the server handle so a test
 * can assert the fallback still delivers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";
import { buildModel } from "./model.ts";
import { renderDashboard } from "./render.ts";
import { EVENTS_PATH, MODEL_PATH, RELOAD_EVENT } from "./script.ts";

export const DEFAULT_PORT = 4477;
export const LOOPBACK = "127.0.0.1";
/**
 * Hostnames a loopback dashboard answers to, whatever port they carry.
 *
 * Only the NAME is checked, never the port: `ssh -L 5000:localhost:4477` and
 * `docker run -p` both change the port a browser asks for and neither is an
 * attack. The port is not what a rebinding page can forge; the name is.
 */
const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "::1"];
/** Collapse a burst of writes — a stage finishing touches several files at once. */
export const DEBOUNCE_MS = 300;
const POLL_MS = 500;
const HEARTBEAT_MS = 25_000;
/** Enough for a run tree; a cap so a stray symlink cannot make the sweep unbounded. */
const MAX_SWEEP_ENTRIES = 20_000;

export interface DashboardServerOptions {
  readonly root: string;
  /** 0 asks the OS for a free port — what the tests use. */
  readonly port?: number;
  readonly host?: string;
  /** Overridable so a test does not have to wait 300 ms. */
  readonly debounceMs?: number;
  /**
   * `"auto"` (the default) uses recursive `fs.watch` where the platform has it.
   * `"poll"` forces the mtime sweep — the path Linux CI may take on its own, so
   * a test can exercise it everywhere rather than only where it happens to run.
   */
  readonly watch?: "auto" | "poll";
}

export interface DashboardServer {
  readonly port: number;
  readonly url: string;
  /** "watch" when the OS told us about the change, "poll" on the fallback. */
  readonly watchMode: "watch" | "poll";
  close(): Promise<void>;
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<DashboardServer> {
  const root = options.root;
  const host = options.host ?? LOOPBACK;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const clients = new Set<ServerResponse>();
  const sockets = new Set<Socket>();

  const server = createServer((request, response) => {
    handle(root, host, request, response, clients);
  });
  // `server.close()` waits for open connections, and an idle keep-alive socket
  // or a parked SSE stream would make Ctrl-C hang. Track them, drop them on close.
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await listen(server, options.port ?? DEFAULT_PORT, host);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? DEFAULT_PORT);

  const watcher = watchWorkspace(root, debounceMs, options.watch ?? "auto", () => {
    for (const client of clients) send(client, RELOAD_EVENT, new Date().toISOString());
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    port,
    url: `http://${host}:${String(port)}`,
    watchMode: watcher.mode,
    close: async (): Promise<void> => {
      clearInterval(heartbeat);
      watcher.close();
      for (const client of clients) client.end();
      clients.clear();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closed;
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/**
 * The hostname inside a `Host` header, lowercased, port dropped, `null` if absent
 * or unparseable. `[::1]:4477` → `::1`; `example.com` → `example.com`.
 */
export function hostnameOfHeader(header: string | undefined): string | null {
  const value = (header ?? "").trim().toLowerCase();
  if (value === "") return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? null : value.slice(1, end);
  }
  // More than one colon and no brackets is a bare IPv6 literal — RFC 3986 says
  // it should be bracketed, but nothing forces a client to comply, and it cannot
  // carry a port in that shape, so the whole value is the name.
  if (value.split(":").length > 2) return value;
  const name = value.split(":")[0] ?? "";
  return name === "" ? null : name;
}

/** True when the request names us — a loopback host, or the host we bound to. */
export function isAllowedHost(header: string | undefined, boundHost: string): boolean {
  const name = hostnameOfHeader(header);
  if (name === null) return false;
  return LOOPBACK_HOSTNAMES.includes(name) || name === boundHost.toLowerCase();
}

function handle(
  root: string,
  boundHost: string,
  request: IncomingMessage,
  response: ServerResponse,
  clients: Set<ServerResponse>,
): void {
  // Before the method, before the route: a rebound name must not reach either.
  if (!isAllowedHost(request.headers.host, boundHost)) {
    text(
      response,
      403,
      `refused: Host \`${request.headers.host ?? "(absent)"}\` is not this machine\n`
      + `this dashboard answers to ${LOOPBACK_HOSTNAMES.join(", ")} only — reach it at `
      + `http://${LOOPBACK}:<port>/\n`,
    );
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    text(response, 405, "read-only: this server answers GET and nothing else\n");
    return;
  }
  const path = (request.url ?? "/").split("?")[0] ?? "/";

  if (path === EVENTS_PATH) {
    openStream(response, clients);
    return;
  }
  if (path === MODEL_PATH) {
    const body = `${JSON.stringify(buildModel(root, stamp(), { live: true }), null, 2)}\n`;
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }
  if (path === "/" || path === "/index.html") {
    const body = renderDashboard(buildModel(root, stamp(), { live: true }));
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }
  text(response, 404, `no such page: ${path}\nthis server serves /, ${MODEL_PATH} and ${EVENTS_PATH}\n`);
}

function openStream(response: ServerResponse, clients: Set<ServerResponse>): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  // Tell the browser how long to wait before reconnecting, then say hello so a
  // proxy cannot sit on an empty response.
  response.write("retry: 2000\n\n");
  send(response, "hello", new Date().toISOString());
  clients.add(response);
  response.on("close", () => clients.delete(response));
}

function send(response: ServerResponse, event: string, data: string): void {
  response.write(`event: ${event}\ndata: ${data}\n\n`);
}

function text(response: ServerResponse, code: number, body: string): void {
  response.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

/** ISO to the second — the page shows it, and the milliseconds are noise. */
function stamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface Watching {
  readonly mode: "watch" | "poll";
  close(): void;
}

/**
 * Watch `.tldrx/**` and `tldrx-work/**`, debounced.
 *
 * The workspace root itself is watched non-recursively too, so a dashboard
 * started in a directory that has neither folder yet comes alive the moment
 * `tldrx init` creates one.
 */
function watchWorkspace(
  root: string,
  debounceMs: number,
  requested: "auto" | "poll",
  onChange: () => void,
): Watching {
  const targets = [join(root, PROJECT_FRAMEWORK_DIR), join(root, PROJECT_WORK_DIR)];
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let mode: "watch" | "poll" = "watch";

  const fire = (): void => {
    if (closed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      arm();
      onChange();
    }, debounceMs);
    timer.unref();
  };

  const arm = (): void => {
    if (closed || mode === "poll") return;
    for (const dir of [root, ...targets]) {
      if (watchers.has(dir) || !existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: dir !== root, persistent: false }, () => fire());
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch {
        // One directory refused to be watched; the others still can be. The
        // decision to poll was already taken (or not) by `supportsRecursive`.
      }
    }
  };

  if (requested === "poll" || !supportsRecursive(root)) mode = "poll";
  else arm();

  let poller: ReturnType<typeof setInterval> | null = null;
  if (mode === "poll") {
    let previous = fingerprint(root, targets);
    poller = setInterval(() => {
      const next = fingerprint(root, targets);
      if (next !== previous) {
        previous = next;
        fire();
      }
    }, POLL_MS);
    poller.unref();
  }

  return {
    mode,
    close: (): void => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      if (poller !== null) clearInterval(poller);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

/**
 * Ask the platform once, up front, whether it can watch a tree.
 *
 * Recursive `fs.watch` is not universal — it arrived late on Linux and each
 * runtime implements it on its own schedule — so this probes rather than
 * assuming, and the answer decides the whole strategy instead of being
 * rediscovered halfway through.
 */
function supportsRecursive(dir: string): boolean {
  try {
    const probe = watch(dir, { recursive: true, persistent: false }, () => {});
    probe.close();
    return true;
  } catch {
    return false;
  }
}

/** A cheap "did anything change" string: every path plus its mtime and size. */
function fingerprint(root: string, targets: readonly string[]): string {
  const parts: string[] = [];
  let budget = MAX_SWEEP_ENTRIES;
  const walk = (dir: string): void => {
    if (budget <= 0) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const path = join(dir, entry);
      try {
        const stats = statSync(path);
        if (stats.isDirectory()) {
          parts.push(`${path}/`);
          walk(path);
        } else {
          parts.push(`${path}:${String(stats.mtimeMs)}:${String(stats.size)}`);
        }
      } catch {
        parts.push(`${path}:gone`);
      }
    }
  };
  parts.push(existsSync(join(root, PROJECT_FRAMEWORK_DIR)) ? "tldrx" : "-");
  for (const target of targets) if (existsSync(target)) walk(target);
  return parts.join("\n");
}
