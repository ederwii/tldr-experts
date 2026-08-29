/**
 * Write the seeded experts to `.tldrx/experts/<name>/`.
 *
 * Create-if-absent, always: an expert folder is the team's, and a second `init`
 * must never overwrite training or a hand-written role. Levels are computed by
 * the §2.6 formula even at seed time, so no number in the file is a literal.
 */
import { join } from "node:path";
import { buildCompetenciesDocument } from "./competenciesDocument.ts";
import { validateCompetenciesDocument, formatIssues } from "./validateEmitted.ts";
import { renderExpert } from "./renderExpert.ts";
import { stringifyYaml } from "../yaml.ts";
import type { ExpertPlan } from "./planExperts.ts";
import type { WriteLog } from "./writeFile.ts";

export const EXPERTS_DIR = ".tldrx/experts";

export interface SeedExpertsOptions {
  readonly outDir: string;
  readonly plans: readonly ExpertPlan[];
  readonly createdAt: string;
  readonly log: WriteLog;
}

export async function seedExperts(options: SeedExpertsOptions): Promise<string[]> {
  const seeded: string[] = [];

  for (const plan of options.plans) {
    const relDir = `${EXPERTS_DIR}/${plan.name}`;
    const absDir = join(options.outDir, relDir);

    const competencies = buildCompetenciesDocument(plan.name, plan.areas);
    const validation = validateCompetenciesDocument(competencies);
    if (!validation.ok) throw new Error(formatIssues(`${relDir}/competencies.yml`, validation));

    await options.log.createIfAbsent(
      join(absDir, "expert.md"), `${relDir}/expert.md`, renderExpert(plan, options.createdAt),
    );
    await options.log.createIfAbsent(
      join(absDir, "competencies.yml"), `${relDir}/competencies.yml`,
      `# Written by \`tldrx init\` (spec §2.6). \`level\` is computed, never hand-set.\n`
        + stringifyYaml(competencies),
    );
    seeded.push(plan.name);
  }
  return seeded;
}
