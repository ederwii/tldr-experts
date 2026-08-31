/**
 * `tldrx dashboard` — watch the files live, or export one static page (§12).
 *
 * Both modes render the same model through the same renderer; the only
 * difference is whether the page keeps listening. Neither writes anything into
 * the workspace beyond the requested export, and no route on the server accepts
 * anything but a GET.
 *
 * Ctrl-C is a first-class exit here, not a crash: SIGINT closes the listener and
 * the watcher and returns 0, because the thing being interrupted is a viewer.
 */
import { isAbsolute, join } from "node:path";
import type { Command } from "../Command.ts";
import { boolFlag, numberFlag, parseArgs, stringFlag, UsageError } from "../argv.ts";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { resolveWorkspaceRoot } from "../../core/experts/index.ts";
import { runtime } from "../../core/runtime/index.ts";
import {
  DEFAULT_OUT_DIR, DEFAULT_PORT, startDashboardServer, writeStaticDashboard,
} from "../../core/dashboard/index.ts";

const VALUE_FLAGS = ["out", "root", "port"] as const;

export const dashboardCommand: Command = {
  name: "dashboard",
  summary: "Watch the workspace live in a browser, or export it as one static page",
  usage: "tldrx dashboard [--port <n>] [--open] [--root <path>] | tldrx dashboard --static [--out <dir>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    let args;
    try {
      args = parseArgs(argv, [...VALUE_FLAGS]);
    } catch (error) {
      process.stderr.write(`tldrx dashboard: ${message(error)}\n`);
      return EXIT_USAGE;
    }

    const root = resolveWorkspaceRoot(stringFlag(args, "root") ?? null);
    return boolFlag(args, "static") ? exportStatic(args, root) : serve(args, root);
  },
};

function exportStatic(args: ReturnType<typeof parseArgs>, root: string): number {
  const out = stringFlag(args, "out");
  const outDir = out === undefined ? join(root, DEFAULT_OUT_DIR) : isAbsolute(out) ? out : join(root, out);
  try {
    const written = writeStaticDashboard(root, outDir, stamp());
    // A run folder that did not parse is named here rather than quietly missing
    // from the count: "0 run(s)" at a workspace that visibly holds one is a lie.
    const unreadable = written.unreadable === 0
      ? ""
      : `, ${String(written.unreadable)} unreadable`;
    process.stdout.write(
      `wrote ${written.path} (${String(written.bytes)} bytes)\n`
        + `  ${String(written.runs)} run(s)${unreadable}, ${String(written.experts)} expert(s), `
        + "no external requests\n",
    );
    return EXIT_OK;
  } catch (error) {
    process.stderr.write(`tldrx dashboard: ${message(error)}\n`);
    return EXIT_FAILED;
  }
}

async function serve(args: ReturnType<typeof parseArgs>, root: string): Promise<number> {
  let port: number;
  try {
    port = numberFlag(args, "port") ?? DEFAULT_PORT;
  } catch (error) {
    process.stderr.write(`tldrx dashboard: ${message(error)}\n`);
    return EXIT_USAGE;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    process.stderr.write(`tldrx dashboard: --port expects 0-65535, got '${String(port)}'\n`);
    return EXIT_USAGE;
  }

  let server;
  try {
    server = await startDashboardServer({ root, port });
  } catch (error) {
    process.stderr.write(
      `tldrx dashboard: could not listen on port ${String(port)} — ${message(error)}\n`
        + "  another dashboard may already be running; try --port 0 for any free port\n",
    );
    return EXIT_FAILED;
  }

  process.stdout.write(
    `tldrx dashboard: ${server.url}\n`
      + `  watching ${root} (.tldrx/ and tldrx-work/, ${server.watchMode === "poll" ? "polled" : "file events"})\n`
      + "  read-only — this page never writes. Ctrl-C to stop.\n",
  );

  if (boolFlag(args, "open")) await open(server.url);

  await untilInterrupted();
  await server.close();
  process.stdout.write("tldrx dashboard: stopped\n");
  return EXIT_OK;
}

/** Resolves on SIGINT/SIGTERM. The only thing keeping the command alive. */
function untilInterrupted(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/**
 * `--open`, through the runtime seam's spawn.
 *
 * `[assumption]` The seam has no "open a URL" capability and the platform
 * openers are not interchangeable, so the mapping lives here. A failure is
 * reported and ignored — the URL is already on stdout, and not having a browser
 * is not a reason to refuse to serve.
 */
async function open(url: string): Promise<void> {
  const [cmd, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const result = await runtime.spawn(cmd as string, args as string[]);
  if (result.exitCode !== 0) {
    process.stderr.write(`tldrx dashboard: could not open a browser (${cmd as string} exited ${String(result.exitCode)})\n`);
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function message(error: unknown): string {
  return error instanceof UsageError || error instanceof Error ? error.message : String(error);
}
