/**
 * The project's own `.gitignore` must not swallow tldrx state.
 *
 * Found in the wild 2026-08-30: a repo carrying the stock .NET `[Ll]og/` rule,
 * where `tldrx-work/<run>/04-build/log/<story>.md` — the Build phase's per-story
 * review log, spec §1 `[c]` committed — was written and silently never committed.
 *
 * Every assertion here goes through a REAL `git check-ignore` in a REAL repo.
 * Gitignore precedence is not something to assert from memory: the reason the
 * managed block needs both `!tldrx-work/` and `!tldrx-work/**`, and the reason
 * the framework's own ignores must come AFTER the negations, are both facts about
 * git that only git can confirm.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITIGNORE_BODY,
  GITIGNORE_IGNORES,
  GITIGNORE_NEGATIONS,
  writeAmbientFootprint,
} from "../src/core/init/ambientFootprint.ts";
import { GITIGNORE_MARKERS, upsertBlock } from "../src/core/init/markerBlock.ts";
import { WriteLog } from "../src/core/init/writeFile.ts";
import { DoctorReport } from "../src/core/doctor/DoctorReport.ts";
import { runDoctor } from "../src/core/doctor/runDoctor.ts";
import { doctorJson } from "../src/cli/commands/doctor.ts";
import {
  describeRule,
  findGitignoreShadows,
  parseCheckIgnoreZ,
  probePaths,
  LOG_PROBE_NAME,
} from "../src/core/doctor/gitignoreShadow.ts";

/** The stock .NET rules, verbatim — this is the pair that produced the bug. */
const DOTNET_RULES = "[Ll]og/\n[Ll]ogs/\n";

const RUN = "260830-scores";
const STORY_LOG = `tldrx-work/${RUN}/04-build/log/S1.md`;
const PRODUCT_LOG = "Logs/build.log";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tldrx-gitignore-"));
  await spawn(["git", "init", "-b", "main"], root);
  await spawn(["git", "config", "user.email", "fixture@example.com"], root);
  await spawn(["git", "config", "user.name", "Fixture"], root);

  for (const rel of [
    STORY_LOG,
    `tldrx-work/${RUN}/run.yml`,
    `tldrx-work/${RUN}/events.jsonl`,
    `tldrx-work/${RUN}/.lock`,
    `tldrx-work/${RUN}/.agent/prompt.md`,
    ".tldrx/memory/facts.yml",
    ".tldrx/cache/digest.json",
    ".tldrx/graphify-out/graph.json",
    PRODUCT_LOG,
    "log/app.log",
    "src/App.cs",
  ]) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), "x\n");
  }
  await writeFile(join(root, ".gitignore"), DOTNET_RULES);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the bug, before the fix", () => {
  test("a stock `[Ll]og/` rule ignores the build's per-story review log", async () => {
    expect(await isIgnored(STORY_LOG)).toBe(true);
    expect(await ruleFor(STORY_LOG)).toBe(".gitignore:1:[Ll]og/");
  });

  test("doctor names the offending file:line and the rule", async () => {
    const shadow = await findGitignoreShadows(root);
    expect(shadow.ran).toBe(true);
    expect(shadow.error).toBeNull();
    const paths = shadow.shadowed.map((s) => s.path);
    expect(paths).toContain(`tldrx-work/${RUN}/04-build/log/${LOG_PROBE_NAME}`);
    const hit = shadow.shadowed.find((s) => s.path.endsWith(LOG_PROBE_NAME));
    expect(hit).toBeDefined();
    expect(describeRule(hit as NonNullable<typeof hit>)).toBe(".gitignore:1:[Ll]og/");
  });

  test("the report says it, and the exit code does not move", async () => {
    const shadow = await findGitignoreShadows(root);
    const rendered = new DoctorReport([], null, [], shadow).render();
    expect(rendered).toContain("Gitignore shadow:");
    expect(rendered).toContain(".gitignore:1:[Ll]og/");
    expect(rendered).toContain("does not change the exit code");
    // `healthy` is about the tools; a shadow must never flip it.
    expect(new DoctorReport([], null, [], shadow).healthy).toBe(true);
  });
});

describe("the fix: init's managed block", () => {
  beforeEach(async () => {
    await writeAmbientFootprint(root, new WriteLog());
  });

  test("the story log is no longer ignored — `git check-ignore` exits 1", async () => {
    const result = await spawn(["git", "check-ignore", STORY_LOG], root);
    expect(result.exitCode).toBe(1);
    expect(await isIgnored(STORY_LOG)).toBe(false);
  });

  test("every probed state path survives", async () => {
    for (const path of probePaths(root)) expect(await isIgnored(path)).toBe(false);
    const shadow = await findGitignoreShadows(root);
    expect(shadow.shadowed).toEqual([]);
    expect(shadow.probed).toHaveLength(4);
  });

  test("the product's own log rules still work", async () => {
    expect(await isIgnored(PRODUCT_LOG)).toBe(true);
    expect(await ruleFor(PRODUCT_LOG)).toBe(".gitignore:2:[Ll]ogs/");
    expect(await isIgnored("log/app.log")).toBe(true);
  });

  test("the framework's own ignores still win, because they come after", async () => {
    for (const path of [
      `tldrx-work/${RUN}/.lock`,
      `tldrx-work/${RUN}/.agent/prompt.md`,
      ".tldrx/cache/digest.json",
      ".tldrx/graphify-out/graph.json",
    ]) {
      expect(await isIgnored(path)).toBe(true);
    }
    // Not an accident of the array literal: assert the ORDER in the emitted body.
    const body = GITIGNORE_BODY.split("\n");
    expect(body.indexOf("!.tldrx/**")).toBeLessThan(body.indexOf(".tldrx/cache/"));
    expect(body.indexOf("!tldrx-work/**")).toBeLessThan(body.indexOf("tldrx-work/*/.lock"));
  });

  test("the whole state tree is committable, not just the probes", async () => {
    await spawn(["git", "add", "-A"], root);
    const tracked = (await spawn(["git", "ls-files"], root)).stdout.split("\n");
    expect(tracked).toContain(STORY_LOG);
    expect(tracked).toContain(`tldrx-work/${RUN}/run.yml`);
    expect(tracked).toContain(".tldrx/memory/facts.yml");
    expect(tracked).not.toContain(`tldrx-work/${RUN}/.lock`);
    expect(tracked).not.toContain(PRODUCT_LOG);
  });

  test("doctor reports clean once the block is there", async () => {
    const shadow = await findGitignoreShadows(root);
    expect(new DoctorReport([], null, [], shadow).render())
      .toContain("State files vs .gitignore: 4 probed, none ignored.");
  });
});

describe("wired into `tldrx doctor` end to end", () => {
  test("the warning reaches the rendered output and the JSON, without moving the exit code", async () => {
    const shadowed = await runDoctor({ mcp: false, root });
    expect(shadowed.output).toContain("Gitignore shadow:");
    expect(shadowed.output).toContain(".gitignore:1:[Ll]og/");
    expect(shadowed.gitignoreShadow?.ran).toBe(true);
    expect(shadowed.exitCode).toBe(shadowed.healthy ? 0 : 1);
    expect(JSON.parse(doctorJson(shadowed)).gitignoreShadow.shadowed.length).toBeGreaterThan(0);

    await writeAmbientFootprint(root, new WriteLog());
    const clean = await runDoctor({ mcp: false, root });
    expect(clean.output).toContain("State files vs .gitignore: 4 probed, none ignored.");
    expect(clean.gitignoreShadow?.shadowed).toEqual([]);
    // The one thing that must NOT change: a shadow is a warning.
    expect(clean.exitCode).toBe(shadowed.exitCode);
  }, 60_000);
});

describe("a project rule that eats the state ROOTS, not just a subfolder", () => {
  test("`*-work/` and `.tldrx/` are undone too — this is why the bare negations exist", async () => {
    await writeFile(join(root, ".gitignore"), "*-work/\n.tldrx/\n");
    expect(await isIgnored(`tldrx-work/${RUN}/run.yml`)).toBe(true);

    await writeAmbientFootprint(root, new WriteLog());
    for (const path of probePaths(root)) expect(await isIgnored(path)).toBe(false);

    // Without the bare-directory negations the `**` pair cannot reach inside,
    // because gitignore does not re-include a file under an excluded directory.
    await writeFile(
      join(root, ".gitignore"),
      upsertBlock("*-work/\n.tldrx/\n", "!tldrx-work/**\n!.tldrx/**", GITIGNORE_MARKERS),
    );
    expect(await isIgnored(`tldrx-work/${RUN}/run.yml`)).toBe(true);
  });
});

describe("init is idempotent, and upgrades a block written before the fix", () => {
  /** The block exactly as v0.3.0 shipped it: the ignores, no negations. */
  const OLD_BODY = GITIGNORE_IGNORES.join("\n");

  test("an old block is replaced in place, markers and neighbours preserved", async () => {
    const before = `${DOTNET_RULES}\n${upsertBlock("", OLD_BODY, GITIGNORE_MARKERS)}\n# my own rule\nbin/\n`;
    await writeFile(join(root, ".gitignore"), before);
    expect(await isIgnored(STORY_LOG)).toBe(true);

    await writeAmbientFootprint(root, new WriteLog());

    const after = await Bun.file(join(root, ".gitignore")).text();
    expect(after.match(new RegExp(GITIGNORE_MARKERS.begin, "g"))).toHaveLength(1);
    expect(after.match(new RegExp(GITIGNORE_MARKERS.end, "g"))).toHaveLength(1);
    expect(after).toContain(DOTNET_RULES.trim());
    expect(after).toContain("# my own rule");
    expect(after).toContain("bin/");
    for (const negation of GITIGNORE_NEGATIONS) expect(after).toContain(negation);
    expect(await isIgnored(STORY_LOG)).toBe(false);
    expect(await isIgnored("bin/x.dll")).toBe(true);
  });

  test("re-running leaves the file byte-identical", async () => {
    await writeAmbientFootprint(root, new WriteLog());
    const once = await Bun.file(join(root, ".gitignore")).text();
    await writeAmbientFootprint(root, new WriteLog());
    await writeAmbientFootprint(root, new WriteLog());
    expect(await Bun.file(join(root, ".gitignore")).text()).toBe(once);
  });
});

describe("probe selection", () => {
  test("it asks about the newest run, and probes 04-build/log with a synthetic name", async () => {
    await mkdir(join(root, "tldrx-work", "260901-later"), { recursive: true });
    await mkdir(join(root, "tldrx-work", "260101-earlier"), { recursive: true });
    expect(probePaths(root)).toEqual([
      "tldrx-work/260901-later/run.yml",
      "tldrx-work/260901-later/events.jsonl",
      `tldrx-work/260901-later/04-build/log/${LOG_PROBE_NAME}`,
      ".tldrx/memory/facts.yml",
    ]);
  });

  test("a workspace with no run still gets probed — the rules apply to it too", async () => {
    await rm(join(root, "tldrx-work"), { recursive: true, force: true });
    const paths = probePaths(root);
    expect(paths).toHaveLength(4);
    expect(paths[0]).toBe("tldrx-work/000000-doctor-probe/run.yml");
    expect(await isIgnored(paths[2] as string)).toBe(true); // still shadowed by `[Ll]og/`
  });
});

describe("parsing `git check-ignore -v -z`", () => {
  /** `\\0` followed by a digit is an OCTAL escape in JS, so records are joined. */
  const record = (...fields: readonly string[]): string => fields.join("\u0000") + "\u0000";

  test("a `!` pattern is a re-inclusion, not a shadow", () => {
    expect(parseCheckIgnoreZ(record(".gitignore", "5", "!tldrx-work/**", "tldrx-work/r/run.yml")))
      .toEqual([]);
  });

  test("four NUL-separated fields per record, several records", () => {
    const stdout = record(".gitignore", "1", "[Ll]og/", "a/log/x.md")
      + record(".git/info/exclude", "7", "*.yml", "b/run.yml");
    expect(parseCheckIgnoreZ(stdout)).toEqual([
      { path: "a/log/x.md", source: ".gitignore", line: 1, pattern: "[Ll]og/" },
      { path: "b/run.yml", source: ".git/info/exclude", line: 7, pattern: "*.yml" },
    ]);
  });

  test("no output at all means nothing matched any rule", () => {
    expect(parseCheckIgnoreZ("")).toEqual([]);
  });
});

describe("when git cannot answer", () => {
  test("`ran: false` is reported, and it is not the claim `nothing is wrong`", async () => {
    const bare = await mkdtemp(join(tmpdir(), "tldrx-norepo-"));
    try {
      const shadow = await findGitignoreShadows(bare);
      expect(shadow.ran).toBe(false);
      expect(shadow.shadowed).toEqual([]);
      expect(shadow.error).toContain("not a git repository");
      expect(new DoctorReport([], null, [], shadow).render())
        .toContain("could not run `git check-ignore`");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("no workspace root at all says so, rather than saying clean", () => {
    expect(new DoctorReport([], null, null, null).render())
      .toContain("State files vs .gitignore: no workspace here — nothing probed.");
  });
});

/** `git check-ignore <path>`: exit 0 = ignored, 1 = not. The exit code, explicitly. */
async function isIgnored(path: string): Promise<boolean> {
  const result = await spawn(["git", "check-ignore", "--no-index", path], root);
  expect([0, 1]).toContain(result.exitCode);
  return result.exitCode === 0;
}

/** `source:line:pattern` of the rule that decided, from `git check-ignore -v`. */
async function ruleFor(path: string): Promise<string> {
  const result = await spawn(["git", "check-ignore", "-v", "--no-index", path], root);
  return (result.stdout.split("\t")[0] ?? "").trim();
}

async function spawn(
  argv: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("empty argv");
  const proc = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}
