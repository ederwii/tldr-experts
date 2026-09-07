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
 *   - Nothing is inferred. A timeout is `verified: false` with `exit_code: null` and
 *     "timed out after Ns"; a non-zero exit is `verified: false` with the real code; a
 *     command that could not be started says that, and not that it timed out. None of
 *     those is an absence and none of them is a guess.
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
  /** True only when the command ran to completion and exited 0. */
  readonly verified: boolean;
  /** The measured exit code, or null when nothing exited (timeout, unspawnable, not probed). */
  readonly exit_code: number | null;
  /** When this probe was taken. The caller's clock — this file reads none. */
  readonly at: string;
  /** Why `verified` is what it is — always a sentence, never empty. */
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
    const absent = (reason: string): void => {
      probes[slot] = { verified: false, exit_code: null, at: options.at, reason };
    };

    if (!PROBED_SLOTS.includes(slot)) {
      absent(`not probed: \`${slot}\` starts a long-running process${origin}`);
      continue;
    }
    if (options.skip !== undefined) {
      absent(`${options.skip}${origin}`);
      continue;
    }
    const argv = splitArgv(command);
    if (argv === null) {
      absent(`not probed: \`${command}\` needs a shell and this probe does not open one${origin}`);
      continue;
    }

    const outcome = await raceDeadline(runner, argv, repoDir, options.timeoutMs);
    if (outcome.kind === "timeout") {
      absent(`not verified: \`${command}\` timed out after ${seconds(options.timeoutMs)}${origin}`);
      continue;
    }
    if (outcome.kind === "unspawnable") {
      absent(`not probed: \`${command}\` could not be started — ${outcome.why}${origin}`);
      continue;
    }
    probes[slot] = {
      verified: outcome.exitCode === 0,
      exit_code: outcome.exitCode,
      at: options.at,
      reason: outcome.exitCode === 0
        ? `verified: \`${command}\` exited 0${origin}`
        : `not verified: \`${command}\` exited ${String(outcome.exitCode)}${origin}`,
    };
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
    (result): Outcome => ({ kind: "exited", exitCode: result.exitCode }),
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
  return text === "" ? "no reason given" : text;
}

/** `120s`, `20ms` — never a rounded-to-zero "0s" for a sub-second budget. */
function seconds(timeoutMs: number): string {
  return timeoutMs >= 1000 ? `${String(Math.round(timeoutMs / 1000))}s` : `${String(timeoutMs)}ms`;
}
