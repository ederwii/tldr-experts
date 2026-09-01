/**
 * "A newer tldr-experts is out" — one line, never on the hot path (issue #62).
 *
 * ## The shape the issue fixed, and why each half of it is here
 *
 * The owner asked for an oh-my-zsh-style notice, and then wrote down the four
 * constraints that make one tolerable. They are not preferences; they are what
 * separates a courtesy from a tax:
 *
 *   **Zero network on the hot path.** A command READS A FILE. The registry call
 *   happens in a DETACHED child spawned after the output is written, and its answer
 *   is for the NEXT invocation. `tldrx status` is never slower because npm is.
 *
 *   **Silent on any failure.** A refused connection, a 500, a body that is not the
 *   JSON we asked for, an unwritable home directory: every one of them writes
 *   nothing and says nothing. There is no failure mode in which this feature
 *   produces an error message.
 *
 *   **Never in `--json`, never during a hook.** A JSON consumer must never be
 *   handed prose, and a hook must stay deterministic — spec §0. Both are refused by
 *   `suppressionReason` before anything is read.
 *
 *   **One line.** Asserted as an exact string in `test/update-notice.test.ts`,
 *   because "roughly this sentence" is how one line becomes three.
 *
 * ## On by default, with two opt-outs (owner decision, 2026-09-01)
 *
 * `TLDRX_UPDATE_CHECK=off` for one shell or one CI job, and `update_check: off` in
 * `~/.tldrx/config.yml` for the machine. The env var is spelled like every other
 * one this framework reads (`TLDRX_UI`, `TLDRX_CLAUDE_BIN`); the file is YAML under
 * the user config dir, which is where the cache already lives, so opting out does
 * not mean learning a new place.
 *
 * ## Where the state lives
 *
 * `~/.tldrx/version-check.json` — `{latest, checked_at}`, one object, refreshed at
 * most once a day. It is the user's, not the workspace's: which version of the CLI
 * is installed is a fact about the machine, and putting it in a repo's `.tldrx/`
 * would put it in someone's diff.
 *
 * Nothing here is behind the runtime seam. The seam exists for capabilities that
 * DIFFER between Bun and Node (`src/core/runtime/Runtime.ts`), and its invariant is
 * `grep -rn 'Bun\.' src` outside that folder; `node:child_process` and `fetch`
 * behave identically on both, so a third implementation of each would buy nothing.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { isNewer, parseVersion } from "./version.ts";

/** The npm package this CLI is published as. */
export const PACKAGE_NAME = "tldr-experts";

/** `latest` only — the whole document would be a megabyte of every version ever. */
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/** The background child gets a hard stop: a hung socket must not outlive the shell. */
export const REGISTRY_TIMEOUT_MS = 5_000;

/** Once a day. A release is not an event you need to hear about within the hour. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The env opt-out. Spelled like `TLDRX_UI` and `TLDRX_CLAUDE_BIN`. */
export const UPDATE_CHECK_ENV = "TLDRX_UPDATE_CHECK";

/** The key in `~/.tldrx/config.yml` that means the same thing, permanently. */
export const UPDATE_CHECK_KEY = "update_check";

/** The user config dir — `~/.tldrx/`, the twin of a workspace's `.tldrx/`. */
export const USER_DIR = ".tldrx";

/**
 * The argv0 the detached child is spawned with.
 *
 * Not a command and not a flag: it is handled in `dispatch` before the table, the
 * way `learnAgent`'s stand-in already is, so it never appears in `tldrx --help`,
 * never has to be declared in the flag registry, and nobody can type it by accident.
 */
export const VERSION_CHECK_ARGV0 = "__version-check";

export interface VersionCache {
  /** The version the registry called `latest` when it was last asked. */
  readonly latest: string;
  /** RFC3339, so the file is legible to the person who finds it. */
  readonly checked_at: string;
}

export function userDir(home: string): string {
  return join(home, USER_DIR);
}

export function userCachePath(home: string): string {
  return join(userDir(home), "version-check.json");
}

export function userConfigPath(home: string): string {
  return join(userDir(home), "config.yml");
}

/** The cache, or null for missing, unreadable, malformed or half-written. */
export function readCache(path: string): VersionCache | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const latest = (doc as { latest?: unknown } | null)?.latest;
  const checkedAt = (doc as { checked_at?: unknown } | null)?.checked_at;
  if (typeof latest !== "string" || latest === "") return null;
  if (typeof checkedAt !== "string" || checkedAt === "") return null;
  return { latest, checked_at: checkedAt };
}

/** Best effort. A home directory that cannot be written to is not an error here. */
export function writeCache(path: string, cache: VersionCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch {
    // Silent by design: the notice is a courtesy, and a courtesy never fails loudly.
  }
}

/** Was this cache written within the TTL, by a clock that ran forwards? */
export function isFresh(cache: VersionCache, nowMs: number, ttlMs: number = CACHE_TTL_MS): boolean {
  const at = Date.parse(cache.checked_at);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= 0 && age <= ttlMs;
}

export interface NoticeInput {
  /** The command about to run (or that just ran), by its dispatch-table name. */
  readonly command: string;
  /** Its argv, minus the command name. */
  readonly argv: readonly string[];
  /** Is stdout a terminal? A courtesy line is for a human, not for a pipe. */
  readonly isTty: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory — where the cache and the config live. */
  readonly home: string;
}

/** Commands during which the notice must never appear. */
const SILENT_COMMANDS: ReadonlySet<string> = new Set([
  // Hook execution: spec §0 says a hook is deterministic, and a hook's stderr is
  // read by Claude Code. Both `hook` and `statusline` spawn one.
  "hook",
  "statusline",
  // `update` is about to say considerably more than one line about this exact topic.
  "update",
]);

const OFF_WORDS: ReadonlySet<string> = new Set(["off", "0", "false", "no", "never"]);

/** Why the notice must stay silent, or null when it may speak. */
export function suppressionReason(input: NoticeInput): string | null {
  if (SILENT_COMMANDS.has(input.command)) return `${input.command} must stay deterministic`;
  if (input.argv.some((arg) => arg === "--json" || arg.startsWith("--json="))) {
    return "--json output carries no prose";
  }
  if (!input.isTty) return "stdout is not a terminal";
  const ci = input.env.CI ?? "";
  if (ci !== "" && !OFF_WORDS.has(ci.toLowerCase())) return "CI";
  const flag = input.env[UPDATE_CHECK_ENV];
  if (flag !== undefined && OFF_WORDS.has(flag.trim().toLowerCase())) return `${UPDATE_CHECK_ENV} is off`;
  if (configSaysOff(input.home)) return `${UPDATE_CHECK_KEY} is off in ${userConfigPath(input.home)}`;
  return null;
}

/**
 * `update_check: off` in the user config.
 *
 * Both a YAML boolean and the WORD are accepted: YAML 1.1 reads a bare `off` as
 * `false` and YAML 1.2 reads it as the string `"off"`, and which one the host
 * runtime implements is not something a person editing this file should have to
 * know. A file that does not exist, does not parse, or says something else, is not
 * an opt-out.
 */
function configSaysOff(home: string): boolean {
  const path = userConfigPath(home);
  if (!existsSync(path)) return false;
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  const value = (doc as Record<string, unknown> | null)?.[UPDATE_CHECK_KEY];
  if (value === false) return true;
  return typeof value === "string" && OFF_WORDS.has(value.trim().toLowerCase());
}

/**
 * The line, or null when there is nothing to say.
 *
 * The wording is the issue's, to the character. It is one line and carries the
 * command that acts on it, so nobody has to go looking for what to type.
 */
export function noticeLine(latest: string, current: string): string | null {
  if (!isNewer(latest, current)) return null;
  return `${PACKAGE_NAME} ${latest} available (you have ${current}) — tldrx update`;
}

export interface VersionCheckOptions {
  readonly home: string;
  readonly now: Date;
  readonly fetchText: (url: string, timeoutMs: number) => Promise<string>;
}

/**
 * ONE registry call, and the cache write it earns. This is the whole job of the
 * detached child.
 *
 * Every failure path is the same path: return, having written nothing. A version
 * that does not parse is treated as a failure too — a cache holding `"<html>"`
 * would produce a notice about a version that does not exist.
 */
export async function versionCheckOnce(options: VersionCheckOptions): Promise<void> {
  try {
    const body = await options.fetchText(REGISTRY_URL, REGISTRY_TIMEOUT_MS);
    const latest = (JSON.parse(body) as { version?: unknown } | null)?.version;
    if (typeof latest !== "string" || parseVersion(latest) === null) return;
    writeCache(userCachePath(options.home), { latest, checked_at: options.now.toISOString() });
  } catch {
    // Silent on ANY network failure — the issue's word, and its whole point.
  }
}

/** The real fetch, with a hard timeout. Only the detached child ever calls it. */
export async function fetchRegistryText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`registry answered ${String(response.status)}`);
  return await response.text();
}

/**
 * Spawn the check into its own process and forget it.
 *
 * `detached` + `stdio: "ignore"` + `unref()` is what makes this off the hot path in
 * fact and not just in intent: the parent's event loop has nothing left holding it,
 * so `tldrx` exits at the same moment it would have without this line, and the
 * child's output can reach no terminal even if something in it decided to print.
 */
export function scheduleVersionCheck(entry: string | undefined = process.argv[1]): void {
  try {
    if (entry === undefined || entry === "") return;
    const child = spawn(process.execPath, [entry, VERSION_CHECK_ARGV0], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // A machine that will not fork is not a machine that needs telling about it.
  }
}

/**
 * Print the notice if the cache has one to print, then top the cache up if it is
 * stale. Reads one small file; spawns at most one detached child; never awaits a
 * network call. Any throw is swallowed — a courtesy line may not break a command.
 *
 * `current` is a THUNK, not a string, and that is not fussiness: it is
 * `frameworkVersion()`, which reads `package.json` off disk. Suppression is decided
 * first, so a hook — whose whole budget is 50 ms (spec §0) — pays nothing at all for
 * a feature that is switched off for it. Awaiting it before the check would have
 * added a file read to every invocation of every command, which is the hot-path cost
 * this feature was designed not to have.
 */
export async function announceVersion(
  input: NoticeInput,
  current: () => Promise<string>,
): Promise<void> {
  try {
    if (suppressionReason(input) !== null) return;
    const path = userCachePath(input.home);
    const cache = readCache(path);
    if (cache !== null) {
      const line = noticeLine(cache.latest, await current());
      // stderr, so a command's stdout stays exactly what it was.
      if (line !== null) process.stderr.write(`${line}\n`);
    }
    if (cache === null || !isFresh(cache, Date.now())) scheduleVersionCheck();
  } catch {
    // Deliberately nothing.
  }
}
