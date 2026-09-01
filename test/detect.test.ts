import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  detectCi, detectCommands, detectDefaultBranch, detectStack, detectWorkspace,
  findRepos, isSingleArgvCommand, repoSlug, scoreConfidence, uniqueSlug, walkFiles,
  SpawnCommandRunner, FALLBACK_BRANCH, type RepoCommands,
} from "../src/core/detect/index.ts";
import { emptyFixture, fakeRunner, multiRepoFixture, okResult, singleRepoFixture, type Fixture } from "./init-fixture.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const runner = new SpawnCommandRunner();

describe("repo slugs", () => {
  test("a directory name becomes a `^[a-z0-9-]{1,32}$` key", () => {
    expect(repoSlug("Scavtopia.Workflows")).toBe("scavtopia-workflows");
    expect(repoSlug("my repo!!")).toBe("my-repo");
    expect(repoSlug("---")).toBe("repo");
    expect(repoSlug("a".repeat(40))).toHaveLength(32);
  });

  test("collisions are resolved, never silently merged", () => {
    expect(uniqueSlug("api", new Set())).toBe("api");
    expect(uniqueSlug("api", new Set(["api"]))).toBe("api-2");
    expect(uniqueSlug("api", new Set(["api", "api-2"]))).toBe("api-3");
  });
});

describe("workspace mode", () => {
  let multi: Fixture;
  let single: Fixture;
  let empty: Fixture;

  beforeAll(async () => {
    [multi, single, empty] = await Promise.all([multiRepoFixture(), singleRepoFixture(), emptyFixture()]);
  });
  afterAll(async () => {
    await Promise.all([multi.cleanup(), single.cleanup(), empty.cleanup()]);
  });

  test("child git repos make it multi-repo", async () => {
    const found = await findRepos(multi.root);
    expect(found.mode).toBe("multi-repo");
    expect(found.rootIsRepo).toBe(true);
    expect([...found.repoDirs].sort()).toEqual(["Api.Service", "lab"]);
  });

  test("a lone repo is single-repo, with path `.`", async () => {
    const found = await findRepos(single.root);
    expect(found.mode).toBe("single-repo");
    expect(found.repoDirs).toEqual(["."]);
  });

  test("a directory with no git anywhere yields no repos", async () => {
    const found = await findRepos(empty.root);
    expect(found.repoDirs).toEqual([]);
    expect(found.rootIsRepo).toBe(false);
  });
});

describe("stack and commands", () => {
  let multi: Fixture;

  beforeAll(async () => { multi = await multiRepoFixture(); });
  afterAll(async () => { await multi.cleanup(); });

  test("package.json gives language, frameworks and package manager", async () => {
    const stack = await detectStack(join(multi.root, "lab"));
    expect(stack.languages).toEqual(["typescript"]);
    expect(stack.stack).toEqual(["typescript", "react", "vite"]);
    expect(stack.packageManager).toBe("npm");
    expect(stack.manifests).toContain("package.json");
  });

  test("a .sln/.csproj gives dotnet and nuget", async () => {
    const stack = await detectStack(join(multi.root, "Api.Service"));
    expect(stack.languages).toEqual(["dotnet"]);
    expect(stack.packageManager).toBe("nuget");
  });

  test("scripts become commands, and every citation points at the line that declares them", async () => {
    const dir = join(multi.root, "lab");
    const detected = await detectCommands(dir, await detectStack(dir));
    expect(detected.commands).toEqual({
      build: "npm run build", test: "npm run test", lint: "npm run lint",
      typecheck: "npm run typecheck", run: "npm run dev",
    });
    const manifest = await Bun.file(join(dir, "package.json")).text();
    for (const evidence of detected.evidence) {
      const [path, line] = evidence.src.split(":");
      expect(path).toBe("package.json");
      const target = manifest.split("\n")[Number(line) - 1] ?? "";
      expect(target).toContain("\"");
    }
  });

  test("dotnet commands come from the project files, and `run` needs exactly one non-test project", async () => {
    const dir = join(multi.root, "Api.Service");
    const detected = await detectCommands(dir, await detectStack(dir));
    expect(detected.commands.build).toBe("dotnet build");
    expect(detected.commands.test).toBe("dotnet test");
    expect(detected.commands.lint).toBe("dotnet format --verify-no-changes");
    expect(detected.commands.run).toBe("dotnet run --project src/Api/Api.csproj");
    expect(detected.commands.typecheck).toBeNull();
    expect(detected.missing).toContain("typecheck");
  });

  test("CI files are listed, not interpreted", async () => {
    expect(await detectCi(join(multi.root, "lab"))).toEqual([".github/workflows/ci.yml"]);
    expect(await detectCi(join(multi.root, "Api.Service"))).toEqual([]);
  });

  test("the walk skips node_modules and .git", async () => {
    const files = await walkFiles(join(multi.root, "lab"));
    expect(files.some((file) => file.path.includes(".git/"))).toBe(false);
    expect(files.map((file) => file.path)).toContain("src/index.ts");
  });
});

describe("default branch", () => {
  test("origin/HEAD is used when git reports it", async () => {
    const stub = fakeRunner(new Map([["git symbolic-ref", okResult("refs/remotes/origin/develop\n")]]));
    expect(await detectDefaultBranch(stub, "/nowhere")).toEqual({ branch: "develop", measured: true });
  });

  test("no origin falls back to main, and says it was not measured", async () => {
    const stub = fakeRunner(new Map());
    expect(await detectDefaultBranch(stub, "/nowhere")).toEqual({ branch: FALLBACK_BRANCH, measured: false });
  });
});

describe("confidence", () => {
  const commands = (partial: Partial<RepoCommands>): RepoCommands => ({
    build: null, test: null, lint: null, typecheck: null, run: null, ...partial,
  });

  test("build and test both known is high", () => {
    expect(scoreConfidence(commands({ build: "x", test: "y" }), 1)).toBe("high");
  });

  test("some commands is medium", () => {
    expect(scoreConfidence(commands({ build: "x" }), 1)).toBe("medium");
  });

  test("no manifest or no commands is low — the interview will ask", () => {
    expect(scoreConfidence(commands({ build: "x" }), 0)).toBe("low");
    expect(scoreConfidence(commands({}), 2)).toBe("low");
  });
});

describe("commands are auditable", () => {
  test("shell metacharacters are rejected: a command must be a single argv", () => {
    expect(isSingleArgvCommand("npm run build")).toBe(true);
    expect(isSingleArgvCommand("npm run build && rm -rf /")).toBe(false);
    expect(isSingleArgvCommand("cat x | sh")).toBe(false);
    expect(isSingleArgvCommand("")).toBe(false);
  });
});

describe("detectWorkspace", () => {
  let multi: Fixture;

  beforeAll(async () => { multi = await multiRepoFixture(); });
  afterAll(async () => { await multi.cleanup(); });

  test("reports both repos with slug names, relative paths and detected commands", async () => {
    const workspace = await detectWorkspace(multi.root, runner);
    expect(workspace.mode).toBe("multi-repo");
    expect(workspace.repos.map((repo) => repo.name)).toEqual(["api-service", "lab"]);

    const lab = workspace.repos.find((repo) => repo.name === "lab");
    expect(lab?.path).toBe("lab");
    expect(lab?.defaultBranch).toBe("main");
    expect(lab?.confidence).toBe("high");
    expect(lab?.commands.build).toBe("npm run build");
    for (const repo of workspace.repos) {
      for (const command of Object.values(repo.commands)) {
        if (command !== null) expect(isSingleArgvCommand(command)).toBe(true);
      }
    }
  });

  test("a repo with no manifest is low confidence rather than guessed at", async () => {
    const bare = join(multi.root, "notes");
    await Bun.write(join(bare, "README.md"), "# notes\n");
    const proc = Bun.spawn(["git", "init", "-b", "main"], { cwd: bare, stdout: "pipe", stderr: "pipe" });
    await proc.exited;

    const workspace = await detectWorkspace(multi.root, runner);
    const notes = workspace.repos.find((repo) => repo.name === "notes");
    expect(notes?.confidence).toBe("low");
    expect(notes?.stack).toEqual([]);
    expect(notes?.commands).toEqual({ build: null, test: null, lint: null, typecheck: null, run: null });
    await rm(bare, { recursive: true, force: true });
  });
});
