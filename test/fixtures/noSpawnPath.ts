/**
 * A PATH on which `claude` is a refusal.
 *
 * Written after a measured incident (2026-08-29): a stale test asserted that
 * `tldrx expert train` was a stub, wave 7 made it real, and the test spawned a
 * genuine `claude -p` against a checked-in fixture with a $2.00 ceiling. It wrote
 * a knowledge file into the repo and cost real money that no ledger recorded,
 * because the test process was killed at its 5 s timeout before the run finished.
 *
 * Every fixture that drives a spawning command through a REAL `tldrx` subprocess
 * uses this: the live PATH with one directory prepended, holding a `claude` that
 * exits 1 immediately. `bun`, `git` and everything else still resolve; the real
 * `claude` can no longer be reached, whatever a test asserts or forgets to.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeGuard(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-noclaude-"));
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "claude");
  writeFileSync(
    shim,
    "#!/bin/sh\n"
    + 'echo "test guard: the real \\`claude\\` is not reachable from the test suite" >&2\n'
    + "exit 1\n",
    "utf8",
  );
  chmodSync(shim, 0o755);
  return dir;
}

const GUARD_DIR = makeGuard();

/** The live PATH with the refusing `claude` first. */
export const NO_CLAUDE_PATH: string = `${GUARD_DIR}:${process.env.PATH ?? ""}`;

/** Child env for a `tldrx` subprocess that must never spend money. */
export function noSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.PATH = NO_CLAUDE_PATH;
  return env;
}
