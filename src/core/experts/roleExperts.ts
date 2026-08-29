/**
 * ROLE experts — the five names the shipped stage files have always asked for.
 *
 * `stages/<stage>/stage.yml` names `product`, `architect`, `delivery`, `developer` and
 * `operations` in its `experts:` lists. Until wave I, `tldrx init` seeded only the
 * first of those (plus `<lang>-stack` and one domain expert per detected source
 * folder — `src/core/init/planExperts.ts`), so on every real workspace four of the
 * five resolved to nothing: measured 2026-08-29 on `~/aparece-v2`, whose
 * `.tldrx/experts/` held `product`, `dotnet-stack` and seven domain experts and
 * not one of `architect`, `delivery`, `developer`, `operations`.
 *
 * A role expert is not a folder of code. Its subject is the WORKFLOW — the stage
 * it serves, what that stage is accountable for, what it must refuse, and what it
 * hands to the next one. That is why:
 *
 *  - its body ships as an editable file under `templates/experts/<role>.md`
 *    rather than being generated from detection, which knows nothing about it;
 *  - its front matter is `kind: role`, so the §2.3 domain-match rule (which reads
 *    `kind: domain`) never picks it up by path — a role loads because a stage
 *    NAMED it, and for no other reason;
 *  - its training mode is `full`, not `light`: a grep for the word "architect"
 *    over a codebase is not this expert's domain (see `roleTraining.ts`).
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { TEMPLATES_DIR } from "../paths.ts";
import { runtime } from "../runtime/index.ts";

/** The stage files' `experts:` names, in workflow order: what → how → plan → build → watch. */
export const ROLE_EXPERTS: readonly string[] = [
  "product", "architect", "delivery", "developer", "operations",
];

/** Where a role body lives, so `init` and `expert create --role` read one file. */
export const ROLE_TEMPLATES_DIR: string = join(TEMPLATES_DIR, "experts");

export function isRoleExpert(name: string): boolean {
  return ROLE_EXPERTS.includes(name);
}

export function roleTemplatePath(role: string): string {
  return join(ROLE_TEMPLATES_DIR, `${role}.md`);
}

export function hasRoleTemplate(role: string): boolean {
  return existsSync(roleTemplatePath(role));
}

/**
 * What one seeded role expert is accountable for, as its single competency area.
 *
 * `product` is the exception and keeps the area `init` has always given it — the
 * PROJECT's own slug — because that is the one role whose subject has a real name
 * this workspace knows. Renaming it to `product` would rewrite an area id that
 * existing workspaces already carry evidence under, for no gain.
 */
export const ROLE_AREA_TITLES: Readonly<Record<string, string>> = {
  product: "The product, the What stage, and what counts as done",
  architect: "The How stage: design placed on real files, contracts, and risk",
  delivery: "The Plan stage: stories, dependency waves, and the budget",
  developer: "The Build stage: one story, its DoD, and the evidence it leaves",
  operations: "The Watch stage: what a shipped feature emits, and its baseline",
};

export interface RoleRenderOptions {
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly repos: readonly string[];
}

/**
 * Read a role body, or `null` when this slug ships none.
 *
 * `null` rather than a throw: `expert create --role <slug>` is open-world (a team
 * may want a `security` role the framework never heard of), and the caller falls
 * back to the generic `templates/expert.md` with `kind: role`.
 */
export async function readRoleTemplate(role: string): Promise<string | null> {
  const path = roleTemplatePath(role);
  if (!existsSync(path)) return null;
  return runtime.readText(path);
}

/**
 * Fill a role template's front matter. The BODY is left byte-for-byte alone — it
 * is the part a team edits, and a renderer that rewrote prose would silently undo
 * their edits on the next `init`.
 */
export function renderRoleExpert(template: string, options: RoleRenderOptions): string {
  return template
    .replace(/^name:.*$/m, `name: ${options.name}`)
    .replace(/^kind:.*$/m, "kind: role")
    .replace(/^created_by:.*$/m, `created_by: "${options.createdBy}"`)
    .replace(/^created_at:.*$/m, `created_at: ${options.createdAt}`)
    .replace(/^repos:.*$/m, `repos: [${options.repos.join(", ")}]`)
    .replace(/^# <Expert name>$/m, `# ${options.name}`);
}
