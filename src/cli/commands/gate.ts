/** `tldrx gate template` — write the skeleton evidence note for the current stage.
 *
 * Design §A.6. An `agent` gate is closed over a structured evidence note
 * (`.agent/<stage>/evidence.md`), and this is the non-signing helper that puts
 * one on disk with its MEASURED fields filled: which gate it is for, the time,
 * how many citations the §2.8 resolver found in this stage's outputs, and how
 * many touched paths the plan declares. Every JUDGEMENT is left blank, so the
 * file it writes deliberately does NOT validate: a template that parsed clean out
 * of the box would be a signature nobody had to earn.
 *
 * It spends nothing, spawns nothing, approves nothing and advances no cursor.
 * `approve --as-agent` is the one verb that signs (wave 2C); this only says what
 * the note has to contain.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_GATE_REFUSED, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { isResolved, resolveRunOrExplain } from "../resolveRun.ts";
import { evidencePath, type PathContext } from "../../core/facilitator/paths.ts";
import { countCitations, countDeclaredTouches } from "../../core/run/evidenceScope.ts";
import {
  describeEvidenceTemplate, renderEvidenceTemplate, type EvidenceTemplateInput,
} from "../../core/text/evidence.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["run", "root"];

export const gateCommand: Command = {
  name: "gate",
  summary: "Write the skeleton evidence note an agent gate is closed over",
  usage: "tldrx gate template [<run>] [--run <id>] [--force] [--root <path>]",
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    if (sub !== "template") {
      process.stderr.write(`tldrx gate: expected \`template\`\n${gateCommand.usage}\n`);
      return EXIT_USAGE;
    }
    return Promise.resolve(template(rest));
  },
};

function template(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const root = workspaceRootFrom(args);
    const resolved = resolveRunOrExplain("tldrx gate template", root, stringFlag(args, "run") ?? args.positionals[0]);
    if (!isResolved(resolved)) return resolved.exit;
    const store = resolved.store;

    const entry = store.cursorEntry();
    if (entry === null) {
      process.stderr.write(
        `tldrx gate template: ${store.runId}'s cursor does not point at a stage — nothing to write a note for\n`,
      );
      return EXIT_GATE_REFUSED;
    }
    const gate = `${entry.phase.id}/${entry.stage.id}`;
    const path = evidencePath(store.runDir, entry.stage.id);

    // An evidence note already on disk is somebody's work. Overwriting it would
    // destroy the one artefact a gate rests on, and the operator asked for a
    // blank form, not for that.
    if (existsSync(path) && !boolFlag(args, "force")) {
      process.stderr.write(
        `tldrx gate template: refused — ${relative(root, path)} already exists. `
        + "Read it, or pass --force to replace it with a blank form.\n",
      );
      return EXIT_GATE_REFUSED;
    }

    const ctx: PathContext = { root, runDir: store.runDir };
    const input: EvidenceTemplateInput = {
      gate,
      by: currentActor(),
      at: nowRfc3339(),
      citationsOf: countCitations(entry.stage.outputs, ctx),
      touchesAudited: countDeclaredTouches(ctx),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderEvidenceTemplate(input), "utf8");

    const lines = describeEvidenceTemplate(relative(root, path), input);
    process.stdout.write(`${lines.join("\n")}\n`);
    return EXIT_OK;
  } catch (error) {
    return fail("gate template", error);
  }
}
