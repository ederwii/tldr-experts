/**
 * `tldrx expert create <name>` — write `.tldrx/experts/<name>/`.
 *
 * Create-only, never overwrite: an expert folder holds a team's hand-written
 * role and whatever training has accumulated, and a `create` that clobbered it
 * would destroy exactly the thing the framework claims to accumulate. An
 * existing folder is an error (exit 1), not a merge.
 *
 * `expert.md` is rendered from `templates/expert.md` with the front matter
 * filled in. `competencies.yml` is built by the same `buildCompetenciesDocument`
 * that `init` uses rather than from `templates/competencies.yml`, because that
 * template is still the v0 draft shape (`schema_version: 0`, `areas[].area`) and
 * does not match spec §2.6. `[assumption]`
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES_DIR } from "../paths.ts";
import { stringifyYaml } from "../yaml.ts";
import { buildCompetenciesDocument, type AreaSeed } from "../init/competenciesDocument.ts";
import { COMPETENCIES_FILE, EXPERT_FILE, expertDir } from "./loadExperts.ts";

/** `[assumption]` The `repos[].name` grammar from spec §2.1, reused for expert folders. */
export const EXPERT_NAME_RE = /^[a-z0-9-]{1,32}$/;

export interface CreateExpertOptions {
  readonly root: string;
  readonly name: string;
  /** One competency area for the domain, when given. */
  readonly domain?: string | null;
  /** One competency area for the stack/language, when given. */
  readonly stack?: string | null;
  readonly createdAt: string;
}

export interface CreatedExpert {
  readonly dir: string;
  readonly files: readonly string[];
  readonly areas: readonly string[];
}

/**
 * `[assumption]` The spec does not say what `kind` a hand-created expert has:
 * `--stack` makes it a stack expert, anything else a domain one. Both flags may
 * be given, and each contributes exactly one area.
 */
export function planAreas(options: CreateExpertOptions): readonly AreaSeed[] {
  const areas: AreaSeed[] = [];
  const stack = (options.stack ?? "").trim();
  const domain = (options.domain ?? "").trim();
  if (stack !== "") areas.push({ id: stack, title: `${stack} language, build and test tooling` });
  if (domain !== "") areas.push({ id: domain, title: `The ${domain} domain` });
  return areas;
}

export async function createExpert(options: CreateExpertOptions): Promise<CreatedExpert> {
  if (!EXPERT_NAME_RE.test(options.name)) {
    throw new Error(`invalid expert name '${options.name}' — expected ${EXPERT_NAME_RE.source}`);
  }
  const dir = expertDir(options.root, options.name);
  const expertPath = join(dir, EXPERT_FILE);
  const competenciesPath = join(dir, COMPETENCIES_FILE);
  if (existsSync(expertPath) || existsSync(competenciesPath)) {
    throw new Error(`expert '${options.name}' already exists at ${dir} — refusing to overwrite it`);
  }

  const areas = planAreas(options);
  const kind = (options.stack ?? "").trim() !== "" ? "stack" : "domain";
  const template = await Bun.file(join(TEMPLATES_DIR, EXPERT_FILE)).text();

  mkdirSync(dir, { recursive: true });
  writeFileSync(expertPath, renderExpertMarkdown(template, options.name, kind, options.createdAt), "utf8");
  writeFileSync(
    competenciesPath,
    "# Written by `tldrx expert create` (spec §2.6). `level` is computed, never hand-set.\n"
      + stringifyYaml(buildCompetenciesDocument(options.name, areas)),
    "utf8",
  );

  return { dir, files: [expertPath, competenciesPath], areas: areas.map((area) => area.id) };
}

/** Fill the template's front matter and title; the guidance body is left intact. */
export function renderExpertMarkdown(
  template: string,
  name: string,
  kind: string,
  createdAt: string,
): string {
  return template
    .replace(/^name:.*$/m, `name: ${name}`)
    .replace(/^kind:.*$/m, `kind: ${kind}            # domain | stack | role`)
    .replace(/^created_by:.*$/m, 'created_by: "tldrx expert create"')
    .replace(/^created_at:.*$/m, `created_at: ${createdAt}`)
    .replace(/^# <Expert name>$/m, `# ${name}`);
}
