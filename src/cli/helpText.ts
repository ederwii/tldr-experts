/**
 * What every command takes, what each flag means, and what it can exit with.
 *
 * One registry, keyed by command name, read by three different callers:
 *
 *   `tldrx <cmd> --help`   renders it (`commands/help.ts`)
 *   the argv guard         rejects a flag that is not in it (`argv.ts`, `index.ts`)
 *   the drift test         asserts every flag the code reads is declared here
 *
 * Before this existed, `<cmd> --help` printed the usage line and nothing else: no
 * flag meanings, no allowed values, no exit codes — and an unknown flag was
 * silently ignored, so `tldrx status --nope` exited 0 having done something other
 * than what was asked. Both failures had the same cause: nothing knew what a
 * command's flags WERE. This is that knowledge, in one place, so the help text and
 * the parser can never disagree about it.
 *
 * Closed value sets are imported from wherever they are enforced (`EFFORT_LEVELS`,
 * `UI_MODES`, the workflow stems on disk), never retyped: a help screen listing
 * values the validator does not accept is worse than no help screen.
 */
import { knownScopes } from "../core/seed/splitFile.ts";
import { EFFORT_LEVELS } from "../core/schemas/stage.ts";
import { UI_MODES } from "../core/ui/index.ts";
import {
  EXIT_AGENT_FAILED, EXIT_AWAITING_HUMAN, EXIT_GATE_REFUSED, EXIT_NOT_FOUND,
  EXIT_NOT_IMPLEMENTED, EXIT_OK, EXIT_USAGE,
} from "./exitCodes.ts";

/** Allowed values for a flag: a fixed list, or one read from disk at render time. */
export type FlagValues = readonly string[] | (() => readonly string[]);

export interface FlagHelp {
  /** The name without `--`. */
  readonly name: string;
  /** The value placeholder (`<path>`), or null for a boolean flag. */
  readonly arg: string | null;
  /** One line: what passing it does. */
  readonly meaning: string;
  /** The closed set of values, when there is one. */
  readonly values?: FlagValues;
  /** Which subcommand it belongs to; absent means "every subcommand". */
  readonly sub?: string;
  /** Passing it twice adds a second value rather than replacing the first. */
  readonly repeatable?: boolean;
}

export interface ArgHelp {
  /** As it appears in the usage line, e.g. `<slug>` or `[<run>]`. */
  readonly name: string;
  readonly meaning: string;
}

export interface CommandHelp {
  readonly name: string;
  /** One line, in plain language, of what the command is for. */
  readonly description: string;
  readonly args: readonly ArgHelp[];
  readonly flags: readonly FlagHelp[];
  /** One or two real invocations. */
  readonly examples: readonly string[];
  /** Every exit code this command can return. Always includes 0. */
  readonly exits: readonly number[];
  /** Anything the flag table cannot say in one line. */
  readonly notes?: readonly string[];
  /**
   * This command forwards its argv to something else, so the guard must not
   * judge it. `hook` and `statusline` spawn a hook script with everything after
   * the name (`hook.ts:51,66`); rejecting a flag they never read themselves would
   * be the CLI refusing on a script's behalf.
   */
  readonly passthrough?: boolean;
}

// --- the exit table (spec §3) -----------------------------------------------

/**
 * What each code MEANS, beside the number `exitCodes.ts` defines. The numbers are
 * imported rather than written down again, so this table cannot drift from them.
 *
 * `64` is reserved for a command that is not implemented. No command in this build
 * is a stub, so nothing returns it today — it stays defined because the honesty
 * rule it encodes ("never print success for work you did not do") outlives the
 * absence of stubs.
 */
export const EXIT_MEANINGS: ReadonlyMap<number, string> = new Map([
  [EXIT_OK, "ok"],
  [EXIT_USAGE, "usage or schema error, or a check ran and failed"],
  [EXIT_GATE_REFUSED, "refused: a gate said no, or several runs are open and it will not guess"],
  [EXIT_NOT_FOUND, "not found: no workspace, no run, no card by that name"],
  [EXIT_AWAITING_HUMAN, "awaiting a human: the stage ran and stopped at its gate"],
  [EXIT_AGENT_FAILED, "the sub-agent failed"],
  [EXIT_NOT_IMPLEMENTED, "not implemented (reserved; no command in this build returns it)"],
]);

/** `0  ok` … one line per code, for `tldrx --help` and `<cmd> --help`. */
export function exitLines(codes: readonly number[]): readonly string[] {
  return [...codes]
    .sort((a, b) => a - b)
    .map((code) => `  ${String(code).padEnd(2)}  ${EXIT_MEANINGS.get(code) ?? "(undocumented)"}`);
}

/** Every code, for the `tldrx --help` legend. */
export const ALL_EXIT_CODES: readonly number[] = [...EXIT_MEANINGS.keys()];

// --- flags shared by several commands ---------------------------------------

const root = (): FlagHelp => ({
  name: "root",
  arg: "<path>",
  meaning: "Workspace to act on. Default: the nearest directory at or above the cwd holding .tldrx/.",
});

const json = (what: string, sub?: string): FlagHelp => ({
  name: "json",
  arg: null,
  meaning: `Print ${what} as JSON on stdout instead of the table.`,
  ...(sub === undefined ? {} : { sub }),
});

const runFlag = (): FlagHelp => ({
  name: "run",
  arg: "<id>",
  meaning: "Which run to act on. Omit it and the one open run is used; several open runs is a refusal (exit 2), never a guess.",
});

const model = (sub?: string): FlagHelp => ({
  name: "model",
  arg: "<m>",
  meaning: "Model for the sub-agent, passed through to `claude --model`. Default: the stage's own `model:`.",
  ...(sub === undefined ? {} : { sub }),
});

const effort = (sub?: string): FlagHelp => ({
  name: "effort",
  arg: "<level>",
  meaning: "Reasoning effort for the sub-agent. This is the cost lever: it changes what the turn costs, where --max-usd only ends one late.",
  values: EFFORT_LEVELS,
  ...(sub === undefined ? {} : { sub }),
});

const ui = (sub?: string): FlagHelp => ({
  name: "ui",
  arg: "<mode>",
  meaning: "What to show while a sub-agent runs; every byte of it goes to stderr. Default: auto. TLDRX_UI sets it too.",
  values: UI_MODES,
  ...(sub === undefined ? {} : { sub }),
});

const maxUsd = (sub?: string): FlagHelp => ({
  name: "max-usd",
  arg: "<n>",
  meaning: "Stop after the turn that crosses this many dollars. A ceiling on the run, not a brake on the turn in flight.",
  ...(sub === undefined ? {} : { sub }),
});

const yolo = (sub?: string): FlagHelp => ({
  name: "yolo",
  arg: null,
  meaning: "Let the sub-agent run without per-tool permission prompts. It still cannot push.",
  ...(sub === undefined ? {} : { sub }),
});

const prepare = (sub?: string): FlagHelp => ({
  name: "prepare",
  arg: null,
  meaning: "Write the prompt and stop, spawning nothing. Pair with --commit to run the two halves separately.",
  ...(sub === undefined ? {} : { sub }),
});

const commit = (sub?: string): FlagHelp => ({
  name: "commit",
  arg: null,
  meaning: "Record the result of a --prepare cycle that was run by hand. Spawns nothing.",
  ...(sub === undefined ? {} : { sub }),
});

/** The 13 (today) workflow presets `--scope` accepts, read from disk when asked. */
export function scopeValues(cwd: string = process.cwd()): readonly string[] {
  return [...knownScopes(cwd)].sort();
}

// --- the registry ------------------------------------------------------------

const ENTRIES: readonly CommandHelp[] = [
  {
    name: "init",
    description: "Detect the workspace, build the code map, and write down the questions detection could not answer.",
    args: [],
    flags: [
      root(),
      { name: "out", arg: "<path>", meaning: "Where to write .tldrx/. Default: the same directory as --root." },
      { name: "no-interview", arg: null, meaning: "Skip .tldrx/init-questions.md entirely; nothing is asked." },
      {
        name: "process",
        arg: "<name>",
        meaning: "How the team plans, recorded in .tldrx/process.yml.",
        values: ["scrum", "kanban", "shape-up", "none"],
      },
      { name: "stack", arg: "<a,b,…>", meaning: "Declare the stack instead of detecting it. Comma-separated, e.g. ts,dotnet,python." },
      { name: "mcp", arg: null, meaning: "Also ask `claude mcp list` which servers are configured. Slower: it health-checks each one." },
      {
        name: "provider",
        arg: "<name>",
        meaning: "Which map provider to use. auto picks graphify when it is on PATH, else static.",
        values: ["auto", "graphify", "static"],
      },
      {
        name: "ui",
        arg: "<mode>",
        meaning: "What to show while it works; every byte of it goes to stderr. Default: auto. TLDRX_UI sets it too.",
        values: UI_MODES,
      },
      { name: "quiet", arg: null, meaning: "No live progress. The report at the end is still printed." },
    ],
    examples: [
      "tldrx init",
      "tldrx init --process scrum --stack ts,dotnet",
      "tldrx init --quiet",
    ],
    exits: [EXIT_OK, EXIT_USAGE],
    notes: [
      "Deterministic and offline: filesystem and git only. No model runs and nothing is sent anywhere.",
      "Most of the wait is the code map: `graphify update` runs once per repo. `--provider static` is much faster and still cites every claim.",
    ],
  },
  {
    name: "install",
    description: "Install the tldrx skill, hooks and status line into .claude/.",
    args: [],
    flags: [
      { name: "claude", arg: null, meaning: "The install target. Required — it is the only one today." },
      { name: "project", arg: null, meaning: "Install into ./.claude/ (the default)." },
      { name: "user", arg: null, meaning: "Install into ~/.claude/ instead, for every project on this machine." },
      { name: "skill-only", arg: null, meaning: "Install the skill and neither the hooks nor the status line." },
      { name: "no-hooks", arg: null, meaning: "Skip the hooks." },
      { name: "no-statusline", arg: null, meaning: "Skip the status line." },
      { name: "force-statusline", arg: null, meaning: "Replace an existing statusLine setting instead of leaving it alone." },
      { name: "uninstall", arg: null, meaning: "Remove what a previous install wrote, and nothing else." },
      { name: "dry-run", arg: null, meaning: "Print what would be written or removed. Writes nothing." },
    ],
    examples: [
      "tldrx install --claude",
      "tldrx install --claude --user --dry-run",
    ],
    exits: [EXIT_OK, EXIT_USAGE],
  },
  {
    name: "doctor",
    description: "Check the local environment against env.yml and say what is missing.",
    args: [],
    flags: [
      { name: "mcp", arg: null, meaning: "Also run `claude mcp list`. Slow: it live-health-checks every server." },
      json("the check results"),
    ],
    examples: [
      "tldrx doctor",
      "tldrx doctor --json",
    ],
    exits: [EXIT_OK, EXIT_USAGE],
    notes: [
      "Exit 1 means a REQUIRED tool is missing or below its min_version. An optional tool is reported, never fatal.",
    ],
  },
  {
    name: "status",
    description: "Everything in this workspace that is waiting on a human, and the command that moves each one.",
    args: [],
    flags: [json("the report"), root()],
    examples: [
      "tldrx status",
      "tldrx status --json",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND],
    notes: [
      "A report: it exits 0 whether or not anything is pending. The only non-zero finding is 3, which means there is no .tldrx/ here at all.",
      "Untrained experts are printed as advice under the blockers and are NOT counted in the header; they degrade a stage, they do not block one.",
    ],
  },
  {
    name: "run",
    description: "Create a piece of work, look at one, drive one to its next human gate, hand it to a host session or back, or get a stuck one moving again.",
    args: [
      { name: "<slug>", meaning: "run new: the short name. The id becomes <yymmdd>-<slug>." },
      {
        name: "[<run>]",
        meaning: "run attend / run status / run estimate / run auto / run unlock / run cancel: a run id. Omit it and the one open run is used.",
      },
      { name: "<host|--none>", meaning: "run attend: which way to flip it. `host` hands the run to a host session; `--none` hands it back." },
    ],
    flags: [
      { name: "title", arg: "<t>", meaning: "Human title for the run. Default: the slug.", sub: "new" },
      {
        name: "scope",
        arg: "<s>",
        meaning: "Which workflow preset to open the run with. Default: feature.",
        values: () => scopeValues(),
        sub: "new",
      },
      { name: "budget", arg: "<usd>", meaning: "Total ceiling for the run. Default: the preset's default_budget_usd.", sub: "new" },
      { name: "repos", arg: "<a,b>", meaning: "Limit the run to these repos of the workspace. Comma-separated.", sub: "new" },
      { name: "from", arg: "<dir>", meaning: "Distil an AI-DLC intent folder into 01-what/ as the run is created.", sub: "new" },
      { name: "seed", arg: "<file|dir>", meaning: "Import a document, or a directory of them, as the run's seed.", sub: "new", repeatable: true },
      {
        name: "gates",
        arg: "<a,b|all|none>",
        meaning: "Which stages a PERSON approves; every other gate closes automatically. Overrides the workflow's gates: wholesale.",
        sub: "new",
      },
      {
        name: "attended-by",
        arg: "<host>",
        meaning: "Open the run with a host session driving it: the framework writes prompt bundles and judges results, and never spawns. `tldrx next` then refuses the headless mode (exit 4) and names the --prepare command; `run auto` is refused outright. Absent (the default) the framework may spawn, exactly as before.",
        values: ["host"],
        sub: "new",
      },
      {
        name: "none",
        arg: null,
        meaning: "Hand the run back to the framework: it may spawn on it again. The opposite direction to `tldrx run attend host`.",
        sub: "attend",
      },
      { ...runFlag(), sub: "attend" },
      json("the run view", "status"),
      { ...runFlag(), sub: "status" },
      json("the estimate", "estimate"),
      { ...runFlag(), sub: "estimate" },
      { ...runFlag(), sub: "auto" },
      maxUsd("auto"),
      { name: "until", arg: "<stage>", meaning: "Stop the loop before this stage rather than at the first human gate.", sub: "auto" },
      { name: "parallel", arg: "<n>", meaning: "How many stories of ONE build wave run at once. `waves.yml` already guarantees a dependency is in an earlier wave, so a wave's stories are independent by construction. Merges into the epic still happen in the wave's listed order, after every story of that wave has finished, and each sub-agent keeps its own budget share. Default 1: one story at a time, exactly as before. Overrides the workflow's `build: {parallel: N}` and stage.yml's `parallel:`.", sub: "auto" },
      model("auto"),
      effort("auto"),
      yolo("auto"),
      ui("auto"),
      { ...runFlag(), sub: "unlock" },
      {
        name: "force",
        arg: null,
        meaning: "Remove a .lock a LIVE process still holds. Without it a live pid is refused (exit 2): 'the pid was recycled' and 'a colleague is running the stage right now' look identical from here, and only one of them is safe.",
        sub: "unlock",
      },
      { ...runFlag(), sub: "cancel" },
      {
        name: "note",
        arg: "<text>",
        meaning: "Why the run is being abandoned. Required — an empty note is a usage error (exit 1). Kept in the event log and in run.yml's cancelled:.",
        sub: "cancel",
      },
      {
        name: "force",
        arg: null,
        meaning: "Cancel a run that a live process still holds the .lock on, and release it. Without it a live pid is refused (exit 2) rather than closed out from under the process working on it.",
        sub: "cancel",
      },
      root(),
    ],
    examples: [
      "tldrx run new checkout-v2 --scope feature --budget 40",
      "tldrx run new checkout-v2 --attended-by host",
      "tldrx run attend host 260101-checkout",
      "tldrx run attend --none 260101-checkout",
      "tldrx run status --json",
      "tldrx run estimate",
      "tldrx run auto --max-usd 15 --until build",
      "tldrx run auto --parallel 3",
      "tldrx run unlock 260101-checkout --force",
      'tldrx run cancel 260101-checkout --note "superseded by the v2 spec"',
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_AWAITING_HUMAN, EXIT_AGENT_FAILED],
    notes: [
      "`run status` with several runs open LISTS them and exits 0 — it is the screen you read to find the id every other command wants.",
      "`run estimate` is the one command here that GUESSES, and it says so in its own output. The input half is measured — the next stage's prompt, assembled by the same code `next` uses and weighed by the same context ledger. The output half is the median output tokens of past attempts at that stage id, and with no history it prints no estimate rather than inventing one. For what was actually spent, use `tldrx cost`.",
      "`run unlock` drops a .lock nobody is behind and puts the stage it stranded back to ready. It spends nothing and touches no stage output.",
      "`run cancel` closes a run for good: cancelled is terminal, so `tldrx status` and every id-less command stop seeing it. Nothing is deleted — the stages, outputs, events and money spent stay on disk and `tldrx replay <id>` still reads them.",
    ],
  },
  {
    name: "seed",
    description: "Triage a seed too big for one run into several, then create them.",
    args: [
      { name: "<path>", meaning: "seed triage: the document or directory to inventory." },
      { name: "<split.yml>", meaning: "seed answer / seed apply: the proposal to act on." },
      { name: "<Qid> <text>", meaning: "seed answer: the question to answer, and the answer." },
    ],
    flags: [
      { name: "out", arg: "<dir>", meaning: "Where to write the triage folder. Default: .tldrx/triage/<yymmdd>-<name>/.", sub: "triage" },
      json("the inventory", "triage"),
      { name: "threshold-tokens", arg: "<n>", meaning: "Size above which a seed is called big enough to split.", sub: "triage" },
      { name: "propose", arg: null, meaning: "Spawn a sub-agent to propose the split, instead of only inventorying it.", sub: "triage" },
      model("triage"),
      effort("triage"),
      maxUsd("triage"),
      ui("triage"),
      prepare("triage"),
      commit("triage"),
      yolo("triage"),
      { name: "dry-run", arg: null, meaning: "Say which runs would be created. Creates nothing.", sub: "apply" },
      root(),
    ],
    examples: [
      "tldrx seed triage docs/",
      "tldrx seed triage docs/ --propose --max-usd 2",
      "tldrx seed apply .tldrx/triage/260101-docs/split.yml --dry-run",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_AGENT_FAILED],
  },
  {
    name: "next",
    description: "Run the run's next stage and stop at its gate.",
    args: [{ name: "[<run>]", meaning: "A run id. Omit it and the one open run is used." }],
    flags: [
      runFlag(),
      { name: "dry-run", arg: null, meaning: "Say which stage would run, with its inputs and budget. Spawns nothing and writes nothing." },
      prepare(),
      commit(),
      model(),
      effort(),
      maxUsd(),
      {
        name: "prompt-max-bytes",
        arg: "<n>",
        meaning: "Ceiling on the ASSEMBLED PROMPT for this run. Over it the stage is refused (exit 2) with the biggest sections named — before a cent is spent, which is the difference between this and --max-usd. Default: the stage's prompt_max_bytes, else 160 KB.",
      },
      {
        name: "max-reads",
        arg: "<n>",
        meaning: "How many Read/Glob/Grep calls the sub-agent may complete before it is stopped mid-turn. The brake --max-usd is not: it ends a turn that has already been paid for. Default: the stage's max_reads (120; 200 on build, 60 on watch).",
      },
      {
        name: "cost-usd",
        arg: "<n>",
        meaning: "--commit only: what the host session's sub-agent actually cost. An in-session turn has no meter of its own — it was billed to the host — so with nothing declared the task is recorded `cost_usd: null, metered: false` rather than $0.00, which would be a measurement and a false one.",
      },
      {
        name: "tokens",
        arg: "<n>",
        meaning: "--commit only: tokens the host session used, recorded beside the declared cost. Optional.",
      },
      yolo(),
      { name: "keep-worktrees", arg: null, meaning: "Leave the per-story worktrees on disk after the build stage finishes with them." },
      { name: "parallel", arg: "<n>", meaning: "How many stories of ONE build wave run at once. `waves.yml` already guarantees a dependency is in an earlier wave, so a wave's stories are independent by construction. Merges into the epic still happen in the wave's listed order, after every story of that wave has finished, and each sub-agent keeps its own budget share. Default 1: one story at a time, exactly as before. Overrides the workflow's `build: {parallel: N}` and stage.yml's `parallel:`." },
      {
        name: "discard-pending",
        arg: null,
        meaning: "Bin an orphaned --prepare bundle and run the stage again. Without it a stage left running with a bundle on disk is refused (exit 2) rather than re-spawned, because that would throw away a sub-agent turn this run has already paid for. On a build stage running off an implicit plan (a scope that skips Plan) it also DERIVES THE PLAN AGAIN from the run's handoff and answers — but only while nothing has been built off it: a plan with recorded evidence, or whose story branch already carries a commit, is kept and the reason said.",
      },
      {
        name: "reuse-epic",
        arg: null,
        meaning: "Let the build stage adopt an existing epic/<slug> branch this run did not cut. Without it a foreign epic branch is refused rather than stacked onto.",
      },
      ui(),
      root(),
    ],
    examples: [
      "tldrx next",
      "tldrx next --dry-run",
      "tldrx next 260101-checkout --effort high --max-usd 8",
      "tldrx next --discard-pending",
      "tldrx next --prompt-max-bytes 120000 --max-reads 60",
      "tldrx next --parallel 3",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_AWAITING_HUMAN, EXIT_AGENT_FAILED],
    notes: [
      "Exit 4 is the normal end of a successful stage: it ran, it wrote its outputs, and a person now has to approve.",
      "--prepare and --dry-run print the CONTEXT LEDGER: bytes per section of the prompt, the total against prompt_max_bytes, and any declared input that had to be truncated. `tldrx run estimate` prints the same ledger with a price on it.",
    ],
  },
  {
    name: "answer",
    description: "Answer one open question from the command line, recording it as a fact.",
    args: [
      { name: "<Qid>", meaning: "The question id, e.g. Q3." },
      { name: "<text>", meaning: "The answer. Quote it if it has spaces." },
    ],
    flags: [runFlag(), root()],
    examples: ['tldrx answer Q3 "Redis sorted set, one key per tenant"'],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND],
  },
  {
    name: "interview",
    description: "Work through the open questions in the terminal, one at a time.",
    args: [],
    flags: [
      runFlag(),
      { name: "init", arg: null, meaning: "Answer .tldrx/init-questions.md instead of a run's questions.md." },
      { name: "yes-to-defaults", arg: null, meaning: "Take the first option of every question that offers one." },
      root(),
    ],
    examples: [
      "tldrx interview --init",
      "tldrx interview --run 260101-checkout",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "This is the only way to answer the INIT questions: editing .tldrx/init-questions.md by hand fills the slot but records no fact and writes no process.yml.",
    ],
  },
  {
    name: "questions",
    description: "Check that this run's questions.md can be read by the \u00a72.7 parser.",
    args: [{ name: "[<run>]", meaning: "A run id. Omit it and the one open run is used." }],
    flags: [
      runFlag(),
      {
        name: "fix",
        arg: null,
        meaning: "Rewrite the blocks the parser cannot see into the grammar, without changing a word: the title, the reason, every option and any answer already typed come across verbatim. What is added is the heading separator, the metadata comment and the [Answer]: slot.",
        sub: "lint",
      },
      {
        name: "area",
        arg: "<a>",
        meaning: "The area stamped on a block --fix has to write metadata for, when the prose form recorded none. Default: general.",
        sub: "lint",
      },
      root(),
    ],
    examples: [
      "tldrx questions lint",
      "tldrx questions lint --run 260101-checkout --fix",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "A heading that misses `## Qn \u00b7 Title` is not half-read, it is read as ABSENT — so everything downstream reports \"0 open questions\" and an auto gate signs itself over them. This names every block in that state and exits 2.",
    ],
  },
  {
    name: "approve",
    description: "Approve the gate the run is sitting at.",
    args: [],
    flags: [
      runFlag(),
      { name: "note", arg: "<text>", meaning: "What you are approving and why. Kept in the event log." },
      root(),
    ],
    examples: ['tldrx approve --note "design lands on real paths"'],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
  },
  {
    name: "reject",
    description: "Send the current stage back with a note saying what has to change, or revoke an approval already given.",
    args: [],
    flags: [
      { name: "note", arg: "<text>", meaning: "What has to change. Required — a rejection with no reason is not actionable." },
      {
        name: "stage",
        arg: "<phase>/<stage>",
        meaning: "Revoke an approval already given, whoever signed it: the cursor moves back to that stage, one gate.revoked is appended carrying signed_by, and later stages that had run are marked stale — their files stay on disk and stop counting as current. Nothing is deleted and no cost is refunded. The one verb that may reopen a finished run.",
      },
      runFlag(),
      root(),
    ],
    examples: [
      'tldrx reject --note "contracts.md does not name the events"',
      'tldrx reject --stage 02-how/design --note "the auto gate signed over four open questions"',
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
  },
  {
    name: "story",
    description: "Give one Build story another run of attempts, signed with a note.",
    args: [{ name: "<id>", meaning: "The story id, e.g. S3." }],
    flags: [
      {
        name: "note",
        arg: "<text>",
        meaning: "Why this story must be built anyway. Required \u2014 a reopen with no reason is not actionable. It is recorded on the story.reopened event and printed by the Build stage when the story runs again.",
      },
      runFlag(),
      root(),
    ],
    examples: [
      'tldrx story reopen S3 --note "it gates wave 3 (S4, S6) and the owner has decided it ships"',
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "Reopenable states are `blocked`, `review` and `in_progress`. A `done` story refuses: undoing finished work is a decision about the STAGE, so it is `tldrx reject --stage <phase>/<stage>`. A `todo` story refuses too \u2014 it is already pending.",
      "The story goes back to `todo` and its attempt counter restarts at 1 of 2. Nothing is erased to make that true: `story.reopened` is a reset boundary the review ledger reads, every earlier attempt stays in events.jsonl, and the event records how many verdicts the closed run consumed.",
      "It runs no agent, spends nothing, deletes nothing and refunds nothing. The story's branch is kept \u2014 that is what carries the last developer's commits forward \u2014 and its worktree is left exactly as the build left it, to be reopened from the branch if the build had removed it.",
      "It does NOT make the stage runnable. If the Build stage is at its gate, `tldrx reject --note \"\u2026\"` sends it back to `ready` first; if the gate is already signed, `tldrx reject --stage` takes that back.",
    ],
  },
  {
    name: "budget",
    description: "What the run may still spend, and where to move a ceiling from.",
    args: [
      { name: "<phase>", meaning: "budget raise: the phase whose ceiling goes up, e.g. 04-build." },
      { name: "<usd>", meaning: "budget raise: the new ceiling for that phase." },
    ],
    flags: [
      runFlag(),
      json("the budget view", "show"),
      { name: "take-from", arg: "<phase>", meaning: "Move the money out of this phase instead of raising the run's total.", sub: "raise" },
      { name: "note", arg: "<text>", meaning: "Why the ceiling moved. Recorded on the budget.raised event beside the before/after and the actor.", sub: "raise" },
      root(),
    ],
    examples: [
      "tldrx budget show",
      "tldrx budget raise 04-build 25 --take-from 02-how",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
  },
  {
    name: "cost",
    description: "What the work actually cost — per attempt, per stage, per run.",
    args: [
      {
        name: "[<run>]",
        meaning: "A run id. Omit it and the one open run is used; several open runs is a refusal, never a guess. Ignored with --all.",
      },
    ],
    flags: [
      runFlag(),
      {
        name: "all",
        arg: null,
        meaning: "Every run in the workspace, finished ones included, totalled per economy. The run argument is ignored.",
      },
      json("the cost breakdown"),
      root(),
    ],
    examples: [
      "tldrx cost",
      "tldrx cost --all",
      "tldrx cost 260101-checkout --json",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND],
    notes: [
      "Read off `agent.result` events and nothing else: every dollar printed here is one the Claude CLI reported. No token count is ever multiplied by a price — `tldrx run estimate` is the command allowed to guess, and it says ESTIMATE in words.",
      "Attempts are never merged. A stage that failed twice cost three turns, and that retry is usually the money you are looking for.",
      "Work this process never saw a cost for is reported as UNMETERED rather than summed as $0.00 — a missing number and a free turn are not the same claim.",
    ],
  },
  {
    name: "map",
    description: "Build, refresh or drift-check the code knowledge base under .tldrx/map/.",
    args: [],
    flags: [
      { name: "refresh", arg: null, meaning: "Re-detect the workspace and rewrite .tldrx/map/**." },
      { name: "check", arg: null, meaning: "Resolve every [src: path:line] citation in the map against the filesystem. Exit 1 lists the ones that no longer land." },
      root(),
      {
        name: "provider",
        arg: "<name>",
        meaning: "Which map provider to use. auto picks graphify when it is on PATH, else static.",
        values: ["auto", "graphify", "static"],
      },
    ],
    examples: [
      "tldrx map --refresh",
      "tldrx map --check",
    ],
    exits: [EXIT_OK, EXIT_USAGE],
    notes: ["One of --refresh or --check is required; they are the subcommands, spelled as flags."],
  },
  {
    name: "expert",
    description: "List or create experts, recompute their levels, or train one.",
    args: [
      { name: "<name>", meaning: "expert create / train: the expert. expert recompute: optional — all of them by default." },
    ],
    flags: [
      json("the table", "list"),
      { name: "role", arg: "<slug>", meaning: "Create a ROLE expert with the shipped body for that role.", sub: "create" },
      { name: "domain", arg: "<slug>", meaning: "Add one domain area to the new expert, at level 0.", sub: "create" },
      { name: "stack", arg: "<lang>", meaning: "Add one stack area to the new expert, at level 0.", sub: "create" },
      { name: "area", arg: "<area>", meaning: "Which competency area to train. Required.", sub: "train" },
      {
        name: "mode",
        arg: "<mode>",
        meaning: "light reads the code; full mines finished runs' handoffs. A role expert only trains full.",
        values: ["light", "full"],
        sub: "train",
      },
      maxUsd("train"),
      model("train"),
      effort("train"),
      prepare("train"),
      commit("train"),
      yolo("train"),
      { name: "print-prompt", arg: null, meaning: "Print the training prompt and stop. Spawns nothing and costs nothing.", sub: "train" },
      ui("train"),
      json("the results", "recompute"),
      root(),
    ],
    examples: [
      "tldrx expert list",
      "tldrx expert train billing --area money --mode light --print-prompt",
      "tldrx expert recompute --json",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_AGENT_FAILED],
  },
  {
    name: "dashboard",
    description: "Watch the workspace live in a browser, or export it as one static page.",
    args: [],
    flags: [
      { name: "port", arg: "<n>", meaning: "Port to serve on. Default 4477; 0 takes any free one." },
      { name: "open", arg: null, meaning: "Open the page in the default browser once the server is up." },
      { name: "static", arg: null, meaning: "Write one self-contained page instead of serving. No server, no watcher." },
      { name: "out", arg: "<dir>", meaning: "Where --static writes the page.", sub: "static" },
      root(),
    ],
    examples: [
      "tldrx dashboard --open",
      "tldrx dashboard --static --out ./public",
    ],
    exits: [EXIT_OK, EXIT_USAGE],
    notes: ["Read-only: it serves GET and writes nothing into the workspace. Ctrl-C exits 0."],
  },
  {
    name: "replay",
    description: "Render a run's events.jsonl as a narrative of what happened and what it cost.",
    args: [
      {
        name: "[<run-id>]",
        meaning: "Which run to narrate. Omit it and the newest run is used; several runs OPEN is a refusal (exit 2), never a guess.",
      },
    ],
    flags: [root()],
    examples: [
      "tldrx replay",
      "tldrx replay 260101-checkout",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: ["Read-only: every line comes from an event that was actually logged. Nothing is written."],
  },
  {
    name: "retro",
    description: "Close a run and write down what it learned.",
    args: [
      {
        name: "[<run-id>]",
        meaning: "Which run to close. Omit it and the newest run is used; several runs open is a refusal (exit 2).",
      },
    ],
    flags: [
      { name: "apply", arg: null, meaning: "Also append the practice proposals to .tldrx/memory/practices.md." },
      root(),
    ],
    examples: [
      "tldrx retro",
      "tldrx retro 260101-checkout --apply",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
  },
  {
    name: "watch",
    description: "List the watcher cards a run produced, or re-check one against the code as it is now.",
    args: [{ name: "[<feature>]", meaning: "watch check: which card to re-resolve. Required for check, unused by list." }],
    flags: [
      runFlag(),
      json("the card list", "list"),
      root(),
    ],
    examples: [
      "tldrx watch list",
      "tldrx watch list --json",
      "tldrx watch check checkout-flow",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: ["`watch check` exits 1 when a citation no longer resolves — a check that reported rot on stdout and exited 0 would be invisible to CI."],
  },
  {
    name: "tickets",
    description: "Mirror the plan's epics and stories to a ticket tool. The files stay the source of truth.",
    args: [],
    flags: [
      runFlag(),
      {
        name: "apply",
        arg: null,
        meaning: "Actually create and edit issues. Without it `sync` previews and calls nothing — the one verb here that reaches a third party does not write by default.",
        sub: "sync",
      },
      { name: "dry-run", arg: null, meaning: "The default, kept as an explicit alias for it: say what would be created or edited, call nothing, write nothing. Passing it also cancels an --apply on the same line.", sub: "sync" },
      {
        name: "provider",
        arg: "<kind>",
        meaning: "Override process.yml's ticket_tool.kind for this call.",
        values: ["github", "jira"],
        sub: "sync",
      },
      root(),
    ],
    examples: [
      "tldrx tickets status",
      "tldrx tickets sync",
      "tldrx tickets sync --apply",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: ["No --json: the sync report and the status table are prose, and a JSON shape nobody consumes is a promise this would then have to keep."],
  },
  {
    name: "hook",
    description: "Run one tldrx hook script: payload on stdin, decision on stdout.",
    args: [{ name: "<script>", meaning: "Which hook to run. See Subcommands below." }],
    flags: [],
    examples: ["echo '{}' | tldrx hook session-start"],
    exits: [EXIT_OK, EXIT_USAGE],
    passthrough: true,
    notes: ["Everything after the script name is forwarded to it unchanged, so this command judges no flags of its own."],
  },
  {
    name: "statusline",
    description: "Render the tldrx status line, for Claude Code's statusLine setting.",
    args: [],
    flags: [],
    examples: ["tldrx statusline"],
    exits: [EXIT_OK],
    passthrough: true,
  },
  {
    name: "version",
    description: "Print the tldrx version.",
    args: [],
    flags: [],
    examples: ["tldrx --version"],
    exits: [EXIT_OK],
  },
  {
    name: "help",
    description: "Print the command list, the loop, and the exit-code table.",
    args: [],
    flags: [],
    examples: ["tldrx --help", "tldrx status --help"],
    exits: [EXIT_OK],
  },
];

const BY_NAME: ReadonlyMap<string, CommandHelp> = new Map(ENTRIES.map((entry) => [entry.name, entry]));

export function helpFor(name: string): CommandHelp | undefined {
  return BY_NAME.get(name);
}

export const HELP_ENTRIES: readonly CommandHelp[] = ENTRIES;

// --- what the argv guard asks it ---------------------------------------------

/**
 * Every flag name this command accepts, across all of its subcommands.
 *
 * Deliberately not per-subcommand: `tldrx budget show --take-from x` stays
 * accepted (and ignored, as it always was). The guard's job is to catch a flag
 * the command cannot read AT ALL — a typo — not to police which subcommand a
 * legal flag belongs to, which would be a behaviour change dressed as a fix.
 */
export function declaredFlags(name: string): ReadonlySet<string> {
  return new Set((helpFor(name)?.flags ?? []).map((flag) => flag.name));
}

/** The subset of those that take a value, so the guard skips the value. */
export function declaredValueFlags(name: string): ReadonlySet<string> {
  return new Set((helpFor(name)?.flags ?? []).filter((flag) => flag.arg !== null).map((flag) => flag.name));
}

export function supportsJson(name: string): boolean {
  return declaredFlags(name).has("json");
}

/** True when argv belongs to something else and this CLI must not judge it. */
export function isPassthrough(name: string): boolean {
  return helpFor(name)?.passthrough === true;
}

// --- rendering ---------------------------------------------------------------

export function flagValues(flag: FlagHelp): readonly string[] {
  const values = flag.values;
  if (values === undefined) return [];
  return typeof values === "function" ? values() : values;
}

/** `--effort <level>` — the left column of the flag table. */
export function flagLabel(flag: FlagHelp): string {
  return flag.arg === null ? `--${flag.name}` : `--${flag.name} ${flag.arg}`;
}

/**
 * The flag table, grouped by subcommand when the command has them.
 *
 * `indent` is the left margin; `width` is where the meaning column starts, so a
 * long flag name pushes its own meaning onto the next line rather than pushing
 * every other command's meaning to the right.
 */
export function renderFlagTable(flags: readonly FlagHelp[], indent = "  "): readonly string[] {
  if (flags.length === 0) return [];
  const shared = flags.filter((flag) => flag.sub === undefined);
  const grouped = new Map<string, FlagHelp[]>();
  for (const flag of flags) {
    if (flag.sub === undefined) continue;
    const list = grouped.get(flag.sub);
    if (list === undefined) grouped.set(flag.sub, [flag]);
    else list.push(flag);
  }
  const width = Math.max(...flags.map((flag) => flagLabel(flag).length)) + 2;

  // No subcommand carries flags of its own: one flat table, no headers to read.
  if (grouped.size === 0) return shared.flatMap((flag) => renderFlag(flag, indent, width));

  const lines: string[] = [];
  for (const [sub, list] of grouped) {
    lines.push(`${indent}${sub}:`);
    for (const flag of list) lines.push(...renderFlag(flag, `${indent}  `, width));
  }
  if (shared.length > 0) {
    lines.push(`${indent}any subcommand:`);
    for (const flag of shared) lines.push(...renderFlag(flag, `${indent}  `, width));
  }
  return lines;
}

/** The terminal width the flag table is laid out for. */
const COLUMNS = 98;

function renderFlag(flag: FlagHelp, indent: string, width: number): readonly string[] {
  const label = flagLabel(flag);
  const gutter = `${indent}${" ".repeat(width)}`;
  const body = COLUMNS - gutter.length;
  const paragraphs = [flag.meaning];
  const values = flagValues(flag);
  if (values.length > 0) paragraphs.push(`one of: ${values.join(", ")}`);
  if (flag.repeatable === true) paragraphs.push("repeatable: pass it more than once to add, not to replace.");

  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    for (const line of wrap(paragraph, body)) {
      lines.push(lines.length === 0 ? `${indent}${label.padEnd(width)}${line}` : `${gutter}${line}`);
    }
  }
  return lines;
}

/** Greedy word wrap. No hyphenation, no cleverness — a value list must stay copy-pasteable. */
export function wrap(text: string, width: number): readonly string[] {
  const limit = Math.max(20, width);
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= limit) line = `${line} ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out;
}
