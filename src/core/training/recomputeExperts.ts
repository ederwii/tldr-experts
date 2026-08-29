/**
 * `tldrx expert recompute [<name>]` — settle a level that drifted.
 *
 * Spec §2.6 says `level` is computed and "a hand-edited value is overwritten on
 * the next write". Until now the only thing that ever wrote one was a headless or
 * `--commit` training run. `--print-prompt` training — a human pasting the prompt
 * into their own session, which is a supported path, not a workaround — left the
 * evidence on disk and the level at whatever it was, so `expert list` and the
 * dashboard warned "stores level 0, evidence computes 5" forever and the only fix
 * was to edit the YAML by hand. That is exactly the hand-edited number the spec
 * says must be temporary.
 *
 * This is arithmetic over evidence already on disk. It reads no code, spawns
 * nothing, spends nothing, and does NOT touch `status` or `last_trained`: it is
 * not a training run and must not leave a record that says it was.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { expertsDir } from "../experts/loadExperts.ts";
import {
  CompetenciesError, recomputeCompetencies, type CompetenciesRecompute,
} from "./competenciesWrite.ts";

export interface RecomputeExpertsOptions {
  readonly root: string;
  /** One expert, or every expert in the workspace when null. */
  readonly expert: string | null;
  readonly now: Date;
}

export interface RecomputedExpert extends CompetenciesRecompute {
  readonly expert: string;
}

export class ExpertNotFound extends Error {}

/** Every expert folder, sorted — the same listing `expert list` walks. */
export function expertNames(root: string): readonly string[] {
  const dir = expertsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => statSync(`${dir}/${entry}`).isDirectory()).sort();
}

export function recomputeExperts(options: RecomputeExpertsOptions): readonly RecomputedExpert[] {
  const all = expertNames(options.root);
  if (options.expert !== null && !all.includes(options.expert)) {
    const known = all.join(", ") || "none";
    throw new ExpertNotFound(`no expert '${options.expert}' in this workspace (experts: ${known})`);
  }
  const wanted = options.expert === null ? all : [options.expert];

  return wanted.map((expert) => {
    try {
      return { expert, ...recomputeCompetencies({ root: options.root, expert, now: options.now }) };
    } catch (error) {
      // A named expert whose file is missing is "not found", not a crash; over the
      // whole workspace it is still worth failing loudly rather than skipping a
      // file and printing a clean sweep.
      if (error instanceof CompetenciesError) throw new ExpertNotFound(`${expert}: ${error.message}`);
      throw error;
    }
  });
}

/**
 * One line per area, in the shape the CLI prints.
 *
 * `name/area: level 0 → 5 (17 evidence)` when it moved, `… level 5 unchanged …`
 * when it did not. An area whose file carried no `level:` at all says `(unset)`
 * rather than pretending it stored a zero.
 */
export function renderRecompute(results: readonly RecomputedExpert[]): readonly string[] {
  const lines: string[] = [];
  for (const result of results) {
    if (result.areas.length === 0) {
      lines.push(`${result.expert}: no areas`);
      continue;
    }
    for (const area of result.areas) {
      const count = `(${String(area.evidenceCount)} evidence)`;
      lines.push(
        area.changed
          ? `${result.expert}/${area.id}: level ${before(area.levelBefore)} → ${String(area.levelAfter)} ${count}`
          : `${result.expert}/${area.id}: level ${String(area.levelAfter)} unchanged ${count}`,
      );
    }
  }
  return lines;
}

export function recomputeJson(results: readonly RecomputedExpert[]): string {
  return JSON.stringify(
    results.map((result) => ({
      expert: result.expert,
      path: result.path,
      written: result.written,
      areas: result.areas.map((area) => ({
        id: area.id,
        level_before: area.levelBefore,
        level_after: area.levelAfter,
        evidence_count: area.evidenceCount,
        changed: area.changed,
      })),
      warnings: result.warnings,
    })),
    null,
    2,
  );
}

function before(level: number | null): string {
  return level === null ? "(unset)" : String(level);
}
