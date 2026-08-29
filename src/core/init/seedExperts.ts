/**
 * Write the seeded experts to `.tldrx/experts/<name>/`.
 *
 * Create-if-absent, always: an expert folder is the team's, and a second `init`
 * must never overwrite training or a hand-written role. Levels are computed by
 * the §2.6 formula even at seed time, so no number in the file is a literal.
 *
 * That create-if-absent rule is also what makes ADDING an expert safe. Wave I
 * introduced four new role experts; running `init` again on a workspace seeded
 * before it writes those four and leaves every existing `expert.md` and
 * `competencies.yml` byte-for-byte alone, because each file is offered to
 * `createIfAbsent` independently rather than the folder being written as a unit.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildCompetenciesDocument } from "./competenciesDocument.ts";
import { validateCompetenciesDocument, formatIssues } from "./validateEmitted.ts";
import { renderExpert } from "./renderExpert.ts";
import { stringifyYaml } from "../yaml.ts";
import { KNOWLEDGE_DIRNAME } from "../experts/expertKnowledge.ts";
import { readRoleTemplate, renderRoleExpert } from "../experts/roleExperts.ts";
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
      join(absDir, "expert.md"), `${relDir}/expert.md`, await expertBody(plan, options.createdAt),
    );
    await options.log.createIfAbsent(
      join(absDir, "competencies.yml"), `${relDir}/competencies.yml`,
      `# Written by \`tldrx init\` (spec §2.6). \`level\` is computed, never hand-set.\n`
        + stringifyYaml(competencies),
    );
    // An empty `knowledge/` is where `tldrx expert train` will land, and an
    // operator who opens the folder should see that before any training has run.
    // mkdir, not a placeholder file: a README nobody wrote would be inlined into
    // every prompt that loads this expert.
    if (plan.kind === "role") mkdirSync(join(absDir, KNOWLEDGE_DIRNAME), { recursive: true });
    seeded.push(plan.name);
  }
  return seeded;
}

/**
 * A role expert's prose ships as `templates/experts/<role>.md` so a team can edit
 * what every stage prompt will say about that role; everything else is generated
 * from detection. A role slug with no template file falls back to the generated
 * body rather than failing the whole `init`.
 */
async function expertBody(plan: ExpertPlan, createdAt: string): Promise<string> {
  if (plan.kind !== "role") return renderExpert(plan, createdAt);
  const template = await readRoleTemplate(plan.name);
  if (template === null) return renderExpert(plan, createdAt);
  return renderRoleExpert(template, {
    name: plan.name,
    createdBy: "tldrx init",
    createdAt,
    repos: plan.repos,
  });
}
