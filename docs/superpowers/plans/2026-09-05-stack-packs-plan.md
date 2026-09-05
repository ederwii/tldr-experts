# Stack Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `<lang>-stack` expert a real, opt-in body (a language pack), materialise framework overlays that manifest detection can prove, name the project's Claude skills to the developer, and hand the reviewer the packs' `## Checks` — all behind one per-project switch that is off by default.

**Architecture:** Detection grows two evidence-only lists per repo (`overlays`, `skills`) written into `workspace.yml` on every `tldrx init`; one additive `stack_packs` block carries the switch across re-inits. Pack bodies and overlay files ship as templates under `templates/experts/stack/` and are materialised into the existing `.tldrx/experts/<lang>-stack/` folder — the body replaces the seeded stub only when the stub is untouched, overlays are framework-managed files. Because every prompt renderer already prints an expert's `body`, `loadExpertBundles` composing `body + overlays/*.md` is the one change that reaches stage prompts and the Build developer; the reviewer and the `## Project skills` section are explicit additions.

**Tech Stack:** TypeScript on Bun (build/test) targeting Node ≥ 20 (runtime); `bun:test`; no new dependencies; `node:crypto` for the templates hash.

**Spec:** `docs/superpowers/specs/2026-09-05-stack-packs-design.md` — approved; this plan argues from it and does not re-open its decisions.

## Global Constraints

- `version: 1` file formats only grow: every new `workspace.yml` key is additive, old files load unchanged, `version` stays `1` (spec §3, §4.3; AGENTS.md §7).
- Off by default: with `stack_packs` absent or `enabled: false`, every prompt renders byte-identically to today except the `## Project skills` section, which is independent of the switch (spec §4.5).
- One implementation per derivation (AGENTS.md §7): overlay ids live only in `src/core/detect/overlays.ts`; the two pack headings live only in `src/core/experts/packSections.ts`; the stub body is derived by calling `renderExpert`, never re-typed; `truncateAtHeading`, `splitFrontMatter`, `section`, `stackExpertNames` are imported, never copied; package.json is read once, in `detectStack`.
- Size caps, enforced by a shape test: pack body ≤ 8 KiB (`8192` bytes), overlay ≤ 6 KiB (`6144` bytes), composed prompt body `PACK_MAX_BYTES = 24 * 1024` (spec §4.1, §4.5).
- Template file format (spec §4.1): `# <title>`, one paragraph of scope, `## Defaults (when the repo is silent)`, `## Checks (always asked in review)`; every Default bullet ends `— overridden by: <signal>`; every Check bullet carries a `verify:` hint; version-agnostic; no absolute paths; no workspace names (spec decision 7 — also: never name a private workspace anywhere in this change, tests and docs included).
- Overlays are detected from manifests only, never inferred from a language; unknown → no overlay (spec decision 3, §4.4).
- Exit codes: `expert packs status` exits 0 always; `enable` exits 1 (usage family, `EXIT_USAGE`/`EXIT_FAILED` are both `1` in `src/cli/exitCodes.ts`) when no repo has a detectable language (spec §4.6).
- No `Bun.*` under `src/` outside `src/core/runtime/` (AGENTS.md §3). Tests may use `Bun.spawn`.
- Red-first: every behaviour change starts with a failing test whose verbatim RED output you keep for the report. Run each gate command on its own and read its exit code on its own line (`cmd; echo "exit=$?"`), never through a pipe (AGENTS.md §1).
- Hermetic spawning tests: a test file that spawns (`git`, the CLI) imports `spawnTestTimeout` from `./fixtures/machineLoad.ts` and calls `setDefaultTimeout(spawnTestTimeout())`; spawned children get a private `TMPDIR` in their env. `test/machine-load.test.ts` auto-adds one guard row per test file whose SOURCE contains `node:child_process` or `Bun.spawn` — count those when you reconcile the test delta (AGENTS.md §8).
- Docs EN and ES in lockstep; the current version is never typed into prose; banned positioning words per `test/public-surface-consistency.test.ts` (`lightweight`, bare `tool-agnostic`, absolute sync claims).
- Commit after every task. Every commit message ends with these two trailer lines:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
  ```
- Work only in this worktree on branch `feat/stack-packs`. No release steps here — release is `scripts/release.sh`, a separate ritual (AGENTS.md §6).

## File map

Create:
- `src/core/detect/overlays.ts` — the 13-row detection table, manifest readers, `detectOverlays`.
- `src/core/detect/skills.ts` — `.claude/skills/*/SKILL.md` detection with `tracked`.
- `src/core/experts/stackPacks.ts` — leaf reader of `workspace.yml`'s `stack_packs` / `overlays` / `skills`, `renderProjectSkills`.
- `src/core/experts/packSections.ts` — heading constants, `composePackBody`, `checksOf`, `readOverlayFiles`, `stackChecks`.
- `src/core/experts/packTemplates.ts` — template paths, readers, `templatesHash`.
- `src/core/init/stackPacks.ts` — enable / disable / status / apply (bodies + overlays) orchestration.
- `templates/experts/stack/{typescript,javascript,python,dotnet}.md` and `templates/experts/stack/overlays/<13 ids>.md`.
- Tests: `test/detect-overlays.test.ts`, `test/detect-skills.test.ts`, `test/pack-sections.test.ts`, `test/pack-templates.test.ts`, `test/stack-packs.test.ts`, `test/stack-packs-prompt.test.ts`, `test/stack-packs-cli.test.ts`.

Modify:
- `src/core/detect/stack.ts` (package.json dependency groups), `types.ts`, `detectWorkspace.ts`, `index.ts`.
- `src/core/init/workspaceDocument.ts`, `runInit.ts`, `src/core/schemas/workspace.ts`.
- `src/core/experts/expertBundle.ts`, `index.ts`.
- `src/core/facilitator/prompt.ts`, `contextLedger.ts`, `runNext.ts`, `index.ts`, `executors/build.ts`.
- `src/core/build/prompts.ts`.
- `src/cli/commands/expert.ts`, `src/cli/helpText.ts`.
- `test/process-answers.test.ts`, `test/detect.test.ts`, `test/init.test.ts`, `test/schemas.test.ts`, `test/build-executor.test.ts`, `test/cli.test.ts`, `test/fixtures/build/workspace.ts`.
- Docs: `CHANGELOG.md`, `README.md`, `docs/spec.md`, `docs/ROADMAP.md`, `docs/guide/04-experts.md`, `docs/guide/08-cli-reference.md`, `docs-site/{guides/experts,reference/cli,concepts/files-as-state,quickstart}.md` and their `docs-site/es/` twins.

---

### Task 1: Overlay detection table and manifest readers

**Files:**
- Modify: `src/core/detect/stack.ts:33-38,106-111` (`PackageJson` gains `groups`)
- Create: `src/core/detect/overlays.ts`
- Modify: `src/core/detect/index.ts`
- Test: `test/detect-overlays.test.ts`, `test/detect.test.ts:73-79`

**Interfaces:**
- Consumes: `PackageJson`, `walkFiles`, `readEntries` from `src/core/detect/`; `runtime` from `src/core/runtime/index.ts`.
- Produces: `PACK_LANGUAGES`, `PackLanguage`, `DetectedOverlay {id, evidence}`, `OverlayRule {id, languages, applies}`, `OVERLAY_RULES`, `overlayRule(id)`, `Manifests`, `readManifests(repoDir, packageJson)`, `applyOverlayRules(manifests, rules?)`, `detectOverlays(repoDir, packageJson)`, `includeNames`, `pyprojectDependencies`, `requirementNames`, `requirementName`.

- [ ] **Step 1: Write the failing tests**

Create `test/detect-overlays.test.ts`:

```ts
/**
 * Overlays are facts about manifests (stack packs design §4.4). Every rule fires on a
 * synthetic manifest that names the signal and stays silent on its negative; the evidence
 * string is the table's, verbatim, because that string is written into workspace.yml.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOverlayRules, detectOverlays, includeNames, OVERLAY_RULES, PACK_LANGUAGES,
  pyprojectDependencies, readManifests, requirementNames,
} from "../src/core/detect/overlays.ts";
import { detectStack } from "../src/core/detect/stack.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A throwaway repo dir holding exactly `files` (path → text). Dirs ending in `/` are created empty. */
function repo(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-overlays-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    if (rel.endsWith("/")) { mkdirSync(join(dir, rel), { recursive: true }); continue; }
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  return dir;
}

function pkg(deps: Record<string, string>, dev: Record<string, string> = {}): string {
  return JSON.stringify({ name: "x", dependencies: deps, devDependencies: dev }) + "\n";
}

async function overlays(dir: string): Promise<Record<string, string>> {
  const stack = await detectStack(dir);
  const out: Record<string, string> = {};
  for (const item of await detectOverlays(dir, stack.packageJson)) out[item.id] = item.evidence;
  return out;
}

const WEB_CSPROJ = "<Project Sdk=\"Microsoft.NET.Sdk.Web\">\n  <ItemGroup>\n    <PackageReference Include=\"Swashbuckle.AspNetCore\" />\n  </ItemGroup>\n</Project>\n";

describe("the table is what ships", () => {
  test("thirteen rules, unique ids, every id assigned to at least one pack language", () => {
    expect(OVERLAY_RULES).toHaveLength(13);
    expect(new Set(OVERLAY_RULES.map((rule) => rule.id)).size).toBe(13);
    for (const rule of OVERLAY_RULES) {
      expect(rule.languages.length, rule.id).toBeGreaterThan(0);
      for (const lang of rule.languages) expect(PACK_LANGUAGES).toContain(lang);
    }
  });

  test("a repo with no manifest at all yields no overlay — never a guess", async () => {
    expect(await overlays(repo({ "README.md": "# hi\n" }))).toEqual({});
  });
});

describe("JavaScript / TypeScript rules", () => {
  test("react fires on a dependency and says which group it came from", async () => {
    expect(await overlays(repo({ "package.json": pkg({ react: "*" }) })))
      .toEqual({ react: "package.json: dependencies.react" });
  });

  test("vite + react without next is a SPA; with next it is not", async () => {
    const spa = await overlays(repo({ "package.json": pkg({ react: "*" }, { vite: "*" }) }));
    expect(spa["vite-react-spa"]).toBe("package.json: devDependencies.vite + dependencies.react");
    const withNext = await overlays(repo({ "package.json": pkg({ react: "*", next: "*" }, { vite: "*" }), "app/": "" }));
    expect(withNext["vite-react-spa"]).toBeUndefined();
    expect(withNext["next-app-router"]).toBe("package.json: dependencies.next; app/ present");
  });

  test("next without an app/ directory is not the app router", async () => {
    expect((await overlays(repo({ "package.json": pkg({ next: "*" }) })))["next-app-router"]).toBeUndefined();
    expect((await overlays(repo({ "package.json": pkg({ next: "*" }), "src/app/": "" })))["next-app-router"])
      .toBe("package.json: dependencies.next; src/app/ present");
  });

  test("expo-router, express and prisma each fire on their own package", async () => {
    const found = await overlays(repo({ "package.json": pkg({ "expo-router": "*", express: "*" }, { prisma: "*" }) }));
    expect(found["expo-router"]).toBe("package.json: dependencies.expo-router");
    expect(found["node-express"]).toBe("package.json: dependencies.express");
    expect(found.prisma).toBe("package.json: devDependencies.prisma");
    expect((await overlays(repo({ "package.json": pkg({ "@prisma/client": "*" }) }))).prisma)
      .toBe("package.json: dependencies.@prisma/client");
    expect((await overlays(repo({ "package.json": pkg({ expo: "*" }) })))["expo-router"])
      .toBe("package.json: dependencies.expo");
  });
});

describe(".NET rules", () => {
  test("a Web SDK project with no Controllers/ is minimal APIs; with one it is controllers", async () => {
    const minimal = await overlays(repo({ "src/Api/Api.csproj": WEB_CSPROJ }));
    expect(minimal).toEqual({ "aspnet-minimal-apis": "src/Api/Api.csproj: Sdk=Web; no Controllers/" });
    const controllers = await overlays(repo({ "src/Api/Api.csproj": WEB_CSPROJ, "src/Api/Controllers/": "" }));
    expect(controllers).toEqual({ "aspnet-controllers": "src/Api/Api.csproj: Sdk=Web; Controllers/ present" });
  });

  test("a library project is neither", async () => {
    expect(await overlays(repo({ "src/Lib/Lib.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />\n" }))).toEqual({});
  });

  test("MediatR is found in a csproj PackageReference, case-insensitively, evidence as written", async () => {
    const found = await overlays(repo({
      "src/App/App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><PackageReference Include=\"mediatr\" Version=\"1\" /></ItemGroup></Project>\n",
    }));
    expect(found["mediatr-cqrs"]).toBe("src/App/App.csproj: Include=\"mediatr\"");
  });

  test("Directory.Packages.props is honoured when the csproj carries no version", async () => {
    const found = await overlays(repo({
      "Directory.Packages.props": "<Project><ItemGroup><PackageVersion Include=\"MediatR\" Version=\"12.0.0\" /></ItemGroup></Project>\n",
      "src/App/App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><PackageReference Include=\"MediatR\" /></ItemGroup></Project>\n",
    }));
    expect(found["mediatr-cqrs"]).toBe("Directory.Packages.props: Include=\"MediatR\"");
  });

  test("EF Core needs BOTH an EntityFrameworkCore package and an Npgsql one", async () => {
    const both = await overlays(repo({
      "src/App/App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>"
        + "<PackageReference Include=\"Microsoft.EntityFrameworkCore\" Version=\"1\" />"
        + "<PackageReference Include=\"Npgsql.EntityFrameworkCore.PostgreSQL\" Version=\"1\" />"
        + "</ItemGroup></Project>\n",
    }));
    expect(both["efcore-npgsql"]).toBe("src/App/App.csproj: Include=\"Npgsql.EntityFrameworkCore.PostgreSQL\"");
    const efOnly = await overlays(repo({
      "src/App/App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><PackageReference Include=\"Microsoft.EntityFrameworkCore\" Version=\"1\" /></ItemGroup></Project>\n",
    }));
    expect(efOnly["efcore-npgsql"]).toBeUndefined();
  });
});

describe("Python rules", () => {
  test("fastapi and sqlalchemy are read from [project] dependencies; alembic is noted either way", async () => {
    const found = await overlays(repo({
      "pyproject.toml": "[project]\nname = \"svc\"\ndependencies = [\n  \"FastAPI>=0.1\",\n  \"sqlalchemy[asyncio]\",\n]\n\n[tool.ruff]\nline-length = 100\n",
    }));
    expect(found.fastapi).toBe("pyproject.toml: dependencies fastapi");
    expect(found["sqlalchemy-alembic"]).toBe("pyproject.toml: dependencies sqlalchemy; alembic absent");
    const withAlembic = await overlays(repo({
      "pyproject.toml": "[project]\ndependencies = [\"sqlalchemy\", \"alembic\"]\n",
    }));
    expect(withAlembic["sqlalchemy-alembic"]).toBe("pyproject.toml: dependencies sqlalchemy; alembic present");
  });

  test("requirements*.txt is honoured too, comments and pins stripped", async () => {
    const found = await overlays(repo({
      "requirements.txt": "# web\nfastapi==0.100.0  # pinned\n-r requirements-dev.txt\n",
      "requirements-dev.txt": "pytest\n",
    }));
    expect(found.fastapi).toBe("requirements.txt: fastapi");
  });

  test("a dependency named in [tool.*] but not in [project] does not count", async () => {
    const found = await overlays(repo({ "pyproject.toml": "[tool.poetry.dependencies]\nfastapi = \"*\"\n" }));
    expect(found.fastapi).toBeUndefined();
  });
});

describe("postgres-testcontainers spans the three ecosystems", () => {
  test(".NET: an Npgsql driver plus a Testcontainers package", async () => {
    const found = await overlays(repo({
      "src/T/T.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>"
        + "<PackageReference Include=\"Npgsql\" Version=\"1\" />"
        + "<PackageReference Include=\"Testcontainers.PostgreSql\" Version=\"1\" />"
        + "</ItemGroup></Project>\n",
    }));
    expect(found["postgres-testcontainers"]).toBe("src/T/T.csproj: Npgsql + Testcontainers.PostgreSql");
  });

  test("npm: pg plus @testcontainers/postgresql", async () => {
    const found = await overlays(repo({ "package.json": pkg({ pg: "*" }, { "@testcontainers/postgresql": "*" }) }));
    expect(found["postgres-testcontainers"]).toBe("package.json: pg + @testcontainers/postgresql");
  });

  test("python: psycopg (any flavour) plus testcontainers", async () => {
    const found = await overlays(repo({ "pyproject.toml": "[project]\ndependencies = [\"psycopg[binary]\", \"testcontainers\"]\n" }));
    expect(found["postgres-testcontainers"]).toBe("pyproject.toml: psycopg + testcontainers");
  });

  test("a driver alone is not a testcontainers setup", async () => {
    expect((await overlays(repo({ "package.json": pkg({ pg: "*" }) })))["postgres-testcontainers"]).toBeUndefined();
  });
});

describe("the readers", () => {
  test("includeNames reads PackageReference and PackageVersion, as written", () => {
    expect(includeNames("<PackageReference Include=\"A.B\" Version=\"1\" /><PackageVersion Include=\"c\" />"))
      .toEqual(["A.B", "c"]);
    expect(includeNames("<ProjectReference Include=\"../X/X.csproj\" />")).toEqual([]);
  });

  test("pyprojectDependencies lower-cases and strips extras, versions and markers", () => {
    expect(pyprojectDependencies("[project]\ndependencies = [\n \"Psycopg[binary]>=3 ; python_version>='3.10'\",\n 'Alembic',\n]\n"))
      .toEqual(["psycopg", "alembic"]);
    expect(pyprojectDependencies("[project]\nname='x'\n")).toEqual([]);
  });

  test("requirementNames skips blank lines, comments and -r includes", () => {
    expect(requirementNames("# c\n\nFastAPI==1\n-r other.txt\nuvicorn[standard]\n")).toEqual(["fastapi", "uvicorn"]);
  });

  test("applyOverlayRules runs the given rules in table order", async () => {
    const dir = repo({ "package.json": pkg({ react: "*", express: "*" }) });
    const manifests = await readManifests(dir, (await detectStack(dir)).packageJson);
    expect(applyOverlayRules(manifests).map((item) => item.id)).toEqual(["react", "node-express"]);
  });
});

describe("package.json keeps its two dependency groups apart", () => {
  test("detectStack reports which group a name came from", async () => {
    const stack = await detectStack(repo({ "package.json": pkg({ react: "*" }, { vite: "*" }) }));
    expect(stack.packageJson?.groups.dependencies).toEqual(["react"]);
    expect(stack.packageJson?.groups.devDependencies).toEqual(["vite"]);
    // The merged list every existing reader keys on is unchanged.
    expect(stack.packageJson?.dependencies).toEqual(["react", "vite"]);
  });
});
```

Also add one assertion to `test/detect.test.ts` inside the test `"package.json gives language, frameworks and package manager"` (after line 78):

```ts
    expect(stack.packageJson?.groups.devDependencies).toContain("vite");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/detect-overlays.test.ts; echo "exit=$?"`
Expected: FAIL — `Cannot find module '../src/core/detect/overlays.ts'`; `exit=1`. Keep the output.

- [ ] **Step 3: Extend `PackageJson` with the two groups**

In `src/core/detect/stack.ts` replace the `PackageJson` interface and the return of `readPackageJson`:

```ts
export interface PackageJson {
  readonly path: string;
  readonly text: string;
  readonly scripts: Readonly<Record<string, string>>;
  /** `dependencies` ∪ `devDependencies` — the list every existing reader keys on. */
  readonly dependencies: readonly string[];
  /**
   * The two groups apart, for a reader that must SAY which one a name came from:
   * an overlay's evidence string (`package.json: devDependencies.vite`) is written
   * into `workspace.yml`, and a merged list cannot produce it.
   */
  readonly groups: Readonly<Record<"dependencies" | "devDependencies", readonly string[]>>;
}
```

```ts
  const record = parsed as Record<string, unknown>;
  const dependencies = Object.keys(stringMap(record.dependencies));
  const devDependencies = Object.keys(stringMap(record.devDependencies));
  return {
    path: "package.json",
    text,
    scripts: stringMap(record.scripts),
    dependencies: [...dependencies, ...devDependencies],
    groups: { dependencies, devDependencies },
  };
```

- [ ] **Step 4: Create `src/core/detect/overlays.ts`**

```ts
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

/** `fastapi` → `pyproject.toml: dependencies fastapi` or `<requirements file>: fastapi`. */
function pyDep(manifests: Manifests, prefix: string): string | null {
  const lower = prefix.toLowerCase();
  if (manifests.pyproject.some((name) => name.startsWith(lower))) return `pyproject.toml: dependencies ${prefix}`;
  for (const [file, names] of manifests.requirements) {
    if (names.some((name) => name.startsWith(lower))) return `${file}: ${prefix}`;
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

/** The first of these signals present, searched .NET → npm → Python, for the cross-stack rule. */
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
  for (const prefix of names.py) {
    const lower = prefix.toLowerCase();
    if (manifests.pyproject.some((name) => name.startsWith(lower))) return { file: "pyproject.toml", name: prefix };
    for (const [file, list] of manifests.requirements) {
      if (list.some((name) => name.startsWith(lower))) return { file, name: prefix };
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
      const driver = firstSignal(m, { net: ["Npgsql"], npm: ["pg", "@prisma/adapter-pg"], py: ["asyncpg", "psycopg"] });
      const containers = firstSignal(m, {
        net: ["Testcontainers"], npm: ["testcontainers", "@testcontainers/postgresql"], py: ["testcontainers"],
      });
      if (driver === null || containers === null) return null;
      return `${driver.file}: ${driver.name} + ${containers.name}`;
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
  const list = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(section.join("\n"));
  if (list === null) return [];
  return [...(list[1] ?? "").matchAll(/["']([^"']+)["']/g)]
    .map((match) => requirementName(match[1] ?? ""))
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
```

Append to `src/core/detect/index.ts`:

```ts
export {
  detectOverlays, readManifests, applyOverlayRules, overlayRule, includeNames, pyprojectDependencies,
  requirementName, requirementNames, isPackLanguage, OVERLAY_RULES, PACK_LANGUAGES,
  type DetectedOverlay, type Manifests, type NetPackage, type OverlayRule, type PackLanguage,
} from "./overlays.ts";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/detect-overlays.test.ts test/detect.test.ts; echo "exit=$?"`
Expected: all PASS; `exit=0`.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck; echo "exit=$?"` — Expected `exit=0`.

```bash
git add src/core/detect/overlays.ts src/core/detect/stack.ts src/core/detect/index.ts test/detect-overlays.test.ts test/detect.test.ts
git commit -m "feat(detect): overlay detection table — thirteen manifest-proven framework signals with evidence strings

Overlays are facts about manifests, never inferences from a language (stack packs design §4.4). package.json keeps its two dependency groups apart so an evidence string can say which one a name came from.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 2: Project skills detection

**Files:**
- Create: `src/core/detect/skills.ts`
- Modify: `src/core/detect/index.ts`
- Test: `test/detect-skills.test.ts`

**Interfaces:**
- Consumes: `readEntries` (`walk.ts`), `runtime`, `splitFrontMatter` (`src/core/experts/expertDocument.ts`), `CommandRunner`.
- Produces: `SKILLS_DIR = ".claude/skills"`, `SKILL_FILE = "SKILL.md"`, `DetectedSkill {name, description, path, tracked}`, `detectSkills(repoDir, runner)`.

- [ ] **Step 1: Write the failing test**

Create `test/detect-skills.test.ts`:

```ts
/**
 * Project skills are NAMED, never loaded (stack packs design decision 6): the harness
 * invokes a skill, the framework only tells the developer it exists. `tracked` is the
 * load-bearing bit — Build runs in a worktree of tracked files, so an untracked skill is
 * absent exactly where the story is written.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpawnCommandRunner } from "../src/core/detect/CommandRunner.ts";
import { detectSkills, SKILLS_DIR } from "../src/core/detect/skills.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test here runs a REAL `git`. Process cost is a property of the machine, so the
// fixed 5000 ms default would measure the box (#43); the budget scales with measured load.
setDefaultTimeout(spawnTestTimeout());

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A real repo with a private $TMPDIR for every git it spawns (#95/#97). */
function repo(): { root: string; git: (...args: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), "tldrx-skills-"));
  const scratch = mkdtempSync(join(tmpdir(), "tldrx-skills-tmp-"));
  dirs.push(root, scratch);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "pipe", env: { ...process.env, TMPDIR: scratch } });
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  return { root, git };
}

function skill(root: string, dir: string, frontMatter: string): void {
  mkdirSync(join(root, SKILLS_DIR, dir), { recursive: true });
  writeFileSync(join(root, SKILLS_DIR, dir, "SKILL.md"), `---\n${frontMatter}\n---\n\n# body\n`, "utf8");
}

const runner = new SpawnCommandRunner();

describe("detectSkills", () => {
  test("no .claude/skills directory is an empty list, not an error", async () => {
    const { root } = repo();
    expect(await detectSkills(root, runner)).toEqual([]);
  });

  test("name and description come from the front matter; tracked follows git", async () => {
    const { root, git } = repo();
    skill(root, "impeccable", "name: impeccable\ndescription: Use when the user wants to design a page");
    skill(root, "scratch", "name: scratch\ndescription: Not committed yet");
    git("add", `${SKILLS_DIR}/impeccable`);
    git("commit", "-q", "-m", "skill", "--no-gpg-sign");

    const found = await detectSkills(root, runner);
    expect(found).toEqual([
      { name: "impeccable", description: "Use when the user wants to design a page", path: ".claude/skills/impeccable/SKILL.md", tracked: true },
      { name: "scratch", description: "Not committed yet", path: ".claude/skills/scratch/SKILL.md", tracked: false },
    ]);
  });

  test("a directory without SKILL.md is not a skill; a missing name falls back to the directory", async () => {
    const { root } = repo();
    mkdirSync(join(root, SKILLS_DIR, "empty"), { recursive: true });
    skill(root, "nameless", "description: only a description");
    const found = await detectSkills(root, runner);
    expect(found.map((item) => item.name)).toEqual(["nameless"]);
    expect(found[0]?.description).toBe("only a description");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/detect-skills.test.ts; echo "exit=$?"`
Expected: FAIL — `Cannot find module '../src/core/detect/skills.ts'`; `exit=1`. Keep the output.

- [ ] **Step 3: Create `src/core/detect/skills.ts`**

```ts
/**
 * Project skills — `.claude/skills/<name>/SKILL.md` — detected and NAMED, never loaded.
 *
 * Skills are for doing and packs are for checking (stack packs design decision 6): the
 * harness loads and invokes a skill; the framework only tells the developer they exist,
 * with the `description` each skill declares for itself. `tracked` matters because Build
 * runs in a worktree that carries tracked files only — an untracked skill does not exist
 * where the story is written, and the prompt says so.
 *
 * The front matter is read with the one parser `expert.md` already has
 * (`experts/expertDocument.ts`); a second YAML-ish reader for the same `---` block is the
 * kind of copy #80 was filed over. Known limit, inherited from that parser: a `#` inside a
 * description ends it (`C# projects` reads as `C`). Evidence-only field; not fixed here.
 */
import { join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { splitFrontMatter } from "../experts/expertDocument.ts";
import { readEntries } from "./walk.ts";
import type { CommandRunner } from "./CommandRunner.ts";

export const SKILLS_DIR = ".claude/skills";
export const SKILL_FILE = "SKILL.md";

export interface DetectedSkill {
  readonly name: string;
  readonly description: string;
  /** Repo-relative, POSIX: `.claude/skills/<dir>/SKILL.md`. */
  readonly path: string;
  /** `git ls-files --error-unmatch` exit 0. False ⇒ absent from story worktrees. */
  readonly tracked: boolean;
}

export async function detectSkills(repoDir: string, runner: CommandRunner): Promise<readonly DetectedSkill[]> {
  const skills: DetectedSkill[] = [];
  for (const entry of await readEntries(join(repoDir, SKILLS_DIR))) {
    if (!entry.isDirectory()) continue;
    const rel = `${SKILLS_DIR}/${entry.name}/${SKILL_FILE}`;
    const abs = join(repoDir, rel);
    if (!(await runtime.exists(abs))) continue;
    const { frontMatter } = splitFrontMatter(await runtime.readText(abs));
    const tracked = (await runner.run(["git", "ls-files", "--error-unmatch", "--", rel], repoDir)).exitCode === 0;
    skills.push({
      name: frontMatter.get("name") ?? entry.name,
      description: frontMatter.get("description") ?? "",
      path: rel,
      tracked,
    });
  }
  return skills;
}
```

Append to `src/core/detect/index.ts`:

```ts
export { detectSkills, SKILLS_DIR, SKILL_FILE, type DetectedSkill } from "./skills.ts";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/detect-skills.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`.

Run: `bun test test/machine-load.test.ts; echo "exit=$?"` — Expected PASS; the guard's `test.each` now lists `detect-skills.test.ts` (its source contains `node:child_process`). Note this **+1 guard row** for the test-delta reconciliation.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck; echo "exit=$?"` — Expected `exit=0`.

```bash
git add src/core/detect/skills.ts src/core/detect/index.ts test/detect-skills.test.ts
git commit -m "feat(detect): name the project's Claude skills, with whether git tracks them

Skills are for doing, packs are for checking (stack packs design decision 6). tracked matters because a Build worktree carries tracked files only.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 3: `workspace.yml` grows `overlays`, `skills` and a carried-forward `stack_packs`

**Files:**
- Modify: `src/core/detect/types.ts:33-52`, `src/core/detect/detectWorkspace.ts:62-100`
- Modify: `src/core/init/workspaceDocument.ts`, `src/core/init/runInit.ts:213-232`, `src/core/init/index.ts`
- Modify: `src/core/schemas/workspace.ts`
- Create: `src/core/experts/stackPacks.ts` (reader only, this task)
- Modify: `src/core/experts/index.ts`, `test/process-answers.test.ts` (the one `DetectedRepo` literal)
- Test: `test/init.test.ts`, `test/schemas.test.ts`

**Interfaces:**
- Consumes: `DetectedOverlay`, `DetectedSkill`, `detectOverlays`, `detectSkills`.
- Produces: `DetectedRepo.overlays`, `DetectedRepo.skills`; `WorkspaceRepoDocument.overlays/skills`; `StackPacksDocument {enabled, enabled_at}`; `WorkspaceDocument.stack_packs?`; `BuildWorkspaceInput.stackPacks?`; `WORKSPACE_FILE_HEADER`, `renderWorkspaceFile(document)`; `readStackPacks(root): StackPacksState {present, enabled, enabledAt, repos: RepoPacks[]}` with `RepoPacks {name, stack, overlays, skills}`.

- [ ] **Step 1: Write the failing tests**

In `test/init.test.ts`, inside `describe("tldrx init — multi-repo workspace", …)` after the test `"workspace.yml carries the spec §2.1 fields for every repo"`, add:

```ts
  test("every repo carries its detected overlays with evidence, and its skills (stack packs design §4.3)", async () => {
    const document = await readYaml(join(fixture.root, ".tldrx/workspace.yml"));
    const repos = document.repos as Record<string, unknown>[];
    const lab = repos.find((repo) => repo.name === "lab");
    expect(lab?.overlays).toEqual([
      { id: "react", evidence: "package.json: dependencies.react" },
      { id: "vite-react-spa", evidence: "package.json: devDependencies.vite + dependencies.react" },
    ]);
    expect(lab?.skills).toEqual([]);
    const api = repos.find((repo) => repo.name === "api-service");
    expect(api?.overlays).toEqual([{ id: "aspnet-minimal-apis", evidence: "src/Api/Api.csproj: Sdk=Web; no Controllers/" }]);
    // Off by default: a first init writes no switch at all.
    expect(document.stack_packs).toBeUndefined();
  });

  test("stack_packs is carried forward across a re-init, byte for byte", async () => {
    const path = join(fixture.root, ".tldrx/workspace.yml");
    const before = await readYaml(path);
    writeFileSync(path, readFileSync(path, "utf8")
      + "stack_packs:\n  enabled: true\n  enabled_at: 2026-09-05T10:00:00Z\n", "utf8");
    await init(fixture.root);
    const after = await readYaml(path);
    expect(after.stack_packs).toEqual({ enabled: true, enabled_at: "2026-09-05T10:00:00Z" });
    expect(after.repos).toEqual(before.repos);
  });
```

In `test/schemas.test.ts`, add a new top-level `describe` at the end of the file:

```ts
describe("workspace.yml: stack_packs is additive and validated when present (stack packs design §4.3)", () => {
  const base = { version: 1, mode: "single", root: ".", repos: [] };

  test("a workspace written before the key existed loads with no issue", () => {
    expect(validate("workspace", base).ok).toBe(true);
  });

  test("a well-formed block is accepted", () => {
    expect(validate("workspace", { ...base, stack_packs: { enabled: true, enabled_at: "2026-09-05T10:00:00Z" } }).ok).toBe(true);
    expect(validate("workspace", { ...base, stack_packs: { enabled: false, enabled_at: null } }).ok).toBe(true);
  });

  test("enabled must be a boolean, and the block must be a mapping", () => {
    expect(issueText("workspace", { ...base, stack_packs: { enabled: "yes" } })).toContain("stack_packs.enabled: expected a boolean");
    expect(issueText("workspace", { ...base, stack_packs: "on" })).toContain("stack_packs: expected a mapping");
  });
});
```

(`issueText` and `validate` already exist in that file — check the import list at the top and reuse the same helper name; if `issueText` is defined below its first use, keep the new block at the file's end.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/init.test.ts test/schemas.test.ts; echo "exit=$?"`
Expected: FAIL — `lab?.overlays` is `undefined`; `stack_packs` dropped on re-init; `stack_packs.enabled: expected a boolean` not found; `exit=1`. Keep the output.

- [ ] **Step 3: Grow `DetectedRepo` and detection**

`src/core/detect/types.ts` — add imports at the top and two fields to `DetectedRepo` after `ci`:

```ts
import type { DetectedOverlay } from "./overlays.ts";
import type { DetectedSkill } from "./skills.ts";
```

```ts
  readonly ci: readonly string[];
  /** Framework overlays detection can PROVE from manifests, with their evidence (`detect/overlays.ts`). */
  readonly overlays: readonly DetectedOverlay[];
  /** `.claude/skills/*/SKILL.md` in this repo, named and flagged tracked/untracked (`detect/skills.ts`). */
  readonly skills: readonly DetectedSkill[];
  readonly confidence: Confidence;
```

`src/core/detect/detectWorkspace.ts` — import and compute:

```ts
import { detectOverlays } from "./overlays.ts";
import { detectSkills } from "./skills.ts";
```

after `const codeFiles = await countCodeFiles(absPath);`:

```ts
    const overlays = await detectOverlays(absPath, stack.packageJson);
    const skills = await detectSkills(absPath, runner);
```

and in the `detected` literal after `ci,`:

```ts
      overlays,
      skills,
```

`test/process-answers.test.ts` — find the one `DetectedRepo` literal (it has `codeFiles:`) and add `overlays: [], skills: [],` beside `ci`.

- [ ] **Step 4: Grow the workspace document and its writer**

`src/core/init/workspaceDocument.ts`:

```ts
import type { DetectedOverlay } from "../detect/overlays.ts";
import type { DetectedSkill } from "../detect/skills.ts";
import { stringifyYaml } from "../yaml.ts";
```

Add to `WorkspaceRepoDocument` after `ci`:

```ts
  readonly overlays: readonly DetectedOverlay[];
  readonly skills: readonly DetectedSkill[];
```

Add the block type and the optional field (after `mcp_servers` in `WorkspaceDocument`, so the bytes every existing reader knows come first):

```ts
/** The one stack-packs switch (stack packs design §4.3). Absent means off. */
export interface StackPacksDocument {
  readonly enabled: boolean;
  readonly enabled_at: string | null;
}
```

```ts
  readonly mcp_servers: readonly McpServerDocument[];
  readonly stack_packs?: StackPacksDocument;
```

Add to `BuildWorkspaceInput`:

```ts
  /** Carried forward from the file being regenerated; null when it never had one. */
  readonly stackPacks?: StackPacksDocument | null;
```

In `buildWorkspaceDocument`, after the `mcp_servers` entry:

```ts
    ...(input.stackPacks === undefined || input.stackPacks === null ? {} : { stack_packs: input.stackPacks }),
```

In `toRepoDocument`, after `ci: repo.ci,`:

```ts
    overlays: repo.overlays.map((item) => ({ id: item.id, evidence: item.evidence })),
    skills: repo.skills.map((item) => ({
      name: item.name, description: item.description, path: item.path, tracked: item.tracked,
    })),
```

Add at the end of the file (moved out of `runInit.ts` so `expert packs` writes the same header):

```ts
/** The comment `tldrx init` puts above the YAML — spelled once, for every writer of this file. */
export const WORKSPACE_FILE_HEADER =
  "# Written by `tldrx init` (spec §2.1). Detection result: which repos exist, their\n"
  + "# stack, and the ONLY commands the DoD gate and the map may run. Regenerated on\n"
  + "# every `tldrx init`; hand edits to detected values are overwritten.\n";

export function renderWorkspaceFile(document: unknown): string {
  return WORKSPACE_FILE_HEADER + stringifyYaml(document);
}
```

`src/core/init/runInit.ts` — in `writeWorkspaceFile`, add the carried block and use the shared renderer:

```ts
import { readStackPacks } from "../experts/stackPacks.ts";
import { buildWorkspaceDocument, renderWorkspaceFile } from "./workspaceDocument.ts";
```

```ts
async function writeWorkspaceFile(input: WorkspaceWriteInput): Promise<void> {
  // The switch outlives detection: `workspace.yml` is regenerated on every init, and a
  // team that turned the packs on must not find them off after re-running it.
  const carried = readStackPacks(input.out);
  const document = buildWorkspaceDocument({
    workspace: input.workspace,
    root: input.root === input.out ? "." : toPosix(relative(input.out, input.root)) || input.root,
    detectedAt: input.timestamp,
    cliVersion: input.deps.cliVersion,
    provider: input.map.providers.join(", ") || "none",
    mcpServers: input.mcpServers,
    stackPacks: carried.present ? { enabled: carried.enabled, enabled_at: carried.enabledAt } : null,
  });
  const validation = validateWorkspaceDocument(document);
  if (!validation.ok) throw new Error(formatIssues(WORKSPACE_FILE, validation));

  await input.log.overwrite(join(input.out, WORKSPACE_FILE), WORKSPACE_FILE, renderWorkspaceFile(document));
}
```

Delete the three-line inline header string that was there. Export the new names from `src/core/init/index.ts`:

```ts
export {
  buildWorkspaceDocument, renderWorkspaceFile, WORKSPACE_FILE_HEADER,
  type WorkspaceDocument, type WorkspaceRepoDocument, type StackPacksDocument,
} from "./workspaceDocument.ts";
```

- [ ] **Step 5: Create the leaf reader `src/core/experts/stackPacks.ts`**

```ts
/**
 * What `workspace.yml` says about the stack packs — read by every prompt path, so it is a
 * LEAF like `stackExperts.ts`: one file, one parse, tolerant of a file written before the
 * keys existed (absent ⇒ off, empty lists). Nothing here writes; `init/stackPacks.ts` does.
 *
 * Not folded into `hooks/lib/workspace.ts`: that loader is bundled into every hook and
 * `test/build.test.ts` caps a hook entry at 50 KB (gh #94). Prompt assembly is not a hook.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { parseYaml } from "../yaml.ts";
import type { DetectedOverlay } from "../detect/overlays.ts";
import type { DetectedSkill } from "../detect/skills.ts";

export interface RepoPacks {
  readonly name: string;
  /** `repos[].stack`, so a caller can tell which `<lang>-stack` experts a repo maps to. */
  readonly stack: readonly string[];
  readonly overlays: readonly DetectedOverlay[];
  readonly skills: readonly DetectedSkill[];
}

export interface StackPacksState {
  /** Whether the file carries a `stack_packs` block at all. */
  readonly present: boolean;
  readonly enabled: boolean;
  readonly enabledAt: string | null;
  readonly repos: readonly RepoPacks[];
}

export const NO_STACK_PACKS: StackPacksState = { present: false, enabled: false, enabledAt: null, repos: [] };

/** `root` is the directory holding `.tldrx/` — the same `root` `expertDir` takes. */
export function readStackPacks(root: string): StackPacksState {
  const path = join(root, PROJECT_FRAMEWORK_DIR, "workspace.yml");
  if (!existsSync(path)) return NO_STACK_PACKS;
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return NO_STACK_PACKS;
  }
  if (typeof doc !== "object" || doc === null) return NO_STACK_PACKS;
  const record = doc as Record<string, unknown>;

  const block = record.stack_packs;
  const present = typeof block === "object" && block !== null;
  const enabled = present && (block as Record<string, unknown>).enabled === true;
  const at = present ? (block as Record<string, unknown>).enabled_at : null;

  const repos: RepoPacks[] = [];
  if (Array.isArray(record.repos)) {
    for (const row of record.repos as unknown[]) {
      if (typeof row !== "object" || row === null) continue;
      const repo = row as Record<string, unknown>;
      if (typeof repo.name !== "string") continue;
      repos.push({
        name: repo.name,
        stack: strings(repo.stack),
        overlays: overlaysOf(repo.overlays),
        skills: skillsOf(repo.skills),
      });
    }
  }
  return { present, enabled, enabledAt: typeof at === "string" ? at : null, repos };
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === "string") : [];
}

function overlaysOf(value: unknown): readonly DetectedOverlay[] {
  if (!Array.isArray(value)) return [];
  const out: DetectedOverlay[] = [];
  for (const item of value as unknown[]) {
    const row = item as Record<string, unknown> | null;
    if (row === null || typeof row !== "object" || typeof row.id !== "string") continue;
    out.push({ id: row.id, evidence: typeof row.evidence === "string" ? row.evidence : "" });
  }
  return out;
}

function skillsOf(value: unknown): readonly DetectedSkill[] {
  if (!Array.isArray(value)) return [];
  const out: DetectedSkill[] = [];
  for (const item of value as unknown[]) {
    const row = item as Record<string, unknown> | null;
    if (row === null || typeof row !== "object" || typeof row.name !== "string") continue;
    out.push({
      name: row.name,
      description: typeof row.description === "string" ? row.description : "",
      path: typeof row.path === "string" ? row.path : "",
      tracked: row.tracked === true,
    });
  }
  return out;
}
```

Append to `src/core/experts/index.ts`:

```ts
export { readStackPacks, NO_STACK_PACKS } from "./stackPacks.ts";
export type { StackPacksState, RepoPacks } from "./stackPacks.ts";
```

- [ ] **Step 6: Validate the block in the shipped schema**

`src/core/schemas/workspace.ts` — add the settings type and field:

```ts
/** `stack_packs:` — the one opt-in switch for stack expert packs. Additive; absent means off. */
export interface StackPacksSettings {
  readonly enabled: boolean;
  readonly enabled_at?: string | null;
}
```

```ts
  readonly seed_triage?: SeedTriageSettings;
  readonly stack_packs?: StackPacksSettings;
```

and in `validateWorkspace`, before `return result(issues, deprecations);`:

```ts
  if (doc.stack_packs !== undefined) {
    if (isRecord(doc.stack_packs)) {
      if (typeof doc.stack_packs.enabled !== "boolean") {
        issues.push({ path: "stack_packs.enabled", message: "expected a boolean" });
      }
      const at = doc.stack_packs.enabled_at;
      if (at !== undefined && at !== null && typeof at !== "string") {
        issues.push({ path: "stack_packs.enabled_at", message: "expected an RFC3339 string or null" });
      }
    } else {
      issues.push({ path: "stack_packs", message: "expected a mapping" });
    }
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test test/init.test.ts test/schemas.test.ts test/process-answers.test.ts test/detect.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`.

- [ ] **Step 8: Full gates and commit**

Run each on its own line: `bun run typecheck; echo "exit=$?"` · `bun test; echo "exit=$?"` · `bun run build; echo "exit=$?"`. Expected `exit=0` each. (`test/build.test.ts` enforces the 50 KB hook cap — if it goes red, the new import reached a hook bundle; the leaf reader must not be imported from `src/hooks/`.)

```bash
git add src/core/detect src/core/init src/core/schemas/workspace.ts src/core/experts/stackPacks.ts src/core/experts/index.ts test/init.test.ts test/schemas.test.ts test/process-answers.test.ts
git commit -m "feat(init): workspace.yml records overlays with evidence, project skills, and carries stack_packs across re-init

Additive under version: 1. The switch outlives detection because the file is regenerated on every init.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 4: Pack sections and template access (the two headings, composition, hash)

**Files:**
- Create: `src/core/experts/packSections.ts`, `src/core/experts/packTemplates.ts`
- Modify: `src/core/experts/index.ts`
- Test: `test/pack-sections.test.ts`

**Interfaces:**
- Consumes: `truncateAtHeading`, `byteLength` (`expertKnowledge.ts`); `splitFrontMatter`, `section` (`expertDocument.ts`); `TEMPLATES_DIR` (`paths.ts`); `PACK_LANGUAGES`, `PackLanguage` (`detect/overlays.ts`).
- Produces (packSections): `DEFAULTS_HEADING`, `CHECKS_HEADING`, `OVERRIDDEN_BY`, `VERIFY_HINT`, `OVERLAYS_DIRNAME`, `PACK_MAX_BYTES`, `OverlayFile {id, text}`, `overlayMarker(id)`, `ComposedPack {text, inlined, notInlined, truncated}`, `composePackBody(body, overlays, maxBytes?)`, `checksOf(text)`, `readOverlayFiles(expertDirAbs)`.
- Produces (packTemplates): `PACK_TEMPLATES_DIR`, `OVERLAY_TEMPLATES_DIR`, `PACK_BODY_MAX_BYTES = 8192`, `OVERLAY_MAX_BYTES = 6144`, `packBodyPath(lang)`, `overlayTemplatePath(id)`, `readPackBody(lang)`, `readOverlayTemplate(id)`, `packTemplateFiles()`, `hashTemplates(entries)`, `templatesHash()`.

- [ ] **Step 1: Write the failing test**

Create `test/pack-sections.test.ts`:

```ts
/**
 * The pack grammar has exactly two headings and one composition rule (stack packs
 * design §4.1, §4.5). Everything that reads a pack — the prompt, the reviewer, the shape
 * test — imports these constants; nothing re-types them.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKS_HEADING, DEFAULTS_HEADING, checksOf, composePackBody, OVERLAYS_DIRNAME, overlayMarker,
  PACK_MAX_BYTES, readOverlayFiles,
} from "../src/core/experts/packSections.ts";
import { hashTemplates, OVERLAY_MAX_BYTES, PACK_BODY_MAX_BYTES, templatesHash } from "../src/core/experts/packTemplates.ts";
import { byteLength } from "../src/core/experts/expertKnowledge.ts";

const BODY = [
  "---", "name: typescript-stack", "kind: stack", "---", "",
  "# TypeScript", "", "Scope paragraph.", "",
  `## ${DEFAULTS_HEADING}`, "", "- Strict on. — overridden by: tsconfig.json compilerOptions.strict", "",
  `## ${CHECKS_HEADING}`, "", "- Any `any`? verify: grep for `: any`", "",
].join("\n");

function overlay(id: string, filler = ""): { id: string; text: string } {
  return {
    id,
    text: [`# ${id}`, "", "Scope.", "", `## ${DEFAULTS_HEADING}`, "", `- d — overridden by: x${filler}`, "",
      `## ${CHECKS_HEADING}`, "", `- c verify: y`, ""].join("\n"),
  };
}

describe("the headings", () => {
  test("are the exact strings the spec names", () => {
    expect(DEFAULTS_HEADING).toBe("Defaults (when the repo is silent)");
    expect(CHECKS_HEADING).toBe("Checks (always asked in review)");
    expect(OVERLAYS_DIRNAME).toBe("overlays");
    expect(PACK_MAX_BYTES).toBe(24 * 1024);
    expect(PACK_BODY_MAX_BYTES).toBe(8 * 1024);
    expect(OVERLAY_MAX_BYTES).toBe(6 * 1024);
  });
});

describe("composePackBody", () => {
  test("appends every overlay after the body, sorted by id, each under its marker", () => {
    const composed = composePackBody(BODY, [overlay("react"), overlay("aspnet-controllers")]);
    expect(composed.inlined).toEqual(["aspnet-controllers", "react"]);
    expect(composed.notInlined).toEqual([]);
    expect(composed.truncated).toBe(false);
    expect(composed.text.indexOf(overlayMarker("aspnet-controllers"))).toBeLessThan(composed.text.indexOf(overlayMarker("react")));
    expect(composed.text.startsWith("---\nname: typescript-stack")).toBe(true);
  });

  test("no overlays ⇒ the body, trimmed, with one trailing newline", () => {
    expect(composePackBody(BODY, []).text).toBe(`${BODY.trimEnd()}\n`);
  });

  test("past the cap, whole overlays are dropped at an H2 boundary and NAMED in a marker", () => {
    const big = overlay("zeta", "x".repeat(3000));
    const composed = composePackBody(BODY, [overlay("alpha"), big, overlay("beta")], 3500);
    expect(byteLength(composed.text)).toBeLessThanOrEqual(3500 + 200);
    expect(composed.notInlined).toContain("zeta");
    expect(composed.text).toContain(`(not inlined: ${composed.notInlined.length} overlays — ${composed.notInlined.join(", ")})`);
    expect(composed.truncated).toBe(true);
  });

  test("a cap smaller than the body still yields the body alone, never an empty prompt block", () => {
    const composed = composePackBody(BODY, [overlay("react")], 10);
    expect(composed.text).toBe(`${BODY.trimEnd()}\n`);
    expect(composed.notInlined).toEqual(["react"]);
  });
});

describe("checksOf", () => {
  test("returns the Checks section of a pack (front matter tolerated) and empty when absent", () => {
    expect(checksOf(BODY)).toBe("- Any `any`? verify: grep for `: any`");
    expect(checksOf("# nothing\n\n## Other\n\n- x\n")).toBe("");
  });
});

describe("readOverlayFiles", () => {
  test("reads overlays/*.md sorted by id, ignores everything else, tolerates a missing dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-pack-"));
    try {
      expect(readOverlayFiles(dir)).toEqual([]);
      mkdirSync(join(dir, OVERLAYS_DIRNAME));
      writeFileSync(join(dir, OVERLAYS_DIRNAME, "react.md"), "# react\n", "utf8");
      writeFileSync(join(dir, OVERLAYS_DIRNAME, "aspnet-controllers.md"), "# c\n", "utf8");
      writeFileSync(join(dir, OVERLAYS_DIRNAME, "notes.txt"), "no", "utf8");
      expect(readOverlayFiles(dir)).toEqual([
        { id: "aspnet-controllers", text: "# c\n" }, { id: "react", text: "# react\n" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the templates hash", () => {
  test("is twelve hex chars, stable, and changes with content or path", () => {
    const a = hashTemplates([{ rel: "typescript.md", text: "# a\n" }]);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(hashTemplates([{ rel: "typescript.md", text: "# a\n" }])).toBe(a);
    expect(hashTemplates([{ rel: "typescript.md", text: "# b\n" }])).not.toBe(a);
    expect(hashTemplates([{ rel: "javascript.md", text: "# a\n" }])).not.toBe(a);
    expect(templatesHash()).toMatch(/^[0-9a-f]{12}$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/pack-sections.test.ts; echo "exit=$?"` — Expected FAIL, `Cannot find module '../src/core/experts/packSections.ts'`; `exit=1`. Keep the output.

- [ ] **Step 3: Create `src/core/experts/packSections.ts`**

```ts
/**
 * The pack grammar (stack packs design §4.1) and the one composition rule (§4.5).
 *
 * A pack — a language body or a framework overlay — has exactly two H2s. Defaults apply
 * only when the repo is silent on the topic and each one names the signal that overrides
 * it; Checks are asked of every review and a miss is a finding with a cited file, with the
 * project's own convention as the accepted answer when it exists. Measured repo
 * conventions win over pack content, always (decision 1).
 *
 * These two heading strings are spelled here and nowhere else: the templates carry them,
 * the shape test asserts them, the reviewer extracts by them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { section, splitFrontMatter } from "./expertDocument.ts";
import { byteLength, truncateAtHeading } from "./expertKnowledge.ts";

export const DEFAULTS_HEADING = "Defaults (when the repo is silent)";
export const CHECKS_HEADING = "Checks (always asked in review)";
/** Every Default bullet ends with this and the signal that overrides it. */
export const OVERRIDDEN_BY = "— overridden by:";
/** Every Check bullet carries this and what to open or run. */
export const VERIFY_HINT = "verify:";

/** `.tldrx/experts/<lang>-stack/overlays/` — framework-managed, rewritten on enable and re-init. */
export const OVERLAYS_DIRNAME = "overlays";

/**
 * `[assumption]` 24 KB for body + overlays together, per stack expert. Separate from the
 * 48 KB trained-knowledge budget on purpose: pack prose must not crowd out what training
 * found (§3). A body is ≤ 8 KB and an overlay ≤ 6 KB, so two or three overlays fit whole.
 */
export const PACK_MAX_BYTES = 24 * 1024;

export interface OverlayFile {
  readonly id: string;
  readonly text: string;
}

export function overlayMarker(id: string): string {
  return `<!-- overlay: ${id} -->`;
}

export interface ComposedPack {
  readonly text: string;
  readonly inlined: readonly string[];
  readonly notInlined: readonly string[];
  readonly truncated: boolean;
}

/**
 * `body + overlays/*.md` sorted by id, cut at an H2 boundary to fit `maxBytes`, with the
 * overlays that did not make it NAMED — the same H2 rule and the same "say what was left
 * behind" the knowledge budget uses (`truncateAtHeading`, imported, not copied).
 */
export function composePackBody(
  body: string,
  overlays: readonly OverlayFile[],
  maxBytes: number = PACK_MAX_BYTES,
): ComposedPack {
  const sorted = [...overlays].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const full = `${[body.trimEnd(), ...sorted.map((o) => `${overlayMarker(o.id)}\n${o.text.trimEnd()}`)].join("\n\n")}\n`;
  const cut = truncateAtHeading(full, maxBytes);
  const text = cut === "" ? `${body.trimEnd()}\n` : cut;
  const inlined = sorted.filter((o) => text.includes(overlayMarker(o.id))).map((o) => o.id);
  const notInlined = sorted.filter((o) => !text.includes(overlayMarker(o.id))).map((o) => o.id);
  const truncated = byteLength(text) < byteLength(full);
  if (notInlined.length === 0) return { text, inlined, notInlined, truncated };
  return {
    text: `${text.trimEnd()}\n\n(not inlined: ${String(notInlined.length)} overlays — ${notInlined.join(", ")})\n`,
    inlined,
    notInlined,
    truncated,
  };
}

/** The `## Checks (always asked in review)` section of a pack or overlay; `""` when it has none. */
export function checksOf(text: string): string {
  return section(splitFrontMatter(text).body, CHECKS_HEADING);
}

/** `overlays/*.md` under one expert folder, sorted by id. Missing folder ⇒ empty. */
export function readOverlayFiles(expertDirAbs: string): readonly OverlayFile[] {
  const dir = join(expertDirAbs, OVERLAYS_DIRNAME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => ({ id: entry.replace(/\.md$/, ""), text: readFileSync(join(dir, entry), "utf8") }));
}
```

- [ ] **Step 4: Create `src/core/experts/packTemplates.ts`**

```ts
/**
 * Where the shipped packs live and how a shipment is named.
 *
 * `templates/experts/stack/<lang>.md` is a language pack body; `overlays/<id>.md` is a
 * framework overlay. Both ship in the npm package (`files: templates`) and are read from
 * `TEMPLATES_DIR` at run time, exactly as role bodies are. `pack: <lang>@<hash>` in a
 * materialised expert's front matter names one exact shipment: the hash covers every
 * template's path and bytes, so a changed template is a different hash.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES_DIR } from "../paths.ts";
import type { PackLanguage } from "../detect/overlays.ts";

export const PACK_TEMPLATES_DIR: string = join(TEMPLATES_DIR, "experts", "stack");
export const OVERLAY_TEMPLATES_DIR: string = join(PACK_TEMPLATES_DIR, "overlays");

/** Caps a shape test enforces (stack packs design §4.1). */
export const PACK_BODY_MAX_BYTES = 8 * 1024;
export const OVERLAY_MAX_BYTES = 6 * 1024;

export function packBodyPath(lang: PackLanguage): string {
  return join(PACK_TEMPLATES_DIR, `${lang}.md`);
}

export function overlayTemplatePath(id: string): string {
  return join(OVERLAY_TEMPLATES_DIR, `${id}.md`);
}

/** The shipped body for a language, or null when none ships — the caller says so, never guesses. */
export function readPackBody(lang: PackLanguage): string | null {
  const path = packBodyPath(lang);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function readOverlayTemplate(id: string): string | null {
  const path = overlayTemplatePath(id);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export interface TemplateFile {
  /** Relative to `PACK_TEMPLATES_DIR`, POSIX: `typescript.md`, `overlays/react.md`. */
  readonly rel: string;
  readonly abs: string;
}

/** Every shipped `.md` under the pack templates dir, sorted by `rel`. Missing dir ⇒ empty. */
export function packTemplateFiles(): readonly TemplateFile[] {
  const out: TemplateFile[] = [];
  if (!existsSync(PACK_TEMPLATES_DIR)) return out;
  for (const entry of readdirSync(PACK_TEMPLATES_DIR).sort()) {
    if (entry.endsWith(".md")) out.push({ rel: entry, abs: join(PACK_TEMPLATES_DIR, entry) });
  }
  if (existsSync(OVERLAY_TEMPLATES_DIR)) {
    for (const entry of readdirSync(OVERLAY_TEMPLATES_DIR).sort()) {
      if (entry.endsWith(".md")) out.push({ rel: `overlays/${entry}`, abs: join(OVERLAY_TEMPLATES_DIR, entry) });
    }
  }
  return out;
}

/** First 12 hex of sha256 over `rel\n<text>\n` for every entry, in the given order. */
export function hashTemplates(entries: readonly { readonly rel: string; readonly text: string }[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${entry.rel}\n${entry.text}\n`);
  return hash.digest("hex").slice(0, 12);
}

export function templatesHash(): string {
  return hashTemplates(packTemplateFiles().map((file) => ({ rel: file.rel, text: readFileSync(file.abs, "utf8") })));
}
```

Append to `src/core/experts/index.ts`:

```ts
export {
  DEFAULTS_HEADING, CHECKS_HEADING, OVERRIDDEN_BY, VERIFY_HINT, OVERLAYS_DIRNAME, PACK_MAX_BYTES,
  composePackBody, checksOf, overlayMarker, readOverlayFiles,
} from "./packSections.ts";
export type { OverlayFile, ComposedPack } from "./packSections.ts";
export {
  PACK_TEMPLATES_DIR, OVERLAY_TEMPLATES_DIR, PACK_BODY_MAX_BYTES, OVERLAY_MAX_BYTES,
  packBodyPath, overlayTemplatePath, readPackBody, readOverlayTemplate, packTemplateFiles, hashTemplates, templatesHash,
} from "./packTemplates.ts";
export type { TemplateFile } from "./packTemplates.ts";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/pack-sections.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck; echo "exit=$?"` — Expected `exit=0`.

```bash
git add src/core/experts/packSections.ts src/core/experts/packTemplates.ts src/core/experts/index.ts test/pack-sections.test.ts
git commit -m "feat(experts): the pack grammar — two headings, one composition rule, one shipment hash

Body + overlays compose under a 24 KB cap with the knowledge budget's own H2 cut, and the overlays left behind are named, not dropped.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 5: The four language pack bodies, pinned by a shape test

**Files:**
- Create: `templates/experts/stack/typescript.md`, `javascript.md`, `python.md`, `dotnet.md`
- Test: `test/pack-templates.test.ts`

**Interfaces:**
- Consumes: `PACK_LANGUAGES`; `PACK_TEMPLATES_DIR`, `packBodyPath`, `PACK_BODY_MAX_BYTES`; `DEFAULTS_HEADING`, `CHECKS_HEADING`, `OVERRIDDEN_BY`, `VERIFY_HINT`.
- Produces: the four bodies, in the exact §4.1 format, that `applyStackPacks` (Task 7) copies into `expert.md`.

- [ ] **Step 1: Write the failing shape test**

Create `test/pack-templates.test.ts`:

```ts
/**
 * The shipped packs obey one format (stack packs design §4.1) and the shape test is the
 * thing that keeps them honest: interrogative Checks with a `verify:` hint, Defaults that
 * name what overrides them, size caps, no machine paths, no workspace names. Content is
 * a person's judgement; format is the framework's.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PACK_LANGUAGES } from "../src/core/detect/overlays.ts";
import {
  CHECKS_HEADING, DEFAULTS_HEADING, OVERRIDDEN_BY, VERIFY_HINT,
} from "../src/core/experts/packSections.ts";
import { PACK_BODY_MAX_BYTES, PACK_TEMPLATES_DIR, packBodyPath } from "../src/core/experts/packTemplates.ts";
import { section } from "../src/core/experts/expertDocument.ts";
import { byteLength } from "../src/core/experts/expertKnowledge.ts";

/** Bullets of a section, continuation lines joined — a wrapped bullet is one bullet. */
export function bullets(body: string): readonly string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^- /.test(line)) out.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
  }
  return out;
}

/** Every rule a pack file — body or overlay — must satisfy. Shared with the overlay describe below. */
export function assertPackShape(label: string, text: string, maxBytes: number): void {
  const lines = text.split("\n");
  expect(lines[0], `${label}: first line is the H1`).toMatch(/^# \S/);
  expect(text.endsWith("\n"), `${label}: ends with a newline`).toBe(true);
  expect(byteLength(text), `${label}: size cap`).toBeLessThanOrEqual(maxBytes);

  const h2s = lines.filter((line) => line.startsWith("## ")).map((line) => line.slice(3).trim());
  expect(h2s, `${label}: exactly the two H2s, Defaults first`).toEqual([DEFAULTS_HEADING, CHECKS_HEADING]);
  expect(lines.some((line) => /^#{3,} /.test(line)), `${label}: no H3 or deeper`).toBe(false);

  const scope = lines.slice(1, lines.indexOf(`## ${DEFAULTS_HEADING}`)).filter((line) => line.trim() !== "");
  expect(scope.length, `${label}: one scope paragraph between the H1 and Defaults`).toBeGreaterThan(0);
  expect(scope.some((line) => line.startsWith("- ")), `${label}: the scope is prose, not bullets`).toBe(false);

  const defaults = bullets(section(text, DEFAULTS_HEADING));
  expect(defaults.length, `${label}: at least one Default`).toBeGreaterThan(0);
  for (const item of defaults) {
    expect(item, `${label}: Default must end with "${OVERRIDDEN_BY} <signal>"`).toMatch(new RegExp(`${OVERRIDDEN_BY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\S.*$`));
  }
  const checks = bullets(section(text, CHECKS_HEADING));
  expect(checks.length, `${label}: at least one Check`).toBeGreaterThan(0);
  for (const item of checks) {
    expect(item, `${label}: Check must carry a "${VERIFY_HINT}" hint`).toContain(VERIFY_HINT);
    expect(item, `${label}: a Check is a question`).toContain("?");
  }

  for (const banned of ["/Users/", "C:\\", "~/", "/home/"]) {
    expect(text, `${label}: no machine path (${banned})`).not.toContain(banned);
  }
  expect(text, `${label}: version-agnostic — no "vNN" or "version NN" in prose`).not.toMatch(/\b(?:v\d+(?:\.\d+)*|version \d+)\b/i);
}

describe("language pack bodies", () => {
  test("one body ships per pack language, and nothing else sits beside them", () => {
    const files = readdirSync(PACK_TEMPLATES_DIR).filter((entry) => entry.endsWith(".md")).sort();
    expect(files).toEqual([...PACK_LANGUAGES].map((lang) => `${lang}.md`).sort());
  });

  for (const lang of PACK_LANGUAGES) {
    test(`${lang}.md has the §4.1 shape and fits in ${String(PACK_BODY_MAX_BYTES)} bytes`, () => {
      const path = packBodyPath(lang);
      expect(existsSync(path), path).toBe(true);
      assertPackShape(`${lang}.md`, readFileSync(path, "utf8"), PACK_BODY_MAX_BYTES);
    });
  }

  test("a body never carries front matter — the expert's own front matter is preserved on apply", () => {
    for (const lang of PACK_LANGUAGES) {
      expect(readFileSync(packBodyPath(lang), "utf8").startsWith("---"), lang).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/pack-templates.test.ts; echo "exit=$?"` — Expected FAIL, `ENOENT … templates/experts/stack`; `exit=1`. Keep the output.

- [ ] **Step 3: Author the four bodies**

Format, exactly (the shape test enforces it):

```markdown
# <Title>

<One paragraph of scope: which code this applies to, and the sentence "Measured repo
conventions win over anything below: a Default applies only where the repo is silent, and
a Check's accepted answer is the project's own convention when it has one.">

## Defaults (when the repo is silent)

- <One default, imperative, one topic.> — overridden by: <the file or signal that decides it>

## Checks (always asked in review)

- <One question about the diff?> verify: <what to open, grep, or run>
```

Authoring rules, applied to every bullet:
- **Defaults** are prescriptive only where the repo is silent, and each names the *signal* that overrides it — a file path, a manifest key, a lockfile, a config section, a present skill (`— overridden by: a project skill that covers it`). Never a version number.
- **Checks** are questions (end with `?`), each with `verify:` naming what to open or run. Prefer the repo's own commands from `workspace.yml` (`verify: run the typecheck command declared in .tldrx/workspace.yml`) over invented ones. A Check must be answerable from the diff plus one file.
- Technology-accurate and version-agnostic: no `React 19`, no `.NET 8`, no `Python 3.12`; nothing that is true only of one release. Anything you are not sure is true of the technology today is left out — a pack is refused prose, never invented prose.
- Neutral on architecture; architecture is an overlay's job (Task 6).
- Voice: the shipped role bodies (`templates/experts/developer.md`) — direct, second person, short bullets.
- Byte budget: ≤ 8192 bytes; aim for 10–16 Defaults and 12–18 Checks.
- No workspace names, no machine paths, no `~/`.

Topics each body must cover (write the prose yourself):

`typescript.md` — Defaults: strictness flags and what the repo's `tsconfig.json` decides; `unknown` over `any` at boundaries; narrowing over casts; exhaustive `switch` on unions; type-only imports; module format coherent with the runtime (`"type"` in package.json / `module` in tsconfig); the package manager the lockfile names; no floating promises; errors are `Error` instances and are never swallowed; public types exported from one entry; test runner and lint/format tools are the ones the manifest declares. Checks: any new `any` or `as` cast?; a promise not awaited or returned?; a `catch` that drops the error?; a new dependency without a lockfile change?; a `switch` over a union with no exhaustive default?; a test that cannot fail (asserts a constant, or nothing)?; typecheck and lint commands from `workspace.yml` green?; a changed public type without its consumer updated?; `console.log` left in production paths?; an enum introduced where the repo uses const objects (or the reverse)?

`javascript.md` — the same shape without the type system: module format coherence (`"type": "module"`, `require` vs `import`), strict equality, no implicit globals, JSDoc where the repo already uses it, async discipline, error handling, dependency + lockfile, test runner and lint from the manifest, no `eval`/`new Function`, input validation at boundaries. Checks mirror TypeScript's minus the type-only ones, plus: a callback API mixed with promises?; a mutable default parameter or shared module-level state?

`python.md` — Defaults: `pyproject.toml` is the source of truth for tooling; the environment/package tool the lockfile names (uv/poetry/pip); type hints where the repo has them and the checker it configures (mypy/pyright); formatter/linter as configured (ruff/black); pytest discovery per config; specific exceptions, never bare `except:`; `logging` not `print`; f-strings; dataclasses/pydantic per what the repo already uses; imports absolute within the package; `__init__.py` per packaging style; no mutable default arguments; `with` for resources. Checks: bare `except` or `except Exception: pass`?; a new dependency outside `pyproject`/requirements and the lockfile?; a function without hints in a hinted module?; `print` in library code?; a test without an assertion?; `subprocess` with `shell=True` on interpolated input?; a global mutable at import time?; lint/typecheck/test commands green?

`dotnet.md` — Defaults: nullable reference types as the csproj/`Directory.Build.props` decides; warnings-as-errors as configured; `async` all the way with a `CancellationToken` parameter on I/O paths; no `.Result`/`.Wait()`; DI lifetimes match usage (scoped for per-request state); configuration through `IOptions<T>`; `ILogger<T>` with structured message templates, never string interpolation in the template; tests with the framework the test csproj names (xUnit/NUnit/MSTest); analyzers/`.editorconfig` respected; central package management — when `Directory.Packages.props` exists, a csproj never carries a `Version`; `record` for immutable data; `sealed` where the repo does it; `IDisposable` honoured via `using`. Checks: a `.Result`/`.Wait()` or `async void` outside an event handler?; an I/O call without the token that is in scope?; a `Version=` added to a csproj under central package management?; a captured scoped service in a singleton?; string-interpolated log template?; a new public API without a test?; `catch (Exception)` that swallows?; nullable warnings suppressed with `!` rather than handled?; build/test/lint commands from `workspace.yml` green?

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/pack-templates.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`. Fix any bullet the shape test names (the failure message carries the file and the rule).

Also: `bun test test/pack-sections.test.ts; echo "exit=$?"` — `templatesHash()` now hashes real files; expected PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/experts/stack test/pack-templates.test.ts
git commit -m "feat(packs): the four language pack bodies — interrogative Checks, yielding Defaults, pinned by a shape test

Measured repo conventions win over pack content, always (stack packs design decision 1).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 6: The thirteen overlay templates, one-to-one with the detection table

**Files:**
- Create: `templates/experts/stack/overlays/{react,next-app-router,vite-react-spa,expo-router,node-express,prisma,aspnet-minimal-apis,aspnet-controllers,mediatr-cqrs,efcore-npgsql,fastapi,sqlalchemy-alembic,postgres-testcontainers}.md`
- Test: `test/pack-templates.test.ts` (append)

**Interfaces:**
- Consumes: `OVERLAY_RULES`, `OVERLAY_TEMPLATES_DIR`, `overlayTemplatePath`, `OVERLAY_MAX_BYTES`, `assertPackShape` (this file).
- Produces: the overlay files `materialiseOverlays` (Task 7) copies under `overlays/`.

- [ ] **Step 1: Append the failing tests to `test/pack-templates.test.ts`**

Add these imports at the top: `import { readdirSync as readDir } from "node:fs";` is already covered by `readdirSync` — only add `OVERLAY_RULES` to the `detect/overlays.ts` import and `OVERLAY_MAX_BYTES, OVERLAY_TEMPLATES_DIR, overlayTemplatePath` to the `packTemplates.ts` import, plus:

```ts
import { join, relative } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { walkFiles } from "../src/core/detect/walk.ts";
```

Then append:

```ts
describe("framework overlays mirror the detection table one-to-one (one derivation)", () => {
  const ids = OVERLAY_RULES.map((rule) => rule.id).sort();

  test("every rule has a template and every template has a rule", () => {
    const files = readdirSync(OVERLAY_TEMPLATES_DIR).filter((entry) => entry.endsWith(".md")).map((entry) => entry.replace(/\.md$/, "")).sort();
    expect(files).toEqual(ids);
  });

  for (const id of OVERLAY_RULES.map((rule) => rule.id)) {
    test(`overlays/${id}.md has the §4.1 shape and fits in ${String(OVERLAY_MAX_BYTES)} bytes`, () => {
      assertPackShape(`overlays/${id}.md`, readFileSync(overlayTemplatePath(id), "utf8"), OVERLAY_MAX_BYTES);
    });
  }

  /**
   * The table in `src/core/detect/overlays.ts` is the ONE list of ids. A second copy in a
   * renderer, a status printer or a docs generator would be #80 again under a new name,
   * so the guard is on the literal: no other file under `src/` may spell an overlay id in
   * quotes. Tests and templates are allowed — they are the readers this pins for.
   */
  test("no file under src/ other than the table spells an overlay id as a string literal", async () => {
    const files = await walkFiles(join(FRAMEWORK_ROOT, "src"));
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.path.endsWith(".ts") || file.path === "core/detect/overlays.ts") continue;
      const text = readFileSync(join(FRAMEWORK_ROOT, "src", file.path), "utf8");
      for (const id of ids) {
        if (text.includes(`"${id}"`) || text.includes(`'${id}'`)) offenders.push(`${file.path}: ${id}`);
      }
    }
    expect(offenders).toEqual([]);
    // Not vacuous: the table itself does spell them.
    expect(readFileSync(join(FRAMEWORK_ROOT, "src/core/detect/overlays.ts"), "utf8")).toContain(`"${ids[0] ?? ""}"`);
    expect(relative(FRAMEWORK_ROOT, OVERLAY_TEMPLATES_DIR)).toBe("templates/experts/stack/overlays");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/pack-templates.test.ts; echo "exit=$?"` — Expected FAIL, `ENOENT … stack/overlays`; `exit=1`. Keep the output.

- [ ] **Step 3: Author the thirteen overlays**

Same format and authoring rules as Task 5 (H1, one scope paragraph, the two H2s, Defaults ending `— overridden by: <signal>`, Checks as questions with `verify:`), cap 6144 bytes each, aim for 6–10 Defaults and 6–10 Checks. "General backend / frontend practice" lives here, not in a third layer (decision 2). Topics per overlay:

- `react.md` — components pure; hooks rules (top level, exhaustive deps as the lint config decides); stable keys; state colocated; effects for synchronisation only, data fetching via whatever the repo already uses; `memo`/`useMemo` only with a measurement; semantic elements and labels; error boundaries at route level; tests query by role (as the repo's testing library does). Checks: an index used as a key?; a fetch inside `useEffect` where the repo has a data layer?; a hook called conditionally?; derived state stored in state?; a new component without a test where siblings have one?; an accessibility regression (div-as-button, missing label)?
- `next-app-router.md` — server components by default, `"use client"` only where a browser API or interactivity needs it; data fetching in server components / route handlers; `loading.tsx` / `error.tsx` per segment as the repo does; metadata via the metadata API; only `NEXT_PUBLIC_` variables reach the client; caching and revalidation stated explicitly; no pages-router APIs (`next/router`) in `app/`. Checks: a client component importing server-only code?; a secret behind `NEXT_PUBLIC_`?; a route handler without an explicit cache/revalidate decision?; `next/router` in `app/`?; a segment without an error boundary where the repo has them?
- `vite-react-spa.md` — `import.meta.env` with the `VITE_` prefix, typed where the repo types env; route-level code splitting with `lazy`; the router the manifest names; dev proxy for the API as `vite.config` decides; static assets through imports not string paths; build output ignored. Checks: `process.env` in browser code?; an env var without `VITE_`?; a whole route eagerly imported where siblings are lazy?; an asset referenced by a hard-coded path?; build and test commands green?
- `expo-router.md` — file-based routes under `app/`; `Link`/`router` from `expo-router` for navigation; platform files (`.ios.tsx`, `.android.tsx`, `.web.tsx`) only when behaviour differs; config in `app.json`/`app.config.*` as the repo has it; `EXPO_PUBLIC_` for client env; a native module addition needs a native rebuild — said in the story log; safe-area handling as the repo does. Checks: navigation via a string path the router does not know?; a native dependency added without the rebuild noted?; a secret behind `EXPO_PUBLIC_`?; platform-specific code without the platform file?
- `node-express.md` — middleware order (parsers, auth, routes, 404, error handler last); the error handler has the four-argument signature; async handlers forward rejections to `next` (or a wrapper the repo uses); validation at the boundary with what the repo uses; no secrets in code; request logging as configured; graceful shutdown on SIGTERM; status codes explicit. Checks: an async handler that can reject without reaching the error handler?; a route mounted after the 404 handler?; a request body used without validation?; an error handler that leaks stack traces to the client?; a new route without a test?
- `prisma.md` — `schema.prisma` is the source of truth; a schema change ships with a migration (`prisma migrate`), never `db push` in the migration flow; one client instance per process; `select`/`include` deliberate in hot paths; multi-write in a transaction; generated client not committed unless the repo does; seed script as the repo has it. Checks: a schema change without a migration file?; a migration edited after it was committed?; a new `PrismaClient()` per request?; two dependent writes outside a transaction?; a raw query with interpolated input?
- `aspnet-minimal-apis.md` — endpoints grouped with `MapGroup`; typed results; validation approach as the repo has it; `ProblemDetails` for errors; services via parameter injection; a `CancellationToken` parameter on every endpoint that does I/O; OpenAPI annotations as configured; no `Controllers/` introduced beside minimal endpoints. Checks: an endpoint returning an untyped `IResult` where siblings are typed?; an endpoint without a `CancellationToken`?; an error returned as a bare string?; a new endpoint outside its group?; a controller added to a minimal-API project?
- `aspnet-controllers.md` — `[ApiController]` and attribute routing; `ActionResult<T>` return types; model validation via the pipeline, not by hand; `ProblemDetails`; thin actions that delegate; filters for cross-cutting concerns; versioning as the repo does it. Checks: a fat action with business logic?; manual `ModelState` checks where the pipeline already does it?; an action returning `object`/`IActionResult` where siblings are typed?; a new controller without tests where siblings have them?; a route string that duplicates an existing one?
- `mediatr-cqrs.md` — one request type, one handler; commands and queries separated (naming and folders as the repo does); pipeline behaviours for validation/logging/transactions; handlers never call other handlers; controllers/endpoints only send; the token flows into the handler; handler registration by assembly scan as configured. Checks: a handler calling `Send` on another request?; business logic in the endpoint instead of the handler?; a query that writes?; a new request type without a handler test?; validation done in the handler where a behaviour exists?
- `efcore-npgsql.md` — migrations committed and named; `DbContext` scoped; `AsNoTracking` for read paths; no N+1 (projection or `Include`); Npgsql-specific types (`timestamptz`, `jsonb`, arrays) used deliberately; connection strings from configuration; indexes in the model; `SaveChangesAsync` with the token; raw SQL parameterised. Checks: a model change without a migration?; a migration edited after commit?; a query in a loop?; a `DateTime` without a kind where the column is `timestamptz`?; a tracked query on a read path?; interpolated SQL?
- `fastapi.md` — pydantic models for request and response; `Depends` for injection; `async def` only with async I/O underneath; routers per module; explicit `response_model` and status codes; settings via the settings class the repo has; lifespan for startup/shutdown; `HTTPException` with a detail; tests via the test client the repo uses. Checks: an `async def` endpoint doing blocking I/O?; an endpoint without a response model where siblings have one?; a raw dict returned where a model exists?; a dependency created at import time?; a new endpoint without a test?
- `sqlalchemy-alembic.md` — models are the source of truth; migrations autogenerated then REVIEWED (autogenerate misses renames and constraints); one head; sessions scoped per request/unit of work, never at import time; query style consistent with the repo (2.0 `select()` vs legacy); relationship loading explicit; alembic env reads the same settings as the app. Checks: a model change without a migration?; an unreviewed autogenerate (drop + create for a rename)?; a second migration head?; a session held across requests?; a lazy relationship touched in a loop?
- `postgres-testcontainers.md` — integration tests run against a real Postgres container, never a mock of the database; container lifetime as the repo does it (per class/per run); migrations applied to the container before tests; isolation per test (schema, database, or transaction rollback) as the repo does; connection string taken from the container, never a fixed port; the Docker precondition named in the story log and DoD; containers stopped in teardown. Checks: a database test against a mock or an in-memory substitute?; a hard-coded port or host?; tests that share state without isolation?; a schema change without the migration running in the container?; the Docker precondition unstated?

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/pack-templates.test.ts test/pack-sections.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add templates/experts/stack/overlays test/pack-templates.test.ts
git commit -m "feat(packs): thirteen framework overlays, one per detection-table row, pinned one-to-one

An overlay is a fact about a manifest, never an inference from a language (stack packs design decision 3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 7: Materialisation — enable / disable / status, body rule, overlays, re-init

**Files:**
- Create: `src/core/init/stackPacks.ts`
- Modify: `src/core/init/runInit.ts:146-153` (apply on re-init when the switch is on), `src/core/init/index.ts`
- Test: `test/stack-packs.test.ts`

**Interfaces:**
- Consumes: `detectWorkspace`, `isPackLanguage`, `overlayRule`, `PACK_LANGUAGES`, `repoSlug`; `renderExpert`, `planExperts`, `seedExperts`, `EXPERTS_DIR`, `WriteLog`, `loadWorkspaceFile`, `renderWorkspaceFile`, `validateWorkspaceDocument`, `formatIssues`; `expertDir`, `EXPERT_FILE`, `expertsDir`, `splitFrontMatter`, `parseList`, `readOverlayFiles`, `OVERLAYS_DIRNAME`, `readPackBody`, `readOverlayTemplate`, `templatesHash`, `readStackPacks`; `readYamlFile`; `runtime`; `PROJECT_WORKSPACE_FILE`.
- Produces: `BodyState`, `stubBodyFor(name, repos)`, `packBodyText(template)`, `bodyState(expertMd, lang)`, `applyStackPacks({workspaceDir, workspace, log}) → {lines, applied, overlays, kept}`, `patchWorkspaceDocument(existing, workspace, stackPacks) → {document, unmatched}`, `PacksOutcome {ok, lines}`, `enableStackPacks({workspaceDir, runner, now})`, `disableStackPacks({workspaceDir})`, `stackPacksStatus({workspaceDir})`, `describeRepos(repos)`.

- [ ] **Step 1: Write the failing tests**

Create `test/stack-packs.test.ts`:

```ts
/**
 * The materialisation rules (stack packs design §4.2, §4.6): the pack body replaces a
 * stub and ONLY a stub, overlays are framework-managed files rewritten on every enable
 * and re-init, disable removes overlays and nothing else, and the switch survives
 * `tldrx init`. Real fixtures, real detection: the rules read manifests and git.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SpawnCommandRunner } from "../src/core/detect/index.ts";
import { rfc3339, runInit, type InitOptions } from "../src/core/init/index.ts";
import {
  bodyState, disableStackPacks, enableStackPacks, stackPacksStatus, stubBodyFor,
} from "../src/core/init/stackPacks.ts";
import { readStackPacks } from "../src/core/experts/stackPacks.ts";
import { readOverlayTemplate, readPackBody, templatesHash } from "../src/core/experts/packTemplates.ts";
import { OVERLAYS_DIRNAME } from "../src/core/experts/packSections.ts";
import { splitFrontMatter } from "../src/core/experts/expertDocument.ts";
import { parseList } from "../src/core/experts/expertDomain.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { greenfieldFixture, multiRepoFixture, singleRepoFixture, type Fixture } from "./init-fixture.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// The fixtures `git init` and detection runs `git`; the budget scales with measured load (#43).
setDefaultTimeout(spawnTestTimeout());

const runner = new SpawnCommandRunner();
const NOW = new Date("2026-09-05T10:00:00Z");
const AT = rfc3339(NOW);

function options(root: string): InitOptions {
  return { root, out: root, interview: false, methodology: null, mcp: false, stack: [], provider: "static" };
}
async function init(root: string): Promise<void> {
  await runInit(options(root), { runner, cliVersion: "0.0.1", now: NOW });
}
function yaml(path: string): Record<string, unknown> {
  return parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
}
function expertPath(root: string, name: string): string {
  return join(root, ".tldrx", "experts", name, "expert.md");
}
function overlayPath(root: string, name: string, id: string): string {
  return join(root, ".tldrx", "experts", name, OVERLAYS_DIRNAME, `${id}.md`);
}

describe("single repo: enable → status → disable", () => {
  let fixture: Fixture;
  beforeAll(async () => { fixture = await singleRepoFixture(); await init(fixture.root); });
  afterAll(async () => { await fixture.cleanup(); });

  test("the seeded stack body IS what stubBodyFor derives — one derivation, via renderExpert", () => {
    const text = readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8");
    const { frontMatter, body } = splitFrontMatter(text);
    expect(body).toBe(stubBodyFor("typescript-stack", parseList(frontMatter.get("repos") ?? "")));
    expect(bodyState(text, "typescript")).toEqual({ kind: "stub" });
  });

  test("status before enable: disabled, overlays detected, body stub", async () => {
    const outcome = await stackPacksStatus({ workspaceDir: fixture.root });
    expect(outcome.ok).toBe(true);
    const text = outcome.lines.join("\n");
    expect(text).toContain("stack packs: disabled");
    expect(text).toContain("react (package.json: dependencies.react)");
    expect(text).toContain("typescript-stack: body stub, overlays: none");
  });

  test("enable applies the pack body to the untouched stub, writes overlays, records the switch", async () => {
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.ok).toBe(true);
    const text = outcome.lines.join("\n");
    const hash = templatesHash();
    expect(text).toContain(`stack packs: enabled (${AT})`);
    expect(text).toContain(`typescript-stack: pack applied (pack@${hash})`);
    expect(text).toContain("typescript-stack: overlays written: react, vite-react-spa");

    const expert = readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8");
    const { frontMatter, body } = splitFrontMatter(expert);
    expect(frontMatter.get("name")).toBe("typescript-stack");
    expect(frontMatter.get("kind")).toBe("stack");
    expect(frontMatter.get("pack")).toBe(`typescript@${hash}`);
    expect(body).toBe(`\n${readPackBody("typescript") ?? "MISSING"}`);

    expect(readFileSync(overlayPath(fixture.root, "typescript-stack", "react"), "utf8")).toBe(readOverlayTemplate("react") ?? "MISSING");
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "vite-react-spa"))).toBe(true);

    const doc = yaml(join(fixture.root, ".tldrx", "workspace.yml"));
    expect(doc.stack_packs).toEqual({ enabled: true, enabled_at: AT });
    const repos = doc.repos as Record<string, unknown>[];
    expect(repos[0]?.overlays).toEqual([
      { id: "react", evidence: "package.json: dependencies.react" },
      { id: "vite-react-spa", evidence: "package.json: devDependencies.vite + dependencies.react" },
    ]);
    expect(readStackPacks(fixture.root).enabled).toBe(true);
  });

  test("a second enable is idempotent on the body and REWRITES the overlays folder", async () => {
    rmSync(overlayPath(fixture.root, "typescript-stack", "react"));
    writeFileSync(overlayPath(fixture.root, "typescript-stack", "stale"), "# stale\n", "utf8");
    const before = readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8");
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.lines.join("\n")).toContain(`typescript-stack: pack already at pack@${templatesHash()}`);
    expect(readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8")).toBe(before);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "react"))).toBe(true);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "stale"))).toBe(false);
  });

  test("an edited body is KEPT and said so; an emptied body is re-seeded", async () => {
    const path = expertPath(fixture.root, "typescript-stack");
    const edited = `${readFileSync(path, "utf8")}\n- our own rule\n`;
    writeFileSync(path, edited, "utf8");
    const kept = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(kept.lines).toContain("  kept: typescript-stack body was edited — pack body not applied (delete the body to re-seed)");
    expect(readFileSync(path, "utf8")).toBe(edited);
    const status = await stackPacksStatus({ workspaceDir: fixture.root });
    expect(status.lines.join("\n")).toContain(`typescript-stack: body edited (was pack@${templatesHash()})`);

    const { body } = splitFrontMatter(edited);
    writeFileSync(path, edited.slice(0, edited.length - body.length), "utf8");
    const reseeded = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(reseeded.lines.join("\n")).toContain("typescript-stack: pack applied");
    expect(splitFrontMatter(readFileSync(path, "utf8")).body).toBe(`\n${readPackBody("typescript") ?? "MISSING"}`);
  });

  test("disable removes overlays only and clears the switch", async () => {
    const competencies = join(fixture.root, ".tldrx", "experts", "typescript-stack", "competencies.yml");
    const competenciesBefore = readFileSync(competencies, "utf8");
    const bodyBefore = readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8");
    const outcome = await disableStackPacks({ workspaceDir: fixture.root });
    expect(outcome.ok).toBe(true);
    expect(outcome.lines.join("\n")).toContain("bodies and knowledge/ untouched");
    expect(existsSync(join(fixture.root, ".tldrx", "experts", "typescript-stack", OVERLAYS_DIRNAME))).toBe(false);
    expect(readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8")).toBe(bodyBefore);
    expect(readFileSync(competencies, "utf8")).toBe(competenciesBefore);
    expect(yaml(join(fixture.root, ".tldrx", "workspace.yml")).stack_packs).toEqual({ enabled: false, enabled_at: null });
  });

  test("re-init with the switch on re-materialises the overlays and keeps the switch", async () => {
    await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    rmSync(join(fixture.root, ".tldrx", "experts", "typescript-stack", OVERLAYS_DIRNAME), { recursive: true, force: true });
    await init(fixture.root);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "react"))).toBe(true);
    expect(yaml(join(fixture.root, ".tldrx", "workspace.yml")).stack_packs).toEqual({ enabled: true, enabled_at: AT });
  });
});

describe("multi-repo: overlays land under the language expert they belong to", () => {
  let fixture: Fixture;
  beforeAll(async () => { fixture = await multiRepoFixture(); await init(fixture.root); });
  afterAll(async () => { await fixture.cleanup(); });

  test("a .NET overlay goes under dotnet-stack, never under typescript-stack", async () => {
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.ok).toBe(true);
    expect(outcome.lines.join("\n")).toContain("dotnet-stack: pack applied");
    expect(existsSync(overlayPath(fixture.root, "dotnet-stack", "aspnet-minimal-apis"))).toBe(true);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "react"))).toBe(true);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "aspnet-minimal-apis"))).toBe(false);
    expect(existsSync(overlayPath(fixture.root, "dotnet-stack", "react"))).toBe(false);
  });
});

describe("greenfield: nothing to enable", () => {
  let fixture: Fixture;
  beforeAll(async () => { fixture = await greenfieldFixture(); await init(fixture.root); });
  afterAll(async () => { await fixture.cleanup(); });

  test("enable refuses (usage family) and leaves workspace.yml without a switch", async () => {
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("no detectable language");
    expect(yaml(join(fixture.root, ".tldrx", "workspace.yml")).stack_packs).toBeUndefined();
  });

  test("enable on a directory with no workspace.yml names `tldrx init`", async () => {
    const empty = join(fixture.root, "elsewhere");
    mkdirSync(empty, { recursive: true });
    await expect(enableStackPacks({ workspaceDir: empty, runner, now: AT })).rejects.toThrow("run `tldrx init` first");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/stack-packs.test.ts; echo "exit=$?"` — Expected FAIL, `Cannot find module '../src/core/init/stackPacks.ts'`; `exit=1`. Keep the output.

- [ ] **Step 3: Create `src/core/init/stackPacks.ts`**

```ts
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
import type { DetectedWorkspace } from "../detect/types.ts";
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
  const noPack = [...new Set(input.workspace.repos.flatMap((repo) => repo.languages))]
    .filter((lang) => !isPackLanguage(lang));
  if (noPack.length > 0) lines.push(`no pack ships for ${noPack.join(", ")}`);
  return { lines, applied, overlays, kept };
}

/** Empty every `<lang>-stack/overlays/`, then write what detection proved. Returns the count written. */
async function materialiseOverlays(input: ApplyInput, lines: string[]): Promise<number> {
  const targets = new Map<string, Map<string, string>>();
  for (const repo of input.workspace.repos) {
    const langs = repo.languages.filter(isPackLanguage);
    for (const overlay of repo.overlays) {
      const rule = overlayRule(overlay.id);
      const template = readOverlayTemplate(overlay.id);
      if (rule === undefined || template === null) continue;
      for (const lang of langs) {
        if (!rule.languages.includes(lang)) continue;
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
  return written;
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
  const state = readStackPacks(input.workspaceDir);
  const lines: string[] = [
    state.enabled ? `stack packs: enabled (since ${state.enabledAt ?? "unknown"})` : "stack packs: disabled",
    ...describeRepos(state.repos),
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
```

- [ ] **Step 4: Re-apply on re-init when the switch is on**

In `src/core/init/runInit.ts`, import `applyStackPacks` and `readStackPacks`, then after `seeding.done(...)` (line 153) insert:

```ts
  // The switch was carried into the file just written; with it on, the overlays are
  // framework-managed and must be regenerated like every other detection output, and a
  // language that appeared since the last init gets its pack body on its fresh stub.
  if (readStackPacks(out).enabled) {
    const packing = steps.begin("applying stack packs");
    const report = await applyStackPacks({ workspaceDir: out, workspace, log });
    packing.done(`${plural(report.applied, "pack body")} applied, ${plural(report.overlays, "overlay")} written`);
  }
```

Export from `src/core/init/index.ts`:

```ts
export {
  applyStackPacks, bodyState, describeRepos, disableStackPacks, enableStackPacks, packBodyText,
  patchWorkspaceDocument, stackPacksStatus, stubBodyFor,
  type ApplyReport, type BodyState, type PacksOutcome,
} from "./stackPacks.ts";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/stack-packs.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`.

- [ ] **Step 6: Full gates and commit**

Run each on its own line: `bun run typecheck; echo "exit=$?"` · `bun test; echo "exit=$?"` · `bun run build; echo "exit=$?"`. Expected `exit=0` each.

```bash
git add src/core/init/stackPacks.ts src/core/init/runInit.ts src/core/init/index.ts test/stack-packs.test.ts
git commit -m "feat(init): materialise stack packs — body replaces a stub only, overlays are framework-managed, disable removes overlays alone

The stub is recognised by calling the seeder, not by a second copy of its text; an edited body is kept and said so.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 8: Prompt path — the bundle composes `body + overlays` when the switch is on

**Files:**
- Modify: `src/core/experts/expertBundle.ts:30-50,100-147,165-193`
- Test: `test/stack-packs-prompt.test.ts`

**Interfaces:**
- Consumes: `readStackPacks`, `composePackBody`, `readOverlayFiles`, `splitFrontMatter`, `expertDir`.
- Produces: `ExpertBundle.overlays: readonly string[]` (ids inlined); `loadExpertBundles` returns a composed `body` for `kind: stack` experts when enabled; `describeBundles` names the overlays.

- [ ] **Step 1: Write the failing test**

Create `test/stack-packs-prompt.test.ts`:

```ts
/**
 * The prompt path (stack packs design §4.5). Because every renderer prints an expert's
 * `body`, composing `body + overlays` inside `loadExpertBundles` is the one change that
 * reaches stage prompts and the Build developer. With the switch off, bytes are today's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBundles, loadExpertBundles } from "../src/core/experts/expertBundle.ts";
import { CHECKS_HEADING, DEFAULTS_HEADING, overlayMarker, OVERLAYS_DIRNAME } from "../src/core/experts/packSections.ts";
import { renderParts, buildPrompt } from "../src/core/facilitator/prompt.ts";
import { buildDeveloperPrompt } from "../src/core/build/prompts.ts";
import type { PlannedEpic, PlannedStory } from "../src/core/build/plan.ts";

let roots: string[] = [];
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

export interface PackRootOptions {
  readonly enabled: boolean | null;
  readonly overlays?: readonly string[];
  readonly skills?: readonly { name: string; description: string; tracked: boolean }[];
}

/** A workspace with one `lab` repo, one `typescript-stack` expert, and whatever the test asks for. */
export function packRoot(options: PackRootOptions): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-packs-prompt-"));
  roots.push(root);
  const expert = join(root, ".tldrx", "experts", "typescript-stack");
  mkdirSync(join(root, ".tldrx", "conventions"), { recursive: true });
  mkdirSync(expert, { recursive: true });
  const skills = (options.skills ?? []).map((skill) =>
    `      - {name: ${skill.name}, description: "${skill.description}", path: .claude/skills/${skill.name}/SKILL.md, tracked: ${String(skill.tracked)}}`);
  writeFileSync(join(root, ".tldrx", "workspace.yml"), [
    "version: 1", "mode: single-repo", "root_is_repo: true", "root: .", "repos:",
    "  - name: lab", "    path: .", "    default_branch: main", "    stack: [typescript]",
    "    package_manager: npm", "    commands: {build: null, test: null, lint: null, typecheck: null, run: null}",
    "    ci: []",
    `    overlays: [${(options.overlays ?? []).map((id) => `{id: ${id}, evidence: "package.json: dependencies.${id}"}`).join(", ")}]`,
    skills.length === 0 ? "    skills: []" : `    skills:\n${skills.join("\n")}`,
    "    confidence: high",
    ...(options.enabled === null ? [] : ["stack_packs:", `  enabled: ${String(options.enabled)}`, "  enabled_at: 2026-09-05T10:00:00Z"]),
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(expert, "expert.md"), [
    "---", "name: typescript-stack", "kind: stack", "status: created", "repos: [lab]", "---", "",
    "# TypeScript", "", "Scope.", "", `## ${DEFAULTS_HEADING}`, "", "- Strict on. — overridden by: tsconfig.json", "",
    `## ${CHECKS_HEADING}`, "", "- Any new `any`? verify: grep `: any`", "",
  ].join("\n"), "utf8");
  writeFileSync(join(expert, "competencies.yml"), "version: 1\nexpert: typescript-stack\nstatus: created\nareas: []\n", "utf8");
  for (const id of options.overlays ?? []) {
    mkdirSync(join(expert, OVERLAYS_DIRNAME), { recursive: true });
    writeFileSync(join(expert, OVERLAYS_DIRNAME, `${id}.md`), [
      `# ${id}`, "", "Scope.", "", `## ${DEFAULTS_HEADING}`, "", `- ${id} default — overridden by: x`, "",
      `## ${CHECKS_HEADING}`, "", `- ${id} check? verify: y`, "",
    ].join("\n"), "utf8");
  }
  return root;
}

function bundlesOf(root: string) {
  return loadExpertBundles({ root, staged: [], repos: ["lab"], stackExperts: true, stackNames: ["typescript-stack"] });
}

const EPIC: PlannedEpic = {
  epic: { version: 1, id: "E1", title: "Tenancy", repos: ["lab"], stories: ["S5"], branch: "epic/tenancy", status: "todo" },
  text: "# E1\n", path: "/nowhere/E1.md", rel: "03-plan/epics/E1.md",
};
const STORY: PlannedStory = {
  story: {
    version: 1, id: "S5", epic: "E1", title: "OTP confirm", repo: "lab", status: "todo", depends_on: [], touches: [],
    acceptance: ["it confirms"], test_plan: ["$ npm test -> exit 0"], evidence: [],
  },
  dod: { present: true, commands: ["npm test"] },
  text: "# S5\n", path: "/nowhere/S5.md", rel: "03-plan/stories/S5.md", wave: "W1", goal: [],
};

export function devPrompt(experts: readonly { name: string; body: string }[], extra: Record<string, unknown> = {}): string {
  return buildDeveloperPrompt({
    runId: "260905-x", story: STORY, epic: EPIC, repoName: "lab", branch: "story/x/S5", epicBranch: "epic/tenancy",
    worktree: "/nowhere", commands: ["npm test"], conventions: "_none_", facts: "_none_", experts, budgetUsd: 4, ...extra,
  });
}

describe("loadExpertBundles with the switch on", () => {
  test("a stack expert's body carries its overlays, sorted, under markers", () => {
    const root = packRoot({ enabled: true, overlays: ["react", "prisma"] });
    const set = bundlesOf(root);
    const body = set.experts[0]?.body ?? "";
    expect(set.experts[0]?.overlays).toEqual(["prisma", "react"]);
    expect(body.indexOf(overlayMarker("prisma"))).toBeGreaterThan(body.indexOf(`## ${CHECKS_HEADING}`));
    expect(body.indexOf(overlayMarker("prisma"))).toBeLessThan(body.indexOf(overlayMarker("react")));
    expect(body).toContain("- react check? verify: y");
    expect(describeBundles(set).join("\n")).toContain("overlays: prisma, react");
  });

  test("the stage prompt and the developer prompt both contain the overlay — no renderer changed", () => {
    const root = packRoot({ enabled: true, overlays: ["react"] });
    const experts = bundlesOf(root).experts;
    const stage = buildPrompt({
      stageMd: "# stage\n\n## Inputs\n\n(x)\n", values: { run: "r", repos: "lab", inputs: "-", facts: "-", conventions: "-", budget_usd: "1.00" },
      experts, inputs: [],
    });
    expect(stage).toContain(overlayMarker("react"));
    expect(renderParts({ stageMd: "# s\n", values: { run: "r", repos: "lab", inputs: "-", facts: "-", conventions: "-", budget_usd: "1.00" }, experts, inputs: [] })
      .find((part) => part.kind === "expert-body")?.text).toContain(overlayMarker("react"));
    expect(devPrompt(experts)).toContain(overlayMarker("react"));
  });
});

describe("loadExpertBundles with the switch off or absent", () => {
  test("overlay files on disk are NOT inlined — bodies render as today", () => {
    for (const enabled of [false, null]) {
      const root = packRoot({ enabled, overlays: ["react"] });
      const set = bundlesOf(root);
      expect(set.experts[0]?.body).not.toContain(overlayMarker("react"));
      expect(set.experts[0]?.overlays).toEqual([]);
      expect(describeBundles(set).join("\n")).not.toContain("overlays:");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/stack-packs-prompt.test.ts; echo "exit=$?"` — Expected FAIL: `set.experts[0]?.overlays` is `undefined`, body lacks the marker; `exit=1`. Keep the output. (If `PlannedEpic`/`PlannedStory` fields differ from the literals above, `bun run typecheck` names the field; correct the literal against `src/core/build/plan.ts` — the shape is copied from `test/dispatch-notes.test.ts:260-285`.)

- [ ] **Step 3: Compose in `loadExpertBundles`**

In `src/core/experts/expertBundle.ts` add imports:

```ts
import { splitFrontMatter } from "./expertDocument.ts";
import { composePackBody, readOverlayFiles } from "./packSections.ts";
import { readStackPacks } from "./stackPacks.ts";
```

Add to `ExpertBundle` after `bodyBytes`:

```ts
  /** Overlay ids inlined into `body` (stack packs, switch on and `kind: stack` only). Empty otherwise. */
  readonly overlays: readonly string[];
```

In `loadExpertBundles`, read the switch once before the loop and compose per stack expert:

```ts
  // Read once: the switch is one fact about the workspace, not one per expert.
  const packs = readStackPacks(input.root);
  …
    const raw = readFileSync(path, "utf8");
    // Packs live inside the stack expert (design decision 5): with the switch on, a
    // `kind: stack` body carries its overlays, and every renderer that prints `body`
    // — stage prompts, the developer — gets them without a change of its own.
    const composed = packs.enabled && splitFrontMatter(raw).frontMatter.get("kind") === "stack"
      ? composePackBody(raw, readOverlayFiles(expertDir(input.root, chosen.name)))
      : null;
    const body = composed === null ? raw : composed.text;
```

and in the pushed record add `overlays: composed === null ? [] : composed.inlined,`.

In `describeBundles`, extend the per-expert line:

```ts
      + ` — expert.md ${bytes(expert.bodyBytes)}${expert.overlays.length === 0 ? "" : ` (overlays: ${expert.overlays.join(", ")})`}, ${files}${expert.truncated ? ", truncated" : ""}`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/stack-packs-prompt.test.ts test/expert-knowledge.test.ts test/dispatch-notes.test.ts test/token-economy.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck; echo "exit=$?"` — Expected `exit=0`.

```bash
git add src/core/experts/expertBundle.ts test/stack-packs-prompt.test.ts
git commit -m "feat(experts): a stack expert's bundle body carries its overlays when the packs are on

One composition inside loadExpertBundles reaches every renderer that prints body; the switch off renders today's bytes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 9: The reviewer gets `## Stack checks`

**Files:**
- Modify: `src/core/experts/packSections.ts` (add `stackChecks`), `src/core/experts/index.ts`
- Modify: `src/core/build/prompts.ts:243-290,366-410` (`ReviewerPromptParts.stackChecks`, the section)
- Modify: `src/core/facilitator/executors/build.ts:2306-2325` (`reviewerPrompt` passes it)
- Modify: `test/fixtures/build/workspace.ts:46-93,285-308` (fixture options `stackPacks`, `overlays`, `skills`)
- Test: `test/stack-packs-prompt.test.ts` (append), `test/build-executor.test.ts` (append)

**Interfaces:**
- Consumes: `stackExpertNames`, `expertDir`, `EXPERT_FILE`, `readStackPacks`, `checksOf`, `readOverlayFiles`, `splitFrontMatter`.
- Produces: `stackChecks(root, repos): string | null`; `STACK_CHECKS_HEADING = "Stack checks (the repo's own conventions win)"`; `ReviewerPromptParts.stackChecks?: string | null`; fixture options `BuildWorkspaceOptions.stackPacks?: boolean`, `.overlays?: readonly DetectedOverlay[]`, `.skills?: readonly DetectedSkill[]` (skills used in Task 10).

- [ ] **Step 1: Write the failing tests**

Append to `test/stack-packs-prompt.test.ts` (add `buildReviewerPrompt, STACK_CHECKS_HEADING` to the `build/prompts.ts` import and `stackChecks` to a new import from `../src/core/experts/packSections.ts`):

```ts
function reviewPrompt(checks: string | null | undefined): string {
  return buildReviewerPrompt({
    runId: "260905-x", story: STORY, repoName: "lab", branch: "story/x/S5", epicBranch: "epic/tenancy",
    worktree: "/nowhere", conventions: "_none_", dodResults: [], stackChecks: checks,
  });
}

describe("the reviewer's stack checks", () => {
  test("stackChecks collects the Checks of the body and of each overlay — enabled only, Defaults never", () => {
    const on = packRoot({ enabled: true, overlays: ["react"] });
    const text = stackChecks(on, ["lab"]) ?? "";
    expect(text).toContain("### typescript-stack\n\n- Any new `any`? verify: grep `: any`");
    expect(text).toContain("### typescript-stack · overlay react\n\n- react check? verify: y");
    expect(text).not.toContain(DEFAULTS_HEADING);
    expect(stackChecks(packRoot({ enabled: false, overlays: ["react"] }), ["lab"])).toBeNull();
    expect(stackChecks(packRoot({ enabled: true }), ["other-repo"])).toBeNull();
  });

  test("the reviewer prompt carries the section only when given checks, between Conventions and The story", () => {
    expect(reviewPrompt(null)).toBe(reviewPrompt(undefined));
    expect(reviewPrompt(null)).not.toContain(STACK_CHECKS_HEADING);
    const text = reviewPrompt("### typescript-stack\n\n- Any new `any`? verify: grep");
    expect(text.split(`## ${STACK_CHECKS_HEADING}`).length - 1).toBe(1);
    expect(text.indexOf("## Conventions")).toBeLessThan(text.indexOf(`## ${STACK_CHECKS_HEADING}`));
    expect(text.indexOf(`## ${STACK_CHECKS_HEADING}`)).toBeLessThan(text.indexOf("## The story"));
    expect(text).toContain("the project's own convention");
  });
});
```

Append to `test/build-executor.test.ts`, at the end of the file (it already imports `readFileSync`, `join`, `workspace`, `next`):

```ts
describe("stack packs reach the Build reviewer (stack packs design §4.5)", () => {
  const STACK_EXPERT: Readonly<Record<string, string>> = {
    ".tldrx/experts/typescript-stack/expert.md": [
      "---", "name: typescript-stack", "kind: stack", "status: created", "repos: [app]", "---", "",
      "# TypeScript", "", "Scope.", "", "## Defaults (when the repo is silent)", "", "- d — overridden by: x", "",
      "## Checks (always asked in review)", "", "- Any new `any`? verify: grep `: any`", "",
    ].join("\n"),
    ".tldrx/experts/typescript-stack/competencies.yml": "version: 1\nexpert: typescript-stack\nstatus: created\nareas: []\n",
    ".tldrx/experts/typescript-stack/overlays/react.md":
      "# react\n\nScope.\n\n## Defaults (when the repo is silent)\n\n- d — overridden by: x\n\n## Checks (always asked in review)\n\n- Index keys? verify: grep key=\n",
  };
  const ONE: BuildWorkspaceOptions = {
    stories: [{ id: "S1", epic: "E1", title: "First story" }],
    epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
    waves: [["S1"]],
    files: STACK_EXPERT,
  };

  test("switch on: the reviewer prompt carries `## Stack checks` with the overlay's checks; the developer carries the overlay", async () => {
    const ws = workspace({ ...ONE, stackPacks: true, overlays: [{ id: "react", evidence: "package.json: dependencies.react" }] });
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    await next(ws);
    const reviewer = readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8");
    expect(reviewer).toContain("## Stack checks (the repo's own conventions win)");
    expect(reviewer).toContain("- Index keys? verify: grep key=");
    expect(readFileSync(join(promptDir, "developer-S1-1.md"), "utf8")).toContain("<!-- overlay: react -->");
  });

  test("switch off: neither prompt mentions the overlay or the checks section", async () => {
    const ws = workspace({ ...ONE, overlays: [{ id: "react", evidence: "package.json: dependencies.react" }] });
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    await next(ws);
    expect(readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8")).not.toContain("## Stack checks");
    expect(readFileSync(join(promptDir, "developer-S1-1.md"), "utf8")).not.toContain("<!-- overlay: react -->");
  });
});
```

(`BuildWorkspaceOptions` is already imported there as a type; if not, add it to the `./fixtures/build/workspace.ts` import.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/stack-packs-prompt.test.ts; echo "exit=$?"` — Expected FAIL: `stackChecks` is not exported / `STACK_CHECKS_HEADING` undefined; `exit=1`. Keep the output.

Run: `bun run typecheck; echo "exit=$?"` — Expected non-zero: `stackPacks`/`overlays` are not in `BuildWorkspaceOptions`. Keep it.

- [ ] **Step 3: Grow the build fixture**

In `test/fixtures/build/workspace.ts`, add to `BuildWorkspaceOptions`:

```ts
  /** `stack_packs: {enabled: true}` in workspace.yml — the packs switch (stack packs design §4.3). */
  readonly stackPacks?: boolean;
  /** `repos[].overlays` as detection would have written them. */
  readonly overlays?: readonly { readonly id: string; readonly evidence: string }[];
  /** `repos[].skills` as detection would have written them. */
  readonly skills?: readonly { readonly name: string; readonly description: string; readonly path: string; readonly tracked: boolean }[];
```

Change the `workspaceYaml` call (line 125) to pass the three, and the function to render them:

```ts
  write(root, ".tldrx/workspace.yml", workspaceYaml(repoName, options.commands, rootIsRepo, {
    stackPacks: options.stackPacks ?? false, overlays: options.overlays ?? [], skills: options.skills ?? [],
  }));
```

```ts
function workspaceYaml(
  repo: string,
  commands?: Readonly<Record<string, string | null>>,
  rootIsRepo = false,
  packs: {
    readonly stackPacks: boolean;
    readonly overlays: readonly { readonly id: string; readonly evidence: string }[];
    readonly skills: readonly { readonly name: string; readonly description: string; readonly path: string; readonly tracked: boolean }[];
  } = { stackPacks: false, overlays: [], skills: [] },
): string {
  const declared = commands ?? { build: null, test: "npm run test", lint: null, typecheck: null, run: null };
  const rendered = Object.entries(declared)
    .map(([key, value]) => `${key}: ${value === null ? "null" : JSON.stringify(value)}`)
    .join(", ");
  const overlays = packs.overlays.map((o) => `      - {id: ${o.id}, evidence: ${JSON.stringify(o.evidence)}}`);
  const skills = packs.skills.map((s) =>
    `      - {name: ${s.name}, description: ${JSON.stringify(s.description)}, path: ${s.path}, tracked: ${String(s.tracked)}}`);
  return `version: 1
mode: single-repo
root_is_repo: ${String(rootIsRepo)}
detected_at: 2026-08-29T09:00:00Z
detected_by: "tldrx test"
repos:
  - name: ${repo}
    path: ${rootIsRepo ? "." : repo}
    default_branch: main
    stack: [typescript]
    package_manager: npm
    commands: {${rendered}}
    ci: []
${overlays.length === 0 ? "    overlays: []" : `    overlays:\n${overlays.join("\n")}`}
${skills.length === 0 ? "    skills: []" : `    skills:\n${skills.join("\n")}`}
    confidence: high
${packs.stackPacks ? "stack_packs:\n  enabled: true\n  enabled_at: 2026-09-05T10:00:00Z\n" : ""}`;
}
```

- [ ] **Step 4: Implement `stackChecks`, the section, and the wiring**

Append to `src/core/experts/packSections.ts` (add imports `stackExpertNames` from `./stackExperts.ts`, `expertDir`, `EXPERT_FILE` from `./loadExperts.ts`, `readStackPacks` from `./stackPacks.ts`):

```ts
/**
 * The `## Checks` of every active pack for `repos` — body first, then each overlay —
 * or null when the switch is off or nothing has checks. This ONE helper feeds the
 * reviewer prompt and `tldrx expert packs status`; it never returns Defaults.
 */
export function stackChecks(root: string, repos: readonly string[]): string | null {
  if (!readStackPacks(root).enabled) return null;
  const chunks: string[] = [];
  for (const name of stackExpertNames(root, repos)) {
    const path = join(expertDir(root, name), EXPERT_FILE);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (splitFrontMatter(text).frontMatter.get("kind") !== "stack") continue;
    const own = checksOf(text);
    if (own !== "") chunks.push(`### ${name}\n\n${own}`);
    for (const overlay of readOverlayFiles(expertDir(root, name))) {
      const checks = checksOf(overlay.text);
      if (checks !== "") chunks.push(`### ${name} · overlay ${overlay.id}\n\n${checks}`);
    }
  }
  return chunks.length === 0 ? null : chunks.join("\n\n");
}
```

Add `stackChecks` to the `packSections.ts` export line in `src/core/experts/index.ts`.

In `src/core/build/prompts.ts`, add to `ReviewerPromptParts`:

```ts
  /**
   * The active stack packs' `## Checks`, rendered by `experts/packSections.ts stackChecks`
   * (stack packs design §4.5). Null or absent renders NOTHING: the reviewer prompt had
   * no expert content before this existed and a switched-off workspace keeps those bytes.
   */
  readonly stackChecks?: string | null;
```

Export the heading and the section renderer:

```ts
export const STACK_CHECKS_HEADING = "Stack checks (the repo's own conventions win)";

/** `## Stack checks …`, or nothing at all — measured conventions outrank pack content, and the prompt says so. */
function stackChecksSection(body: string | null | undefined): readonly string[] {
  const text = (body ?? "").trim();
  if (text === "") return [];
  return [
    `## ${STACK_CHECKS_HEADING}`,
    "",
    "Ask each of these of the diff. A miss is a finding with a cited file. Where the project",
    "already has a convention on the topic — in the conventions above, or in the code the diff",
    "sits in — the project's own convention is the accepted answer, not the pack's.",
    "",
    text,
    "",
  ];
}
```

In `buildReviewerPrompt`, after the lines

```ts
    "## Conventions",
    "",
    parts.conventions,
    "",
```

insert `...stackChecksSection(parts.stackChecks),`.

In `src/core/facilitator/executors/build.ts`, import `stackChecks` from `"../../experts/packSections.ts"` and add to the `buildReviewerPrompt({...})` call inside `reviewerPrompt`:

```ts
      // The active packs' checks for this story's repo (stack packs design §4.5): the
      // same helper `expert packs status` prints, so the reviewer and the operator read
      // one list. Null when the switch is off, which renders nothing.
      stackChecks: stackChecks(this.ctx.root, [story.planned.story.repo]),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/stack-packs-prompt.test.ts test/build-executor.test.ts test/review-handshake.test.ts test/reviewer-envelope-authority.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck; echo "exit=$?"` — Expected `exit=0`.

```bash
git add src/core/experts/packSections.ts src/core/experts/index.ts src/core/build/prompts.ts src/core/facilitator/executors/build.ts test/fixtures/build/workspace.ts test/stack-packs-prompt.test.ts test/build-executor.test.ts
git commit -m "feat(build): the reviewer is handed the active packs' Checks under one heading that says the repo's own conventions win

The reviewer prompt had no expert content at all; this is the explicit addition the design calls for, off ⇒ byte-identical.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 10: `## Project skills` — named to the developer, `Skill` allowed, untracked warned

**Files:**
- Modify: `src/core/experts/stackPacks.ts` (add `PROJECT_SKILLS_HEADING`, `skillsFor`, `untrackedSkillWarnings`, `renderProjectSkills`), `src/core/experts/index.ts`
- Modify: `src/core/facilitator/prompt.ts:83-200` (`PromptParts.projectSkills`, `renderParts`, `PromptPartKind`), `src/core/facilitator/index.ts`
- Modify: `src/core/facilitator/contextLedger.ts:52-62,95-151,186-192,247-256`
- Modify: `src/core/build/prompts.ts:52-102,156-161,238-241` (`DeveloperPromptParts.projectSkills`)
- Modify: `src/core/facilitator/runNext.ts:1669-1700` (`assemblePrompt`), `src/core/facilitator/executors/build.ts:297-303,1949-1956,3125-3160,3782-3790`
- Test: `test/stack-packs-prompt.test.ts` (append), `test/dispatch-notes.test.ts` (one ledger assertion), `test/build-executor.test.ts` (append)

**Interfaces:**
- Consumes: `readStackPacks`, `StackPacksState`, `DetectedSkill`.
- Produces: `PROJECT_SKILLS_HEADING = "Project skills"`, `skillsFor(state, repos): readonly DetectedSkill[]` (deduped by path, sorted by name), `renderProjectSkills(skills): string` (`""` when none), `untrackedSkillWarnings(skills): readonly string[]`; `PromptParts.projectSkills?: string`; `PromptPartKind` gains `"project-skills"`; `LedgerGroups.projectSkills`; `DeveloperPromptParts.projectSkills?: string`; `developerTools(repoCommands, options?: {skills?: boolean})`.

- [ ] **Step 1: Write the failing tests**

Append to `test/stack-packs-prompt.test.ts` (add imports: `renderProjectSkills, skillsFor, untrackedSkillWarnings, PROJECT_SKILLS_HEADING, readStackPacks` from `../src/core/experts/stackPacks.ts`; `buildLedger` from `../src/core/facilitator/contextLedger.ts`; `developerTools` from `../src/core/facilitator/executors/build.ts`; `BASE_TOOLS` from `../src/core/facilitator/spawnAgent.ts`):

```ts
describe("project skills are named, never loaded (design decision 6)", () => {
  test("renderProjectSkills lists name — description, flags untracked, and is empty for none", () => {
    const skills = skillsFor(readStackPacks(packRoot({
      enabled: null,
      skills: [{ name: "zeta", description: "Last", tracked: true }, { name: "alpha", description: "First", tracked: false }],
    })), ["lab"]);
    expect(skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    const text = renderProjectSkills(skills);
    expect(text).toContain("- alpha — First (untracked: not present in story worktrees)");
    expect(text).toContain("- zeta — Last");
    expect(text).toContain("Skill tool");
    expect(renderProjectSkills([])).toBe("");
    expect(untrackedSkillWarnings(skills)).toEqual([
      "warning: project skill alpha is untracked (.claude/skills/alpha/SKILL.md) — not present in story worktrees",
    ]);
    // Independent of the switch: off, on, absent all name the skills.
    expect(skillsFor(readStackPacks(packRoot({ enabled: false, skills: [{ name: "a", description: "d", tracked: true }] })), ["lab"])).toHaveLength(1);
  });

  test("the stage prompt renders `## Project skills` after Dispatch notes, and the ledger counts it", () => {
    const values = { run: "r", repos: "lab", inputs: "-", facts: "-", conventions: "-", budget_usd: "1.00" };
    const parts = renderParts({
      stageMd: "# s\n\n## Inputs\n\n(x)\n", values, experts: [], inputs: [],
      dispatchNotes: "Docker is up.", projectSkills: renderProjectSkills([{ name: "alpha", description: "First", path: "p", tracked: true }]),
    });
    const kinds = parts.map((part) => part.kind);
    expect(kinds.indexOf("project-skills")).toBe(kinds.indexOf("dispatch-notes") + 1);
    const text = buildPrompt({ stageMd: "# s\n", values, experts: [], inputs: [], projectSkills: renderProjectSkills([{ name: "alpha", description: "First", path: "p", tracked: true }]) });
    expect(text.split(`## ${PROJECT_SKILLS_HEADING}`).length - 1).toBe(1);
    expect(buildPrompt({ stageMd: "# s\n", values, experts: [], inputs: [], projectSkills: "" }))
      .toBe(buildPrompt({ stageMd: "# s\n", values, experts: [], inputs: [] }));
    const ledger = buildLedger({ parts, inputBytes: [], truncatedInputs: [], limitBytes: 160_000, model: null });
    expect(ledger.groups.projectSkills).toBeGreaterThan(0);
    expect(ledger.totalBytes).toBe(parts.reduce((sum, part) => sum + Buffer.byteLength(part.text, "utf8"), 0));
  });

  test("the developer prompt renders the section after Dispatch notes and before Investigate; absent ⇒ identical", () => {
    const skills = renderProjectSkills([{ name: "alpha", description: "First", path: "p", tracked: true }]);
    const text = devPrompt([], { dispatchNotes: "Docker is up.", projectSkills: skills });
    expect(text.indexOf("## Dispatch notes")).toBeLessThan(text.indexOf(`## ${PROJECT_SKILLS_HEADING}`));
    expect(text.indexOf(`## ${PROJECT_SKILLS_HEADING}`)).toBeLessThan(text.indexOf("## Investigate"));
    expect(devPrompt([], { projectSkills: "" })).toBe(devPrompt([]));
  });

  test("developerTools adds `Skill` only when asked", () => {
    expect(developerTools(["npm test"])).not.toContain("Skill");
    expect(developerTools(["npm test"], { skills: false })).toEqual(developerTools(["npm test"]));
    const withSkill = developerTools(["npm test"], { skills: true });
    expect(withSkill).toContain("Skill");
    expect(withSkill.filter((tool) => !BASE_TOOLS.includes(tool) && tool !== "Skill")).toEqual(["Bash(npm test)", "Bash(git add *)", "Bash(git commit *)"]);
  });
});
```

Append to `test/build-executor.test.ts` inside the `describe("stack packs reach the Build reviewer …")` block from Task 9:

```ts
  test("a detected skill is named to the developer, `Skill` joins its allowance, and an untracked one is warned at Build start", async () => {
    const ws = workspace({
      ...ONE,
      skills: [
        { name: "impeccable", description: "Use when designing a page", path: ".claude/skills/impeccable/SKILL.md", tracked: true },
        { name: "scratch", description: "Not committed", path: ".claude/skills/scratch/SKILL.md", tracked: false },
      ],
    });
    const promptDir = join(ws.root, "prompts");
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_ARGV_LOG = argvLog;
    const outcome = await next(ws);
    expect(outcome.lines.join("\n")).toContain("warning: project skill scratch is untracked");
    const developer = readFileSync(join(promptDir, "developer-S1-1.md"), "utf8");
    expect(developer).toContain("## Project skills");
    expect(developer).toContain("- impeccable — Use when designing a page");
    expect(developer).toContain("- scratch — Not committed (untracked: not present in story worktrees)");
    const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const devAllowance = calls[0]?.[calls[0].indexOf("--allowedTools") + 1] ?? "";
    expect(devAllowance.split(",")).toContain("Skill");
    expect(calls[1]?.[calls[1].indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,Bash(git diff *)");
  });

  test("no skills ⇒ no section, no `Skill` in the allowance", async () => {
    const ws = workspace(ONE);
    const promptDir = join(ws.root, "prompts");
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_ARGV_LOG = argvLog;
    await next(ws);
    expect(readFileSync(join(promptDir, "developer-S1-1.md"), "utf8")).not.toContain("## Project skills");
    const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect((calls[0]?.[calls[0].indexOf("--allowedTools") + 1] ?? "").split(",")).not.toContain("Skill");
  });
```

In `test/dispatch-notes.test.ts`, find the assertion on the ledger's kinds around line 186 (`renderParts(base({ dispatchNotes: "docker is up", previousAttempt: "it failed" }))`) — it lists part kinds in order; the new kind is only emitted when `projectSkills` is set, so nothing there changes. Add no assertion; the group is pinned above.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/stack-packs-prompt.test.ts; echo "exit=$?"` — Expected FAIL: `renderProjectSkills` not exported; `exit=1`. Keep the output.

- [ ] **Step 3: The section renderer in `src/core/experts/stackPacks.ts`**

Append:

```ts
/** The heading the rendered section carries, in every prompt shape (precedent: `## Dispatch notes`). */
export const PROJECT_SKILLS_HEADING = "Project skills";

/** Skills of `repos`, deduplicated by path, sorted by name — the list every prompt renders. */
export function skillsFor(state: StackPacksState, repos: readonly string[]): readonly DetectedSkill[] {
  const byPath = new Map<string, DetectedSkill>();
  for (const repo of state.repos) {
    if (!repos.includes(repo.name)) continue;
    for (const skill of repo.skills) if (!byPath.has(skill.path)) byPath.set(skill.path, skill);
  }
  return [...byPath.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The body of `## Project skills`, or `""` when there are none — and then no section is
 * emitted at all. Skills are for DOING: the harness loads and invokes them; this only
 * says they exist, in the skill's own words (decision 6). Independent of the switch.
 */
export function renderProjectSkills(skills: readonly DetectedSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "Skills installed in this project (`.claude/skills/<name>/SKILL.md`). When a skill's",
    "description matches the work, invoke it with the Skill tool: it is how this project wants",
    "that job done, and it outranks the Defaults of any expert above.",
    "",
    ...skills.map((skill) =>
      `- ${skill.name} — ${skill.description === "" ? "(no description)" : skill.description}`
      + (skill.tracked ? "" : " (untracked: not present in story worktrees)")),
  ].join("\n");
}

/** One line per untracked skill, for the Build opening lines: a skill the worktree cannot see. */
export function untrackedSkillWarnings(skills: readonly DetectedSkill[]): readonly string[] {
  return skills
    .filter((skill) => !skill.tracked)
    .map((skill) => `warning: project skill ${skill.name} is untracked (${skill.path}) — not present in story worktrees`);
}
```

Add `DetectedSkill` to the imports if the type import is not already there, and export the four names from `src/core/experts/index.ts` on the `stackPacks.ts` line.

- [ ] **Step 4: The stage prompt part and the ledger**

`src/core/facilitator/prompt.ts` — import `PROJECT_SKILLS_HEADING` from `"../experts/stackPacks.ts"` and re-export it beside `DISPATCH_NOTES_HEADING`; add to `PromptParts` after `dispatchNotes`:

```ts
  /**
   * The rendered body of `## Project skills` — the project's own Claude skills, named
   * (`experts/stackPacks.ts renderProjectSkills`). Empty when there are none, and then
   * no section is emitted. Independent of the stack-packs switch.
   */
  readonly projectSkills?: string;
```

In `renderParts`, cut the heading too and emit the part after dispatch notes:

```ts
  const substituted = cutSection(
    cutSection(
      cutSection(
        cutSection(substitute(parts.stageMd, parts.values), INPUTS_HEADING),
        DISPATCH_NOTES_HEADING,
      ),
      PROJECT_SKILLS_HEADING,
    ),
    PREVIOUS_ATTEMPT_HEADING,
  );
```

```ts
  const skills = (parts.projectSkills ?? "").trim();
  if (skills !== "") {
    out.push({
      kind: "project-skills",
      name: PROJECT_SKILLS_HEADING,
      text: `\n## ${PROJECT_SKILLS_HEADING}\n\n${skills}\n`,
    });
  }
```

placed between the dispatch-notes push and the previous-attempt push. Extend the union:

```ts
export type PromptPartKind =
  | "stage" | "expert-body" | "expert-knowledge" | "inputs" | "dispatch-notes" | "project-skills" | "previous-attempt";
```

Add `PROJECT_SKILLS_HEADING` to the `prompt.ts` export list in `src/core/facilitator/index.ts`.

`src/core/facilitator/contextLedger.ts` — add `readonly projectSkills: number;` to `LedgerGroups` after `dispatchNotes`; in `buildLedger` add `let projectSkills = 0;`, a `case "project-skills":` that adds bytes and pushes the row exactly as `dispatch-notes` does, include it in `totalBytes` (`… + dispatchNotes + projectSkills + previousAttempt`) and in the `groups` literal; in the describe line (around line 190) add `+ (g.projectSkills === 0 ? "" : ` · project skills ${bytes(g.projectSkills)}`)` beside the dispatch-notes term; in `label()` add `case "project-skills": return "project skills";`.

- [ ] **Step 5: The developer prompt, the tools, the wiring**

`src/core/build/prompts.ts` — add to `DeveloperPromptParts` after `dispatchNotes`:

```ts
  /** The rendered body of `## Project skills` (`experts/stackPacks.ts`); empty ⇒ no section. */
  readonly projectSkills?: string;
```

After `...dispatchNotesSection(parts.dispatchNotes),` insert `...projectSkillsSection(parts.projectSkills),` and add beside `dispatchNotesSection`:

```ts
/** `## Project skills`, or nothing — after the notes, before the brief's own steps. */
function projectSkillsSection(body: string | undefined): readonly string[] {
  const text = (body ?? "").trim();
  return text === "" ? [] : [`## ${PROJECT_SKILLS_HEADING}`, "", text, ""];
}
```

with `import { PROJECT_SKILLS_HEADING } from "../experts/stackPacks.ts";`.

`src/core/facilitator/runNext.ts` `assemblePrompt` — import `readStackPacks, renderProjectSkills, skillsFor` from `"../experts/stackPacks.ts"` and add to the `renderParts({...})` call after `dispatchNotes: dispatchNotes.body,`:

```ts
    projectSkills: renderProjectSkills(skillsFor(readStackPacks(options.root), store.run.repos)),
```

`src/core/facilitator/executors/build.ts`:

1. Import `readStackPacks, renderProjectSkills, skillsFor, untrackedSkillWarnings` from `"../../experts/stackPacks.ts"`.
2. In `buildExecutor`, right after `const workspace = loadWorkspace(ctx.root);` and the `opening` declaration:

```ts
  // A skill git does not track is absent from every story worktree; say so once, at the
  // start, rather than letting the developer discover a file the prompt named is missing.
  opening.push(...untrackedSkillWarnings(skillsFor(readStackPacks(ctx.root), ctx.repos)));
```

3. In `developerPrompt`, compute `const skills = skillsFor(readStackPacks(this.ctx.root), [repo]);` and pass `projectSkills: renderProjectSkills(skills),` to `buildDeveloperPrompt`.
4. At the spawn site (line ~1954) replace `tools: developerTools(commands),` with:

```ts
      // `Skill` only when there is one to invoke: an allowance for a tool nothing needs
      // is a wider surface for no reason.
      tools: developerTools(commands, { skills: skillsFor(readStackPacks(this.ctx.root), [story.planned.story.repo]).length > 0 }),
```

5. Change `developerTools`:

```ts
export function developerTools(
  repoCommands: readonly string[],
  options: { readonly skills?: boolean } = {},
): readonly string[] {
  return [
    ...BASE_TOOLS,
    ...(options.skills === true ? ["Skill"] : []),
    ...repoCommands.map((command) => `Bash(${command})`),
    "Bash(git add *)",
    "Bash(git commit *)",
  ];
}
```

Check `test/build-executor.test.ts:154` still holds (`developerTools(["npm run test"])` with no options is unchanged).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test test/stack-packs-prompt.test.ts test/build-executor.test.ts test/dispatch-notes.test.ts test/token-economy.test.ts test/facilitator.test.ts test/dod-allowlist.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`.

- [ ] **Step 7: Full gates and commit**

Run each on its own line: `bun run typecheck; echo "exit=$?"` · `bun test; echo "exit=$?"` · `bun run build; echo "exit=$?"`. Expected `exit=0` each.

```bash
git add src/core/experts/stackPacks.ts src/core/experts/index.ts src/core/facilitator/prompt.ts src/core/facilitator/index.ts src/core/facilitator/contextLedger.ts src/core/facilitator/runNext.ts src/core/facilitator/executors/build.ts src/core/build/prompts.ts test/stack-packs-prompt.test.ts test/build-executor.test.ts
git commit -m "feat(prompt): name the project's skills to every stage and to the developer, allow Skill only then, warn on untracked

Skills are for doing and packs for checking; the section is independent of the packs switch (stack packs design decision 6).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 11: `tldrx expert packs <enable|disable|status>` with help text

**Files:**
- Modify: `src/cli/commands/expert.ts:34-70`, `src/cli/helpText.ts:942-978`
- Modify: `docs/guide/08-cli-reference.md:723-736` (the usage block only — the rest of the docs is Task 12), `test/cli.test.ts:411-425` (`DOCUMENTED_SUBCOMMANDS`)
- Test: `test/stack-packs-cli.test.ts`

**Interfaces:**
- Consumes: `enableStackPacks`, `disableStackPacks`, `stackPacksStatus`, `rfc3339` (`src/core/init/index.ts`); `SpawnCommandRunner`; `resolveWorkspaceRoot`; `EXIT_OK`, `EXIT_FAILED`.
- Produces: the `packs` subcommand; help registry entry updates.

- [ ] **Step 1: Write the failing tests**

Create `test/stack-packs-cli.test.ts`:

```ts
/**
 * `tldrx expert packs` through the real CLI (stack packs design §4.6): exit families,
 * the lines an operator reads, and `--help` as the authoritative surface.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { SpawnCommandRunner } from "../src/core/detect/index.ts";
import { runInit, type InitOptions } from "../src/core/init/index.ts";
import { templatesHash } from "../src/core/experts/packTemplates.ts";
import { greenfieldFixture, singleRepoFixture, type Fixture } from "./init-fixture.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test here spawns the real CLI; the budget scales with measured load (#43).
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const runner = new SpawnCommandRunner();
const NOW = new Date("2026-09-05T10:00:00Z");

interface Run { readonly code: number; readonly stdout: string; readonly stderr: string; }

/** The CLI, with a private $TMPDIR per invocation and a `claude` that refuses (#95/#97). */
async function tldrx(cwd: string, ...args: string[]): Promise<Run> {
  const scratch = mkdtempSync(join(tmpdir(), "tldrx-packs-cli-tmp-"));
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...noSpawnEnv(), TMPDIR: scratch },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

function options(root: string): InitOptions {
  return { root, out: root, interview: false, methodology: null, mcp: false, stack: [], provider: "static" };
}

describe("tldrx expert packs", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await singleRepoFixture();
    await runInit(options(fixture.root), { runner, cliVersion: "0.0.1", now: NOW });
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("status exits 0 and says disabled before anyone enabled it", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "status", "--root", fixture.root);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("stack packs: disabled");
    expect(run.stdout).toContain("typescript-stack: body stub");
  });

  test("enable prints overlays with evidence and the applied pack, then status reflects it", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "enable", "--root", fixture.root);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("react (package.json: dependencies.react)");
    expect(run.stdout).toContain(`typescript-stack: pack applied (pack@${templatesHash()})`);
    expect(existsSync(join(fixture.root, ".tldrx", "experts", "typescript-stack", "overlays", "react.md"))).toBe(true);
    const status = await tldrx(fixture.root, "expert", "packs", "status", "--root", fixture.root);
    expect(status.stdout).toContain("stack packs: enabled");
    expect(status.stdout).toContain(`typescript-stack: body pack@${templatesHash()}, overlays: react, vite-react-spa`);
  });

  test("disable exits 0, removes the overlays, and says what it left alone", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "disable", "--root", fixture.root);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("bodies and knowledge/ untouched");
    expect(existsSync(join(fixture.root, ".tldrx", "experts", "typescript-stack", "overlays"))).toBe(false);
    expect(readFileSync(join(fixture.root, ".tldrx", "workspace.yml"), "utf8")).toContain("enabled: false");
  });

  test("an unknown action is a usage error naming the three verbs", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "bogus", "--root", fixture.root);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("expected enable, disable or status");
  });

  test("--help lists packs and its verbs", async () => {
    const run = await tldrx(FRAMEWORK_ROOT, "expert", "--help");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("packs");
    expect(run.stdout).toContain("tldrx expert packs enable");
  });
});

describe("enable with nothing detectable", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await greenfieldFixture();
    await runInit(options(fixture.root), { runner, cliVersion: "0.0.1", now: NOW });
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("exits 1 (usage family) and says why on stderr", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "enable", "--root", fixture.root);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("no detectable language");
    expect(run.stdout).toBe("");
  });
});
```

In `test/cli.test.ts`, widen the scoped list and its test name:

```ts
  const DOCUMENTED_SUBCOMMANDS = ["run", "plan", "note", "ship", "expert"] as const;

  test("the CLI reference documents every subcommand of `run`, `plan`, `note`, `ship` and `expert` (#54, #55, #72, stack packs)", () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/stack-packs-cli.test.ts test/cli.test.ts; echo "exit=$?"` — Expected FAIL: `expected list, create, train or recompute` on stderr; the reference lacks `tldrx expert packs`; `exit=1`. Keep the output.

- [ ] **Step 3: Wire the subcommand**

In `src/cli/commands/expert.ts`:

```ts
import { rfc3339 } from "../../core/init/index.ts";
import { disableStackPacks, enableStackPacks, stackPacksStatus, type PacksOutcome } from "../../core/init/stackPacks.ts";
import { SpawnCommandRunner } from "../../core/detect/CommandRunner.ts";
```

Add to `USAGE` (and, identically indented, to `usage:`):

```
  tldrx expert packs <enable|disable|status> [--root <path>]
```

`subcommands: ["list", "create", "train", "recompute", "packs"]`; in `run`, add `case "packs": return packs(rest);` and change the default message to `expected list, create, train, recompute or packs`. Add:

```ts
/**
 * `packs` — the one switch for the stack packs (stack packs design §4.6).
 *
 * `enable` re-runs detection, seeds any missing `<lang>-stack`, applies the pack body
 * where the stub is untouched, writes the overlays and records everything in
 * `workspace.yml`. `disable` clears the switch and removes only the overlays. `status`
 * reports and always exits 0. `enable` with no detectable language is a usage error.
 */
async function packs(argv: readonly string[]): Promise<number> {
  const [action, ...rest] = argv;
  const workspaceDir = resolveWorkspaceRoot(option(rest, "--root"));
  let outcome: PacksOutcome;
  try {
    switch (action) {
      case "enable":
        outcome = await enableStackPacks({ workspaceDir, runner: new SpawnCommandRunner(), now: rfc3339(new Date()) });
        break;
      case "disable":
        outcome = await disableStackPacks({ workspaceDir });
        break;
      case "status":
        outcome = await stackPacksStatus({ workspaceDir });
        break;
      default:
        process.stderr.write(`tldrx expert packs: expected enable, disable or status\n${USAGE}\n`);
        return EXIT_FAILED;
    }
  } catch (error) {
    process.stderr.write(`tldrx expert packs: ${message(error)}\n`);
    return EXIT_FAILED;
  }
  const text = `${outcome.lines.join("\n")}\n`;
  if (outcome.ok) {
    process.stdout.write(text);
    return EXIT_OK;
  }
  process.stderr.write(`tldrx expert packs enable: ${text}`);
  return EXIT_FAILED;
}
```

- [ ] **Step 4: The help registry entry**

In `src/cli/helpText.ts`, in the `expert` entry:

- `description: "List or create experts, recompute their levels, train one, or switch the stack packs on."`
- `args` gains: `{ name: "<enable|disable|status>", meaning: "expert packs: turn the stack packs on or off for this workspace, or print their state." }`
- `examples` gains: `"tldrx expert packs enable"`, `"tldrx expert packs status"`
- `notes` gains one paragraph:

```ts
      "`packs enable` is the one switch for the stack packs, off by default. It re-runs detection, seeds any missing `<lang>-stack` expert, gives each one whose body is still the seeded stub the shipped pack body (an edited body is kept and said so — delete the body to re-seed), writes every framework overlay detection can prove under `overlays/` with its evidence in `workspace.yml`, and names the project's `.claude/skills`. `disable` removes the overlays and touches neither bodies nor knowledge. `status` prints all of it and always exits 0; `enable` exits 1 when no repo has a detectable language.",
```

- [ ] **Step 5: The reference usage block**

In `docs/guide/08-cli-reference.md`, the `## \`tldrx expert\`` code block gains a line after `recompute`:

```
tldrx expert packs     <enable|disable|status>
```

and, after the paragraph on `recompute`, one paragraph:

```markdown
`packs` is the one switch for the **stack packs**, off by default. `enable` re-runs detection,
seeds any missing `<lang>-stack` expert, gives each one whose body is still the seeded stub the
shipped pack body — an edited body is kept and said so; delete the body to re-seed — writes every
framework overlay detection can prove under `overlays/` with its evidence recorded in
`workspace.yml`, and names the project's `.claude/skills`. `disable` removes the overlays and
touches neither bodies nor knowledge. `status` prints all of it and always exits `0`; `enable`
exits `1` when no repo has a detectable language. See [4 — Experts](04-experts.md#stack-packs).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test test/stack-packs-cli.test.ts test/cli.test.ts test/experts.test.ts; echo "exit=$?"` — Expected PASS, `exit=0`. (`cli.test.ts` also re-derives every flag `packs` reads — `--root` is declared — and asserts `expert --help` renders.)

Run: `bun test test/machine-load.test.ts; echo "exit=$?"` — the guard now lists `stack-packs-cli.test.ts` (`Bun.spawn`): **+1 guard row**.

- [ ] **Step 7: Typecheck and commit**

Run: `bun run typecheck; echo "exit=$?"` — Expected `exit=0`.

```bash
git add src/cli/commands/expert.ts src/cli/helpText.ts docs/guide/08-cli-reference.md test/cli.test.ts test/stack-packs-cli.test.ts
git commit -m "feat(cli): tldrx expert packs <enable|disable|status> — the one switch, with --help as the surface

Off by default; enable exits 1 (usage family) when no repo has a detectable language; status always exits 0.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 12: Docs — EN and ES in lockstep (spec §6)

**Files:**
- Modify: `docs/spec.md:59-110` (§2.1 fields), `docs/spec.md:1643-1646` (§3 command rows), `docs/spec.md:1994-2013` (§5 prompt order)
- Modify: `docs/ROADMAP.md:45`
- Modify: `docs/guide/04-experts.md` (new `## Stack packs` section after `## Role experts`)
- Modify: `docs/guide/08-cli-reference.md` (already touched in Task 11 — nothing more)
- Modify: `docs-site/guides/experts.md:57-72` and `docs-site/es/guides/experts.md:59-76` (new section after "Which experts a stage loads" / "Qué expertos carga una etapa")
- Modify: `docs-site/reference/cli.md:77` and `docs-site/es/reference/cli.md:77`
- Modify: `docs-site/concepts/files-as-state.md:20-26` and `docs-site/es/concepts/files-as-state.md:20-26`
- Modify: `docs-site/quickstart.md:71-74` and `docs-site/es/quickstart.md:72-75`
- Modify: `README.md:291`

No new pages, so no sidebar change and no dead-link risk. Never type the current version into prose; never use `lightweight`, bare `tool-agnostic`, or an absolute sync claim (`test/public-surface-consistency.test.ts`). Never name a private workspace.

- [ ] **Step 1: `docs/spec.md`**

§2.1 — extend the YAML example's `lab` row with `overlays: [{id: react, evidence: "package.json: dependencies.react"}, …]` and `skills: []`, and add a top-level block after `contracts:`:

```yaml
stack_packs:              # the one opt-in switch for stack expert packs; absent = off
  enabled: true
  enabled_at: 2026-09-05T10:00:00Z
```

Add three rows to the field table:

```markdown
| `repos[].overlays[].{id,evidence}` | str / str | n | Framework overlays detection can PROVE from manifests (`src/core/detect/overlays.ts`), each with the manifest signal that fired it. Always written; `stack_packs.enabled` gates whether they are materialised |
| `repos[].skills[].{name,description,path,tracked}` | str / str / rel path / bool | n | `.claude/skills/*/SKILL.md` in the repo, named to the developer; `tracked: false` ⇒ absent from story worktrees |
| `stack_packs.{enabled,enabled_at}` | bool / RFC3339\|null | n | The stack packs switch (`tldrx expert packs`). Carried forward across `init`; absent means off |
```

§3 — add a row after `tldrx expert recompute`:

```markdown
| `tldrx expert packs <enable\|disable\|status>` | `workspace.yml`, manifests, `.claude/skills/**`, `experts/<lang>-stack/**`, `templates/experts/stack/**` | `enable`: `workspace.yml` (`stack_packs`, `repos[].overlays`, `repos[].skills`), `experts/<lang>-stack/expert.md` (only when its body is the untouched stub), `experts/<lang>-stack/overlays/*.md`; `disable`: `workspace.yml`, removes `overlays/`; `status`: nothing (stdout) | 0,1 |
```

§5 — in the "Expert composition" block, after `<expert.md, verbatim, front matter included>` add a line `<!-- overlay: <id> --> <overlay, verbatim>  — kind: stack experts only, when stack_packs.enabled`; in the prompt-order block, insert `## Project skills` between `## Dispatch notes` and `## Previous attempt` with the comment `<the project's .claude/skills, named — omitted when there are none>`; and one sentence after the block: "The Build reviewer, which carries no expert bodies, gets the active packs' `## Checks` under `## Stack checks (the repo's own conventions win)` when the switch is on."

- [ ] **Step 2: `docs/ROADMAP.md`**

Replace line 45 (`- Stack expertise shared by every expert by default.`) with:

```markdown
- **Stack packs** (on main, unreleased): shipped as opt-in bodies for the `<lang>-stack`
  experts — TypeScript, JavaScript, Python, .NET — plus framework overlays detected from
  manifests, never inferred from a language; interrogative by default, prescriptive only where
  the repo is silent. One switch, `tldrx expert packs enable`. Not "shared by every expert by
  default": measured repo conventions win, and a pack that argued with them would be worse
  than none.
```

- [ ] **Step 3: `docs/guide/04-experts.md`**

After the `## Role experts` section add:

```markdown
## Stack packs

A `<lang>-stack` expert is seeded as a name-only stub: until you train it, the language
name is the only stack-specific thing in its body. **Stack packs** replace that stub with a
shipped body, off by default, one switch:

```bash
tldrx expert packs enable
tldrx expert packs status
tldrx expert packs disable
```

A pack has two sections and nothing else. **Defaults (when the repo is silent)** apply only
where the repo has no signal on the topic, and each one names the signal that overrides it
(`— overridden by: tsconfig.json compilerOptions.strict`). **Checks (always asked in review)**
are questions with a `verify:` hint; a miss is a finding with a cited file, and the project's
own convention is the accepted answer when it has one. Measured repo conventions win over pack
content, always.

Two layers. The **language pack** (`typescript`, `javascript`, `python`, `dotnet`) becomes the
expert's body. **Framework overlays** are detected from manifests — `package.json`, a
`*.csproj` and `Directory.Packages.props`, `pyproject.toml` or `requirements*.txt` — never
inferred from the language, because two workspaces on one language can use opposite
architectures. Each detected overlay is written to `workspace.yml` with its evidence
(`aspnet-controllers: src/Api/Api.csproj: Sdk=Web; Controllers/ present`) and, with the switch
on, materialised as `.tldrx/experts/<lang>-stack/overlays/<id>.md`. Those files are the
framework's: rewritten on every `enable` and every `init`, removed by `disable`.

The body is yours. `enable` replaces it only while it is byte-identical to the stub `init`
seeded; an edited body is kept and the command says so — delete the body to re-seed. The
front matter gains `pack: <lang>@<hash>` so `status` can name the shipment. `knowledge/` is
never touched.

Where it lands: every stage prompt and the Build developer see the composed body (they
already print each expert's body); the Build **reviewer**, which carries no expert content,
gets the active packs' Checks under `## Stack checks (the repo's own conventions win)`.

Project skills — `.claude/skills/<name>/SKILL.md` — are detected alongside and **named** to
the developer under `## Project skills`, independent of the switch. The harness loads and
runs a skill; the framework only says it exists, and allows the `Skill` tool when one does.
A skill git does not track is flagged: a story worktree carries tracked files only.
```

- [ ] **Step 4: docs-site EN**

`docs-site/guides/experts.md` — after "Which experts a stage loads", before "Training one":

```markdown
## Stack packs

A `<language>-stack` expert starts as a stub with nothing stack-specific in it. Turn on the
**stack packs** and it gets a shipped body — TypeScript, JavaScript, Python or .NET — plus
one **overlay** per framework the manifests prove: `react`, `next-app-router`, `prisma`,
`aspnet-controllers`, `mediatr-cqrs`, `efcore-npgsql`, `fastapi`, `sqlalchemy-alembic`,
`postgres-testcontainers` and a few more. Overlays come from `package.json`, the `.csproj`
files or `pyproject.toml`, never from the language name, and each one is written to
`workspace.yml` with the line that proved it.

```bash
tldrx expert packs enable     # one switch, off by default
tldrx expert packs status     # overlays with evidence, skills, each body's state
tldrx expert packs disable    # removes the overlays; bodies and knowledge stay
```

A pack is interrogative: its **Checks** are questions the reviewer asks of every diff, each
with a `verify:` hint, and its **Defaults** apply only where the repo is silent — each one
names what overrides it. Your repo's own conventions win. If you have edited a stack expert's
body, `enable` leaves it alone and says so.

Your project's Claude skills (`.claude/skills/*/SKILL.md`) are named to the developer too,
switch or no switch — the harness runs them; tldrx only says they are there.
```

`docs-site/reference/cli.md:77` — change the row to:

```markdown
| `tldrx expert list \| create \| train \| recompute \| packs` | See [Experts](/guides/experts). `packs enable\|disable\|status` is the one switch for the stack packs. |
```

`docs-site/concepts/files-as-state.md` — in the tree, replace the `experts/` line with:

```
  experts/                       # who the stages lean on, and what they have learned
  experts/<lang>-stack/overlays/ # framework overlays, written by `expert packs enable`
```

`docs-site/quickstart.md` — as a new paragraph directly BEFORE the one that starts "`init` writes `.tldrx/`:" (line 71; that paragraph ends in a colon that introduces a code block, so nothing may be appended to it):

```markdown
The stack expert starts as a stub; `tldrx expert packs enable` gives it a shipped body and
the framework overlays your manifests prove — off by default, one switch.
```

- [ ] **Step 5: docs-site ES (real translations, CLI strings stay in English)**

`docs-site/es/guides/experts.md` — after "Qué expertos carga una etapa", before "Cómo entrenar uno":

```markdown
## Packs de stack

Un experto `<language>-stack` arranca como un esqueleto sin nada específico del stack. Activa
los **packs de stack** y recibe un cuerpo que viene con la herramienta — TypeScript,
JavaScript, Python o .NET — más un **overlay** por cada framework que los manifiestos
demuestran: `react`, `next-app-router`, `prisma`, `aspnet-controllers`, `mediatr-cqrs`,
`efcore-npgsql`, `fastapi`, `sqlalchemy-alembic`, `postgres-testcontainers` y algunos más. Los
overlays salen de `package.json`, de los `.csproj` o de `pyproject.toml`, nunca del nombre del
lenguaje, y cada uno queda escrito en `workspace.yml` con la línea que lo demostró.

```bash
tldrx expert packs enable     # un solo interruptor, apagado por defecto
tldrx expert packs status     # overlays con evidencia, skills, y el estado de cada cuerpo
tldrx expert packs disable    # quita los overlays; cuerpos y conocimiento se quedan
```

Un pack es interrogativo: sus **Checks** son preguntas que el revisor le hace a cada diff,
cada una con una pista `verify:`, y sus **Defaults** aplican solo donde el repo no dice nada —
cada uno nombra qué lo anula. Las convenciones de tu repo ganan. Si editaste el cuerpo de un
experto de stack, `enable` lo deja en paz y te lo dice.

Los skills de Claude de tu proyecto (`.claude/skills/*/SKILL.md`) también se le nombran al
desarrollador, con o sin interruptor — el harness los ejecuta; tldrx solo avisa que están ahí.
```

`docs-site/es/reference/cli.md:77`:

```markdown
| `tldrx expert list \| create \| train \| recompute \| packs` | Ver [Expertos](/es/guides/experts). `packs enable\|disable\|status` es el único interruptor de los packs de stack. |
```

`docs-site/es/concepts/files-as-state.md` — replace the `experts/` line with:

```
  experts/                       # en quién se apoyan las etapas, y qué han aprendido
  experts/<lang>-stack/overlays/ # overlays de framework, escritos por `expert packs enable`
```

`docs-site/es/quickstart.md` — as a new paragraph directly BEFORE the one that starts "`init` escribe `.tldrx/`:" (the twin of the EN placement):

```markdown
El experto de stack arranca como esqueleto; `tldrx expert packs enable` le da un cuerpo que
viene con la herramienta y los overlays de framework que tus manifiestos demuestran — apagado
por defecto, un solo interruptor.
```

- [ ] **Step 6: README**

Line 291: `[4 Experts](docs/guide/04-experts.md) (loading rules, role experts, training, levels)` → `(loading rules, role experts, stack packs, training, levels)`. The release table is the release ritual's job (AGENTS.md §6 step 1) and is **not** edited here.

- [ ] **Step 7: Gates**

Run each on its own line: `bun run docs:build; echo "exit=$?"` · `bun test test/public-surface-consistency.test.ts test/cli.test.ts; echo "exit=$?"` · `git status --porcelain` (docs:build must leave the tree clean apart from your edits). Expected `exit=0` each.

- [ ] **Step 8: Commit**

```bash
git add docs/spec.md docs/ROADMAP.md docs/guide/04-experts.md docs-site README.md
git commit -m "docs: stack packs — workspace fields, the expert packs command, the prompt order, EN and ES in lockstep

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 13: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md:4-16`

- [ ] **Step 1: Check the current unreleased heading**

Run: `sed -n 1,6p CHANGELOG.md` — Expected (measured 2026-09-05 at `6180f6c`): line 4 reads `## 0.8.1 — unreleased`. If it already reads `## 0.9.0 — unreleased`, skip the rename. Also confirm the README release table's top row is `0.8.0` (`grep -n "^| 0\." README.md | head -1`) — the drift guard passes because it equals `package.json`; do not add a row.

- [ ] **Step 2: Rename and add**

Change `## 0.8.1 — unreleased` to `## 0.9.0 — unreleased` (a new command, new `workspace.yml` fields and a new prompt section are a minor, not a patch). Under its existing `### Added`, before the `AGENTS.md` bullet, add:

```markdown
- **Stack packs — `tldrx expert packs enable`.** A `<lang>-stack` expert was a name-only
  stub: the language name was the only stack-specific token in its body, so the developer built
  from the model's habits and the reviewer had no stack checklist to hold a story against
  (the repo's own audit scored the experts' knowledge 6/10). Off by default, one switch: the
  pack body replaces the stub — and ONLY an untouched stub; an edited body is kept and the
  command says so — and every framework overlay detection can prove from a manifest is written
  under `overlays/` with its evidence in `workspace.yml`. Packs are interrogative by owner
  decision: **Checks** are questions with a `verify:` hint that the Build reviewer now asks under
  `## Stack checks (the repo's own conventions win)`, and **Defaults** apply only where the repo
  is silent, each naming the signal that overrides it. Measured repo conventions win, always.
  Four language packs (TypeScript, JavaScript, Python, .NET) and thirteen overlays, one per row
  of the detection table (`react`, `next-app-router`, `vite-react-spa`, `expo-router`,
  `node-express`, `prisma`, `aspnet-minimal-apis`, `aspnet-controllers`, `mediatr-cqrs`,
  `efcore-npgsql`, `fastapi`, `sqlalchemy-alembic`, `postgres-testcontainers`); a shape test
  pins the format, the size caps and the one-to-one mapping. No new prompt mechanism: every
  renderer already prints an expert's body, so composing `body + overlays` in
  `loadExpertBundles` reaches stage prompts and the developer; the reviewer, which carried no
  expert content at all, is the one explicit addition. Switch off ⇒ today's bytes.
- **Overlays are detected from manifests, never inferred from a language.** Two .NET
  workspaces can use opposite architectures (minimal APIs against controllers + MediatR); one
  prescriptive ".NET pack" would be wrong for one of them. Detection reads `package.json` (its
  two dependency groups now kept apart, so an evidence string can say which one a name came
  from), `*.csproj` and `Directory.Packages.props` via a regex over `Include="…"`,
  `pyproject.toml`'s `[project] dependencies` and `requirements*.txt`. Unknown → no overlay.
  `workspace.yml` gains `repos[].overlays` and `stack_packs` — additive under `version: 1`,
  carried forward across every `init`.
- **Project skills are named to the developer.** `.claude/skills/*/SKILL.md` is detected per
  repo into `repos[].skills` and rendered as `## Project skills` in every stage prompt and the
  developer prompt, independent of the packs switch; the developer's `--allowedTools` gains
  `Skill` only when one exists. Skills are for doing and packs for checking: the harness runs a
  skill, the framework only says it is there. A skill git does not track is flagged in the
  prompt and warned at Build start — a story worktree carries tracked files only, so the file
  the prompt names does not exist there.
```

- [ ] **Step 3: Verify and commit**

Run: `bun test test/public-surface-consistency.test.ts; echo "exit=$?"` — Expected PASS, `exit=0` (the README top row still equals `package.json`).

```bash
git add CHANGELOG.md
git commit -m "changelog: stack packs under 0.9.0 — unreleased

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv"
```

---

### Task 14: Full gate run and a clean tree

**Files:** none.

- [ ] **Step 1: Every gate, each exit code on its own line**

```bash
bun run typecheck; echo "typecheck exit=$?"
bun test; echo "test exit=$?"
bun run build; echo "build exit=$?"
bun run docs:build; echo "docs exit=$?"
grep -rn "Bun\." src --include='*.ts' | grep -v "^src/core/runtime/"; echo "seam-grep exit=$? (1 = no hits = pass)"
git status --porcelain; echo "status exit=$?"
```

Expected: `typecheck exit=0`, `test exit=0`, `build exit=0`, `docs exit=0`, the seam grep prints nothing and `exit=1`, and `git status --porcelain` prints nothing. Anything else is a failed change — fix it in the task that owns it, re-run all six.

- [ ] **Step 2: Reconcile the test delta**

Record, for the report: `bun test` pass count before this branch (`git stash` is not allowed in the shared checkout — read it off `origin/main`'s last CI run instead, or from the first `bun test` you ran in this worktree before Task 1) and after; the new test files (`detect-overlays`, `detect-skills`, `pack-sections`, `pack-templates`, `stack-packs`, `stack-packs-prompt`, `stack-packs-cli`) plus the tests added to `detect`, `init`, `schemas`, `build-executor`, `cli`; and the **two** automatic machine-load guard rows (`detect-skills.test.ts`, `stack-packs-cli.test.ts`). The +N must add up; do not hand-wave it.

- [ ] **Step 3: Keep the RED outputs**

Every task's Step 2 output is part of the close (AGENTS.md §1, §11). Paste them verbatim into the report, one per task, labelled.

---

## Self-review (run before handing the plan over)

1. **Spec coverage** — §4.1 templates: Tasks 4–6. §4.2 body rule and overlays: Task 7. §4.3 `workspace.yml`: Task 3 (+ Task 7 for the write on enable). §4.4 table: Task 1. §4.5 prompt path: Task 8 (bodies), Task 9 (reviewer), Task 10 (skills, `Skill`, untracked warning). §4.6 CLI: Task 11. §5 tests: `detect-overlays` (T1), `detect-skills` (T2), `stack-packs` (T7), `pack-templates` (T5/6), prompt tests (T8–10), `schemas` (T3), public-surface/cli (T11/12). §6 docs: Task 12; CHANGELOG: Task 13. §4.7 non-goals untouched.
2. **Placeholder scan** — no `TBD`/`TODO`; pack CONTENT is deliberately authoring guidance (the task brief asks for it), everything else is complete code.
3. **Type consistency** — `readStackPacks(root)` returns `{present, enabled, enabledAt, repos}` (T3) and is consumed by T7/T8/T9/T10 with those names; `composePackBody` returns `{text, inlined, notInlined, truncated}` (T4) and T8 reads `.text`/`.inlined`; `developerTools(commands, {skills})` (T10) matches its test; `PacksOutcome {ok, lines}` (T7) matches T11.
