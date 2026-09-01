/**
 * `tldrx update` — `npm i -g tldr-experts@latest`, and then the truth about what
 * that did (issue #62).
 *
 * ## Why it is a command and not a line in the README
 *
 * The owner installed 0.4.0 on a second machine and had no way to ask the tool to
 * update itself. The install command is one line, and one line in a README is a line
 * somebody types wrong, or types against the wrong package name, or types and then
 * has no idea what changed.
 *
 * ## The part that is not a wrapper
 *
 * **The new version is READ BACK from what npm installed**, out of
 * `$(npm root -g)/tldr-experts/package.json`, and the changelog delta is read out of
 * the CHANGELOG.md sitting beside it. Not out of the registry, and not out of the
 * process that is running — this process is the OLD build, and printing "you now
 * have X" from a number it has not verified is exactly the class of claim that has
 * no business being in a tool that reports on itself. If the read-back fails, it
 * says so and prints no delta, rather than guessing one.
 *
 * ## No network of its own
 *
 * `npm` talks to the registry; this does not. Everything external goes through one
 * transport with an asserted argv, for the same reason `core/run/ship.ts` has one:
 * it is the only way for the test suite to check the command without running it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { changelogDelta } from "./changelog.ts";
import { isNewer } from "./version.ts";
import { PACKAGE_NAME, userCachePath, writeCache } from "./notice.ts";

/** One external command. No cwd: `npm -g` is about the machine, not a directory. */
export interface UpdateTransport {
  run(cmd: string, args: readonly string[]): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

export const NPM_BIN = "npm";

/** A global install pulls a tarball over a network. Five minutes is generous and finite. */
export const UPDATE_TIMEOUT_MS = 300_000;

/** The one command this verb exists to run. Written once, printed and executed from here. */
export const INSTALL_ARGS: readonly string[] = ["i", "-g", `${PACKAGE_NAME}@latest`];

export function realUpdateTransport(): UpdateTransport {
  return {
    async run(cmd, args) {
      const out = await runtime.spawn(cmd, args, { env: process.env, timeoutMs: UPDATE_TIMEOUT_MS });
      return { exitCode: out.timedOut ? 124 : out.exitCode, stdout: out.stdout, stderr: out.stderr };
    },
  };
}

export interface UpdateOptions {
  /** The version running right now — `frameworkVersion()` at the call site. */
  readonly current: string;
  /** The user's home directory, for the version cache this refreshes on success. */
  readonly home: string;
  readonly transport: UpdateTransport;
  /** Run the checks, print the command, install nothing. */
  readonly dryRun?: boolean;
  /** Injected by the tests; the real one is `new Date()`. */
  readonly now?: Date;
}

export interface UpdateOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

const EXIT_OK = 0;
/** Spec §3: a real check ran and something is wrong. */
const EXIT_FAILED = 1;

export async function updateRun(options: UpdateOptions): Promise<UpdateOutcome> {
  const command = `${NPM_BIN} ${INSTALL_ARGS.join(" ")}`;

  const npm = await options.transport.run(NPM_BIN, ["--version"]);
  if (npm.exitCode !== 0) {
    return {
      code: EXIT_FAILED,
      lines: [
        "`npm` is not usable here, and it is what installs the update",
        `  \`${NPM_BIN} --version\` exited ${String(npm.exitCode)}`
          + (firstLine(npm.stderr) === "" ? "" : `: ${firstLine(npm.stderr)}`),
        "  install Node (which brings npm) and try again — nothing was installed.",
      ],
    };
  }

  if (options.dryRun === true) {
    return {
      code: EXIT_OK,
      lines: [
        `would update ${PACKAGE_NAME} from ${options.current} to whatever npm calls \`latest\``,
        `  ${command}`,
        "  --dry-run: nothing was installed.",
      ],
    };
  }

  const installed = await options.transport.run(NPM_BIN, INSTALL_ARGS);
  if (installed.exitCode !== 0) {
    return {
      code: EXIT_FAILED,
      lines: [
        `\`${command}\` failed (exit ${String(installed.exitCode)}) — nothing was installed`,
        ...(firstLine(installed.stderr) === "" ? [] : [`  ${firstLine(installed.stderr)}`]),
        `  the command, to run by hand: ${command}`,
      ],
    };
  }

  // What is actually on disk now. Everything below is read from THERE.
  const dir = await installDir(options.transport);
  const after = dir === null ? null : readVersion(join(dir, "package.json"));
  if (dir === null || after === null) {
    return {
      code: EXIT_OK,
      lines: [
        `\`${command}\` finished`,
        "  could not read the installed version back from `npm root -g`, so there is no",
        "  changelog to show. `tldrx --version` in a NEW shell says what you now have.",
      ],
    };
  }

  // The cache the notice reads: refreshed here so it stops talking immediately,
  // rather than a day from now when the background check next runs.
  writeCache(userCachePath(options.home), {
    latest: after,
    checked_at: (options.now ?? new Date()).toISOString(),
  });

  if (!isNewer(after, options.current)) {
    return {
      code: EXIT_OK,
      lines: [
        `already on ${PACKAGE_NAME} ${after} — \`${command}\` installed nothing new`,
      ],
    };
  }

  const delta = changelogDelta(readTextOrEmpty(join(dir, "CHANGELOG.md")), options.current, after);
  return {
    code: EXIT_OK,
    lines: [
      `updated ${PACKAGE_NAME} ${options.current} → ${after}`,
      ...(delta === ""
        ? ["  the installed CHANGELOG.md has no section between those two versions."]
        : ["", ...delta.split("\n")]),
    ],
  };
}

/** `$(npm root -g)/tldr-experts`, or null when npm would not say. */
async function installDir(transport: UpdateTransport): Promise<string | null> {
  const root = await transport.run(NPM_BIN, ["root", "-g"]);
  const line = root.stdout.split("\n").map((entry) => entry.trim()).find((entry) => entry !== "");
  if (root.exitCode !== 0 || line === undefined) return null;
  return join(line, PACKAGE_NAME);
}

function readVersion(path: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

function readTextOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}
