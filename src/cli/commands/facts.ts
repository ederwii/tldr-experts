/**
 * `tldrx facts add` — record one durable, provenanced fact (spec §2.5).
 *
 * The command the drive mandate has been naming since 0.8.0 (`mandate.ts`'s `--tldr`
 * reporting section, now a runnable example rather than a bare name — a fix-round
 * finding, since `--area`/`--decided-by` are both required and a driver following a
 * bare `tldrx facts add` would hit exit 1 twice). Without it, a driver's only way to
 * write a fact was to edit `.tldrx/memory/facts.yml` by hand — which walks past
 * `FactsStore.append`'s cap, past its `…` marker and its `truncated: true` flag, and
 * past `save()`'s validation. A fact cut mid-word with no marker is a record that
 * does not know it is incomplete.
 *
 * `--decided-by` is REQUIRED, not optional: 0.8.0's rule is that a driver's default
 * is never cited as the owner's decision, so this command never lets the caller
 * skip saying which of the two it was. (The `FactSource.decided_by` field itself
 * stays optional at the schema level — additive, and rows written before it existed
 * or by another writer must keep validating; the requirement lives here, in the
 * command's own argument handling.)
 *
 * Everything real is in `FactsStore.update` — load, mint the id, cap, mark, validate
 * and write, all inside ONE workspace lock, because `nextId()` is `max(id) + 1` off
 * the file and two writers without the lock both mint `F001`.
 */
import type { Command } from "../Command.ts";
import { EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { parseArgs, repeatedFlag, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { FactsStore } from "../../core/facts/FactsStore.ts";
import {
  FACT_CONFIDENCES, FACT_DECIDERS, FACT_KINDS, MAX_FACT_CHARS,
  type FactConfidence, type FactDecider, type FactKind,
} from "../../core/facts/Fact.ts";
import { factsPath } from "../../hooks/lib/workspace.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { EventLog } from "../../core/events/EventLog.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["area", "kind", "confidence", "decided-by", "repo", "run", "root"];

export const factsCommand: Command = {
  name: "facts",
  summary: "Record one durable, provenanced fact the later prompts will read",
  usage:
    'tldrx facts add "<text>" --area <id> --decided-by <owner|driver> [--kind <kind>] '
    + "[--confidence <level>] [--repo <name>] [--run <id>] [--root <path>]",
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, VALUE_FLAGS);
      const [sub, ...rest] = args.positionals;
      if (sub !== "add") {
        process.stderr.write(`tldrx facts: ${factsCommand.usage}\n`);
        return EXIT_USAGE;
      }
      const text = (rest[0] ?? "").trim();
      const area = (stringFlag(args, "area") ?? "").trim();
      const kind = (stringFlag(args, "kind") ?? "observed") as FactKind;
      const confidence = (stringFlag(args, "confidence") ?? "stated") as FactConfidence;
      const decidedBy = stringFlag(args, "decided-by");

      // Refused before anything is opened, and each refusal names the one thing
      // that was wrong. A fact with no assertion, no area to file it under, or no
      // stated decider is not a fact the no-re-ask hook or a `{{facts}}` block can
      // ever match — or, for `decided-by`, not one a later reader can trust.
      const problem = firstProblem(text, area, kind, confidence, decidedBy);
      if (problem !== null) {
        process.stderr.write(`tldrx facts add: ${problem}\n`);
        return EXIT_USAGE;
      }

      const root = workspaceRootFrom(args);
      // The run is provenance, and it is ABSENT WITH A REASON when it cannot be
      // established: `--run` names one, one open run is unambiguous, and several
      // open runs are not something to guess between.
      const resolved = RunStore.resolve(root, stringFlag(args, "run"));
      const runStore = resolved.kind === "one" ? resolved.store : null;

      const fact = FactsStore.update(factsPath(root), (store) => store.append({
        fact: text,
        area,
        repos: [...repeatedFlag(args, "repo")],
        kind,
        confidence,
        source: {
          who: currentActor(),
          when: nowRfc3339(),
          run: runStore === null ? null : runStore.runId,
          q: null,
          decided_by: decidedBy as FactDecider,
        },
      }));

      const lines = [`recorded ${fact.id} in ${area}: ${fact.fact}`];
      if (fact.truncated === true) {
        lines.push(
          `  the text was truncated to ${String(MAX_FACT_CHARS)} characters and marked `
          + "`truncated: true` — a fact is one assertion, not a document",
        );
      }
      if (runStore === null) {
        lines.push(
          resolved.kind === "ambiguous"
            ? "  no run recorded: several runs are open and this will not guess between them — "
              + "pass `--run <id>` to attribute it"
            : "  no run recorded: no open run to attribute it to",
        );
      } else {
        EventLog.forRun(runStore.runDir).tryAppend({
          ts: fact.source.when,
          run: runStore.runId,
          stage: null,
          type: "fact.added",
          actor: fact.source.who,
          cost_usd: 0,
          payload: { fact: fact.id, area: fact.area, kind: fact.kind, q: null },
        });
      }
      process.stdout.write(`${lines.join("\n")}\n`);
      return EXIT_OK;
    } catch (error) {
      return fail("facts", error);
    }
  },
};

/** The first thing wrong with the invocation, or null when nothing is. */
function firstProblem(
  text: string,
  area: string,
  kind: string,
  confidence: string,
  decidedBy: string | undefined,
): string | null {
  if (text === "") return "the fact text is required — a fact without an assertion is not a fact";
  if (area === "") return "--area is required: it is how every reader of facts.yml scopes a match";
  if (!(FACT_KINDS as readonly string[]).includes(kind)) {
    return `--kind must be one of ${FACT_KINDS.join(", ")}`;
  }
  if (!(FACT_CONFIDENCES as readonly string[]).includes(confidence)) {
    return `--confidence must be one of ${FACT_CONFIDENCES.join(", ")}`;
  }
  if (decidedBy === undefined) {
    return "--decided-by is required: a driver's default is never cited as the owner's decision";
  }
  if (!(FACT_DECIDERS as readonly string[]).includes(decidedBy)) {
    return `--decided-by must be one of ${FACT_DECIDERS.join(", ")}`;
  }
  return null;
}
