/**
 * A training pass whose INPUT is empty, answered before the money (gh #101).
 *
 * **What was there.** `runTraining` had exactly one "nothing to work on, refuse
 * before the money" check and it guarded one half of one mode:
 * `nothingToMineRefusal` (`roleTraining.ts:79`) fires only for a ROLE expert with
 * zero minable runs. The CODE pass was pushed unconditionally and nothing ever
 * looked at `selection.inlined.length` — so an expert whose `## Domain` matched
 * no file on disk spawned a sub-agent, was shown no code at all, and wrote a
 * knowledge file about nothing at full price. Measured on this fixture before the
 * fix: `{ code: 0, costUsd: 0.37, wroteKnowledge: true }` on a domain of
 * `src/does-not-exist/`. Live, from #94's thread: two near-empty trainings at
 * $0.82 each whose "code sweeps found nothing in-domain".
 *
 * **The choice, named.** SKIP a dead pass with a stated reason; REFUSE only when
 * no pass survives. That is `nothingToMineRefusal`'s idiom — refuse when there is
 * nothing to train from — without denying a `--mode full` run that still has one
 * real pass. A role expert keeps its own, better-worded refusal, because its runs
 * pass is the only pass it has and "nothing to mine" is already "nothing to train
 * from" there.
 *
 * **This is not the #96/#98 preflight and must not be confused with it.** That
 * one asks *can this afford to finish*; this one asks *is there anything to
 * read*. Underfunded and empty are different refusals with different remedies, so
 * they are different checks with different messages, and neither consults the
 * other. In particular a skipped pass does NOT re-divide the ceiling: the share
 * `trainPreflight` priced and printed is the share the surviving sub-agent gets,
 * and the skipped one is simply not spent.
 *
 * **Exit code: `EXIT_USAGE` (1), deliberately, and it is worth saying why.**
 * `EXIT_GATE_REFUSED` (2) is this codebase's *money* refusal — the `MIN_TRAIN_USD`
 * floor and the #96 preflight. Every "you asked for something with nothing behind
 * it" refusal in `expert train` is 1: `missingAreaRefusal`, `lightModeRefusal`,
 * and `nothingToMineRefusal` — the last of which is this check's literal sibling
 * and is pinned at 1 by `test/training.test.ts` ("--mode full with no run to mine
 * is refused (exit 1)"). Giving the same condition a different code depending on
 * which pass was empty would be the inconsistency, so this is 1 too.
 *
 * Everything here is PURE — no clock, no disk, no environment. The caller hands
 * it what the deterministic pre-pass already found.
 */
import type { TrainingMode } from "./Training.ts";

/**
 * The code pass found no file to show the sub-agent, or null when it did.
 *
 * `inlined` and not `notRead` is the honest count: `notRead` is a list of NAMES
 * the caps left out, and a sub-agent handed forty names and zero file bodies is
 * in exactly the position this check exists to refuse.
 */
export function emptyCodeSweepNote(
  expert: string,
  area: string,
  inlined: number,
  domainPaths: readonly string[],
  repos: readonly string[],
): readonly string[] | null {
  if (inlined > 0) return null;
  const where = repos.length === 0 ? "no repo at all" : repos.join(", ");
  const lines = [
    `the code pass has nothing to read: the pre-pass walked ${where} and selected 0 files.`,
  ];
  if (domainPaths.length > 0) {
    lines.push(
      `  Every file was outside this expert's declared \`## Domain\``
      + ` (${domainPaths.map((path) => `\`${path}\``).join(", ")}).`,
      "  Either that folder is not on disk here, or the bullet is spelled WORKSPACE-relative:",
      "  a `## Domain` bullet is repo-RELATIVE, with no repo prefix (#94). Fix it in",
      `    .tldrx/experts/${expert}/expert.md`,
    );
  } else {
    lines.push(
      "  This expert declares no `## Domain`, so the whole of those repos was in scope and",
      `  nothing matched the words of the area title. Give \`${area}\` a title that names what`,
      "  it is about, or declare a `## Domain`, in",
      `    .tldrx/experts/${expert}/competencies.yml`,
    );
  }
  lines.push("  A sub-agent shown no code writes a knowledge file about no code, at full price.");
  return lines;
}

/**
 * The runs pass has no handoff or retro to mine, or null when it has.
 *
 * This is the arm `nothingToMineRefusal` never covered: its guard reads
 * `if (!isRole || minedFiles > 0) return null`, so a NON-role `--mode full` run
 * against zero minable runs spawned a second sub-agent to write
 * `- none [src: absent:tldrx-work]` — no evidence, no level, full price.
 */
export function emptyRunsNote(
  expert: string,
  area: string,
  minedFiles: number,
): readonly string[] | null {
  if (minedFiles > 0) return null;
  return [
    "the runs pass has nothing to mine: no `tldrx-work/<run>/` holds a handoff or a retro",
    "  this expert's repos match. The sub-agent would write one file saying",
    "  `- none [src: absent:tldrx-work]`: no evidence, no level, full price. Finish a run",
    `  first — its handoffs are what \`--mode full\` reads for ${expert}/${area}.`,
  ];
}

/**
 * Every pass this mode would run has an empty input, so there is nothing to
 * spawn. Null when at least one pass survived — that run proceeds, with the dead
 * pass skipped and said out loud rather than refused.
 */
export function nothingToTrainRefusal(
  expert: string,
  area: string,
  mode: TrainingMode,
  reasons: readonly (readonly string[])[],
): readonly string[] | null {
  if (reasons.length === 0) return null;
  return [
    `${expert}/${area}: nothing to train from in --mode ${mode}, and nothing was spent.`,
    ...reasons.flatMap((reason) => reason.map((line) => `  ${line}`)),
    "  Nothing was spawned: every pass this mode would run has an empty input.",
  ];
}

/** One skipped pass, as the lines an operator is shown on stderr. */
export function skipNoteLines(expert: string, area: string, reason: readonly string[]): readonly string[] {
  const [first, ...rest] = reason;
  return [`${expert}/${area}: skipped — ${first ?? ""}`, ...rest.map((line) => `  ${line}`)];
}
