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
  usage: "tldrx next [<run>] [--dry-run] [--prepare|--commit] [--review] [--fixlist <path>]\n"
    + "                  [--model <m>] [--effort <level>]\n"
    + "                  [--max-usd <n>] [--prompt-max-bytes <n>] [--max-reads <n>] [--cost-usd <n>] [--tokens <n>]\n"
    + "                  [--yolo] [--keep-worktrees] [--discard-pending] [--reuse-epic] [--parallel <n>]\n"
    + "                  [--ui scene|compact|plain|off] [--run <id>] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, [
        "run", "model", "effort", "max-usd", "prompt-max-bytes", "max-reads",
        "cost-usd", "tokens", "root", "ui", "parallel", "fixlist",
      ]);
      const root = workspaceRootFrom(args);
      const mode = resolveMode(args.flags.has("prepare"), args.flags.has("commit"));
      const runId = args.positionals[0] ?? stringFlag(args, "run");

      const dryRun = boolFlag(args, "dry-run");
      // `--cost-usd` is how the HOST declares what an in-session turn cost. It has
      // no meaning anywhere else: headless reconciles the envelope's real
      // `total_cost_usd`, and letting a flag overwrite a measurement would be the
      // exact inversion of what this is for.
      const costUsd = numberFlag(args, "cost-usd");
      if (costUsd !== undefined && mode !== "commit") {
        throw new UsageError("--cost-usd only applies to `tldrx next --commit`: it declares what the host session's sub-agent cost");
      }
      if (costUsd !== undefined && costUsd < 0) {
        throw new UsageError("--cost-usd must be >= 0");
      }
      const tokens = numberFlag(args, "tokens");
      if (tokens !== undefined && mode !== "commit") {
        throw new UsageError("--tokens only applies to `tldrx next --commit`");
      }
      // `--review` names WHICH half of a Build story the handshake is for, so it
      // is meaningless without a half. Refused rather than ignored: a bare
      // `tldrx next --review` that silently ran the whole headless pipeline is
      // the exact mistake the flag exists to make impossible.
      const review = boolFlag(args, "review");
      if (review && mode === "headless") {
        throw new UsageError(
          "--review is a modifier on the in-session handshake: use `tldrx next --prepare --review` to write the "
          + "reviewer bundle, then `tldrx next --commit --review` to settle its verdict",
        );
      }
      // `--fixlist <path>` routes a reviewer's fix list back to the AUTHOR, which
      // is a `--prepare` and only a `--prepare`. On `--commit` there is no bundle
      // left to shape, and headless has no host to route anything to — a flag that
      // was quietly ignored on two of three modes would be a flag nobody could
      // trust on the third.
      const fixlist = stringFlag(args, "fixlist");
      if (fixlist !== undefined && mode !== "prepare") {
        throw new UsageError(
          "--fixlist applies to `tldrx next --prepare`: it re-prepares the story's DEVELOPER bundle "
          + "around a reviewer's fix list (04-build/fixlist/<story>-<n>.md)",
        );
      }
      // `--prepare`, `--commit` and `--dry-run` all spawn nothing, so there is
      // nothing to watch: the handle they get is inert. `--dry-run` DID spawn
      // until issue #17 — it ran the stage and reverted the non-handoff outputs
      // afterwards (measured 2026-08-30: one `agent.spawned`, one `agent.result`,
      // $0.42 on the ledger) — and this flag was already `!dryRun` for it.
      const ui = startUi(args, { root, spawns: mode === "headless" && !dryRun });
      let outcome;
      try {
        outcome = await runNext({
          root,
          runId,
          dryRun,
          mode,
          review,
          fixlist,
          model: stringFlag(args, "model"),
          effort: effortFlag(args),
          maxUsd: numberFlag(args, "max-usd"),
          promptMaxBytes: numberFlag(args, "prompt-max-bytes"),
          maxReads: numberFlag(args, "max-reads"),
          costUsd,
          tokens,
          yolo: boolFlag(args, "yolo"),
          keepWorktrees: boolFlag(args, "keep-worktrees"),
          discardPending: boolFlag(args, "discard-pending"),
          reuseEpic: boolFlag(args, "reuse-epic"),
          parallel: parallelFlag(args),
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

/**
 * `--parallel <n>`, refused rather than clamped when it is not a positive whole
 * number. A `--parallel 0` that quietly became 1 would be a flag that lied about
 * what it did; a `--parallel 2.5` is a typo, not an instruction.
 */
export function parallelFlag(args: Parameters<typeof numberFlag>[0]): number | undefined {
  const value = numberFlag(args, "parallel");
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError("--parallel must be a whole number >= 1 (1 runs one story at a time, which is the default)");
  }
  return value;
}

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
