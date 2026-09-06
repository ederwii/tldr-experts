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
import { hashText, readOverlayTemplate, readPackBody, templatesHash } from "../experts/packTemplates.ts";
import { readStackPacks } from "../experts/stackPacks.ts";
import { plural } from "../map/plural.ts";
import { PROJECT_WORKSPACE_FILE } from "../paths.ts";
import { runtime } from "../runtime/index.ts";
import { readYamlFile } from "../yaml.ts";
import { loadWorkspaceFile } from "./loadWorkspaceFile.ts";
import { planExperts } from "./planExperts.ts";
import { renderExpert } from "./renderExpert.ts";
import { EXPERTS_DIR, seedExperts } from "./seedExperts.ts";
import { formatIssues, validateWorkspaceDocument } from "./validateEmitted.ts";
import { renderWorkspaceFile, type StackPacksDocument, type WorkspaceDocument } from "./workspaceDocument.ts";
import { endWithNewline, WriteLog } from "./writeFile.ts";

export type BodyState =
  | { readonly kind: "stub" }
  | { readonly kind: "pack"; readonly hash: string }
  /** Materialised, untouched, but from an EARLIER shipment: `was` is its hash, `hash` is today's. */
  | { readonly kind: "stale"; readonly was: string; readonly hash: string }
  | { readonly kind: "edited"; readonly was: string | null };

/** The body `init` would seed for this stack expert today — derived by calling the seeder, never re-typed. */
export function stubBodyFor(name: string, repos: readonly string[]): string {
  return splitFrontMatter(renderExpert({ name, kind: "stack", repos, folders: [], areas: [] }, "1970-01-01T00:00:00Z")).body;
}

/** A materialised body: a blank line after the front matter fence, then the template verbatim. */
export function packBodyText(template: string): string {
  return `\n${template}`;
}

/** Exactly the bytes a materialised body has on disk — what `pack_body:` is the sha of. */
function writtenBody(template: string): string {
  // `WriteLog.overwrite` newline-terminates the whole file, and the body is its tail, so
  // this is what will actually be there — hashing the un-terminated text would name bytes
  // that never reach the disk for a template that happens not to end in a newline.
  return endWithNewline(packBodyText(template));
}

/**
 * Which of the four states `expert.md` is in.
 *
 * The front matter carries TWO facts, and keeping them separate is the whole point:
 * `pack_body:` names the body's own bytes, `pack:` names the shipment they came from. So
 * "a human edited this" (bytes differ) and "this is one release behind" (bytes match,
 * shipment differs) are different answers instead of both reading as `edited` — which is
 * what comparing against the current template alone did, and it made packs un-upgradeable
 * the moment any template changed.
 *
 * An EMPTY body reads as `stub` on purpose: §4.2's remedy for an edited body is "delete
 * the body to re-seed", and that remedy only works if an empty body is re-seedable.
 */
export function bodyState(expertMd: string, lang: PackLanguage): BodyState {
  const { frontMatter, body } = splitFrontMatter(expertMd);
  const shipment = templatesHash();
  const declaredBody = frontMatter.get("pack_body") ?? null;
  const declaredPack = frontMatter.get("pack") ?? null;

  if (declaredBody !== null && hashText(body) === declaredBody) {
    const was = shipmentOf(declaredPack);
    if (was === shipment) return { kind: "pack", hash: shipment };
    return { kind: "stale", was: was ?? "unknown", hash: shipment };
  }
  // Tolerant read of a record written before `pack_body:` existed (AGENTS.md §7 — formats
  // only grow): a body byte-identical to what ships TODAY is a current pack, and the next
  // apply stamps the missing key onto it.
  const template = readPackBody(lang);
  if (declaredBody === null && template !== null && body === writtenBody(template)) {
    return { kind: "pack", hash: shipment };
  }

  const name = frontMatter.get("name") ?? `${lang}-stack`;
  if (body.trim() === "" || body === stubBodyFor(name, parseList(frontMatter.get("repos") ?? ""))) return { kind: "stub" };
  return { kind: "edited", was: declaredPack };
}

/** `typescript@abc123def456` → `abc123def456`. Null in, null out — never a guessed hash. */
function shipmentOf(pack: string | null): string | null {
  if (pack === null) return null;
  const at = pack.indexOf("@");
  return at === -1 ? pack : pack.slice(at + 1);
}

/** The front matter block (through its closing fence) with `pack:` and `pack_body:` set or added. */
function headWithPack(head: string, lang: PackLanguage, hash: string, bodyHash: string): string {
  return withKey(withKey(head, "pack", `${lang}@${hash}`), "pack_body", bodyHash);
}

/** One `key: value` line, replaced where it already is or added just above the closing fence. */
function withKey(head: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  if (head === "") return `---\n${line}\n---\n`;
  // Anchored to the whole line, so `pack:` never matches `pack_body:` and vice versa.
  const existing = new RegExp(`^${key}:.*$`, "m");
  if (existing.test(head)) return head.replace(existing, line);
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
  /** Bodies written — a fresh stub materialised, or a stale one upgraded. */
  readonly applied: number;
  readonly overlays: number;
  /** Experts whose edited body was left alone. Names, not a count: the operator has to act. */
  readonly kept: readonly string[];
  /** Experts whose body was replaced with a newer shipment. */
  readonly upgraded: readonly string[];
  /** Detected languages no pack ships for. Named for the same reason `kept` is. */
  readonly noPack: readonly string[];
}

/**
 * The one line `tldrx init` prints for the packs.
 *
 * `kept` and `noPack` are NAMED here rather than counted, because they are the two
 * outcomes an operator has to do something about, and a re-init that silently drops them
 * leaves an edited body looking like a successful apply (found in review, round 1).
 */
export function describePacking(report: ApplyReport): string {
  const parts = [
    `${plural(report.applied, "pack body", "pack bodies")} applied`,
    `${plural(report.overlays, "overlay")} written`,
  ];
  if (report.upgraded.length > 0) parts.push(`upgraded: ${report.upgraded.join(", ")}`);
  if (report.kept.length > 0) {
    parts.push(`kept: ${report.kept.join(", ")} — body edited, pack body not applied`);
  }
  if (report.noPack.length > 0) parts.push(`no pack ships for ${report.noPack.join(", ")}`);
  return parts.join("; ");
}

/** Bodies first, then overlays, for every `<lang>-stack` the workspace's languages name. */
export async function applyStackPacks(input: ApplyInput): Promise<ApplyReport> {
  const lines: string[] = [];
  const kept: string[] = [];
  const upgraded: string[] = [];
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
    const fresh = writtenBody(template);
    switch (state.kind) {
      case "pack":
        // Nothing to write unless the record predates `pack_body:` — then stamp it, so the
        // next shipment can tell this untouched body from an edited one.
        if (!head.includes(`pack: ${lang}@${hash}`) || !/^pack_body:/m.test(head)) {
          await input.log.overwrite(path, rel, headWithPack(head, lang, hash, hashText(body)) + body);
        }
        lines.push(`${name}: pack already at pack@${hash}`);
        break;
      case "stale":
        await input.log.overwrite(path, rel, headWithPack(head, lang, hash, hashText(fresh)) + fresh);
        lines.push(`upgraded: ${name} pack@${state.was} → pack@${hash}`);
        upgraded.push(name);
        applied += 1;
        break;
      case "stub":
        await input.log.overwrite(path, rel, headWithPack(head, lang, hash, hashText(fresh)) + fresh);
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
  return { lines, applied, overlays, kept, upgraded, noPack };
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

/**
 * The shape `validateWorkspaceDocument` PRESUMES but does not check — returned as a
 * sentence naming the file and the missing key, or null when the file is usable.
 *
 * Every other caller of that validator hands it a `buildWorkspaceDocument` result, which
 * cannot be missing a key. `enableStackPacks` is the only one that hands it a parsed FILE,
 * so reaching its unguarded dereferences is THIS module's exposure and this module's job
 * to refuse. Measured on a hand-edited fixture before this guard existed: a repo row with
 * no `commands:` died at `validateEmitted.ts:49` with
 * `TypeError: Object.entries requires that input parameter not be null or undefined`; no
 * `path:` died at `:43` with `undefined is not an object (evaluating 'repo.path.includes')`;
 * a non-list `repos:` died at `:35` with `doc.repos.forEach is not a function`.
 * `loadWorkspaceFile` does not cover this — it skips malformed rows rather than rejecting
 * them, so a file it accepts can still carry every one of those three shapes.
 */
function malformedWorkspace(doc: Record<string, unknown>): string | null {
  const file = PROJECT_WORKSPACE_FILE;
  if (!Array.isArray(doc.repos)) {
    return `${file}: \`repos:\` is missing or is not a list — nothing to enable the packs against.`;
  }
  for (const [index, row] of (doc.repos as unknown[]).entries()) {
    const at = `${file}: repos[${index}]`;
    if (typeof row !== "object" || row === null || Array.isArray(row)) return `${at} is not a mapping.`;
    const repo = row as Record<string, unknown>;
    if (typeof repo.name !== "string") return `${at} has no \`name:\`.`;
    const named = `${at} (${repo.name})`;
    if (typeof repo.path !== "string") return `${named} has no \`path:\`.`;
    if (typeof repo.commands !== "object" || repo.commands === null || Array.isArray(repo.commands)) {
      return `${named} has no \`commands:\` mapping.`;
    }
  }
  return null;
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
  // Before anything is written, and before the validator is handed a hand-editable file.
  const malformed = malformedWorkspace(existing);
  if (malformed !== null) {
    return {
      ok: false,
      lines: [malformed, `Fix it, or re-run \`tldrx init\` to regenerate ${PROJECT_WORKSPACE_FILE} from detection.`],
    };
  }
  const { document, unmatched } = patchWorkspaceDocument(existing, workspace, { enabled: true, enabled_at: input.now });
  // The guard above has established every field this validator dereferences; it projects
  // `mode` onto the skeleton, so it is the right one for a patched raw file.
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
    case "stale": return `pack@${state.was} (stale — shipment is pack@${state.hash})`;
    case "stub": return "stub";
    case "edited": return state.was === null ? "edited" : `edited (was pack@${shipmentOf(state.was) ?? state.was})`;
  }
}
