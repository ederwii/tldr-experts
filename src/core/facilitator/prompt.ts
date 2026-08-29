/**
 * Prompt assembly (spec §2.3, §5).
 *
 * "Placeholders `{{run}} {{repos}} {{inputs}} {{facts}} {{conventions}}
 * {{budget_usd}}` are substituted by the facilitator, never by the model." That
 * sentence is the whole design: the sub-agent is handed a finished document, not
 * a template plus permission to go find things. Its `## Inputs` section carries
 * the CONTENT of the declared inputs and nothing else, so "read nothing else" is
 * a statement about what is physically in the prompt rather than a request.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { parseYaml } from "../yaml.ts";
import { isRetired, type Fact } from "../facts/Fact.ts";

export const PLACEHOLDERS = ["run", "repos", "inputs", "facts", "conventions", "budget_usd"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface PromptParts {
  /** `stage.md`, verbatim. */
  readonly stageMd: string;
  readonly values: Readonly<Record<Placeholder, string>>;
  /** `expert.md` bodies, in load order, keyed by expert name. */
  readonly experts: readonly { readonly name: string; readonly body: string }[];
  /** Declared input path -> file content, already read from disk. */
  readonly inputs: readonly { readonly path: string; readonly content: string }[];
  /**
   * Why this stage is being run again — a previous failure, an operator's reject
   * note, or both. Empty on a first attempt, and then no section is emitted at
   * all: a heading saying "nothing went wrong last time" is noise in every prompt.
   */
  readonly previousAttempt?: string;
}

export function buildPrompt(parts: PromptParts): string {
  const substituted = substitute(parts.stageMd, parts.values);
  const withInputs = replaceSection(substituted, "Inputs", renderInputs(parts.inputs));
  const previous = (parts.previousAttempt ?? "").trim();
  const withPrevious = previous === ""
    ? withInputs
    : replaceSection(withInputs, "Previous attempt", previous);
  const experts = parts.experts.map((expert) =>
    `\n\n---\n\n<!-- expert: ${expert.name} -->\n${expert.body.trimEnd()}\n`,
  );
  return `${withPrevious.trimEnd()}\n${experts.join("")}`;
}

/** Every `{{name}}` we own; anything else is left alone rather than blanked. */
export function substitute(text: string, values: Readonly<Record<Placeholder, string>>): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (whole, name: string) =>
    (PLACEHOLDERS as readonly string[]).includes(name) ? values[name as Placeholder] : whole,
  );
}

/**
 * Replace the body of an H2 section, keeping the heading. When the section does
 * not exist — every DRAFT `stage.md` in this repo is missing `## Inputs` — it is
 * appended, because a prompt without its inputs is not a prompt.
 */
export function replaceSection(markdown: string, heading: string, body: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return `${markdown.trimEnd()}\n\n## ${heading}\n\n${body.trimEnd()}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("## ")) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, start + 1);
  const tail = lines.slice(end);
  return [...head, "", body.trimEnd(), "", ...tail].join("\n");
}

export function renderInputs(inputs: readonly { path: string; content: string }[]): string {
  if (inputs.length === 0) {
    return "_No input files are declared for this stage. Do not go looking for others._";
  }
  const out = [
    "These files are the ONLY ones you may read. Their full content is inlined below,",
    "so there is nothing to open and nothing else to find.",
    "",
  ];
  for (const input of inputs) {
    const fence = fenceFor(input.content);
    out.push(`### \`${input.path}\``, "", `${fence}`, input.content.replace(/\n$/, ""), `${fence}`, "");
  }
  return out.join("\n");
}

/** A fence long enough that the file's own backticks cannot close it. */
export function fenceFor(content: string): string {
  let longest = 2;
  for (const match of content.matchAll(/^\s*(`{3,})/gm)) {
    longest = Math.max(longest, (match[1] ?? "").length);
  }
  return "`".repeat(longest + 1);
}

/**
 * `{{facts}}` — spec §5 renders `grep(facts.yml, sy.area/r.repos)`. A stage has no
 * `area` field in either shape, so the filter is the repo half only: a non-retired
 * fact scoped to a repo in this run, or scoped to none at all (workspace-wide).
 */
export function renderFacts(facts: readonly Fact[], repos: readonly string[]): string {
  const relevant = facts.filter(
    (fact) => !isRetired(fact) && (fact.repos.length === 0 || fact.repos.some((r) => repos.includes(r))),
  );
  if (relevant.length === 0) return "_No recorded facts match this run's repos._";
  return relevant
    .map((fact) => `- [${fact.id}] ${fact.fact} (${fact.area} · ${fact.confidence})`)
    .join("\n");
}

/**
 * `{{conventions}}` — `[assumption]`: the shared file plus one per repo in the
 * run, which is exactly what `tldrx init` writes (`src/core/init/conventions.ts`).
 * Content, not paths: the sub-agent may only read its declared inputs, so a
 * pointer to a file it is not allowed to open would be useless.
 */
export function renderConventions(root: string, repos: readonly string[]): string {
  const files = ["shared.md", ...repos.map((repo) => `${repo}.md`)];
  const chunks: string[] = [];
  for (const name of files) {
    const path = join(root, PROJECT_FRAMEWORK_DIR, "conventions", name);
    if (!existsSync(path)) continue;
    chunks.push(`<!-- ${PROJECT_FRAMEWORK_DIR}/conventions/${name} -->\n${readFileSync(path, "utf8").trimEnd()}`);
  }
  return chunks.length === 0 ? "_No conventions files exist yet._" : chunks.join("\n\n");
}

/** `.tldrx/experts/<name>/expert.md`, skipping the ones that do not exist. */
export function loadExpertBodies(
  root: string,
  names: readonly string[],
): readonly { name: string; body: string }[] {
  const bodies: { name: string; body: string }[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(root, PROJECT_FRAMEWORK_DIR, "experts", name, "expert.md");
    if (!existsSync(path)) continue;
    bodies.push({ name, body: readFileSync(path, "utf8") });
  }
  return bodies;
}

/**
 * Spec §2.3 `stack_experts: also load stack expertise for run.repos`.
 * `[assumption]` — `tldrx init` names these `<language>-stack`
 * (`src/core/init/planExperts.ts`), so the mapping is repo -> its detected
 * languages -> `<language>-stack`, filtered to the ones that exist on disk.
 */
export function stackExpertNames(root: string, repos: readonly string[]): readonly string[] {
  const path = join(root, PROJECT_FRAMEWORK_DIR, "workspace.yml");
  if (!existsSync(path)) return [];
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const list = (doc as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(list)) return [];

  const names: string[] = [];
  for (const row of list as { name?: unknown; stack?: unknown }[]) {
    if (typeof row?.name !== "string" || !repos.includes(row.name)) continue;
    const stack = Array.isArray(row.stack) ? (row.stack as unknown[]) : [];
    for (const language of stack) {
      if (typeof language !== "string" || language === "") continue;
      const expert = `${language}-stack`;
      if (!names.includes(expert)) names.push(expert);
    }
  }
  return names;
}
