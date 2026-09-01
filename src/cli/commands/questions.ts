/** `tldrx questions lint` — is this run's questions.md readable by the parser?
 *
 * The whole §2.7 loop rests on one regex, `^## (Q\d+) · (.+)$`, and a file that
 * misses it is not half-read — it is read as EMPTY. Measured 2026-08-29: a stage
 * followed `templates/questions.md`, wrote `### Q1 — …` with `**Answer:**`, and
 * the facilitator saw zero questions, called "0 open" satisfied, and closed the
 * gate over four unanswered ones. Nothing anywhere said the file was unreadable.
 *
 * So: `lint` says which blocks the parser cannot see, and `--fix` converts them
 * without changing a word — the title, the reason and every option come across
 * verbatim; what is added is the heading separator, the metadata comment and the
 * `[Answer]:` slot. Answers already typed in the prose form are carried over.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { isResolved, resolveRunOrExplain } from "../resolveRun.ts";
import {
  fixQuestions, parseLooseQuestions, parseQuestions, unreadableQuestionHeadings,
} from "../../core/text/questions.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["run", "root", "area"];

export const questionsCommand: Command = {
  name: "questions",
  summary: "Check that this run's questions.md can be read by the §2.7 parser",
  usage: "tldrx questions lint [<run>] [--run <id>] [--fix] [--area <a>] [--root <path>]",
  subcommands: ["lint"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    if (sub !== "lint") {
      process.stderr.write(`tldrx questions: expected \`lint\`\n${questionsCommand.usage}\n`);
      return EXIT_USAGE;
    }
    return Promise.resolve(lint(rest));
  },
};

function lint(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const root = workspaceRootFrom(args);
    const resolved = resolveRunOrExplain("tldrx questions", root, stringFlag(args, "run") ?? args.positionals[0]);
    if (!isResolved(resolved)) return resolved.exit;
    const store = resolved.store;
    const shouldFix = boolFlag(args, "fix");

    const files = questionFiles(store.runDir);
    if (files.length === 0) {
      process.stdout.write(`no questions.md anywhere in ${store.runId} — nothing to lint\n`);
      return EXIT_OK;
    }

    const lines: string[] = [`questions lint · run ${store.runId} · ${files.length} file(s)`, ""];
    let unreadable = 0;
    let fixed = 0;
    const needSource: string[] = [];

    for (const path of files) {
      const rel = path.slice(store.runDir.length + 1);
      const text = readFileSync(path, "utf8");
      const readable = parseQuestions(text).blocks.length;
      const lost = unreadableQuestionHeadings(text);
      if (lost.length === 0) {
        lines.push(`  ok   ${rel} — ${readable} question(s) parse`);
        continue;
      }
      unreadable += lost.length;
      if (!shouldFix) {
        const loose = parseLooseQuestions(text);
        lines.push(`  BAD  ${rel} — ${lost.length} unreadable (${lost.join(", ")}), ${readable} parse`);
        for (const block of loose) {
          lines.push(`         L${block.line} ${block.id}: heading is not \`## ${block.id} · <title>\``);
        }
        continue;
      }
      const result = fixQuestions(text, {
        area: stringFlag(args, "area") ?? "general",
        askedBy: currentActor(),
        askedAt: nowRfc3339(),
      });
      writeFileSync(path, result.text, "utf8");
      fixed += result.converted.length;
      needSource.push(...result.needSource);
      lines.push(`  FIX  ${rel} — converted ${result.converted.join(", ")} to the §2.7 grammar`);
    }

    lines.push("");
    if (unreadable === 0) {
      lines.push("Every question block parses. `tldrx next` and the auto gate can see all of them.");
    } else if (shouldFix) {
      lines.push(
        `Converted ${fixed} block(s). No wording was changed — the heading separator, the metadata `
        + "comment and the `[Answer]:` slot were added. Re-run without --fix to confirm.",
      );
      if (needSource.length > 0) {
        // Deliberately NOT invented. This whole change exists because citations
        // that resolve to nothing were being accepted; a --fix that writes one to
        // satisfy §2.7 would be manufacturing the exact thing being removed.
        lines.push(
          `${needSource.length} block(s) still need a source on their \`Why asked:\` line `
          + `(${needSource.join(", ")}) — the prose form had no such rule, and this command does not `
          + "invent citations. Add the one you actually had in mind.",
        );
      }
    } else {
      lines.push(
        `${unreadable} question(s) are invisible to the parser: an auto gate would read this file as `
        + "\"0 open\" and sign itself. Run `tldrx questions lint --fix` to convert them, or rewrite the "
        + "headings as `## Qn · <title>` with the `<!-- id: Qn | status: open | … -->` line under them.",
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    // Exit 2 (`refused by a gate`, spec §3) when a file is unreadable and was not
    // fixed: a linter that always exits 0 is a linter nothing in CI can use.
    return unreadable > 0 && !shouldFix ? EXIT_GATE_REFUSED : EXIT_OK;
  } catch (error) {
    return fail("questions lint", error);
  }
}

/** Every `<phase>/questions.md` in the run, in phase order. */
function questionFiles(runDir: string): readonly string[] {
  const found: string[] = [];
  for (const phase of ["01-what", "02-how", "03-plan", "04-build", "05-watch"]) {
    const path = join(runDir, phase, "questions.md");
    if (existsSync(path)) found.push(path);
  }
  return found;
}
