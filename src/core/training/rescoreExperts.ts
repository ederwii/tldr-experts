/**
 * `tldrx expert rescore [<name>]` — score the knowledge already on disk (gh #154).
 *
 * **Why this exists.** The gate fix in `knowledgeFile.ts` changes what the NEXT
 * training run earns. It cannot help the files a workspace already paid for:
 * `expert recompute` is arithmetic over the evidence rows in `competencies.yml`,
 * and for every expert the bug hit that array is `[]`. Measured on `~/scavtopia`
 * at 0.8.0, four role experts trained `--mode full` for $9.47 and kept one row —
 * the knowledge files themselves are good, twenty sourced bullets among them, and
 * without a path from "file on disk" back to "evidence row" the cheapest recovery
 * is to buy the same readings a second time.
 *
 * **What it is not.** Not a training run, and it must not leave a record that says
 * it was: it reads no code, spawns nothing, spends nothing, and writes back
 * `status` and `last_trained` exactly as it found them. It is the read half of
 * `expert train` — the same `parseKnowledgeFile`, the same scope, the same
 * evidence derivation — with the sub-agent removed, so a file scores now under
 * the rules in force now.
 *
 * **Dating, and why it is not the clock.** §2.6 weighs recency, so a row's `at`
 * decides part of the level. A reading taken in August is not evidence gathered
 * today, and stamping `now` on a rescored file would quietly raise every level in
 * a workspace that ran this command. So rows are dated by the knowledge file's
 * own `trained_at` when it has one, by the expert's `last_trained` when it does
 * not — and when neither exists there is nothing that dates the reading, so the
 * file is SKIPPED with that as the reason rather than given a date it never had.
 *
 * A file that no longer validates is skipped too. Rescoring is a re-read under
 * today's rules; a file those rules reject is not evidence, and silently keeping
 * its rows because an older tldrx once accepted them is the drift this framework
 * exists to refuse.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { loadWorkspace, toSrcContext } from "../../hooks/lib/workspace.ts";
import { loadExpert } from "../experts/loadExperts.ts";
import { readKnowledgeFiles } from "../experts/expertKnowledge.ts";
import { knowledgeFileArea } from "./Training.ts";
import {
  LIGHT_SHAPE, RUNS_SHAPE, codeEvidence, knowledgeErrors, parseKnowledgeFile, runEvidence,
} from "./knowledgeFile.ts";
import { CompetenciesError, writeCompetencies } from "./competenciesWrite.ts";
import { knowledgeScopeFor } from "./knowledgeScope.ts";
import { ExpertNotFound, expertNames } from "./recomputeExperts.ts";

export interface RescoreOptions {
  readonly root: string;
  /** One expert, or every expert in the workspace when null. */
  readonly expert: string | null;
  /** One area, or every area a knowledge file names when null. */
  readonly area: string | null;
  readonly now: Date;
}

export interface RescoredFile {
  readonly expert: string;
  readonly area: string;
  /** The knowledge file, relative to the workspace root. */
  readonly file: string;
  /** Rows genuinely added — `mergeEvidence` dedupes by `src`, so a re-run adds 0. */
  readonly added: number;
  readonly levelBefore: number;
  readonly levelAfter: number;
  /** `YYYY-MM-DD` the rows were dated, or null when the file was skipped. */
  readonly at: string | null;
  /** Where that date came from — never the clock. */
  readonly dated: "file" | "expert" | null;
  /** Why nothing was written, or null when it was. */
  readonly skipped: string | null;
}

/**
 * Re-derive evidence from every knowledge file on disk, expert by expert.
 *
 * Deterministic and ordered: experts sorted by name (the listing `expert list`
 * walks), files in `readKnowledgeFiles` order, which is the file's own
 * `trained_at` and then its name — never an mtime, which a clone rewrites.
 */
export function rescoreExperts(options: RescoreOptions): readonly RescoredFile[] {
  const all = expertNames(options.root);
  if (options.expert !== null && !all.includes(options.expert)) {
    throw new ExpertNotFound(`no expert '${options.expert}' in .tldrx/experts/`);
  }
  const names = options.expert === null ? all : [options.expert];
  const srcCtx = toSrcContext(loadWorkspace(options.root), null);

  const out: RescoredFile[] = [];
  for (const name of names) {
    for (const file of readKnowledgeFiles(options.root, name)) {
      // Re-read the expert inside the loop: a second file for the same area must
      // see the rows the first one just wrote, or the level it reports is stale.
      const expert = loadExpert(options.root, name, options.now);
      const { area, minesRunRecord } = knowledgeFileArea(file.area);
      if (options.area !== null && area !== options.area) continue;

      const rel = relative(options.root, file.path);
      const skip = (reason: string): void => {
        out.push({
          expert: name, area, file: rel, added: 0,
          levelBefore: 0, levelAfter: 0, at: null, dated: null, skipped: reason,
        });
      };

      if (expert.error !== null) {
        skip(`competencies.yml could not be read — ${expert.error}`);
        continue;
      }
      if (!expert.areas.some((row) => row.id === area)) {
        skip(`no area '${area}' in competencies.yml — the file names an area this expert no longer has`);
        continue;
      }

      const at = file.trainedAt ?? expert.lastTrained;
      if (at === null) {
        skip("nothing dates this reading — the file carries no `trained_at` and the expert no `last_trained`");
        continue;
      }

      const shape = minesRunRecord ? RUNS_SHAPE : LIGHT_SHAPE;
      const scope = knowledgeScopeFor(options.root, expert, area);
      const parsed = parseKnowledgeFile(readFileSync(file.path, "utf8"), srcCtx, shape, scope);
      if (!parsed.ok) {
        const errors = knowledgeErrors(parsed).length;
        skip(`the file does not validate under today's rules — ${String(errors)} problem(s), so it is not evidence`);
        continue;
      }

      const day = at.slice(0, 10);
      const evidence = minesRunRecord ? runEvidence(parsed.bullets, day) : codeEvidence(parsed.bullets, day);
      let written;
      try {
        written = writeCompetencies({
          root: options.root,
          expert: name,
          areaId: area,
          evidence,
          // Unchanged, on purpose: this is not a training run (see the header).
          status: expert.status,
          lastTrained: expert.lastTrained ?? at,
          now: options.now,
        });
      } catch (error) {
        skip(error instanceof CompetenciesError ? error.message : String(error));
        continue;
      }

      out.push({
        expert: name,
        area,
        file: rel,
        added: written.added.length,
        levelBefore: written.levelBefore,
        levelAfter: written.levelAfter,
        at: day,
        dated: file.trainedAt === null ? "expert" : "file",
        skipped: null,
      });
    }
  }
  return out;
}

/** The table `expert rescore` prints. One line per knowledge file, in order. */
export function renderRescore(rows: readonly RescoredFile[]): readonly string[] {
  if (rows.length === 0) {
    return ["no knowledge files to rescore — nothing under .tldrx/experts/*/knowledge/"];
  }
  const lines: string[] = [];
  let added = 0;
  for (const row of rows) {
    if (row.skipped !== null) {
      lines.push(`${row.expert}/${row.area}: skipped — ${row.skipped}`);
      continue;
    }
    added += row.added;
    const dated = row.dated === "expert" ? ", dated by the expert's last_trained" : "";
    lines.push(
      `${row.expert}/${row.area}: +${String(row.added)} row(s) from ${row.file}`
      + ` — level ${String(row.levelBefore)} → ${String(row.levelAfter)} (at ${String(row.at)}${dated})`,
    );
  }
  lines.push(
    `${String(added)} row(s) added from knowledge already on disk — nothing was spawned and nothing was spent`,
  );
  return lines;
}

export function rescoreJson(rows: readonly RescoredFile[]): string {
  return JSON.stringify(rows, null, 2);
}
