/**
 * Framework overlays, detected from manifests and nothing else (stack packs design §4.4).
 *
 * A language pack says how <lang> code is checked; an overlay says how THIS project's
 * framework is checked — and a framework is a fact about a manifest, never about a
 * language. Two .NET workspaces can use opposite architectures (minimal APIs against
 * controllers + CQRS); one prescriptive ".NET pack" would be wrong for one of them. So
 * every row below fires on a named manifest signal and carries the evidence string a
 * reader can open. Unknown → no overlay, never a guess.
 *
 * This table is the ONE list of overlay ids in the tree. The template files under
 * `templates/experts/stack/overlays/` mirror it one-to-one, and a shape test refuses a
 * second copy of any id under `src/`.
 */
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { readEntries, walkFiles } from "./walk.ts";
import type { PackageJson } from "./stack.ts";

/** The languages a pack body ships for. Go and Rust have no overlay evidence to write against. */
export const PACK_LANGUAGES = ["typescript", "javascript", "python", "dotnet"] as const;
export type PackLanguage = (typeof PACK_LANGUAGES)[number];

export function isPackLanguage(value: string): value is PackLanguage {
  return (PACK_LANGUAGES as readonly string[]).includes(value);
}

const JS: readonly PackLanguage[] = ["typescript", "javascript"];
const NET: readonly PackLanguage[] = ["dotnet"];
const PY: readonly PackLanguage[] = ["python"];

export interface DetectedOverlay {
  readonly id: string;
  /** What fired the rule: a manifest path and the signal in it, e.g. `package.json: dependencies.react`. */
  readonly evidence: string;
}

/** One `Include="…"` as written, and the repo-relative file it was read from. */
export interface NetPackage {
  readonly name: string;
  readonly file: string;
}

/** Everything the rules may read. Built once per repo by `readManifests`; rules read only this. */
export interface Manifests {
  readonly packageJson: PackageJson | null;
  /** Repo-relative `*.csproj` paths → file text. */
  readonly csproj: ReadonlyMap<string, string>;
  /** Every PackageReference / PackageVersion `Include` across csproj files and `Directory.Packages.props`. */
  readonly netPackages: readonly NetPackage[];
  /** csproj paths whose own directory holds a `Controllers/` directory. */
  readonly controllers: ReadonlySet<string>;
  /** `[project] dependencies` names from `pyproject.toml`, lower-cased. Empty when absent. */
  readonly pyproject: readonly string[];
  /** Root-level `requirements*.txt` file name → lower-cased names. */
  readonly requirements: ReadonlyMap<string, readonly string[]>;
  /** `app` or `src/app` when that directory exists, else null. */
  readonly appDir: string | null;
}

export interface OverlayRule {
  readonly id: string;
  /** The `<lang>-stack` experts this overlay is materialised under (intersected with the repo's languages). */
  readonly languages: readonly PackLanguage[];
  /** The evidence string when the rule fires, null when it does not. */
  readonly applies: (manifests: Manifests) => string | null;
}

/** `react` → `dependencies.react` (or `devDependencies.react`) when declared, else null. */
function npmDep(pkg: PackageJson | null, name: string): string | null {
  if (pkg === null) return null;
  for (const group of ["dependencies", "devDependencies"] as const) {
    if (pkg.groups[group].includes(name)) return `${group}.${name}`;
  }
  return null;
}

/** The first .NET package whose lower-cased name starts with `prefix`, lower-cased. */
function netPackage(manifests: Manifests, prefix: string): NetPackage | null {
  const lower = prefix.toLowerCase();
  return manifests.netPackages.find((pkg) => pkg.name.toLowerCase().startsWith(lower)) ?? null;
}

function netEvidence(pkg: NetPackage): string {
  return `${pkg.file}: Include="${pkg.name}"`;
}

/**
 * `fastapi` → `pyproject.toml: dependencies fastapi` or `<requirements file>: fastapi`.
 *
 * Exact match on the normalised name, never a prefix: `fastapi-users` and
 * `sqlalchemy-utils` are real, unrelated PyPI packages, and a prefix match would fire
 * this rule's evidence for a name that isn't actually in the file.
 */
function pyDep(manifests: Manifests, name: string): string | null {
  const lower = name.toLowerCase();
  if (manifests.pyproject.includes(lower)) return `pyproject.toml: dependencies ${name}`;
  for (const [file, names] of manifests.requirements) {
    if (names.includes(lower)) return `${file}: ${name}`;
  }
  return null;
}

function webProjects(manifests: Manifests): readonly string[] {
  return [...manifests.csproj.entries()]
    .filter(([, xml]) => /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(xml))
    .map(([path]) => path);
}

interface Signal {
  readonly file: string;
  readonly name: string;
}

/**
 * The first of these signals present, searched .NET → npm → Python, for the cross-stack
 * rule. .NET stays prefix-matched (a provider package like `Npgsql.EntityFrameworkCore.
 * PostgreSQL` is meant to be found by its `Npgsql` namespace root); Python is exact —
 * see `pyDep` for why a prefix match on Python names is wrong.
 */
function firstSignal(
  manifests: Manifests,
  names: { readonly net: readonly string[]; readonly npm: readonly string[]; readonly py: readonly string[] },
): Signal | null {
  for (const prefix of names.net) {
    const pkg = netPackage(manifests, prefix);
    if (pkg !== null) return { file: pkg.file, name: pkg.name };
  }
  for (const name of names.npm) {
    if (npmDep(manifests.packageJson, name) !== null) return { file: "package.json", name };
  }
  for (const name of names.py) {
    const lower = name.toLowerCase();
    if (manifests.pyproject.includes(lower)) return { file: "pyproject.toml", name };
    for (const [file, list] of manifests.requirements) {
      if (list.includes(lower)) return { file, name };
    }
  }
  return null;
}

export const OVERLAY_RULES: readonly OverlayRule[] = [
  {
    id: "react", languages: JS,
    applies: (m) => { const hit = npmDep(m.packageJson, "react"); return hit === null ? null : `package.json: ${hit}`; },
  },
  {
    id: "next-app-router", languages: JS,
    applies: (m) => {
      const next = npmDep(m.packageJson, "next");
      if (next === null || m.appDir === null) return null;
      return `package.json: ${next}; ${m.appDir}/ present`;
    },
  },
  {
    id: "vite-react-spa", languages: JS,
    applies: (m) => {
      const vite = npmDep(m.packageJson, "vite");
      const react = npmDep(m.packageJson, "react");
      if (vite === null || react === null || npmDep(m.packageJson, "next") !== null) return null;
      return `package.json: ${vite} + ${react}`;
    },
  },
  {
    id: "expo-router", languages: JS,
    applies: (m) => {
      const hit = npmDep(m.packageJson, "expo-router") ?? npmDep(m.packageJson, "expo");
      return hit === null ? null : `package.json: ${hit}`;
    },
  },
  {
    id: "node-express", languages: JS,
    applies: (m) => { const hit = npmDep(m.packageJson, "express"); return hit === null ? null : `package.json: ${hit}`; },
  },
  {
    id: "prisma", languages: JS,
    applies: (m) => {
      const hit = npmDep(m.packageJson, "prisma") ?? npmDep(m.packageJson, "@prisma/client");
      return hit === null ? null : `package.json: ${hit}`;
    },
  },
  {
    id: "aspnet-minimal-apis", languages: NET,
    applies: (m) => {
      const hit = webProjects(m).find((path) => !m.controllers.has(path));
      return hit === undefined ? null : `${hit}: Sdk=Web; no Controllers/`;
    },
  },
  {
    id: "aspnet-controllers", languages: NET,
    applies: (m) => {
      const hit = webProjects(m).find((path) => m.controllers.has(path));
      return hit === undefined ? null : `${hit}: Sdk=Web; Controllers/ present`;
    },
  },
  {
    id: "mediatr-cqrs", languages: NET,
    applies: (m) => {
      const hit = m.netPackages.find((pkg) => pkg.name.toLowerCase() === "mediatr");
      return hit === undefined ? null : netEvidence(hit);
    },
  },
  {
    id: "efcore-npgsql", languages: NET,
    applies: (m) => {
      const ef = netPackage(m, "Microsoft.EntityFrameworkCore");
      const npgsql = netPackage(m, "Npgsql");
      return ef === null || npgsql === null ? null : netEvidence(npgsql);
    },
  },
  { id: "fastapi", languages: PY, applies: (m) => pyDep(m, "fastapi") },
  {
    id: "sqlalchemy-alembic", languages: PY,
    applies: (m) => {
      const hit = pyDep(m, "sqlalchemy");
      if (hit === null) return null;
      return `${hit}; alembic ${pyDep(m, "alembic") === null ? "absent" : "present"}`;
    },
  },
  {
    id: "postgres-testcontainers", languages: [...PACK_LANGUAGES],
    applies: (m) => {
      const driver = firstSignal(m, {
        net: ["Npgsql"], npm: ["pg", "@prisma/adapter-pg"], py: ["asyncpg", "psycopg", "psycopg2", "psycopg2-binary"],
      });
      const containers = firstSignal(m, {
        net: ["Testcontainers"], npm: ["testcontainers", "@testcontainers/postgresql"], py: ["testcontainers"],
      });
      if (driver === null || containers === null) return null;
      // Same manifest: name both packages, one file. Different manifests (the driver in
      // one ecosystem, testcontainers in another): name both files, or the evidence
      // would claim a package lives in a file that never mentions it.
      const containerSide = containers.file === driver.file ? containers.name : `${containers.file}: ${containers.name}`;
      return `${driver.file}: ${driver.name} + ${containerSide}`;
    },
  },
];

export function overlayRule(id: string): OverlayRule | undefined {
  return OVERLAY_RULES.find((rule) => rule.id === id);
}

export function applyOverlayRules(
  manifests: Manifests,
  rules: readonly OverlayRule[] = OVERLAY_RULES,
): readonly DetectedOverlay[] {
  const out: DetectedOverlay[] = [];
  for (const rule of rules) {
    const evidence = rule.applies(manifests);
    if (evidence !== null) out.push({ id: rule.id, evidence });
  }
  return out;
}

/**
 * Read what the table names, and nothing else. `packageJson` comes from `detectStack`
 * so package.json is parsed exactly once per repo.
 */
export async function readManifests(repoDir: string, packageJson: PackageJson | null): Promise<Manifests> {
  const files = await walkFiles(repoDir, { maxDepth: 4, maxFiles: 4000 });
  const csproj = new Map<string, string>();
  const netPackages: NetPackage[] = [];
  const controllers = new Set<string>();
  for (const file of files) {
    const isProps = basename(file.path) === "Directory.Packages.props";
    if (!file.path.endsWith(".csproj") && !isProps) continue;
    const text = await runtime.readText(join(repoDir, file.path));
    for (const name of includeNames(text)) netPackages.push({ name, file: file.path });
    if (isProps) continue;
    csproj.set(file.path, text);
    if (await isDirectory(join(repoDir, dirname(file.path), "Controllers"))) controllers.add(file.path);
  }

  const pyprojectPath = join(repoDir, "pyproject.toml");
  const pyproject = (await runtime.exists(pyprojectPath))
    ? pyprojectDependencies(await runtime.readText(pyprojectPath))
    : [];

  const requirements = new Map<string, readonly string[]>();
  for (const entry of await readEntries(repoDir)) {
    if (!entry.isFile() || !/^requirements[^/]*\.txt$/.test(entry.name)) continue;
    requirements.set(entry.name, requirementNames(await runtime.readText(join(repoDir, entry.name))));
  }

  let appDir: string | null = null;
  for (const candidate of ["app", "src/app"]) {
    if (await isDirectory(join(repoDir, candidate))) { appDir = candidate; break; }
  }
  return { packageJson, csproj, netPackages, controllers, pyproject, requirements, appDir };
}

export async function detectOverlays(repoDir: string, packageJson: PackageJson | null): Promise<readonly DetectedOverlay[]> {
  return applyOverlayRules(await readManifests(repoDir, packageJson));
}

/** Every `<PackageReference … Include="…">` / `<PackageVersion … Include="…">`, as written. */
export function includeNames(xml: string): readonly string[] {
  return [...xml.matchAll(/<Package(?:Reference|Version)\b[^>]*\bInclude="([^"]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "");
}

/** `psycopg[binary]>=3 ; python_version>="3.10"` → `psycopg`. Empty when the spec has no name. */
export function requirementName(spec: string): string {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return (match?.[1] ?? "").toLowerCase();
}

/**
 * Quoted string literals in a TOML/Python-style array, read from `text` starting right
 * after its opening `[` at `from`, up to the first `]` that is OUTSIDE any quotes.
 *
 * A lazy `\]` regex over the whole array breaks the moment an entry embeds one, e.g.
 * `"sqlalchemy[asyncio]"` — its own `]` would end the match early and swallow the rest
 * of the array. Scanning quote-to-quote sidesteps that: brackets inside a string are
 * just characters, and only an unquoted `]` ends the array.
 */
function scanStringArray(text: string, from: number): readonly string[] {
  const entries: string[] = [];
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "]") break;
    if (ch === "\"" || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end === -1) break;
      entries.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  return entries;
}

/** Lower-cased names of `[project] dependencies = [...]`; `[tool.*]` tables are not the project's declaration. */
export function pyprojectDependencies(toml: string): readonly string[] {
  const lines = toml.split("\n");
  const start = lines.findIndex((line) => /^\s*\[project\]\s*$/.test(line));
  if (start === -1) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    section.push(line);
  }
  const text = section.join("\n");
  const open = /dependencies\s*=\s*\[/.exec(text);
  if (open === null) return [];
  return scanStringArray(text, open.index + open[0].length)
    .map(requirementName)
    .filter((name) => name !== "");
}

/** One name per requirement line; comments, blank lines and `-r`/`-e` options are skipped. */
export function requirementNames(text: string): readonly string[] {
  return text.split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("-"))
    .map(requirementName)
    .filter((name) => name !== "");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
