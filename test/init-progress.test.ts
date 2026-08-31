/**
 * What `tldrx init` says WHILE it works, and what it must not say.
 *
 * The bug this file pins: init printed nothing at all until it was finished —
 * measured 2026-08-30 at 36.0 s of silence on a five-repo workspace with the
 * default `--provider auto`, against 1.3 s with `--provider static`, so almost
 * the whole wait was one loop that never spoke.
 *
 * Every renderer here is a pure function of its input and every clock is
 * injected, so there is not one timer and not one real duration in this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SpawnCommandRunner } from "../src/core/detect/index.ts";
import { walkFiles, SKIPPED_DIRS } from "../src/core/detect/walk.ts";
import { countCodeFiles } from "../src/core/detect/codeFiles.ts";
import { findRepos } from "../src/core/detect/findRepos.ts";
import { runInit, type InitReport } from "../src/core/init/runInit.ts";
import type { InitOptions } from "../src/core/init/InitOptions.ts";
import { parseInitArgs, renderReport, startInitSteps } from "../src/cli/commands/init.ts";
import { palette, colorEnabled, stripAnsi } from "../src/core/ui/color.ts";
import { renderCampus } from "../src/core/ui/campus.ts";
import { startSteps, silentSteps, HEARTBEAT_MS, type StepOptions } from "../src/core/ui/steps.ts";
import { multiRepoFixture, noisyRepoFixture, type Fixture } from "./init-fixture.ts";

const runner = new SpawnCommandRunner();
const NOW = new Date("2026-08-28T12:00:00Z");
/** A frozen clock: every elapsed time in this file is zero, so nothing prints a duration. */
const FROZEN = (): number => 1_756_468_800_000;

interface Recorder {
  readonly lines: string[];
  readonly write: (text: string) => void;
}

function recorder(): Recorder {
  const chunks: string[] = [];
  return {
    write: (text: string): void => { chunks.push(text); },
    get lines(): string[] {
      return chunks.join("").split("\n").filter((line) => line !== "");
    },
  };
}

function steps(out: Recorder, overrides: Partial<StepOptions> = {}) {
  return startSteps({
    root: "/work/scavtopia",
    isTty: false,
    cols: 100,
    rows: 40,
    env: {},
    write: out.write,
    now: FROZEN,
    schedule: () => null,
    ...overrides,
  });
}

describe("the palette", () => {
  test("a disabled palette is the identity, so a renderer never branches on colour", () => {
    const ink = palette(false);
    expect(ink.enabled).toBe(false);
    expect(ink.green("ok")).toBe("ok");
    expect(ink.bold(ink.magenta("t l d r x"))).toBe("t l d r x");
  });

  test("an enabled palette wraps, and stripAnsi undoes it exactly", () => {
    const ink = palette(true);
    expect(ink.green("ok")).toBe("\x1b[32mok\x1b[0m");
    expect(stripAnsi(ink.bold(ink.cyan("init")))).toBe("init");
  });

  test("FORCE_COLOR beats NO_COLOR beats CI beats the stream", () => {
    expect(colorEnabled({ isTty: false, env: { FORCE_COLOR: "1", NO_COLOR: "1" } })).toBe(true);
    expect(colorEnabled({ isTty: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(colorEnabled({ isTty: true, env: { CI: "true" } })).toBe(false);
    expect(colorEnabled({ isTty: true, env: {} })).toBe(true);
    expect(colorEnabled({ isTty: false, env: {} })).toBe(false);
    // The conventional "set at all" reading, and its two exceptions.
    expect(colorEnabled({ isTty: true, env: { NO_COLOR: "0" } })).toBe(true);
    expect(colorEnabled({ isTty: true, env: { NO_COLOR: "" } })).toBe(true);
  });
});

describe("the campus banner", () => {
  test("it is a schoolhouse, and without colour it is eight plain rows", () => {
    const rows = renderCampus({ root: "/work/scavtopia", palette: palette(false), cols: 100 });
    expect(rows).toHaveLength(8);
    expect(rows.join("\n")).not.toContain("\x1b");
    expect(rows[1]).toContain("t l d r x   i n i t");
    expect(rows[5]).toContain("/work/scavtopia");
    // The drawing itself, so a careless edit to the ASCII is a failing test.
    expect(rows.map((row) => stripAnsi(row).slice(0, 17))).toEqual([
      "       .-.",
      "      ( ^ )      ",
      "       '-'",
      "    .-------.    ",
      "   /_________\\",
      "   | .-. .-. |   ",
      "   | |_| |_| |",
      "   |___[+]___|",
    ]);
  });

  test("colour changes the escapes, never the drawing", () => {
    const plain = renderCampus({ root: "/work/scavtopia", palette: palette(false), cols: 100 });
    const colour = renderCampus({ root: "/work/scavtopia", palette: palette(true), cols: 100 });
    expect(colour.join("\n")).toContain("\x1b[");
    expect(colour.map((row) => stripAnsi(row).trimEnd())).toEqual(plain.map((row) => row.trimEnd()));
  });

  test("a long root is clipped from the left, so the tail stays readable", () => {
    const rows = renderCampus({ root: `/very/long/${"x".repeat(200)}/scavtopia`, palette: palette(false), cols: 60 });
    expect(rows[5]?.length).toBeLessThanOrEqual(60);
    expect(rows[5]).toContain("scavtopia");
  });
});

describe("the step reporter", () => {
  test("plain mode writes one line as a step starts and one when it ends", () => {
    const out = recorder();
    const view = steps(out);
    expect(view.mode).toBe("plain");
    const step = view.begin("detecting repos");
    step.note("mobile — typescript, react, expo · medium confidence · main");
    step.done("multi-repo — 5 repos: mobile, lab");
    view.stop();

    expect(out.lines).toEqual([
      "  · detecting repos…",
      "      mobile — typescript, react, expo · medium confidence · main",
      "  ✓ multi-repo — 5 repos: mobile, lab",
    ]);
  });

  test("plain mode carries no escapes at all — it is what a pipe and a CI log get", () => {
    const out = recorder();
    const view = steps(out, { env: { FORCE_COLOR: "1" } });
    view.begin("detecting repos").done("2 repos");
    view.stop();
    expect(out.lines.join("\n")).not.toContain("\x1b");
  });

  test("`tick` moves a terminal line but is dropped from a log", () => {
    const out = recorder();
    const view = steps(out);
    const step = view.begin("seeding experts");
    step.tick("product");
    step.tick("architect");
    step.done("16 experts at level 0");
    view.stop();
    expect(out.lines).toEqual(["  · seeding experts…", "  ✓ 16 experts at level 0"]);
  });

  test("a failed step is marked, and the list keeps going", () => {
    const out = recorder();
    const view = steps(out);
    view.begin("detecting repos").fail("no git repo at /work/scavtopia");
    view.begin("writing .tldrx/workspace.yml").done(".tldrx/workspace.yml");
    view.stop();
    expect(out.lines[1]).toBe("  ✗ no git repo at /work/scavtopia");
  });

  test("a step left open by a throwing caller is closed, not leaked into the next one", () => {
    const out = recorder();
    const view = steps(out);
    view.begin("building the code map");
    view.begin("writing .tldrx/workspace.yml").done("done");
    view.stop();
    expect(out.lines).toEqual([
      "  · building the code map…",
      "  ✓ building the code map",
      "  · writing .tldrx/workspace.yml…",
      "  ✓ done",
    ]);
  });

  test("a long step says so in plain mode, where there is no spinner to prove it is alive", () => {
    const out = recorder();
    let beat: (() => void) | null = null;
    let clock = 0;
    const view = startSteps({
      root: "/work/scavtopia", isTty: false, cols: 100, rows: 40, env: {},
      write: out.write,
      now: () => clock,
      schedule: (fn) => { beat = fn; return null; },
    });
    const step = view.begin("building the code map");
    clock += 1_000;
    (beat as unknown as () => void)();
    clock += HEARTBEAT_MS;
    (beat as unknown as () => void)();
    step.done("31 map documents via graphify");
    view.stop();

    expect(out.lines).toEqual([
      "  · building the code map…",
      "      still building the code map — 6 s",
      "  ✓ 31 map documents via graphify  (6 s)",
    ]);
  });

  test("a terminal gets a spinner, colour and an in-place rewrite", () => {
    const out = recorder();
    const view = steps(out, { isTty: true, flag: "compact" });
    expect(view.mode).toBe("compact");
    const step = view.begin("building the code map");
    step.tick("scavtopia-workflows…");
    step.done("31 map documents via graphify");
    view.stop();

    const text = out.lines.join("\n");
    expect(text).toContain("\x1b[36m");            // the spinner is cyan
    expect(text).toContain("\x1b[32m✓\x1b[0m");    // the tick is green
    expect(text).toContain("\r\x1b[2K");           // the line is rewritten, not appended
    expect(text).toContain("\x1b[?25l");           // and the cursor is hidden while it moves
    expect(text).toContain("\x1b[?25h");           // and given back on stop()
  });

  test("scene mode paints the schoolhouse; compact mode does not", () => {
    const wide = recorder();
    steps(wide, { isTty: true, flag: "scene" }).stop();
    expect(stripAnsi(wide.lines.join("\n"))).toContain("|___[+]___|");

    const short = recorder();
    steps(short, { isTty: true, flag: "compact" }).stop();
    expect(stripAnsi(short.lines.join("\n"))).not.toContain("|___[+]___|");
  });

  test("a pipe, NO_COLOR and CI all degrade to plain — an explicit --ui scene included", () => {
    for (const env of [{ NO_COLOR: "1" }, { CI: "1" }] as const) {
      const out = recorder();
      const view = steps(out, { isTty: true, flag: "scene", env });
      expect(view.mode).toBe("plain");
      view.begin("detecting repos").done("2 repos");
      view.stop();
      expect(out.lines.join("\n")).not.toContain("\x1b");
    }
    const piped = recorder();
    expect(steps(piped, { isTty: false, flag: "scene" }).mode).toBe("plain");
  });

  test("`--ui off` and the silent reporter render nothing and claim nothing", () => {
    const out = recorder();
    const view = steps(out, { isTty: true, flag: "off" });
    expect(view.active).toBe(false);
    view.begin("detecting repos").done("2 repos");
    view.say("anything");
    view.stop();
    expect(out.lines).toEqual([]);

    const silent = silentSteps();
    expect(silent.active).toBe(false);
    expect(silent.mode).toBe("off");
  });

  test("stop() is idempotent", () => {
    const out = recorder();
    const view = steps(out, { isTty: true, flag: "compact" });
    view.stop();
    const after = out.lines.length;
    view.stop();
    expect(out.lines).toHaveLength(after);
  });
});

describe("`--quiet` and `--ui` on the command line", () => {
  test("--quiet installs a reporter that renders nothing", () => {
    const options = parseInitArgs(["--quiet", "--root", "/work/scavtopia"]);
    expect(options.quiet).toBe(true);
    expect(startInitSteps(options).active).toBe(false);
  });

  test("--ui is carried through, and a value nobody could have meant is refused", () => {
    expect(parseInitArgs(["--ui", "plain"]).ui).toBe("plain");
    expect(parseInitArgs([]).ui).toBeUndefined();
    expect(parseInitArgs([]).quiet).toBe(false);
    expect(() => parseInitArgs(["--ui", "nope"])).toThrow(/--ui expects/);
    expect(() => parseInitArgs(["--ui"])).toThrow(/--ui needs a value/);
  });
});

describe("tldrx init reports every step as it happens", () => {
  let fixture: Fixture;
  let out: Recorder;
  let report: InitReport;

  beforeAll(async () => {
    fixture = await multiRepoFixture();
    out = recorder();
    const view = steps(out, { root: fixture.root });
    report = await runInit(options(fixture.root), { runner, cliVersion: "0.0.1", now: NOW, steps: view });
    view.stop();
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("every stage of the install loop announces itself, in order", () => {
    expect(out.lines.filter((line) => line.startsWith("  · "))).toEqual([
      "  · detecting repos…",
      "  · building the code map…",
      "  · writing .tldrx/workspace.yml…",
      "  · planning the interview…",
      "  · seeding experts…",
      "  · reading conventions…",
      "  · writing the process and facts files…",
      "  · writing .tldrx/init-questions.md…",
      "  · writing .tldrx/init-handoff.md…",
      "  · updating .gitignore and CLAUDE.md…",
    ]);
  });

  test("each one says what came of it, and the numbers match the report", () => {
    const done = out.lines.filter((line) => line.startsWith("  ✓ "));
    expect(done[0]).toBe("  ✓ multi-repo — 2 repos: api-service, lab");
    expect(done[1]).toBe(`  ✓ ${report.map.files.length} map documents via static`);
    expect(done[2]).toBe("  ✓ .tldrx/workspace.yml — 2 repos, 9 gate commands");
    expect(done).toContain(`  ✓ ${report.experts.length} experts at level 0`);
    expect(done).toContain(`  ✓ ${report.questions.length} questions detection could not answer`);
    expect(done.at(-1)).toBe("  ✓ .gitignore, CLAUDE.md — one marked block each");
  });

  test("the slow part names the repo it is inside — the whole point of the fix", () => {
    expect(out.lines).toContain("      api-service — 6 documents via static");
    expect(out.lines).toContain("      lab — 6 documents via static");
  });

  test("detection names each repo with its stack, confidence and branch", () => {
    expect(out.lines).toContain("      lab — typescript, react, vite · high confidence · main");
  });

  test("a run with no reporter is silent and returns exactly the same report", async () => {
    const quiet = await runInit(options(fixture.root), { runner, cliVersion: "0.0.1", now: NOW });
    expect(quiet.map.files).toEqual(report.map.files);
    expect(quiet.experts.map((expert) => expert.name)).toEqual(report.experts.map((expert) => expert.name));
  });
});

describe("the end summary", () => {
  let fixture: Fixture;
  let report: InitReport;

  beforeAll(async () => {
    fixture = await multiRepoFixture();
    report = await runInit(options(fixture.root), { runner, cliVersion: "0.0.1", now: NOW });
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("it still says what was written where, and what to run next", () => {
    const text = renderReport(report, options(fixture.root), palette(false));
    expect(text).not.toContain("\x1b");
    expect(text).toContain("tldrx init — multi-repo, 2 repo(s)");
    expect(text).toContain("lab                  typescript, react, vite · confidence high · branch main");
    expect(text).toContain(`  files      ${report.written.length} written · ${report.created.length} created · 0 kept`);
    expect(text).toContain("Next: read .tldrx/init-handoff.md, then run `tldrx interview --init`");
  });

  test("colour marks the repo, the confidence and the two write verbs — and nothing else moves", () => {
    const text = renderReport(report, options(fixture.root), palette(true));
    expect(text).toContain("\x1b[32mhigh\x1b[0m");
    expect(text).toContain("\x1b[36mlab                 \x1b[0m");
    expect(text).toContain("\x1b[32mcreated\x1b[0m");
    expect(stripAnsi(text)).toBe(renderReport(report, options(fixture.root), palette(false)));
  });
});

describe("the walk never enters a vendored or generated tree", () => {
  let fixture: Fixture;

  beforeAll(async () => { fixture = await noisyRepoFixture(); });
  afterAll(async () => { await fixture.cleanup(); });

  test("node_modules, dist, bin, obj and .venv are skipped by name", async () => {
    const files = (await walkFiles(fixture.root)).map((file) => file.path);
    expect(files).toContain("src/index.ts");
    for (const dir of ["node_modules", "dist", "bin", "obj", ".venv", ".git"]) {
      expect(SKIPPED_DIRS.has(dir)).toBe(true);
      expect(files.some((path) => path.startsWith(`${dir}/`))).toBe(false);
    }
  });

  test("vendored code is not counted as this repo's code", async () => {
    expect(await countCodeFiles(fixture.root)).toBe(2);
  });

  test("a git repo inside node_modules is not a workspace member", async () => {
    const found = await findRepos(fixture.root);
    expect(found.mode).toBe("single-repo");
    expect(found.repoDirs).toEqual(["."]);
  });
});

function options(root: string, overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    root, out: root, interview: true, methodology: null, mcp: false, stack: [], provider: "static", ...overrides,
  };
}
