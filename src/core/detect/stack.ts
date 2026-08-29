/**
 * Stack detection from build manifests, and nothing else.
 *
 * A manifest on disk is evidence; a folder name, a README badge or a familiar
 * layout is not. Every language reported here has a file behind it.
 */
import { join } from "node:path";
import { lineOf } from "./lineOf.ts";
import { walkFiles } from "./walk.ts";
import { runtime } from "../runtime/index.ts";
import type { Evidence } from "./types.ts";

/** Frameworks recognised from `package.json` dependencies, in report order. */
const JS_FRAMEWORKS: readonly string[] = ["react", "vite", "expo", "next"];
const FRAMEWORK_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  react: ["react"],
  vite: ["vite"],
  expo: ["expo"],
  next: ["next"],
};

export interface StackDetection {
  /** Languages plus frameworks, in the order `workspace.yml` records them. */
  readonly stack: readonly string[];
  readonly languages: readonly string[];
  readonly packageManager: string | null;
  /** Repo-relative manifest paths that produced the stack. */
  readonly manifests: readonly string[];
  readonly packageJson: PackageJson | null;
  readonly evidence: readonly Evidence[];
}

export interface PackageJson {
  readonly path: string;
  readonly text: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
}

export async function detectStack(repoDir: string): Promise<StackDetection> {
  const languages: string[] = [];
  const frameworks: string[] = [];
  const manifests: string[] = [];
  const evidence: Evidence[] = [];

  const pkg = await readPackageJson(repoDir);
  if (pkg !== null) {
    manifests.push(pkg.path);
    const typescript = pkg.dependencies.includes("typescript")
      || (await runtime.exists(join(repoDir, "tsconfig.json")));
    languages.push(typescript ? "typescript" : "javascript");
    evidence.push({
      claim: `${typescript ? "TypeScript" : "JavaScript"} project: package.json declares ${pkg.dependencies.length} dependencies`,
      src: `${pkg.path}:${lineOf(pkg.text, "\"name\"")}`,
    });
    for (const framework of JS_FRAMEWORKS) {
      const packages = FRAMEWORK_PACKAGES[framework] ?? [];
      const hit = packages.find((name) => pkg.dependencies.includes(name));
      if (hit === undefined) continue;
      frameworks.push(framework);
      evidence.push({ claim: `Uses ${framework}`, src: `${pkg.path}:${lineOf(pkg.text, `"${hit}"`)}` });
    }
  }

  const dotnetManifest = await findFirst(repoDir, [".sln", ".csproj"]);
  if (dotnetManifest !== null) {
    languages.push("dotnet");
    manifests.push(dotnetManifest);
    evidence.push({ claim: "A .NET project file defines the build", src: `${dotnetManifest}:1` });
  }

  for (const [file, language] of [
    ["pyproject.toml", "python"], ["requirements.txt", "python"],
    ["go.mod", "go"], ["Cargo.toml", "rust"],
  ] as const) {
    if (languages.includes(language)) continue;
    if (!(await runtime.exists(join(repoDir, file)))) continue;
    languages.push(language);
    manifests.push(file);
    evidence.push({ claim: `${language} project manifest present`, src: `${file}:1` });
  }

  const packageManager = await detectPackageManager(repoDir, languages, pkg !== null);
  return {
    stack: [...languages, ...frameworks],
    languages,
    packageManager,
    manifests,
    packageJson: pkg,
    evidence,
  };
}

async function readPackageJson(repoDir: string): Promise<PackageJson | null> {
  const path = join(repoDir, "package.json");
  if (!(await runtime.exists(path))) return null;
  const text = await runtime.readText(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return {
    path: "package.json",
    text,
    scripts: stringMap(record.scripts),
    dependencies: [...Object.keys(stringMap(record.dependencies)), ...Object.keys(stringMap(record.devDependencies))],
  };
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/** First file (shallow, sorted) whose name ends with one of `suffixes`. */
async function findFirst(repoDir: string, suffixes: readonly string[]): Promise<string | null> {
  const files = await walkFiles(repoDir, { maxDepth: 3, maxFiles: 4000 });
  for (const suffix of suffixes) {
    const hit = files.find((file) => file.path.endsWith(suffix));
    if (hit !== undefined) return hit.path;
  }
  return null;
}

async function detectPackageManager(
  repoDir: string,
  languages: readonly string[],
  hasPackageJson: boolean,
): Promise<string | null> {
  for (const [lockfile, manager] of [
    ["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"], ["package-lock.json", "npm"],
  ] as const) {
    if (await runtime.exists(join(repoDir, lockfile))) return manager;
  }
  if (hasPackageJson) return "npm";
  if (languages.includes("dotnet")) return "nuget";
  if (languages.includes("python")) return "pip";
  if (languages.includes("go")) return "go";
  if (languages.includes("rust")) return "cargo";
  return null;
}
