/**
 * Did the commands `tldrx init` is about to write actually run? (#168)
 *
 * `commands:` is the DoD gate's allowlist and it stays byte-identical — this writes
 * an ADDITIVE sibling, `command_probes:`, saying what was measured about each one.
 * The reason it is needed: `detect/commands.ts` claims in its own header that
 * "nothing here is conventional wisdom about a stack", and then SYNTHESISES
 * `go build ./...`, `cargo test` and `dotnet build` from the language id alone, plus
 * python's tools from a MENTION in a manifest. Those are conventions, and a
 * `workspace.yml` that presents them beside a `package.json`-sourced command with no
 * way to tell them apart is a file that cannot be checked. Before this, a workspace
 * could be born with a `build:` that does not exist and the first Build run found out
 * hours later.
 *
 * Four rules, each one the difference between a record and a guess:
 *   - `run` is NEVER probed. It starts a server (`dev`/`start`/`dotnet run`) and a
 *     probe of it either hangs or leaves a process behind. Its row says so.
 *   - Everything goes through `CommandRunner`, argv-only, so nothing is ever
 *     string-concatenated into a shell — the same seam detection already spawns git
 *     through, and the same seam a test injects a fake into.
 *   - The DEADLINE is enforced here, and the classification is
 *     completion-before-deadline. A slow-but-successful probe is a pass, never a
 *     timeout; and a runner that hangs forever still produces a row, because the
 *     probe does not borrow its notion of "too long" from whatever it was handed.
 *   - Nothing is inferred, and in particular **`exited 127` and `never started` are
 *     not the same row**. Both reach this file as exit 127, because both runtimes
 *     settle a failed spawn that way; the seam now reports `spawnFailed` beside it
 *     (`runtime/Runtime.ts`), so a machine with no `go` on PATH gets
 *     `status: unspawnable`, `exit_code: null` and "could not be started — spawn go
 *     ENOENT", while `npm run build` whose `vite` is missing gets the 127 it really
 *     exited with. Writing the first as a measurement is the dangerous direction
 *     (AGENTS.md §7), and it is what shipped before review round 1 caught it.
 *
 * There is exactly ONE derivation of a row — `probeRow` below. Status, `verified`,
 * `exit_code` and `reason` are decided together, in one place, so they cannot drift:
 * `verified` is `status === "ok"` by construction, and `exit_code` is non-null only
 * for a status that means a process actually exited.
 */
import { splitArgv } from "../../hooks/lib/story.ts";
import type { CommandRunner } from "./CommandRunner.ts";
import { COMMAND_SLOTS, type CommandSlot } from "./types.ts";

/**
 * The four slots a gate can meaningfully run. `run` starts a server; it is not one.
 *
 * Data rather than a branch inside the loop, so the exclusion is one thing a reader
 * can check and one thing a test can pin.
 */
export const PROBED_SLOTS: readonly CommandSlot[] = ["build", "test", "lint", "typecheck"];

/**
 * Every outcome a probe can have, named once (§7: one implementation per derivation).
 *
 * Before this existed the six states lived only in the `reason` sentence, and
 * `build/preflight.ts` had to ask `verified === false && exit_code !== null` to mean
 * "measured red" — a machine reading a sentence's side effect. `status` is additive
 * and does not bump `version:` (§7, formats only grow).
 *
 *   `ok`          the command ran and exited 0
 *   `failed`      it ran and exited non-zero — a MEASURED red, and the only status
 *                 anything is entitled to cite as evidence that a command is broken
 *   `timed-out`   it was still running at the deadline; nothing exited
 *   `unspawnable` it never started (ENOENT/EACCES); nothing exited
 *   `not-probed`  it was never going to be run — `run`, or a command needing a shell
 *   `skipped`     the operator said not to (`--no-probe`)
 */
export const PROBE_STATUSES = ["ok", "failed", "timed-out", "unspawnable", "not-probed", "skipped"] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

/** The statuses in which a process really exited, so `exit_code` is a measurement. */
const EXITED: readonly ProbeStatus[] = ["ok", "failed"];

/**
 * How long a single probe may take before it is recorded as a timeout.
 *
 * Two minutes: `init` is already a minutes-long command (measured 36.0 s on a
 * five-repo workspace for the code map alone), and a build that cannot finish in two
 * minutes is a fact worth RECORDING, not worth waiting for. It is also
 * `SpawnCommandRunner`'s own default timeout (`CommandRunner.ts:22`), so the runner
 * `init` hands in kills the child at the same moment this file stops waiting for it.
 */
export const PROBE_TIMEOUT_MS = 120_000;

export interface CommandProbe {
  /** Which of the six outcomes this was. The field every consumer should branch on. */
  readonly status: ProbeStatus;
  /** True only when the command ran to completion and exited 0 — i.e. `status === "ok"`. */
  readonly verified: boolean;
  /** The measured exit code, or null when nothing exited (timeout, unspawnable, not probed). */
  readonly exit_code: number | null;
  /** When this probe was taken. The caller's clock — this file reads none. */
  readonly at: string;
  /** Why `status` is what it is — always a sentence, never empty. */
  readonly reason: string;
}

export type CommandProbes = Partial<Record<CommandSlot, CommandProbe>>;

export interface ProbeOptions {
  readonly at: string;
  readonly timeoutMs: number;
  /** Slots whose command came from the language id rather than from a file. */
  readonly synthesised: ReadonlySet<string>;
  /**
   * Do not probe at all, and record THIS as the reason on every slot that would have
   * been probed (`--no-probe` passes "skipped: --no-probe").
   *
   * A skipped slot is still written, because "absent" and "we chose not to look" are
   * different facts and only one of them is recoverable from a file that says nothing.
   * `run` keeps its own reason: it is not skipped, it is never probed.
   */
  readonly skip?: string;
}

/**
 * The ONE derivation of a probe row.
 *
 * `verified` and `exit_code` are decided FROM `status` here and nowhere else, so a row
 * can never say `status: "timed-out"` beside a confident exit code, or `verified: true`
 * beside a red one.
 */
function probeRow(status: ProbeStatus, exitCode: number, at: string, reason: string): CommandProbe {
  return {
    status,
    verified: status === "ok",
    exit_code: EXITED.includes(status) ? exitCode : null,
    at,
    reason,
  };
}

export async function probeCommands(
  runner: CommandRunner,
  repoDir: string,
  commands: Readonly<Partial<Record<CommandSlot, string | null>>>,
  options: ProbeOptions,
): Promise<CommandProbes> {
  const probes: Record<string, CommandProbe> = {};
  for (const slot of COMMAND_SLOTS) {
    const command = commands[slot] ?? null;
    if (command === null || command === "") continue;
    const origin = options.synthesised.has(slot)
      ? " (this command was synthesised from the language id, not read from a file)"
      : "";
    const row = (status: ProbeStatus, exitCode: number, reason: string): void => {
      probes[slot] = probeRow(status, exitCode, options.at, `${reason}${origin}`);
    };

    if (!PROBED_SLOTS.includes(slot)) {
      row("not-probed", 0, `not probed: \`${slot}\` starts a long-running process`);
      continue;
    }
    if (options.skip !== undefined) {
      row("skipped", 0, options.skip);
      continue;
    }
    const argv = splitArgv(command);
    if (argv === null) {
      row("not-probed", 0, `not probed: \`${command}\` needs a shell and this probe does not open one`);
      continue;
    }

    const outcome = await raceDeadline(runner, argv, repoDir, options.timeoutMs);
    if (outcome.kind === "timeout") {
      row("timed-out", 0, `not verified: \`${command}\` timed out after ${seconds(options.timeoutMs)}`);
      continue;
    }
    if (outcome.kind === "unspawnable") {
      row("unspawnable", 0, `not probed: \`${command}\` could not be started — ${outcome.why}`);
      continue;
    }
    if (outcome.exitCode === 0) {
      row("ok", 0, `verified: \`${command}\` exited 0`);
      continue;
    }
    // 127 is a real exit code here — the command STARTED and exited 127, which is what
    // `npm run build` does when the script's own binary is missing. Naming that is the
    // difference between "your build is red" and "your toolchain is not installed", and
    // the operator needs the second one first.
    const missing = outcome.exitCode === 127 ? " — the command, or something it runs, was not found" : "";
    row("failed", outcome.exitCode, `not verified: \`${command}\` exited ${String(outcome.exitCode)}${missing}`);
  }
  return probes;
}

type Outcome =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "unspawnable"; readonly why: string };

/**
 * The run, or the deadline, whichever lands first.
 *
 * The timer is cleared on every path: a pending `setTimeout` keeps node's event loop
 * alive, and `tldrx init` would sit for two minutes after printing its report.
 *
 * Three things can come back from the runner, and they are told apart by what the seam
 * reports rather than by the exit code: `spawnFailed` (nothing started), `timedOut` (the
 * runner killed it at ITS deadline, which is not this one), and an ordinary exit. A
 * runner that rejects outright is the fourth, and it lands in the same `unspawnable` row.
 */
async function raceDeadline(
  runner: CommandRunner,
  argv: readonly string[],
  repoDir: string,
  timeoutMs: number,
): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => { resolve({ kind: "timeout" }); }, Math.max(0, timeoutMs));
  });
  const ran = runner.run(argv, repoDir).then(
    (result): Outcome => {
      if (result.spawnFailed === true) {
        return { kind: "unspawnable", why: firstLine(result.stderr) };
      }
      if (result.timedOut === true) return { kind: "timeout" };
      return { kind: "exited", exitCode: result.exitCode };
    },
    (error: unknown): Outcome => ({ kind: "unspawnable", why: messageOf(error) }),
  );
  try {
    return await Promise.race([ran, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return firstLine(text);
}

/**
 * One line, trimmed and capped.
 *
 * `reason` is the only free text in `workspace.yml`, and this is the only input to it
 * that is not built from the command string: a system message goes in, so it is bounded
 * here rather than trusted.
 */
function firstLine(text: string): string {
  const line = (text.split("\n").find((entry) => entry.trim() !== "") ?? "").trim();
  if (line === "") return "no reason given";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** `120s`, `20ms` — never a rounded-to-zero "0s" for a sub-second budget. */
function seconds(timeoutMs: number): string {
  return timeoutMs >= 1000 ? `${String(Math.round(timeoutMs / 1000))}s` : `${String(timeoutMs)}ms`;
}
