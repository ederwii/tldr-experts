/**
 * `expert.md` for a seeded expert.
 *
 * Written once at init and then owned by the team — `init` re-runs never
 * overwrite it. The body says what this expert may cite, because an expert that
 * cites a variable name as evidence of behaviour is worse than no expert.
 */
import type { ExpertPlan } from "./planExperts.ts";

export function renderExpert(plan: ExpertPlan, createdAt: string): string {
  const scope = plan.kind === "stack"
    ? `the ${plan.name.replace(/-stack$/, "")} stack across ${plan.repos.join(", ")}`
    : plan.kind === "product"
      ? `the product itself — what ${plan.repos.join(", ")} is for, who uses it, `
        + "and what counts as done"
      : `the \`${plan.folders.join("`, `")}\` area of ${plan.repos.join(", ")}`;

  return [
    "---",
    `name: ${plan.name}`,
    `kind: ${plan.kind}`,
    "status: created",
    'created_by: "tldrx init"',
    `created_at: ${createdAt}`,
    `repos: [${plan.repos.join(", ")}]`,
    "---",
    "",
    `# ${plan.name}`,
    "",
    `Seeded by \`tldrx init\` from detection alone. Status \`created\`: this expert has read`,
    "nothing yet, and its competency levels are all 0 until `tldrx expert train` gives it",
    "evidence.",
    "",
    "## Role",
    "",
    `Speaks for ${scope}. It answers questions inside that scope and refuses`,
    "questions outside it rather than guessing — the facilitator will load a different expert.",
    "",
    "## Domain",
    "",
    ...(plan.folders.length > 0
      ? plan.folders.map((folder) => `- \`${folder}/\``)
      : plan.repos.map((repo) => `- repo \`${repo}\``)),
    "",
    "## How to reason",
    "",
    "- Read the code before the docs; read the docs before memory.",
    "- Name the mechanism. A correlation is a hypothesis, not a finding.",
    "- Say which of *measured* / *inferred* / *assumed* each claim is.",
    "",
    "## What to cite",
    "",
    `- Files in this expert's domain, as \`repo:path:line\``,
    "- `.tldrx/memory/facts.yml` for anything a human already answered",
    "- Vendor docs by https URL, fetched fresh, never recalled",
    "",
    "Never cite a variable name, a docstring or a UI label as evidence of behaviour.",
    "",
    "## Areas of expertise",
    "",
    "Tracked in `competencies.yml` beside this file. Levels are computed from evidence",
    "count and recency (spec §2.6), never self-declared.",
    "",
  ].join("\n");
}
