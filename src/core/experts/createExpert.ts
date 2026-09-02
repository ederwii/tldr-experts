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
 *
 * `--role <slug>` is the third flag, and the only one with a body of its own: it
 * seeds exactly what `init` seeds for a role expert, from the same
 * `templates/experts/<slug>.md`. That matters because the shipped role bodies are
 * the substance of the expert — a `--role architect` that wrote the generic
 * template would create a folder with the right name and none of the content.
 * A slug the framework ships no template for still works: it falls back to the
 * generic template with `kind: role`, so a team can add a `security` role the
 * framework never heard of.
 *
 * **`--area` and `repos:` (gh #94).** `tldrx expert create discoverer` used to
 * write a folder nothing could train: zero areas, and `expert train … --area
 * discoverer` answered `has no area (areas: none)` without naming a flag, a
 * subcommand, or the file to edit. `--area <id> [--title <text>]` is that missing
 * seed. `repos:` is the other half: `expert.md` had no such key at all, so a
 * hand-created expert declared nothing about which repos its `## Domain` bullets
 * are relative to — and the bullets a human then wrote were workspace-relative,
 * which matches nothing (measured 2026-09-02: a $2.10 full training whose 13 code
 * citations all earned `outside domain`). The repo list is read off
 * `.tldrx/workspace.yml`, and a workspace that has none writes `repos: []` rather
 * than guessing.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES_DIR } from "../paths.ts";
import { stringifyYaml } from "../yaml.ts";
import { buildCompetenciesDocument, type AreaSeed } from "../init/competenciesDocument.ts";
import { loadWorkspaceFile } from "../init/loadWorkspaceFile.ts";
import { COMPETENCIES_FILE, EXPERT_FILE, expertDir } from "./loadExperts.ts";
import { KNOWLEDGE_DIRNAME } from "./expertKnowledge.ts";
import { readRoleTemplate, renderRoleExpert, ROLE_AREA_TITLES } from "./roleExperts.ts";
import { runtime } from "../runtime/index.ts";

/** `[assumption]` The `repos[].name` grammar from spec §2.1, reused for expert folders. */
export const EXPERT_NAME_RE = /^[a-z0-9-]{1,32}$/;

export interface CreateExpertOptions {
  readonly root: string;
  readonly name: string;
  /**
   * The competency area to seed, verbatim (gh #94). This is the one flag that
   * says what it does: `--domain`/`--stack` also seed an area, but they name a
   * KIND, and the owner read them as naming a kind and nothing else — which left
   * `expert create <name>` writing an expert `expert train` then refused.
   */
  readonly area?: string | null;
  /**
   * The seeded area's title. It is not decoration: light mode's file sweep greps
   * the words of the area title (`training/selectFiles.ts`), so a title is what
   * decides which files the expert is shown.
   */
  readonly title?: string | null;
  /** One competency area for the domain, when given. */
  readonly domain?: string | null;
  /** One competency area for the stack/language, when given. */
  readonly stack?: string | null;
  /**
   * Seed this as a ROLE expert for `<slug>` — the same thing `tldrx init` writes
   * for `product`, `architect`, `delivery`, `developer` and `operations`.
   */
  readonly role?: string | null;
  readonly createdAt: string;
}

export interface CreatedExpert {
  readonly dir: string;
  readonly files: readonly string[];
  readonly areas: readonly string[];
  /** `role` | `stack` | `domain` — what went into the front matter. */
  readonly kind: string;
  /** True when a shipped `templates/experts/<slug>.md` supplied the body. */
  readonly fromRoleTemplate: boolean;
  /** The `repos:` written into the front matter, off `.tldrx/workspace.yml`. */
  readonly repos: readonly string[];
}

/**
 * `[assumption]` The spec does not say what `kind` a hand-created expert has:
 * `--stack` makes it a stack expert, anything else a domain one. Both flags may
 * be given, and each contributes exactly one area.
 */
export function planAreas(options: CreateExpertOptions): readonly AreaSeed[] {
  const areas: AreaSeed[] = [];
  const area = (options.area ?? "").trim();
  const stack = (options.stack ?? "").trim();
  const domain = (options.domain ?? "").trim();
  const role = (options.role ?? "").trim();
  // `--area` first: it is the one the operator named outright, and the first area
  // is the one `expert list` and the created-expert line lead with.
  if (area !== "") areas.push({ id: area, title: areaTitle(area, options.title) });
  // A role's area is the role itself, and it seeds `--mode full`: light mode is
  // refused for a role expert (`training/roleTraining.ts`), so a copy-pasteable
  // `train_prompt` that named it would be a command that exits 1.
  if (role !== "") {
    areas.push({
      id: role,
      title: ROLE_AREA_TITLES[role] ?? `The ${role} role in this workflow`,
      mode: "full",
    });
  }
  if (stack !== "") areas.push({ id: stack, title: `${stack} language, build and test tooling` });
  if (domain !== "") areas.push({ id: domain, title: `The ${domain} domain` });
  return areas;
}

/**
 * The seeded title for `--area`, and the default is deliberately thin prose
 * rather than the bare id: light mode greps the title's words, so `The discoverer
 * area of this workspace` at least contributes the id itself. The CLI says the
 * default out loud and names `--title`, because a title nobody chose is a search
 * nobody tuned.
 */
export function areaTitle(area: string, title: string | null | undefined): string {
  const given = (title ?? "").trim();
  return given === "" ? `The ${area} area of this workspace` : given;
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
  const role = (options.role ?? "").trim();
  if (role !== "" && !EXPERT_NAME_RE.test(role)) {
    throw new Error(`invalid role '${role}' — expected ${EXPERT_NAME_RE.source}`);
  }
  // An area id is a filename (`knowledge/<area>.md`) and half of a copy-pasteable
  // `--area` argument, so it obeys the same slug rule the expert name does. Caught
  // here rather than written and discovered at train time.
  const area = (options.area ?? "").trim();
  if (area !== "" && !EXPERT_NAME_RE.test(area)) {
    throw new Error(`invalid area '${area}' — expected ${EXPERT_NAME_RE.source}`);
  }
  const repos = await workspaceRepos(options.root);
  const kind = role !== "" ? "role" : (options.stack ?? "").trim() !== "" ? "stack" : "domain";
  const roleTemplate = role === "" ? null : await readRoleTemplate(role);
  const body = roleTemplate === null
    ? renderExpertMarkdown(
      await runtime.readText(join(TEMPLATES_DIR, EXPERT_FILE)),
      options.name, kind, options.createdAt, repos,
    )
    : renderRoleExpert(roleTemplate, {
      name: options.name,
      createdBy: "tldrx expert create",
      createdAt: options.createdAt,
      repos,
    });

  mkdirSync(dir, { recursive: true });
  writeFileSync(expertPath, body, "utf8");
  writeFileSync(
    competenciesPath,
    "# Written by `tldrx expert create` (spec §2.6). `level` is computed, never hand-set.\n"
      + stringifyYaml(buildCompetenciesDocument(options.name, areas)),
    "utf8",
  );
  if (kind === "role") mkdirSync(join(dir, KNOWLEDGE_DIRNAME), { recursive: true });

  return {
    dir,
    files: [expertPath, competenciesPath],
    areas: areas.map((seed) => seed.id),
    kind,
    fromRoleTemplate: roleTemplate !== null,
    repos,
  };
}

/**
 * The workspace's repo names, or none.
 *
 * A missing or unreadable `.tldrx/workspace.yml` is not a reason to refuse to
 * create an expert — `expert create` is one of the commands a person reaches for
 * on a workspace that is not fully set up. It writes `repos: []`, which is the
 * honest answer and still teaches the reader that the key exists.
 */
async function workspaceRepos(root: string): Promise<readonly string[]> {
  try {
    const workspace = await loadWorkspaceFile(root);
    return workspace.repos.map((repo) => repo.name);
  } catch {
    return [];
  }
}

/** Fill the template's front matter and title; the guidance body is left intact. */
export function renderExpertMarkdown(
  template: string,
  name: string,
  kind: string,
  createdAt: string,
  repos: readonly string[] = [],
): string {
  const filled = template
    .replace(/^name:.*$/m, `name: ${name}`)
    .replace(/^kind:.*$/m, `kind: ${kind}            # domain | stack | role`)
    .replace(/^created_by:.*$/m, 'created_by: "tldrx expert create"')
    .replace(/^created_at:.*$/m, `created_at: ${createdAt}`)
    .replace(/^# <Expert name>$/m, `# ${name}`);
  const line = `repos: [${repos.join(", ")}]`;
  // Replace the template's key when it has one, and INSERT it when it does not —
  // an expert.md with no `repos:` is the state gh #94 was filed about, and a
  // renderer that silently produced one again would re-open it.
  return /^repos:.*$/m.test(filled)
    ? filled.replace(/^repos:.*$/m, line)
    : filled.replace(/^created_at:.*$/m, (match) => `${match}\n${line}`);
}
