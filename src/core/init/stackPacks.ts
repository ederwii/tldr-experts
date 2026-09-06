/**
 * Materialising the stack packs into `.tldrx/experts/<lang>-stack/` (stack packs design
 * §4.2, §4.6), and the three verbs behind `tldrx expert packs`.
 *
 * Three rules, each pinned by a test:
 *  - the pack body replaces `expert.md`'s body ONLY when that body is byte-identical to
 *    what `renderExpert` would seed today (or is empty — "delete the body to re-seed");
 *    an edited body is kept and said so. Front matter is preserved and gains
 *    `pack: <lang>@<hash>` so `status` can name the shipment;
 *  - `overlays/` is framework-managed: emptied and rewritten on every enable and re-init,
 *    each overlay under the `<lang>-stack` experts its detection-table row names,
 *    intersected with the repo's own languages;
 *  - `disable` removes `overlays/` and touches nothing else.
 *
 * What cannot be materialised is NAMED, never dropped: a language with no shipped pack,
 * and an overlay whose repo has no pack language to hang it on, each get their own line
 * with the reason (AGENTS.md §7 — absent-with-reason).
 *
 * Nothing here spawns a model. Detection is filesystem + git, exactly as `init`'s.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { detectWorkspace } from "../detect/detectWorkspace.ts";
import { isPackLanguage, overlayRule, PACK_LANGUAGES, type PackLanguage } from "../detect/overlays.ts";
import { repoSlug } from "../detect/repoSlug.ts";
import type { CommandRunner } from "../detect/CommandRunner.ts";
import type { DetectedOverlay } from "../detect/overlays.ts";
import type { DetectedSkill } from "../detect/skills.ts";
import type { DetectedRepo, DetectedWorkspace } from "../detect/types.ts";
import { expertDir, expertsDir, EXPERT_FILE } from "../experts/loadExperts.ts";
import { splitFrontMatter } from "../experts/expertDocument.ts";
import { parseList } from "../experts/expertDomain.ts";
import { OVERLAYS_DIRNAME, readOverlayFiles } from "../experts/packSections.ts";
import { readOverlayTemplate, readPackBody, templatesHash } from "../experts/packTemplates.ts";
import { readStackPacks } from "../experts/stackPacks.ts";
import { PROJECT_WORKSPACE_FILE } from "../paths.ts";
import { runtime } from "../runtime/index.ts";
import { readYamlFile } from "../yaml.ts";
import { loadWorkspaceFile } from "./loadWorkspaceFile.ts";
import { planExperts } from "./planExperts.ts";
import { renderExpert } from "./renderExpert.ts";
import { EXPERTS_DIR, seedExperts } from "./seedExperts.ts";
import { formatIssues, validateWorkspaceDocument } from "./validateEmitted.ts";
import { renderWorkspaceFile, type StackPacksDocument, type WorkspaceDocument } from "./workspaceDocument.ts";
import { WriteLog } from "./writeFile.ts";

export type BodyState =
  | { readonly kind: "stub" }
  | { readonly kind: "pack"; readonly hash: string }
  | { readonly kind: "edited"; readonly was: string | null };

/** The body `init` would seed for this stack expert today — derived by calling the seeder, never re-typed. */
export function stubBodyFor(name: string, repos: readonly string[]): string {
  return splitFrontMatter(renderExpert({ name, kind: "stack", repos, folders: [], areas: [] }, "1970-01-01T00:00:00Z")).body;
}

/** A materialised body: a blank line after the front matter fence, then the template verbatim. */
export function packBodyText(template: string): string {
  return `\n${template}`;
}

/**
 * Which of the three states `expert.md` is in.
 *
 * An EMPTY body reads as `stub` on purpose: §4.2's remedy for an edited body is "delete
 * the body to re-seed", and that remedy only works if an empty body is re-seedable.
 */
export function bodyState(expertMd: string, lang: PackLanguage): BodyState {
  const { frontMatter, body } = splitFrontMatter(expertMd);
  const template = readPackBody(lang);
  if (template !== null && body === packBodyText(template)) return { kind: "pack", hash: templatesHash() };
  const name = frontMatter.get("name") ?? `${lang}-stack`;
  if (body.trim() === "" || body === stubBodyFor(name, parseList(frontMatter.get("repos") ?? ""))) return { kind: "stub" };
  return { kind: "edited", was: frontMatter.get("pack") ?? null };
}

/** The front matter block (through its closing fence) with `pack: <lang>@<hash>` set or added. */
function headWithPack(head: string, lang: PackLanguage, hash: string): string {
  const line = `pack: ${lang}@${hash}`;
  if (head === "") return `---\n${line}\n---\n`;
  if (/^pack:.*$/m.test(head)) return head.replace(/^pack:.*$/m, line);
  const close = head.lastIndexOf("\n---");
  return `${head.slice(0, close)}\n${line}${head.slice(close)}`;
}

export interface ApplyInput {
  /** The directory holding `.tldrx/`. */
  readonly workspaceDir: string;
  readonly workspace: DetectedWorkspace;
  readonly log: WriteLog;
}

export interface ApplyReport {
  readonly lines: readonly string[];
  readonly applied: number;
  readonly overlays: number;
  readonly kept: readonly string[];
}

/** Bodies first, then overlays, for every `<lang>-stack` the workspace's languages name. */
export async function applyStackPacks(input: ApplyInput): Promise<ApplyReport> {
  const lines: string[] = [];
  const kept: string[] = [];
  let applied = 0;
  const languages = PACK_LANGUAGES.filter((lang) =>
    input.workspace.repos.some((repo) => repo.languages.includes(lang)));
  const hash = templatesHash();

  for (const lang of languages) {
    const name = `${lang}-stack`;
    const rel = `${EXPERTS_DIR}/${name}/${EXPERT_FILE}`;
    const path = join(input.workspaceDir, rel);
    if (!existsSync(path)) { lines.push(`${name}: no ${EXPERT_FILE} — not seeded`); continue; }
    const template = readPackBody(lang);
    if (template === null) { lines.push(`${name}: no pack ships for ${lang}`); continue; }
    const text = readFileSync(path, "utf8");
    const state = bodyState(text, lang);
    const { body } = splitFrontMatter(text);
    const head = text.slice(0, text.length - body.length);
    switch (state.kind) {
      case "pack":
        if (!head.includes(`pack: ${lang}@${hash}`)) {
          await input.log.overwrite(path, rel, headWithPack(head, lang, hash) + body);
        }
        lines.push(`${name}: pack already at pack@${hash}`);
        break;
      case "stub":
        await input.log.overwrite(path, rel, headWithPack(head, lang, hash) + packBodyText(template));
        lines.push(`${name}: pack applied (pack@${hash})`);
        applied += 1;
        break;
      case "edited":
        lines.push(`kept: ${name} body was edited — pack body not applied (delete the body to re-seed)`);
        kept.push(name);
        break;
    }
  }

  const overlays = await materialiseOverlays(input, lines);
  // One line per language, not one joined line: each is its own absent-with-reason.
  const noPack = [...new Set(input.workspace.repos.flatMap((repo) => repo.languages))]
    .filter((lang) => !isPackLanguage(lang))
    .sort();
  for (const lang of noPack) lines.push(`no pack ships for ${lang}`);
  return { lines, applied, overlays, kept };
}

/** One detected overlay that no `<lang>-stack` expert could claim, and why not. */
interface Unmaterialised {
  readonly repo: string;
  readonly id: string;
  readonly reason: string;
}

/** Empty every `<lang>-stack/overlays/`, then write what detection proved. Returns the count written. */
async function materialiseOverlays(input: ApplyInput, lines: string[]): Promise<number> {
  const targets = new Map<string, Map<string, string>>();
  const orphans: Unmaterialised[] = [];
  for (const repo of input.workspace.repos) {
    const langs = repo.languages.filter(isPackLanguage);
    for (const overlay of repo.overlays) {
      const rule = overlayRule(overlay.id);
      const template = readOverlayTemplate(overlay.id);
      if (rule === undefined || template === null) {
        orphans.push({ repo: repo.name, id: overlay.id, reason: "no overlay template ships for it" });
        continue;
      }
      const claimed = langs.filter((lang) => rule.languages.includes(lang));
      if (claimed.length === 0) {
        orphans.push({ repo: repo.name, id: overlay.id, reason: noTargetReason(repo, rule.languages) });
        continue;
      }
      for (const lang of claimed) {
        const name = `${lang}-stack`;
        const files = targets.get(name) ?? new Map<string, string>();
        files.set(overlay.id, template);
        targets.set(name, files);
      }
    }
  }
  for (const lang of PACK_LANGUAGES) {
    const dir = join(expertDir(input.workspaceDir, `${lang}-stack`), OVERLAYS_DIRNAME);
    if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  }
  let written = 0;
  for (const [name, files] of [...targets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const dir = expertDir(input.workspaceDir, name);
    if (!existsSync(dir)) { lines.push(`${name}: not seeded — overlays skipped`); continue; }
    const ids = [...files.keys()].sort();
    for (const id of ids) {
      await input.log.overwrite(
        join(dir, OVERLAYS_DIRNAME, `${id}.md`), `${EXPERTS_DIR}/${name}/${OVERLAYS_DIRNAME}/${id}.md`, files.get(id) ?? "",
      );
      written += 1;
    }
    lines.push(`${name}: overlays written: ${ids.join(", ")}`);
  }
  for (const orphan of orphans) {
    lines.push(`${orphan.repo}: overlay ${orphan.id} detected but not materialised — ${orphan.reason}`);
  }
  return written;
}

/** Why an overlay this repo proved has no `<lang>-stack` expert to live under. */
function noTargetReason(repo: DetectedRepo, ruleLanguages: readonly PackLanguage[]): string {
  if (repo.languages.length === 0) return `${repo.name} has no detectable language`;
  return `no pack ships for ${repo.languages.join(", ")} (the overlay belongs to ${ruleLanguages.join(", ")})`;
}

/** `repos[].overlays` / `.skills` from a fresh detection, and the switch, onto the existing document. */
export function patchWorkspaceDocument(
  existing: Record<string, unknown>,
  workspace: DetectedWorkspace,
  stackPacks: StackPacksDocument,
): { document: Record<string, unknown>; unmatched: readonly string[] } {
  const byName = new Map(workspace.repos.map((repo) => [repo.name, repo]));
  const seen = new Set<string>();
  const repos = Array.isArray(existing.repos)
    ? (existing.repos as unknown[]).map((row) => {
        if (typeof row !== "object" || row === null) return row;
        const repo = row as Record<string, unknown>;
        const detected = typeof repo.name === "string" ? byName.get(repo.name) : undefined;
        if (detected === undefined) return repo;
        seen.add(detected.name);
        return {
          ...repo,
          overlays: detected.overlays.map((item) => ({ id: item.id, evidence: item.evidence })),
          skills: detected.skills.map((item) => ({
            name: item.name, description: item.description, path: item.path, tracked: item.tracked,
          })),
        };
      })
    : existing.repos;
  const unmatched = workspace.repos.map((repo) => repo.name).filter((name) => !seen.has(name));
  return { document: { ...existing, repos, stack_packs: stackPacks }, unmatched };
}

export interface PacksOutcome {
  /** False ⇒ the CLI exits 1 (usage family) and prints `lines` on stderr. */
  readonly ok: boolean;
  readonly lines: readonly string[];
}

interface RepoLine {
  readonly name: string;
  readonly overlays: readonly DetectedOverlay[];
  readonly skills: readonly DetectedSkill[];
}

/** `  api — overlays: mediatr-cqrs (Directory.Packages.props: Include="MediatR"); skills: none` */
export function describeRepos(repos: readonly RepoLine[]): readonly string[] {
  return repos.map((repo) => {
    const overlays = repo.overlays.length === 0
      ? "none" : repo.overlays.map((item) => `${item.id} (${item.evidence})`).join(", ");
    const skills = repo.skills.length === 0
      ? "none" : repo.skills.map((item) => `${item.name} (${item.tracked ? "tracked" : "untracked"})`).join(", ");
    return `  ${repo.name} — overlays: ${overlays}; skills: ${skills}`;
  });
}

export async function enableStackPacks(input: {
  readonly workspaceDir: string;
  readonly runner: CommandRunner;
  /** RFC3339, already formatted by the caller (`rfc3339(new Date())`). */
  readonly now: string;
}): Promise<PacksOutcome> {
  const loaded = await loadWorkspaceFile(input.workspaceDir);
  const workspace = await detectWorkspace(loaded.root, input.runner);
  if (!workspace.repos.some((repo) => repo.languages.length > 0)) {
    return {
      ok: false,
      lines: [
        "no detectable language in any repo — nothing to enable.",
        "A pack needs a manifest: package.json, *.csproj or *.sln, pyproject.toml, or requirements.txt.",
      ],
    };
  }
  const path = join(input.workspaceDir, PROJECT_WORKSPACE_FILE);
  const existing = (await readYamlFile(path)) as Record<string, unknown>;
  const { document, unmatched } = patchWorkspaceDocument(existing, workspace, { enabled: true, enabled_at: input.now });
  // The on-disk document already has every §2.1 field; the emitted-document validator
  // projects `mode` onto the skeleton, so it is the right one for a patched raw file.
  const validation = validateWorkspaceDocument(document as unknown as WorkspaceDocument);
  if (!validation.ok) throw new Error(formatIssues(PROJECT_WORKSPACE_FILE, validation));
  await runtime.writeText(path, renderWorkspaceFile(document));

  const log = new WriteLog();
  const plans = planExperts(workspace, [], { project: repoSlug(basename(loaded.root)) })
    .filter((plan) => plan.kind === "stack");
  await seedExperts({ outDir: input.workspaceDir, plans, createdAt: input.now, log });

  const lines: string[] = [`stack packs: enabled (${input.now})`, ...describeRepos(workspace.repos)];
  for (const name of unmatched) lines.push(`  ${name}: not in ${PROJECT_WORKSPACE_FILE} — run \`tldrx init\` to add it`);
  const report = await applyStackPacks({ workspaceDir: input.workspaceDir, workspace, log });
  lines.push(...report.lines.map((line) => `  ${line}`));
  return { ok: true, lines };
}

export async function disableStackPacks(input: { readonly workspaceDir: string }): Promise<PacksOutcome> {
  await loadWorkspaceFile(input.workspaceDir);
  const path = join(input.workspaceDir, PROJECT_WORKSPACE_FILE);
  const existing = (await readYamlFile(path)) as Record<string, unknown>;
  const document = { ...existing, stack_packs: { enabled: false, enabled_at: null } };
  await runtime.writeText(path, renderWorkspaceFile(document));
  const lines: string[] = ["stack packs: disabled"];
  for (const lang of PACK_LANGUAGES) {
    const dir = join(expertDir(input.workspaceDir, `${lang}-stack`), OVERLAYS_DIRNAME);
    if (!existsSync(dir)) continue;
    await rm(dir, { recursive: true, force: true });
    lines.push(`  removed ${EXPERTS_DIR}/${lang}-stack/${OVERLAYS_DIRNAME}/ (regenerable by \`tldrx expert packs enable\`)`);
  }
  lines.push("  bodies and knowledge/ untouched");
  return { ok: true, lines };
}

export async function stackPacksStatus(input: { readonly workspaceDir: string }): Promise<PacksOutcome> {
  await loadWorkspaceFile(input.workspaceDir);
  const packs = readStackPacks(input.workspaceDir);
  const lines: string[] = [
    packs.enabled ? `stack packs: enabled (since ${packs.enabledAt ?? "unknown"})` : "stack packs: disabled",
    ...describeRepos(packs.repos),
  ];
  const dir = expertsDir(input.workspaceDir);
  const names = existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith("-stack")).sort() : [];
  for (const name of names) {
    const lang = name.slice(0, -"-stack".length);
    if (!isPackLanguage(lang)) { lines.push(`  ${name}: no pack ships for ${lang}`); continue; }
    const path = join(expertDir(input.workspaceDir, name), EXPERT_FILE);
    if (!existsSync(path)) { lines.push(`  ${name}: no ${EXPERT_FILE}`); continue; }
    const state = bodyState(readFileSync(path, "utf8"), lang);
    const overlays = readOverlayFiles(expertDir(input.workspaceDir, name)).map((file) => file.id);
    lines.push(`  ${name}: body ${describeBody(state)}, overlays: ${overlays.length === 0 ? "none" : overlays.join(", ")}`);
  }
  return { ok: true, lines };
}

function describeBody(state: BodyState): string {
  switch (state.kind) {
    case "pack": return `pack@${state.hash}`;
    case "stub": return "stub";
    case "edited": return state.was === null ? "edited" : `edited (was pack@${state.was.split("@")[1] ?? state.was})`;
  }
}
