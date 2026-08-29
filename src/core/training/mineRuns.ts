/**
 * Full mode's pre-pass: which past runs and which recorded facts this expert is
 * allowed to learn from.
 *
 * Deterministic, like the code pre-pass, and for the same reason. It reads two
 * things and nothing else:
 *
 *   - `tldrx-work/<run>/**\/{handoff,retro}.md` for every run whose `repos` touch
 *     this expert's repos. A handoff is the one artefact in a run that is already
 *     required to be sourced (§2.8), so mining it cannot manufacture a claim that
 *     was never checked;
 *   - `.tldrx/memory/facts.yml` rows that are not retired and whose `area` or
 *     `repos` match this expert.
 *
 * **Claude Code transcripts are deliberately out of scope.** A transcript has no
 * provenance a `[src: …]` token can express and no line the framework can
 * re-resolve, so an "insight" mined from one would enter `competencies.yml` as an
 * unfalsifiable claim — precisely what the level formula exists to keep out.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { parseYaml } from "../yaml.ts";
import { isRetired, type Fact } from "../facts/Fact.ts";
import { listRunDirs } from "../../hooks/lib/workspace.ts";

/** `[assumption]` — the brief caps light mode at 40 files / 96 KB and says nothing
 * about full mode. These are the same ratio, halved: a run mine is a re-read of
 * documents this framework itself wrote, so it needs less room than a codebase. */
export const MAX_RUN_FILES = 24;
export const MAX_RUN_BYTES = 64 * 1024;

const MINED_NAMES: readonly string[] = ["handoff.md", "retro.md"];
const MAX_DEPTH = 4;

export interface MinedFile {
  /** Workspace-relative, POSIX — exactly the form a `[src: …]` must cite. */
  readonly path: string;
  readonly run: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly lines: number;
}

export interface RunMine {
  readonly files: readonly MinedFile[];
  /** Ranked matches the caps left out, by path. */
  readonly notRead: readonly string[];
  readonly facts: readonly Fact[];
  /** Runs considered and why they were kept or dropped — the audit trail. */
  readonly notes: readonly string[];
}

export interface MineOptions {
  readonly root: string;
  readonly repos: readonly string[];
  readonly areaId: string;
  readonly keywords: readonly string[];
  readonly facts: readonly Fact[];
}

export function mineRuns(options: MineOptions): RunMine {
  const notes: string[] = [];
  const candidates: { path: string; run: string; abs: string }[] = [];

  const runDirs = listRunDirs(options.root);
  if (runDirs.length === 0) {
    notes.push(`no run under \`${PROJECT_WORK_DIR}/\` has a run.yml — there is nothing to mine`);
  }

  for (const runDir of runDirs) {
    const run = runDir.split(/[\\/]/).pop() ?? runDir;
    const repos = runRepos(join(runDir, "run.yml"));
    const shared = repos.filter((repo) => options.repos.includes(repo));
    if (repos.length > 0 && shared.length === 0) {
      notes.push(`${run}: skipped — its repos (${repos.join(", ")}) do not include any of ${options.repos.join(", ")}`);
      continue;
    }
    notes.push(repos.length === 0
      ? `${run}: kept — it declares no repos, so it is workspace-wide`
      : `${run}: kept — shares ${shared.join(", ")}`);
    for (const abs of findMined(runDir, 0)) {
      candidates.push({ path: toPosix(relative(options.root, abs)), run, abs });
    }
  }

  // Newest run first (run ids sort by date), then path — deterministic and useful.
  candidates.sort((a, b) =>
    (a.run > b.run ? -1 : a.run < b.run ? 1 : 0)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files: MinedFile[] = [];
  const notRead: string[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (files.length >= MAX_RUN_FILES || bytes >= MAX_RUN_BYTES) {
      notRead.push(candidate.path);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(candidate.abs, "utf8");
    } catch {
      notRead.push(candidate.path);
      continue;
    }
    const cap = MAX_RUN_BYTES - bytes;
    const raw = Buffer.from(text, "utf8");
    const truncated = raw.length > cap;
    const content = truncated ? raw.subarray(0, cap).toString("utf8") : text;
    bytes += Buffer.byteLength(content, "utf8");
    files.push({ path: candidate.path, run: candidate.run, content, truncated, lines: text.split("\n").length });
  }

  return { files, notRead, facts: relevantFacts(options), notes };
}

/**
 * A fact is in scope when it is live AND it is about this area or these repos.
 * A workspace-wide fact about something else is not made relevant by being
 * workspace-wide — training an `oauth` area on the deploy rota would compute a
 * level nobody could defend.
 */
export function relevantFacts(options: MineOptions): readonly Fact[] {
  const words = new Set<string>([options.areaId, ...options.keywords]);
  return options.facts.filter((fact) => {
    if (isRetired(fact)) return false;
    const area = fact.area.toLowerCase();
    if ([...words].some((word) => area.includes(word) || word.includes(area))) return true;
    return fact.repos.some((repo) => options.repos.includes(repo));
  });
}

function findMined(dir: string, depth: number): readonly string[] {
  if (depth > MAX_DEPTH) return [];
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of [...entries].sort()) {
    if (entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) found.push(...findMined(abs, depth + 1));
    else if (MINED_NAMES.includes(entry)) found.push(abs);
  }
  return found;
}

function runRepos(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    const doc = parseYaml(readFileSync(path, "utf8"));
    const repos = (doc as { repos?: unknown } | null)?.repos;
    if (!Array.isArray(repos)) return [];
    return repos.filter((repo): repo is string => typeof repo === "string");
  } catch {
    return [];
  }
}

function toPosix(path: string): string {
  return path.split(/[\\/]/).join("/");
}
