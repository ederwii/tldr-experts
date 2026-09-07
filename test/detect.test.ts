import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  detectCi, detectCommands, detectDefaultBranch, detectStack, detectWorkspace,
  findRepos, isSingleArgvCommand, probeCommands, repoSlug, scoreConfidence, uniqueSlug, walkFiles,
  PROBED_SLOTS, PROBE_STATUSES, SpawnCommandRunner, FALLBACK_BRANCH,
  type CommandResult, type CommandRunner, type ProbeOptions, type RepoCommands,
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
    expect(stack.packageJson?.groups.devDependencies).toContain("vite");
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

/**
 * `command_probes` — did the commands `init` is about to write actually run? (#168)
 *
 * Unit tests of the POLICY, so nothing here spawns: every runner is a fake, and the
 * hanging one is the only thing that can prove the deadline is enforced by the probe
 * itself rather than borrowed from whatever runner it was handed.
 */
describe("command probes", () => {
  const AT = "2026-09-06T09:00:00Z";

  function defaults(): ProbeOptions {
    return { at: AT, timeoutMs: 30_000, synthesised: new Set<string>() };
  }

  /** Answers instantly with a fixed exit code, and remembers every argv it was handed. */
  function recordingRunner(
    outcome: { exitCode: number },
  ): CommandRunner & { readonly calls: { argv: readonly string[]; cwd: string }[] } {
    const calls: { argv: readonly string[]; cwd: string }[] = [];
    return {
      calls,
      run(argv: readonly string[], cwd: string): Promise<CommandResult> {
        calls.push({ argv, cwd });
        return Promise.resolve({ exitCode: outcome.exitCode, stdout: "", stderr: "" });
      },
    };
  }

  /** A runner whose promise NEVER settles. Only the probe's own deadline can end this. */
  function hangingRunner(): CommandRunner {
    return { run: (): Promise<CommandResult> => new Promise<CommandResult>(() => { /* never */ }) };
  }

  test("each gate slot is probed once, through the runner, and `run` never is", async () => {
    const runner = recordingRunner({ exitCode: 0 });
    const probes = await probeCommands(runner, "/repo", {
      build: "npm run build", test: "npm run test", lint: null, typecheck: "npm run typecheck",
      run: "npm run dev",
    }, defaults());

    expect(runner.calls.map((call) => call.argv.join(" "))).toEqual([
      "npm run build", "npm run test", "npm run typecheck",
    ]);
    expect(runner.calls.every((call) => call.cwd === "/repo")).toBe(true);
    // `run` starts a server. It is never probed, and it says so rather than being
    // silently absent.
    expect(probes.run?.verified).toBe(false);
    expect(probes.run?.reason).toContain("not probed");
    expect(probes.build?.verified).toBe(true);
    expect(probes.build?.exit_code).toBe(0);
    expect(probes.build?.at).toBe(AT);
    // A null slot is absent from the probes, never a guessed row.
    expect(probes.lint).toBeUndefined();
  });

  test("a non-zero exit is recorded as measured-and-red, not as absent", async () => {
    const runner = recordingRunner({ exitCode: 2 });
    const probes = await probeCommands(runner, "/repo", { test: "npm run test" }, defaults());
    expect(probes.test?.verified).toBe(false);
    expect(probes.test?.exit_code).toBe(2);
    expect(probes.test?.reason).toContain("exited 2");
  });

  test("a timeout writes `verified: false` with the reason and no exit code", async () => {
    const runner = hangingRunner();
    const probes = await probeCommands(runner, "/repo", { test: "npm run test" },
      { ...defaults(), timeoutMs: 20 });
    expect(probes.test?.verified).toBe(false);
    expect(probes.test?.exit_code).toBeNull();
    expect(probes.test?.reason).toContain("timed out");
  });

  test("a slow but successful probe is a pass, not a timeout", async () => {
    // The classification is completion-before-deadline, so a command that finishes at
    // 30 ms under a 2000 ms budget is verified — a probe that called anything slow a
    // timeout would be reporting the clock, not the command.
    const slow: CommandRunner = {
      run: () => new Promise<CommandResult>((resolve) => {
        setTimeout(() => { resolve({ exitCode: 0, stdout: "", stderr: "" }); }, 30);
      }),
    };
    const probes = await probeCommands(slow, "/repo", { test: "npm run test" },
      { ...defaults(), timeoutMs: 2000 });
    expect(probes.test?.verified).toBe(true);
    expect(probes.test?.exit_code).toBe(0);
  });

  test("a SYNTHESISED command says it was synthesised from the language id", async () => {
    const runner = recordingRunner({ exitCode: 0 });
    const probes = await probeCommands(runner, "/repo", { test: "go test ./..." },
      { ...defaults(), synthesised: new Set(["test"]) });
    expect(probes.test?.reason).toContain("synthesised from the language id");
  });

  test("a command that needs a shell is not probed, and says which one", async () => {
    const runner = recordingRunner({ exitCode: 0 });
    const probes = await probeCommands(runner, "/repo", { test: "npm test | tee log" }, defaults());
    expect(runner.calls).toEqual([]);
    expect(probes.test?.verified).toBe(false);
    expect(probes.test?.exit_code).toBeNull();
    expect(probes.test?.reason).toContain("needs a shell");
  });

  test("`skip` records the reason on every slot and spawns nothing", async () => {
    const runner = recordingRunner({ exitCode: 0 });
    const probes = await probeCommands(runner, "/repo", { build: "npm run build", run: "npm run dev" },
      { ...defaults(), skip: "skipped: --no-probe" });
    expect(runner.calls).toEqual([]);
    expect(probes.build).toEqual({
      status: "skipped", verified: false, exit_code: null, at: AT, reason: "skipped: --no-probe",
    });
    // `run` is never probed for its own reason, which stays the more specific truth.
    expect(probes.run?.reason).toContain("not probed");
  });

  /**
   * `exited 127` and `never started` are DIFFERENT rows (#168, review round 1).
   *
   * Both reach the probe as exit 127, because both runtimes settle a failed spawn that
   * way. Before `spawnFailed` was carried through the seam, a machine with no `go` on
   * PATH got `exit_code: 127` in `workspace.yml` — a measurement of a process that was
   * never started, which `initProbeLine` would then quote back in a build refusal.
   */
  describe("a command that never started is not a command that exited", () => {
    /** What `SpawnCommandRunner` really returns for ENOENT: 127, and `spawnFailed`. */
    function enoentRunner(): CommandRunner {
      return {
        run: (): Promise<CommandResult> => Promise.resolve({
          exitCode: 127, stdout: "", stderr: "spawn go ENOENT\n", spawnFailed: true,
        }),
      };
    }

    test("a spawn failure is `unspawnable`, with no exit code and the system's own message", async () => {
      const probes = await probeCommands(enoentRunner(), "/repo", { build: "go build ./..." },
        { ...defaults(), synthesised: new Set(["build"]) });
      expect(probes.build?.status).toBe("unspawnable");
      expect(probes.build?.verified).toBe(false);
      expect(probes.build?.exit_code).toBeNull();
      expect(probes.build?.reason).toContain("could not be started");
      expect(probes.build?.reason).toContain("spawn go ENOENT");
      // Still says where the command came from, which is the whole point for a go repo.
      expect(probes.build?.reason).toContain("synthesised from the language id");
    });

    test("a real exit 127 stays a measurement, and the reason says what 127 means", async () => {
      // `npm run build` whose `vite` is missing: npm STARTED and exited 127.
      const probes = await probeCommands(recordingRunner({ exitCode: 127 }), "/repo",
        { build: "npm run build" }, defaults());
      expect(probes.build?.status).toBe("failed");
      expect(probes.build?.exit_code).toBe(127);
      expect(probes.build?.reason).toContain("exited 127");
      expect(probes.build?.reason).toContain("not found");
    });

    test("a runner that rejects lands in the same row, never in the timeout row", async () => {
      const throwing: CommandRunner = { run: () => Promise.reject(new Error("EACCES: permission denied")) };
      const probes = await probeCommands(throwing, "/repo", { test: "npm run test" }, defaults());
      expect(probes.test?.status).toBe("unspawnable");
      expect(probes.test?.exit_code).toBeNull();
      expect(probes.test?.reason).toContain("could not be started");
      expect(probes.test?.reason).toContain("EACCES");
      expect(probes.test?.reason).not.toContain("timed out");
    });

    test("a runner that reports its OWN timeout is a timeout, not an exit", async () => {
      const killed: CommandRunner = {
        run: (): Promise<CommandResult> => Promise.resolve({
          exitCode: 143, stdout: "", stderr: "", timedOut: true,
        }),
      };
      const probes = await probeCommands(killed, "/repo", { test: "npm run test" }, defaults());
      expect(probes.test?.status).toBe("timed-out");
      expect(probes.test?.exit_code).toBeNull();
      expect(probes.test?.reason).toContain("timed out");
    });

    test("an unbounded system message is capped — `reason` is the only free text in the file", async () => {
      const shouty: CommandRunner = {
        run: (): Promise<CommandResult> => Promise.resolve({
          exitCode: 127, stdout: "", stderr: `${"x".repeat(5000)}\nsecond line`, spawnFailed: true,
        }),
      };
      const probes = await probeCommands(shouty, "/repo", { test: "npm run test" }, defaults());
      expect(probes.test?.reason.length).toBeLessThan(400);
      expect(probes.test?.reason).not.toContain("second line");
    });
  });

  test("every row's `verified` and `exit_code` are decided by its status, in one place", async () => {
    // The single derivation: nothing can emit `verified: true` beside a red status, or a
    // confident exit code beside a status that means nothing exited.
    const probes = await probeCommands(recordingRunner({ exitCode: 0 }), "/repo", {
      build: "npm run build", test: "npm run test", run: "npm run dev",
    }, { ...defaults(), skip: "skipped: --no-probe" });
    for (const probe of Object.values(probes)) {
      expect(PROBE_STATUSES).toContain(probe.status);
      expect(probe.verified).toBe(probe.status === "ok");
      if (probe.status !== "ok" && probe.status !== "failed") expect(probe.exit_code).toBeNull();
    }
  });

  test("`run` is not in the probed set — the exclusion is data, not a branch someone can drop", () => {
    expect([...PROBED_SLOTS]).toEqual(["build", "test", "lint", "typecheck"]);
    expect(PROBED_SLOTS).not.toContain("run");
  });
});
