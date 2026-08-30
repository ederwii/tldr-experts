/** `tldrx next` — Advance the active run to its next stage
 *
 * Spec §5 (the facilitator algorithm), §3 (exit codes 0/1/2/4/5). Two execution
 * modes over one code path:
 *
 *   headless   `tldrx next`                spawns `claude -p` itself
 *   in-session `tldrx next --prepare`      writes the prompt bundle and stops
 *              `tldrx next --commit`       validates what the host session produced
 *
 * From "re-read the outputs off disk" onwards the two are literally the same
 * function, which is the point: whichever way the work was done, it is judged by
 * the same rules.
 */
import type { Command } from "../Command.ts";
import {
  EXIT_AGENT_FAILED, EXIT_AWAITING_HUMAN, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE,
} from "../exitCodes.ts";
import { boolFlag, numberFlag, parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { startUi } from "../ui.ts";
import { effortFlag } from "../effort.ts";
import { fail } from "../report.ts";
import { runNext, type NextMode } from "../../core/facilitator/runNext.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";
import { buildWorkspaceStatus, renderWorkspaceStatus } from "../../core/status/index.ts";

/** Codes whose report belongs on stdout: the run is fine, it just needs a human. */
const INFORMATIONAL: readonly number[] = [EXIT_OK, EXIT_AWAITING_HUMAN];

export const nextCommand: Command = {
  name: "next",
  summary: "Advance the active run to its next stage",
  usage: "tldrx next [<run>] [--dry-run] [--prepare|--commit] [--model <m>] [--effort <level>] [--max-usd <n>]\n"
    + "                  [--prompt-max-bytes <n>] [--max-reads <n>]\n"
    + "                  [--yolo] [--keep-worktrees] [--ui scene|compact|plain|off] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, [
        "run", "model", "effort", "max-usd", "prompt-max-bytes", "max-reads", "root", "ui",
      ]);
      const root = workspaceRootFrom(args);
      const mode = resolveMode(args.flags.has("prepare"), args.flags.has("commit"));
      const runId = args.positionals[0] ?? stringFlag(args, "run");

      const dryRun = boolFlag(args, "dry-run");
      // `--prepare`, `--commit` and `--dry-run` spawn nothing, so there is
      // nothing to watch: the handle they get is inert.
      const ui = startUi(args, { root, spawns: mode === "headless" && !dryRun });
      let outcome;
      try {
        outcome = await runNext({
          root,
          runId,
          dryRun,
          mode,
          model: stringFlag(args, "model"),
          effort: effortFlag(args),
          maxUsd: numberFlag(args, "max-usd"),
          promptMaxBytes: numberFlag(args, "prompt-max-bytes"),
          maxReads: numberFlag(args, "max-reads"),
          yolo: boolFlag(args, "yolo"),
          keepWorktrees: boolFlag(args, "keep-worktrees"),
          actor: currentActor(),
          at: nowRfc3339(),
        });
      } finally {
        // Before a single byte of the report is written, so the view never sits
        // half-drawn under it — and on the throw path too.
        ui.stop();
      }

      // "There is no run" is the one refusal a human cannot act on from the
      // message alone — it says what is missing, never what to do instead. The
      // pending report is exactly that answer, and it costs a few file reads. The
      // exit code is untouched: this is context in front of the same `3`.
      if (outcome.code === EXIT_NOT_FOUND && runId === undefined) {
        process.stdout.write(`${renderWorkspaceStatus(buildWorkspaceStatus(root))}\n\n`);
      }

      const text = `${outcome.lines.join("\n")}\n`;
      if (INFORMATIONAL.includes(outcome.code)) process.stdout.write(text);
      else process.stderr.write(prefix(text));
      // Advisories never change the exit code and never gate anything; they go to
      // stderr so a `--prepare` whose stdout a script parses stays parseable.
      for (const line of outcome.stderr ?? []) process.stderr.write(`${line}\n`);
      return outcome.code;
    } catch (error) {
      if (error instanceof UsageError) return fail("next", error, EXIT_USAGE);
      return fail("next", error, codeFor(error));
    }
  },
};

function resolveMode(prepare: boolean, commit: boolean): NextMode {
  if (prepare && commit) throw new UsageError("--prepare and --commit are two halves of one handshake, not both at once");
  if (prepare) return "prepare";
  if (commit) return "commit";
  return "headless";
}

function prefix(text: string): string {
  return text
    .split("\n")
    .map((line, i) => (line === "" ? line : i === 0 ? `tldrx next: ${line}` : `  ${line}`))
    .join("\n");
}

/**
 * A throw that escapes `runNext` is a bug or a broken file, not a gate. Only the
 * codes the spec's §3 row for `next` lists ever come back deliberately; anything
 * else lands on 1.
 */
function codeFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("no run.yml")) return EXIT_NOT_FOUND;
  if (message.includes("refused")) return EXIT_GATE_REFUSED;
  if (message.includes("sub-agent")) return EXIT_AGENT_FAILED;
  return EXIT_USAGE;
}
