/**
 * `tldrx interview` — answer the open questions from a terminal.
 *
 * Spec §7 says the interaction channel is pluggable and the questions file is the
 * contract; this is the terminal plug. It asks the open blocks of one
 * `questions.md` in order, shows each one's `Why asked:` line and options, and
 * records what it is told through the same `src/core/answers/` path `tldrx answer`
 * and the `answer-capture` hook use — footer, `facts.yml` row, two events.
 *
 * It answers nothing on the human's behalf. `s` skips, `q` stops, end of input
 * stops, and every question that was not answered stays `status: open`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../../core/paths.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";
import { openBlocks, parseQuestions } from "../../core/text/questions.ts";
import { createLineReader } from "../../core/interview/lineReader.ts";
import { renderNextSteps } from "../../core/interview/renderQuestion.ts";
import { renderInterviewSummary, runInterview } from "../../core/interview/runInterview.ts";
import { QUESTIONS_FILE } from "../../core/init/questions.ts";
import {
  applyProcessAnswers, collectProcessAnswers, hasProcessAnswer, renderProcessApply,
} from "../../core/init/processAnswers.ts";
import { SpawnCommandRunner } from "../../core/detect/CommandRunner.ts";
import type { CaptureContext, CapturedAnswer } from "../../core/answers/captureAnswers.ts";

const VALUE_FLAGS = ["run", "root"] as const;

interface Target {
  readonly path: string;
  readonly header: string;
  readonly ctx: CaptureContext;
}

/** What resolution found: a file to work through, nothing to ask, or no run at all. */
type Resolution = Target | "no-open-questions" | "not-found";

export const interviewCommand: Command = {
  name: "interview",
  summary: "Answer a run's open questions in the terminal",
  usage: "tldrx interview [--run <id> | --init] [--yes-to-defaults] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, [...VALUE_FLAGS]);
      const init = boolFlag(args, "init");
      const runId = stringFlag(args, "run");
      if (init && runId !== undefined) throw new UsageError("--init and --run name different files; pass one");

      const root = workspaceRootFrom(args);
      const target = init ? initTarget(root) : runTarget(root, runId);
      if (target === "not-found") return EXIT_NOT_FOUND;
      if (target === "no-open-questions") {
        process.stdout.write(renderNextSteps(!init));
        return EXIT_OK;
      }

      process.stdout.write(`${target.header}\n`);
      const reader = createLineReader();
      try {
        const result = await runInterview({
          questionsPath: target.path,
          yesToDefaults: boolFlag(args, "yes-to-defaults"),
          ctx: target.ctx,
          reader,
          out: (text) => process.stdout.write(text),
        });
        process.stdout.write(renderInterviewSummary(result));
        if (init) await applyProcess(root, target.path, result.answered);
      } finally {
        reader.close();
      }
      process.stdout.write(renderNextSteps(!init));
      return EXIT_OK;
    } catch (error) {
      return fail("interview", error, EXIT_USAGE);
    }
  },
};

/**
 * The install interview's two process answers are not just facts: they are the
 * contents of `.tldrx/process.yml`, the file `tldrx tickets` reads. Recording them
 * and leaving that file saying `none` would make the question decorative, so the
 * answers are applied here, after they are recorded and through the same
 * `CommandRunner` seam detection uses.
 *
 * Only `--init` reaches this: a run's `questions.md` asks about the work, not about
 * how the team works.
 */
async function applyProcess(
  root: string,
  questionsPath: string,
  answered: readonly CapturedAnswer[],
): Promise<void> {
  const answers = collectProcessAnswers(questionsPath, answered);
  if (!hasProcessAnswer(answers)) return;
  const applied = await applyProcessAnswers({
    root, answers, runner: new SpawnCommandRunner(), when: nowRfc3339(),
  });
  process.stdout.write(renderProcessApply(applied));
}

/**
 * `.tldrx/init-questions.md`. `[assumption]` — init is not a run, but
 * `captureAnswers` records an event as well as a fact, and dropping the event for
 * this one channel would make the two paths differ. So the run id is the literal
 * string `init` and the log is `.tldrx/events.jsonl`, beside the answers it explains.
 */
function initTarget(root: string): Resolution {
  const path = join(root, ...QUESTIONS_FILE.split("/"));
  if (!existsSync(path)) {
    process.stderr.write(`tldrx interview: no ${QUESTIONS_FILE} — run \`tldrx init\` first\n`);
    return "not-found";
  }
  if (countOpen(path) === 0) {
    process.stdout.write(`Interview — ${QUESTIONS_FILE}\nNo open questions.\n`);
    return "no-open-questions";
  }
  return {
    path,
    header: `Interview — ${QUESTIONS_FILE}`,
    ctx: {
      root,
      runDir: join(root, PROJECT_FRAMEWORK_DIR),
      run: "init",
      actor: currentActor(),
      at: nowRfc3339(),
    },
  };
}

/**
 * The cursor phase's `questions.md`. `[assumption]` — when the cursor phase has no
 * open questions the other phases are searched in run order, because the operator
 * asked to answer questions, not to be told the cursor moved past them.
 */
function runTarget(root: string, runId: string | undefined): Resolution {
  const store = RunStore.find(root, runId);
  if (store === null) {
    process.stderr.write(
      `tldrx interview: ${runId === undefined ? "no non-terminal run" : `no run '${runId}'`}`
      + ` in ${PROJECT_WORK_DIR}/\n`,
    );
    return "not-found";
  }
  const cursorPhase = store.cursorEntry()?.phase.id;
  const phases = store.run.phases.map((phase) => phase.id);
  const ordered = cursorPhase === undefined ? phases : [cursorPhase, ...phases.filter((id) => id !== cursorPhase)];

  for (const phase of ordered) {
    const path = join(store.runDir, phase, "questions.md");
    if (!existsSync(path) || countOpen(path) === 0) continue;
    return {
      path,
      header: `Interview — run ${store.runId} · ${phase}`,
      ctx: {
        root,
        runDir: store.runDir,
        run: store.runId,
        actor: currentActor(),
        at: nowRfc3339(),
      },
    };
  }

  process.stdout.write(`Interview — run ${store.runId}\nNo open questions.\n`);
  return "no-open-questions";
}

function countOpen(path: string): number {
  return openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks).length;
}
