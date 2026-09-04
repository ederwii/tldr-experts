/**
 * `tldrx drive [--attended|--unattended]` — the host/driver mandate as a
 * shipped artifact (issue #63).
 *
 * What is asserted here is the CONTRACT of the text, not its prose: that both
 * modes carry the disciplines the first real runs were driven by, that the two
 * modes actually differ where they are supposed to, that neither runs long
 * enough to stop being read, and that printing a mandate needs no workspace,
 * touches no disk and spawns nothing.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import {
  DRIVE_MODES, MANDATE_MAX_LINES, MANDATE_TLDR_MAX_LINES, renderMandate, type DriveMode,
} from "../src/core/drive/index.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function bareDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-drive-"));
  temps.push(dir);
  return dir;
}

async function tldrxIn(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd, env: noSpawnEnv() });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

const VERSION = "0.4.0";

// --- the renderer ------------------------------------------------------------

describe("renderMandate", () => {
  test("there are exactly two modes", () => {
    expect([...DRIVE_MODES]).toEqual(["attended", "unattended"]);
  });

  for (const mode of DRIVE_MODES) {
    const text = renderMandate(mode, VERSION);
    const lines = text.split("\n");

    test(`${mode}: is under ${String(MANDATE_MAX_LINES)} lines`, () => {
      expect(lines.length).toBeLessThanOrEqual(MANDATE_MAX_LINES);
      expect(lines.length).toBeGreaterThan(40);
    });

    test(`${mode}: is stamped with the framework version it shipped with`, () => {
      expect(text).toContain(VERSION);
    });

    test(`${mode}: carries the three-role protocol, and names the author exclusion`, () => {
      expect(text).toContain("Three roles");
      expect(text.toLowerCase()).toContain("never the author");
      // The host is the third role, and its job is the code — not the reports.
      expect(text.toLowerCase()).toContain("in the code");
    });

    test(`${mode}: carries the evidence discipline, all four rules`, () => {
      expect(text).toContain("measured");
      expect(text).toContain("inferred");
      expect(text).toContain("assumed");
      expect(text.toLowerCase()).toContain("exit code");
      expect(text).toContain("ls-remote");
    });

    test(`${mode}: carries the parking discipline and its hard limit`, () => {
      expect(text.toLowerCase()).toContain("park");
      expect(text.toLowerCase()).toContain("open question");
    });

    test(`${mode}: carries review calibration by stakes`, () => {
      expect(text.toLowerCase()).toContain("stakes");
    });

    test(`${mode}: carries budget honesty`, () => {
      expect(text).toContain("--tokens");
      expect(text.toLowerCase()).toContain("floor");
    });

    test(`${mode}: never tells the driver to push`, () => {
      expect(text).toContain("Never push");
    });
  }

  test("the two modes differ in the GATE section", () => {
    const unattended = renderMandate("unattended", VERSION);
    const attended = renderMandate("attended", VERSION);
    expect(unattended).toContain("tldrx approve --as-agent");
    expect(attended).not.toContain("--as-agent");
    expect(attended).toContain("tldrx approve");
  });

  test("the two modes differ in the PREPARE/COMMIT section", () => {
    const unattended = renderMandate("unattended", VERSION);
    const attended = renderMandate("attended", VERSION);
    expect(unattended).toContain("attended_by: host");
    expect(unattended).toContain("The framework must never spawn");
    expect(attended).toContain("tldrx next");
    expect(attended).not.toContain("The framework must never spawn");
  });

  test("the two modes are not the same document", () => {
    expect(renderMandate("attended", VERSION)).not.toBe(renderMandate("unattended", VERSION));
  });
});

// --- the command -------------------------------------------------------------

describe("tldrx drive", () => {
  test("--unattended prints the mandate on stdout and exits 0", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--unattended");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("tldrx approve --as-agent");
    expect(run.stdout.split("\n").length).toBeLessThanOrEqual(MANDATE_MAX_LINES + 1);
  });

  test("--attended prints the other one", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--attended");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).not.toContain("--as-agent");
    expect(run.stdout).toContain("Three roles");
  });

  /**
   * A direction is required and never guessed — the same refusal
   * `tldrx run attend` makes. Guessing here would hand somebody the wrong
   * half of the one thing this command exists to get right.
   */
  test("with no mode it refuses and names both", async () => {
    const run = await tldrxIn(bareDir(), "drive");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--attended");
    expect(run.stderr).toContain("--unattended");
  });

  test("both modes at once is refused too", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--attended", "--unattended");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("one of");
  });

  test("needs no workspace, and writes nothing where it is run", async () => {
    const dir = bareDir();
    const run = await tldrxIn(dir, "drive", "--unattended");
    expect(run.code).toBe(EXIT_OK);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the printed version is the package's own", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--unattended");
    const version = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()).version;
    expect(run.stdout).toContain(version);
  });
});

/**
 * The `<run>` placeholder, filled in (#75).
 *
 * `--unattended` prints a mandate whose every command reads `tldrx next --prepare
 * <run>`, and the header tells the reader to replace `<run>` with the run id — a
 * hand find-replace across ~8 occurrences, done at the exact moment somebody is
 * trying to START a run, where one occurrence missed sends a session at the wrong
 * run. That is the failure this closes.
 *
 * Two ways in, and one thing neither does. An explicit id (positional or `--run`,
 * the same `?? ` order `ship` uses) is substituted TEXTUALLY: no resolution, no
 * validation, no disk — an id that names no run is the operator's typo to notice,
 * exactly as it would be had they typed it themselves, and the command stays the
 * one thing in the CLI that runs anywhere. With no id, and only then, it looks for
 * the ONE open run in the workspace it is standing in.
 *
 * "The ONE open run" — `RunStore.resolve`'s rule, not "the newest open one". A
 * mandate silently pointed at the wrong run is the very bug being fixed, so where
 * the CLI would refuse to choose, this declines to substitute and leaves `<run>`
 * standing, exactly as today. Never resolvable, never a failure: no workspace, no
 * runs, an unreadable one — every path falls back to the placeholder and exit 0.
 */
describe("the mandate's <run> is filled in when there is an id to fill it with (#75)", () => {
  const RUN_ID = "260901-leaderboard";

  test("renderMandate with an id leaves no `<run>` anywhere in it", () => {
    for (const mode of DRIVE_MODES) {
      const text = renderMandate(mode, VERSION, RUN_ID);
      expect(text).not.toContain("<run>");
      // The commands themselves carry it — `tldrx note <run>` is in both modes.
      expect(text).toContain(`tldrx note ${RUN_ID}`);
    }
    expect(renderMandate("unattended", VERSION, RUN_ID)).toContain(`tldrx next --prepare ${RUN_ID}`);
  });

  test("every occurrence is substituted — all of them, not the first", () => {
    // Measured, and pinned so the count cannot drift silently: the issue said "~8",
    // the mandate carried 7 unattended and 5 attended on 2026-09-01, and the #84
    // preflight added three more to each (`run status`, `run attend host` and the
    // `budget.yml` path — the attended mirror has no `attend host` line, so two).
    // The argument does not depend on the number — one occurrence missed by a hand
    // find-replace sends a session at the wrong run — but the number is checkable,
    // so it is checked rather than approximated.
    const counts: Record<DriveMode, number> = { attended: 7, unattended: 10 };
    for (const mode of DRIVE_MODES) {
      const occurrences = renderMandate(mode, VERSION).split("<run>").length - 1;
      expect(occurrences).toBe(counts[mode]);
      const filled = renderMandate(mode, VERSION, RUN_ID);
      expect(filled.split(RUN_ID).length - 1).toBe(occurrences);
    }
  });

  test("without an id the placeholder and its find-replace instruction both stay", () => {
    const text = renderMandate("unattended", VERSION);
    expect(text).toContain("<run>");
    expect(text).toContain("replacing");
  });

  test("with an id the header stops telling the reader to find-replace", () => {
    const text = renderMandate("unattended", VERSION, RUN_ID);
    expect(text).not.toContain("replacing");
    expect(text).toContain(RUN_ID);
  });

  test("filling it in does not push the mandate over its line budget", () => {
    for (const mode of DRIVE_MODES) {
      const lines = renderMandate(mode, VERSION, RUN_ID).split("\n").length;
      expect(lines).toBeLessThanOrEqual(MANDATE_MAX_LINES);
    }
  });

  test("a positional id substitutes, with no workspace anywhere and nothing written", async () => {
    const dir = bareDir();
    const run = await tldrxIn(dir, "drive", "--unattended", RUN_ID);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).not.toContain("<run>");
    expect(run.stdout).toContain(`tldrx next --prepare ${RUN_ID}`);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("`--run <id>` does the same, the spelling every other command takes", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--unattended", "--run", RUN_ID);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).not.toContain("<run>");
    expect(run.stdout).toContain(RUN_ID);
  });

  test("an id that names no run is substituted anyway — not validated, by design", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--attended", "260101-no-such-run");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("260101-no-such-run");
    expect(run.stderr).toBe("");
  });

  test("with no id and no workspace, `<run>` stands and the exit is still 0", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--unattended");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("<run>");
  });
});

/**
 * The workspace half of #75: resolution, and its deliberate limits.
 */
describe("drive resolves the ONE open run, and refuses to guess between two (#75)", () => {
  let workspace: TempRunWorkspace | null = null;

  afterEach(() => {
    workspace?.dispose();
    workspace = null;
  });

  /** A workspace with `slugs.length` open runs, oldest first. */
  function withRuns(...slugs: readonly string[]): { root: string; ids: readonly string[] } {
    workspace = makeRunWorkspace();
    const root = workspace.root;
    const ids = slugs.map((slug, i) => createRun({
      root, slug, scope: "feature", actor: "alan",
      now: new Date(`2026-08-${String(20 + i).padStart(2, "0")}T09:00:00Z`),
    }).runId);
    return { root, ids };
  }

  test("one open run: its id is filled in without being asked for", async () => {
    const { root, ids } = withRuns("leaderboard");
    const run = await tldrxIn(root, "drive", "--unattended");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).not.toContain("<run>");
    expect(run.stdout).toContain(ids[0] as string);
  });

  test("TWO open runs: `<run>` stands rather than one being picked silently", async () => {
    const { root, ids } = withRuns("alpha", "beta");
    const run = await tldrxIn(root, "drive", "--unattended");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("<run>");
    // Silence would be worse than the placeholder: say which ids were on offer.
    for (const id of ids) expect(run.stderr).toContain(id);
  });

  test("…and naming one of them there fills it in", async () => {
    const { root, ids } = withRuns("alpha", "beta");
    const run = await tldrxIn(root, "drive", "--unattended", ids[0] as string);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).not.toContain("<run>");
    expect(run.stdout).toContain(ids[0] as string);
  });

  test("a workspace with no runs at all keeps the placeholder, quietly", async () => {
    workspace = makeRunWorkspace();
    const run = await tldrxIn(workspace.root, "drive", "--attended");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("<run>");
    expect(run.stderr).toBe("");
  });
});

/**
 * The mandate carries its own preflight (#84).
 *
 * The failure this closes was measured on a real cold start (2026-09-02): launching an
 * unattended run took SIX hand-run commands — `run attend host`, then `run gates set` five
 * times — before the mandate could be pasted at all. Every one of them is a precondition of
 * the discipline the mandate exists to transfer, so an owner running them by hand is doing
 * the driver's job for it. A mandate that assumes its own preconditions is a mandate that
 * only works when somebody has already been careful.
 *
 * So the text now starts by establishing them, and the two modes differ here exactly as they
 * differ at the gate: the unattended driver may MOVE a gate to `agent` — over a note quoting
 * the owner's own delegation, so the change is signed by the owner's words rather than the
 * driver's judgement — and the attended one may not, because in that mode every gate is the
 * owner's and moving one would be the driver quietly taking the signature away.
 *
 * The refusal is the load-bearing half. A driver that cannot establish a precondition and
 * starts anyway has spent money on a run whose gates it may not close.
 */
describe("the mandate carries its own preflight (#84)", () => {
  const unattended = renderMandate("unattended", VERSION);
  const attended = renderMandate("attended", VERSION);
  const both = [["unattended", unattended], ["attended", attended]] as const;

  for (const [mode, text] of both) {
    test(`${mode}: the preflight is the FIRST section, ahead of the roles`, () => {
      expect(text).toContain("## Before anything: the preflight");
      expect(text.indexOf("## Before anything: the preflight"))
        .toBeLessThan(text.indexOf("## Three roles"));
    });

    test(`${mode}: it checks attendedness, off the run's own status`, () => {
      expect(text).toContain("tldrx run status <run>");
      expect(text).toContain("attended_by");
    });

    test(`${mode}: it checks budget.yml and makes the driver state the ceiling`, () => {
      expect(text).toContain("`tldrx-work/<run>/budget.yml`");
      expect(text.toLowerCase()).toContain("state the ceiling");
    });

    test(`${mode}: it refuses to start on a precondition it cannot establish, naming the command`, () => {
      expect(text).toContain("REFUSE to start");
      expect(text).toContain("name the command that failed");
    });
  }

  test("unattended: it sets attendedness, and moves a mismatched gate over a cited note", () => {
    expect(unattended).toContain("tldrx run attend host <run>");
    expect(unattended).toContain('tldrx run gates set <stage>:agent --note "…"');
    expect(unattended).toContain("quoting MY delegation from the launch message");
  });

  test("attended: the gates stay human — the mirror never moves one to `agent`", () => {
    expect(attended).not.toContain("gates set <stage>:agent");
    expect(attended).not.toContain("gates set");
    expect(attended).not.toContain(":agent");
    expect(attended).toContain("they stay mine");
  });

  test("the preflight's `<run>` is substituted like every other one (#75)", () => {
    const filled = renderMandate("unattended", VERSION, "260901-leaderboard");
    expect(filled).toContain("tldrx run status 260901-leaderboard");
    expect(filled).toContain("tldrx run attend host 260901-leaderboard");
    expect(filled).toContain("`tldrx-work/260901-leaderboard/budget.yml`");
    expect(filled).not.toContain("<run>");
    // `<stage>` is NOT a run id and must survive untouched, or the command is a lie.
    expect(filled).toContain("<stage>:agent");
  });

  test("adding it kept both mandates inside the line budget", () => {
    for (const mode of DRIVE_MODES) {
      expect(renderMandate(mode, VERSION).split("\n").length).toBeLessThanOrEqual(MANDATE_MAX_LINES);
      expect(renderMandate(mode, VERSION, "260901-leaderboard").split("\n").length)
        .toBeLessThanOrEqual(MANDATE_MAX_LINES);
    }
  });
});

/**
 * The continuation rule (2026-09-04).
 *
 * The mandate used to license stopping four times and never once say "keep going",
 * and the runs it drove did exactly that: measured over the eight driven runs of
 * the aparece-v2 workspace, 26 `budget.raised` and 26 `question.answered` events,
 * and an owner who had to type "sigue con todas desatendido, no esperes por mi"
 * INSIDE an unattended run to restart a session the old text had correctly halted.
 *
 * What is asserted here is the contract, not the prose: that the unattended mode
 * carries a stop rule with a DEFINITION of strict, that a parked question is
 * shaped so it can be answered in one letter, that the driver's own default is
 * never laundered as the owner's, and — the one that keeps the framework portable —
 * that no operator's chat tool has been baked into the shipped text.
 */
describe("the mandate tells the driver to keep going (#63 follow-up)", () => {
  const unattended = renderMandate("unattended", VERSION);
  const attended = renderMandate("attended", VERSION);

  test("unattended: it says not to stop, and defines what may stop it", () => {
    expect(unattended).toContain("## Do not stop");
    expect(unattended).toContain("STRICT blocker");
    expect(unattended).toContain("no remaining turn can proceed");
  });

  test("unattended: a blocker is not strict until the unblocked work is named", () => {
    expect(unattended).toContain("name the work it does NOT block");
  });

  test("unattended: the old unconditional halts are gone", () => {
    // "do nothing yet, do nothing yet and park it" halted the RUN over a question
    // that blocked one path, and the budget bullet halted it outright.
    expect(unattended).not.toContain("do nothing yet");
    expect(unattended).not.toContain("and wait.");
  });

  test("attended: the stop rule is unattended-only — a person at the keyboard is the stop", () => {
    expect(attended).not.toContain("## Do not stop");
  });

  for (const [mode, text] of [["unattended", unattended], ["attended", attended]] as const) {
    test(`${mode}: a parked question is GUIDED — lettered options, never an open prompt`, () => {
      expect(text).toContain("lettered options");
      expect(text).toContain("Never an open prompt");
      expect(text).toContain("the option you would take");
    });

    test(`${mode}: parking says what it does not block, so the run continues around it`, () => {
      expect(text).toContain("carry on down every path it does not block");
    });

    test(`${mode}: a default the driver took is the DRIVER's, never quoted back as mine`, () => {
      expect(text).toContain("An answer I never gave is not my decision");
      expect(text).toContain("never cite it back to me as mine");
    });

    test(`${mode}: the ask channel is the console, overridable only by the launch message`, () => {
      expect(text).toContain("Ask on the console");
      expect(text).toContain("unless my launch message named another channel");
    });

    /**
     * The framework may not know one operator's chat tool. The owner names a
     * channel in the launch message or gets the console; baking a vendor in here
     * would make one person's setup a dependency of everybody's run.
     */
    test(`${mode}: names no chat vendor — the framework stays channel-agnostic`, () => {
      for (const vendor of ["slack", "pumble", "discord", "teams", "telegram", "webhook"]) {
        expect(text.toLowerCase()).not.toContain(vendor);
      }
    });
  }

  test("unattended: the budget stop asks instead of halting, and still forbids a raise", () => {
    expect(unattended).toContain("A ceiling raise is my decision");
    expect(unattended).toContain("do not route around one");
    expect(unattended).toContain("ask it as a guided question");
    expect(unattended).toContain("keep spending what the ceiling still funds");
  });

  test("unattended: the interrupt list is strict blockers only, asked as questions", () => {
    expect(unattended).toContain("Interrupt me ONLY for a STRICT blocker");
    expect(unattended).toContain("never as a bare halt");
    expect(unattended).toContain("Never push");
  });

  test("the preflight refusal is asked, not gone quiet on", () => {
    expect(unattended).toContain("REFUSE to start");
    expect(unattended).toContain("a strict blocker is asked, never gone quiet on");
  });
});

/**
 * `--tldr` — the reporting contract (2026-09-04).
 *
 * Measured over the ten runs of a real workspace: of ~4.0 MB written, 2.16 MB is
 * trail, and all 261 declared stage `inputs:` across those runs contain ZERO
 * occurrences of `handoff.md`, `retro.md` or `gate-evidence`. Operator notes alone
 * are 133,689 B that no prompt ever reads back. `--tldr` is for the runs whose
 * trail nobody will open, and what it buys is a session that stops narrating.
 *
 * The contract asserted here has a hard edge: `--tldr` may trim PROSE and may not
 * trim CITATIONS. `claim-sources` is condition 5 of the seven `auto` conditions and
 * runs whether or not a stage declared it, so a handoff stripped of `[src: …]`
 * tokens fails the gate this mode exists to close unattended.
 */
describe("tldrx drive --tldr (essentials-only reporting)", () => {
  test("absence is today: no --tldr renders byte-identically to before", () => {
    for (const mode of DRIVE_MODES) {
      expect(renderMandate(mode, VERSION, undefined, false)).toBe(renderMandate(mode, VERSION));
      expect(renderMandate(mode, VERSION, "260901-leaderboard", false))
        .toBe(renderMandate(mode, VERSION, "260901-leaderboard"));
    }
  });

  test("the standard mandate carries no reporting contract at all", () => {
    for (const mode of DRIVE_MODES) {
      expect(renderMandate(mode, VERSION)).not.toContain("## Report terse");
      expect(renderMandate(mode, VERSION)).not.toContain("· tldr ·");
    }
  });

  for (const mode of DRIVE_MODES) {
    const text = renderMandate(mode, VERSION, undefined, true);

    test(`${mode}: --tldr is stamped in the header, so a pasted mandate says which it is`, () => {
      expect(text).toContain(`· ${mode} · tldr · tldrx ${VERSION}`);
    });

    test(`${mode}: it points at the command that already prints the tl;dr`, () => {
      expect(text).toContain("## Report terse");
      expect(text).toContain("tldrx run status <run>");
      expect(text).toContain("Do not retype any of it in words");
    });

    test(`${mode}: the delta is capped at three bullets, and the cap is not a target`, () => {
      expect(text).toContain("at most three bullets of DELTA");
      expect(text).toContain("Three is a cap, not a target");
    });

    test(`${mode}: free text is reserved for a blocker and a correction`, () => {
      expect(text).toContain("Free text is for two things only");
      expect(text).toContain("not a summary of a diff I");
    });

    test(`${mode}: operator notes are off, and facts — which ARE read — are the alternative`, () => {
      expect(text).toContain("Write no `tldrx note` on this run");
      expect(text).toContain("no prompt ever reads one back");
      expect(text).toContain("tldrx facts add");
    });

    /**
     * The load-bearing assertion of the whole flag. A terse handoff is fine; an
     * uncited one is a gate that cannot close.
     */
    test(`${mode}: it trims prose and explicitly NOT citations, naming claim-sources`, () => {
      expect(text).toContain("keep its handoff minimal");
      expect(text).toContain("`claim-sources` validates");
      expect(text).toContain("Trim the prose, never the citations");
      expect(text).toContain("costs the gate you need to close");
    });

    test(`${mode}: the evidence note is minimised too, but still signed`, () => {
      expect(text).toContain("the four H2 sections");
      expect(text).toContain("It is a signature, not a report");
    });

    test(`${mode}: --tldr never weakens the disciplines the mandate exists for`, () => {
      expect(text).toContain("measured");
      expect(text).toContain("Never push");
      expect(text).toContain("Three roles");
      expect(text.toLowerCase()).toContain("stakes");
    });

    test(`${mode}: --tldr fits its own line budget`, () => {
      expect(text.split("\n").length).toBeLessThanOrEqual(MANDATE_TLDR_MAX_LINES);
      expect(renderMandate(mode, VERSION, "260901-leaderboard", true).split("\n").length)
        .toBeLessThanOrEqual(MANDATE_TLDR_MAX_LINES);
    });

    test(`${mode}: the standard mandate stays inside the tighter bound`, () => {
      expect(renderMandate(mode, VERSION).split("\n").length).toBeLessThanOrEqual(MANDATE_MAX_LINES);
    });
  }

  test("the reporting contract substitutes <run> like every other section (#75)", () => {
    const filled = renderMandate("unattended", VERSION, "260901-leaderboard", true);
    expect(filled).toContain("tldrx run status 260901-leaderboard");
    expect(filled).not.toContain("<run>");
  });

  test("the CLI accepts --tldr on both modes and exits 0", async () => {
    const dir = bareDir();
    for (const mode of DRIVE_MODES) {
      const run = await tldrxIn(dir, "drive", `--${mode}`, "--tldr");
      expect(run.code).toBe(EXIT_OK);
      expect(run.stdout).toContain("## Report terse");
      expect(run.stdout.split("\n").length).toBeLessThanOrEqual(MANDATE_TLDR_MAX_LINES + 1);
    }
  });

  test("the CLI without --tldr prints no reporting contract", async () => {
    const dir = bareDir();
    const run = await tldrxIn(dir, "drive", "--unattended");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).not.toContain("## Report terse");
  });
});
