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
import { RUNNABLE_SCRIPTS } from "../core/install/managedEntries.ts";
import { EFFORT_LEVELS } from "../core/schemas/stage.ts";
import { UI_MODES } from "../core/ui/index.ts";
import { FACT_CONFIDENCES, FACT_DECIDERS, FACT_KINDS } from "../core/facts/Fact.ts";
import { ON_GRANT_EXCEED } from "../core/budget/RunBudget.ts";
import {
  EXIT_AGENT_FAILED, EXIT_AWAITING_HUMAN, EXIT_FAILED, EXIT_GATE_REFUSED, EXIT_NOT_FOUND,
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
  /** The verbs this command dispatches on, in the order help lists them. Absent means none. */
  readonly subcommands?: readonly string[];
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
        name: "no-probe",
        arg: null,
        meaning: "Do not run the detected build/test/lint/typecheck commands. Each one is recorded as skipped rather than measured. Use it on a repo you have not read: probing EXECUTES that repo's own commands.",
      },
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
      "Deterministic: filesystem, git, and the repo's own build/test/lint/typecheck commands, each run ONCE to record whether it works (`--no-probe` skips them). No model runs and tldrx itself sends nothing anywhere.",
      "Most of the wait is the code map: `graphify update` runs once per repo. `--provider static` is much faster and still cites every claim.",
      "It PROBES what it detected: each build/test/lint/typecheck command is run once, and the outcome is written to `command_probes:` in workspace.yml. `run` is never probed — it starts a server.",
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
    name: "update",
    description: "Update tldrx to the latest published version, and print the CHANGELOG between the two.",
    args: [],
    flags: [
      { name: "dry-run", arg: null, meaning: "Print the exact `npm` command and install nothing." },
    ],
    examples: [
      "tldrx update",
      "tldrx update --dry-run",
    ],
    exits: [EXIT_OK, EXIT_FAILED],
    notes: [
      "It is `npm i -g tldr-experts@latest` and nothing more clever \u2014 the same command you would type, run for you.",
      "The version it reports is READ BACK from what npm installed (`$(npm root -g)/tldr-experts/package.json`), never assumed: this process is the OLD build and has no way to know what the new one is. If that read fails it says so and prints no changelog.",
      "The changelog delta comes from the CHANGELOG.md that shipped with the version just installed, so the text you read is the text that came with the code now on disk.",
      "On any invocation, a cached one-line notice tells you when a newer version exists. The registry is never called on the hot path: the check runs in a detached child after the output, caches its answer under `~/.tldrx/` for a day, and the NEXT invocation reads the cache. It is silent on any network failure, and never appears in `--json` output or during hook execution.",
      "Opt out with `TLDRX_UPDATE_CHECK=off` for one shell, or `update_check: off` in `~/.tldrx/config.yml` for the machine.",
    ],
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
      "It also reports two things about the WORKSPACE, both warnings that never move the exit code: committed state a `.gitignore` rule is swallowing, and any repo whose `default_branch` in `.tldrx/workspace.yml` does not resolve in that repo. The second one is otherwise invisible \u2014 it makes the Watch stage refuse and leaves the `boundary` gate condition `n/a` at every Build gate.",
    ],
  },
  {
    name: "learn",
    description: "Play the framework in a throwaway sandbox: real commands, a stand-in agent, $0.00.",
    args: [],
    flags: [
      {
        name: "chapter",
        arg: "<n>",
        meaning: "Start at this chapter instead of where you left off. An unfinished chapter it depends on is played first.",
      },
      { name: "reset", arg: null, meaning: "Delete the sandbox and build it again. The only way to start over." },
      { name: "list", arg: null, meaning: "Print the chapters and which are done, and run nothing." },
      {
        name: "sandbox",
        arg: "<path>",
        meaning: "Where the throwaway workspace lives. Default: ~/.tldrx-learn. Refused if it sits inside a real workspace.",
      },
      {
        name: "ui",
        arg: "<mode>",
        meaning: "How much to draw. Same rules as `init`: a pipe, NO_COLOR or CI degrades to plain whatever you ask for.",
        values: UI_MODES,
      },
    ],
    examples: [
      "tldrx learn",
      "tldrx learn --chapter 2",
      "tldrx learn --reset",
    ],
    exits: [EXIT_OK, EXIT_USAGE],
    notes: [
      "It spends nothing and needs no key: the sandbox installs a stand-in `claude` and points TLDRX_CLAUDE_BIN and PATH at it, so the real CLI is unreachable from a tutorial step.",
      "Nothing is ever written outside the sandbox directory, and it is refused outright if that directory sits inside a tldrx workspace.",
      "Progress lives in <sandbox>/progress.json, so a bare `tldrx learn` resumes at the first unfinished chapter.",
      "With no terminal on stdin (a pipe, CI, `< /dev/null`) the chapters play straight through instead of waiting for a keypress.",
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
    subcommands: ["new", "attend", "status", "estimate", "gates", "auto", "unlock", "cancel"],
    description: "Create a piece of work, look at one, drive one to its next human gate, hand it to a host session or back, or get a stuck one moving again.",
    args: [
      { name: "<slug>", meaning: "run new: the short name. The id becomes <yymmdd>-<slug>." },
      {
        name: "[<run>]",
        meaning: "run attend / run status / run estimate / run auto / run unlock / run cancel: a run id. Omit it and the one open run is used.",
      },
      { name: "<host|--none>", meaning: "run attend: which way to flip it. `host` hands the run to a host session and the framework will not spawn on it again; `--none` hands it back." },
      { name: "<stage>:<policy>", meaning: "run gates set: which stage's gate, and who may close it from now on. Qualified always \u2014 a bare stage id is refused, because a signature must not rest on a default." },
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
        arg: "<a,b|a:agent|all|none>",
        meaning: "Which stages a PERSON approves; every other gate closes automatically. A qualified entry names the policy outright \u2014 `plan:agent` is a gate an agent may close over an evidence note. Overrides the workflow's gates: wholesale.",
        sub: "new",
      },
      {
        name: "ship",
        arg: "<push|pr|merge>",
        meaning: "How far past the LAST gate the framework may carry the epic branch, frozen into run.yml as `ship:` (#253). `push` publishes `epic/<slug>` to origin; `pr` also opens the pull request `tldrx ship` opens; `merge` also arms `gh pr merge --auto --merge`, so the remote\u0027s own checks decide \u2014 and a PR that reports NO check is left open with `merge: absent \u2014 no checks to wait on`, never merged over silence. It runs when `run auto` sees the run close, or when a person types `tldrx ship`. Absent (the default) nothing is pushed and nothing is opened, exactly as before. Every gate is still signed by whoever `--gates` says: an unattended ship is `--gates none --ship merge`, on purpose, and run.yml records both.",
        values: ["push", "pr", "merge"],
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
      {
        name: "verbose",
        arg: null,
        meaning: "Under each gate row: the two instants behind a stage's duration \u2014 or the sentence naming which end run.yml is missing \u2014 and the words on a signed gate. The default screen marks a signed note with \u270e and does not quote it.",
        sub: "status",
      },
      { ...runFlag(), sub: "status" },
      json("the estimate", "estimate"),
      { ...runFlag(), sub: "estimate" },
      {
        name: "note",
        arg: "<text>",
        meaning: "Why this stage's gate may now be closed that way. Required \u2014 a gate policy that changed for no recorded reason is the one gate mutation nobody would find later. It is recorded on the gate.policy_changed event.",
        sub: "gates",
      },
      { ...runFlag(), sub: "gates" },
      { ...runFlag(), sub: "auto" },
      maxUsd("auto"),
      { name: "until", arg: "<stage>", meaning: "Stop the loop before this stage rather than at the first human gate.", sub: "auto" },
      { name: "parallel", arg: "<n>", meaning: "How many stories of ONE build wave run at once. `waves.yml` already guarantees a dependency is in an earlier wave, so a wave's stories are independent by construction. Merges into the epic still happen in the wave's listed order, after every story of that wave has finished, and each sub-agent keeps its own budget share. The shipped `stages/build/stage.yml` declares `parallel: 2`, so two at a time is what a workspace overriding nothing gets; the code fallback, for a stage file that declares none, is 1. Overrides the workflow's `build: {parallel: N}` and stage.yml's `parallel:`.", sub: "auto" },
      {
        name: "prompt-max-bytes",
        arg: "<n>",
        meaning: "Passed to EVERY `next` this loop makes: the ceiling on the assembled prompt, over which a stage is refused (exit 2) with the biggest sections named, before a cent is spent. Same precedence as on `tldrx next` \u2014 the flag beats the stage file. Default: the stage's prompt_max_bytes, else 400 KB.",
        sub: "auto",
      },
      {
        name: "max-reads",
        arg: "<n>",
        meaning: "Passed to EVERY `next` this loop makes: how many Read/Glob/Grep calls a sub-agent may complete before it is stopped mid-turn. Same precedence as on `tldrx next` \u2014 the flag beats the stage file. Default: the stage's max_reads (120; 200 on build, 60 on watch).",
        sub: "auto",
      },
      {
        name: "gate-agent",
        arg: null,
        meaning: "When the loop stops for a person, print a DECISION CARD instead of the ordinary status block: the question, its options, the agent's recommendation if an evidence note carried one, and the one command to type. Rendering only \u2014 it never upgrades a stage to `gates_policy: agent`, which is frozen at `run new`.",
        sub: "auto",
      },
      {
        name: "notify-every",
        arg: "<duration>",
        meaning: "Send the workspace's declared notify hook a `status` payload this often while the loop runs \u2014 `30s`, `10m`, `2h`, or a bare number of seconds. Off by default, and it does nothing at all unless `.tldrx/workspace.yml` declares a `notify:` command (\u00a72.18). A `status` payload carries what `tldrx run status` prints. It asks for nothing while the run is moving \u2014 and when the run is PARKED on an open question it says so and repeats the literal answer command, because a heartbeat that keeps saying nothing is waiting on you while a run waits on you is worse than silence.",
        sub: "auto",
      },
      {
        name: "retry-failed",
        arg: "<n>",
        meaning: "How many times in a row the loop may run a FAILED stage again before it stops. 0 \u2014 the default, and what every invocation before this got \u2014 means one attempt and then exit 5. A retry is the same `tldrx next` a person would have typed: the stage is on disk as `failed` with its reason recorded, and the next attempt is told what the last one did. It bounds EXIT 5 AND NOTHING ELSE \u2014 a usage error (1), a money refusal (2) and an awaiting-human park (4) are attempted once however large the bound, because each is a decision a person owns; a phase ceiling especially, which means \"a human decides about money\" and would otherwise become a delay. Only CONSECUTIVE failures count: a stage that succeeds puts the count back to zero. A retry SPENDS \u2014 it is a fresh metered stage under the same phase ceiling and the same --max-usd \u2014 and when the bound is spent the loop stops on the failure\u0027s own exit 5, with the count in the last line.",
        sub: "auto",
      },
      {
        name: "wait-gates",
        arg: "<duration>",
        meaning: "Instead of exiting 4 the moment a stage parks on a pending GATE, poll the run for this long and resume if somebody signs it. `--wait-answers`\u0027 sibling for the other half of exit 4: a gate is closed by `tldrx approve` / `tldrx reject`, not by an answer. Approved \u2192 the loop carries on; rejected \u2192 it stops and prints the note, unless the rejection was `tldrx reject --and-continue`, which re-runs the stage with the note instead (#242); lapsed \u2192 exit 4 with the same lines it always had, after one `gate.timeout` notification. It WAITS FOR a signature and never produces one. A stage on `gates_policy: agent` has already had the engine\u0027s own gate signer run on it before this flag ever sees the gate (see the `gates_policy: agent` note below), so what is left to wait for here is a PERSON \u2014 the same wait a `human` gate gets. Nothing is spent while it waits. Both wait flags may be given together.",
        sub: "auto",
      },
      {
        name: "wait-answers",
        arg: "<duration>",
        meaning: "Instead of exiting 4 the moment a stage parks on an open question, poll the run\u0027s question files for this long and resume if somebody answers. A lapsed wait exits 4 with the same lines it always did, after one `question.timeout` notification. Nothing is spent while it waits, and the loop never answers its own question \u2014 the answer is an ordinary `tldrx answer` run by a person.",
        sub: "auto",
      },
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
      "tldrx run status --verbose",
      "tldrx run estimate",
      'tldrx run gates set plan:agent --note "this run predates the agent policy; the pilot signs with evidence"',
      'tldrx run gates set build:human --note "the owner wants to read every merge from here"',
      "tldrx run auto --max-usd 15 --until build",
      "tldrx run auto --parallel 3",
      "tldrx run auto --prompt-max-bytes 500000 --max-reads 300",
      "tldrx run auto --notify-every 10m",
      "tldrx run auto --retry-failed 2",
      "tldrx run auto --wait-answers 30m",
      "tldrx run auto --wait-answers 4h --wait-gates 4h",
      "tldrx run unlock 260101-checkout --force",
      'tldrx run cancel 260101-checkout --note "superseded by the v2 spec"',
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_AWAITING_HUMAN, EXIT_AGENT_FAILED],
    notes: [
      "`run attend host` is a LOCK, not an engine. It sets one field, spends nothing, runs no stage and touches no branch \u2014 and from then on THE FRAMEWORK WILL NOT SPAWN on that run: every turn is a `tldrx next --prepare` / `tldrx next --commit` handshake with the session driving it, the Build reviewer included. `run attend --none` hands it back.",
      "`run auto` is an ENGINE, not a lock. It calls `next` HEADLESS over and over, so THE FRAMEWORK spawns a metered sub-agent stage after stage, and it stops at the first thing it may not decide: a human gate or an open question (4), a stage failure (5) \u2014 unless `--retry-failed <n>` lets it run that stage again, bounded, up to n times in a row \u2014 a phase ceiling or this loop's own --max-usd (2). It is REFUSED ON AN ATTENDED RUN (exit 1, before the event log is opened) \u2014 a lock and an engine are alternatives, never layers.",
      "`run auto` can also TELL SOMEBODY. When `.tldrx/workspace.yml` declares a `notify:` command (\u00a72.18), the loop hands that command one `version: 1` JSON object on stdin at every moment a person is needed \u2014 an open question with its options and the literal `tldrx answer` line, a gate with the literal approve line, a finished or failed run with its exit code and family \u2014 plus a periodic `status` under `--notify-every`. The framework names no chat tool: the command is the owner\u0027s own, run as argv with no shell, and its exit code is recorded as `notify.sent` / `notify.failed` and NEVER changes the run\u0027s outcome.",
      "Under `run auto`, a stage whose `gates_policy` is `agent` gets one bounded GATE-SIGNER turn of its own. When the stage\u0027s checks have passed, the engine spawns a single sub-agent at the stage\u0027s model and effort, on a quarter of the stage\u0027s per-agent ceiling, allowed to read and to write exactly one file: `.agent/<stage>/evidence.md`. The note then goes through the UNCHANGED `approve --as-agent` path \u2014 the same validator a person\u0027s note goes through \u2014 so `verdict: sign` plus every condition holding closes the gate under the note\u0027s own `by:`, and anything else leaves it pending for a person with the reasons named. The turn is recorded like any other (`agent.spawned` / `agent.result`, `role: gate-signer`) and shows up in `tldrx cost`. There is no flag for it: `gates_policy: agent` is already the owner\u0027s recorded decision that an agent may close this gate, and `human` gates are never touched.",
      "`run auto` walks the LAST MILE when the run was opened with `--ship` (#253): the moment the run reads `done` under it, it runs `tldrx ship` \u2014 push, PR, and under `merge` the auto-merge \u2014 and `run.finished` carries `pr_url` and `merge`. A ship that is refused is the loop\u0027s exit code (2), because the loop was asked for a PR and did not deliver one; the run\u0027s own work is still `done` on disk. A run closed by a hand `tldrx approve` outside the loop is shipped by typing `tldrx ship`, which reads the same block.",
      "`run status` with several runs open LISTS them and exits 0 — it is the screen you read to find the id every other command wants.",
      "`run estimate` is the one command here that GUESSES, and it says so in its own output. The input half is measured — the next stage's prompt, assembled by the same code `next` uses and weighed by the same context ledger. The output half is the median output tokens of past attempts at that stage id, and with no history it prints no estimate rather than inventing one. For what was actually spent, use `tldrx cost`.",
      "`run gates set` is the ONLY sanctioned way to move `gates_policy` after `run new` froze it. It is human-signed like `story reopen`: one stage per invocation, the policy named outright, a required --note, and one `gate.policy_changed` event carrying actor, moment, note and the old\u2192new value. It changes who may CLOSE a gate from then on; gates already signed are untouched, and a no-op is refused rather than recorded.",
      "`run unlock` drops a .lock nobody is behind and puts the stage it stranded back to ready. It spends nothing and touches no stage output.",
      "`run cancel` closes a run for good: cancelled is terminal, so `tldrx status` and every id-less command stop seeing it. Nothing is deleted — the stages, outputs, events and money spent stay on disk and `tldrx replay <id>` still reads them.",
    ],
  },
  {
    name: "seed",
    subcommands: ["triage", "answer", "apply"],
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
      {
        name: "review",
        arg: null,
        meaning: "--prepare/--commit only: this half of the handshake is for the story's REVIEWER, not its developer. --prepare --review writes the reviewer bundle (prompt, diff refs, the DoD already re-run, and the result schema) into .agent/<stage>/<story>/review/ and spawns nothing; --commit --review reads that bundle's result.json as the {verdict, summary, findings} envelope and settles the story by the same rules a spawned review does. Bare --prepare already routes here on its own when a story is waiting on a review.",
      },
      {
        name: "check",
        arg: null,
        meaning: "--commit only: REHEARSE the commit. Validates the prepared bundle's result.json through the same reader --commit uses, prints every refusal with the offending line, and WRITES NOTHING \u2014 no state, no event, no attempt spent. Exit 0 when --commit would read the envelope, 1 when it would not. Its reason for existing is the reviewer envelope: a `refuted` finding whose `[src: \u2026]` citation is not the last thing on its line is refused at --commit --review, and until now that refusal could only arrive after the turn had been paid for. On a DEVELOPER bundle the reader is deliberately tolerant \u2014 a missing `outputs` is read as `[]`, not refused \u2014 so --check exits 0 and NAMES what is about to be coerced. It checks the result envelope, not the stage's gate.",
      },
      {
        name: "fixlist",
        arg: "<path>",
        meaning: "--prepare only: re-prepare the story's DEVELOPER bundle around a reviewer's fix list (04-build/fixlist/<story>-<n>.md). The numbered findings still marked `fix-now` are rendered under `## Fix list` in the prompt with their `Do NOT` lines verbatim, and the prior turn's session_id is carried in pending.json as `resume_session` so the host can resume that sub-agent rather than pay to rebuild its context — the framework resumes nothing itself. Omit it and the latest round on disk is carried by itself; the flag is for naming a different file.",
      },
      model(),
      effort(),
      maxUsd(),
      {
        name: "prompt-max-bytes",
        arg: "<n>",
        meaning: "Ceiling on the ASSEMBLED PROMPT for this run. Over it the stage is refused (exit 2) with the biggest sections named — before a cent is spent, which is the difference between this and --max-usd. Default: the stage's prompt_max_bytes, else 400 KB.",
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
      { name: "keep-worktrees", arg: null, meaning: "Leave the per-story worktrees on disk after the build stage finishes with them, and the run's epic worktrees on disk after the run closes. The epic checkouts survive the Build stage either way (a later Watch stage cites code that is committed on the epic branch and merged nowhere); this flag is what makes them survive the run itself. Remembered on the run, so a close by `tldrx approve` or `tldrx run cancel` honours it too." },
      { name: "parallel", arg: "<n>", meaning: "How many stories of ONE build wave run at once. `waves.yml` already guarantees a dependency is in an earlier wave, so a wave's stories are independent by construction. Merges into the epic still happen in the wave's listed order, after every story of that wave has finished, and each sub-agent keeps its own budget share. The shipped `stages/build/stage.yml` declares `parallel: 2`, so two at a time is what a workspace overriding nothing gets; the code fallback, for a stage file that declares none, is 1. Overrides the workflow's `build: {parallel: N}` and stage.yml's `parallel:`." },
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
      "tldrx next --prepare --review",
      "tldrx next --prepare --fixlist 04-build/fixlist/S5-1.md",
      "tldrx next --commit --review",
      "tldrx next --commit --review --check",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_AWAITING_HUMAN, EXIT_AGENT_FAILED],
    notes: [
      "Exit 4 is the normal end of a successful stage: it ran, it wrote its outputs, and a person now has to approve.",
      "Both halves of the handshake now write `result_schema` into pending.json \u2014 the reviewer's REVIEW_SCHEMA and the developer's {outputs, questions_asked, notes} envelope plus the `cost_usd`/`session_id` a host may declare. Read the shape out of the bundle; do not reconstruct it from memory or from a sibling story.",
      "--prepare and --dry-run print the CONTEXT LEDGER: bytes per section of the prompt, the total against prompt_max_bytes, and any declared input that had to be truncated. `tldrx run estimate` prints the same ledger with a price on it.",
      "On `--commit --review` there is no turn left to configure, so --model and --effort are read as the host's DECLARATION of what judged the diff — the same reading --cost-usd and --tokens already get on --commit — and are recorded on the verdict as basis: host-declared. Declare nothing and the record says `not recorded`: the reviewer bundle's own model is a suggestion tldrx made, and repeating it back would be quoting a suggestion as a measurement of your session. Everywhere else the two flags override the stage's model:/effort: for every sub-agent of the invocation, including a reviewer a stage.yml reviewer:/reviewer_by_stakes: block would otherwise have moved.",
    ],
  },
  {
    name: "answer",
    description: "Answer one open question from the command line, recording it as a fact.",
    args: [
      { name: "<Qid>", meaning: "The question id, e.g. Q3." },
      { name: "<text>", meaning: "The answer. Quote it if it has spaces." },
    ],
    flags: [
      {
        name: "supersede",
        arg: null,
        meaning: "REVERSE a decision this question already recorded. Only valid on an ANSWERED question. The old fact keeps its text and gains superseded_by; a new fact carries this answer with the same area, and with the repos its predecessor bound to unless --repo or the question's own affects: rescopes it; the block keeps its original [Answer]: line and gains a superseding one plus a footer. Everything that FEEDS a decision \u2014 no-re-ask, every {{facts}} block, the training miner, the implicit plan \u2014 then reads the new fact and not the old one. Without it, answering an answered question is refused, because an answer is recorded once.",
      },
      {
        name: "decided-by",
        arg: "<who>",
        meaning: "Who decided, as against who typed it. OPTIONAL here, and required on `facts add`: this command is also driven by the answer-capture hook, which fires on an agent's own Write and on a human's edit and so cannot honestly say either. Absent means \u201cnot stated\u201d, never \u201cowner\u201d, and the command says so on stdout.",
        values: FACT_DECIDERS,
      },
      {
        name: "repo",
        arg: "<name>",
        meaning: "Scope the answered fact to one repo, so every {{facts}} block outside it stops carrying a decision that was never about it. Repeatable. A name no repo in workspace.yml answers to is refused before anything is written.",
        repeatable: true,
      },
      runFlag(),
      root(),
    ],
    examples: [
      'tldrx answer Q3 "Redis sorted set, one key per tenant"',
      'tldrx answer Q3 "Postgres table after all \u2014 the contention risk was refuted" --supersede',
      'tldrx answer Q4 "B \u2014 rankings are global" --decided-by owner --repo api',
    ],
    // 2 is `resolveRunOrExplain`'s: several runs are open and none was named, so
    // the command declines to choose one rather than answer into the wrong run.
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "A second reversal supersedes the SECOND answer, not the first: the chain is walked to its head, so `--supersede` can be used as many times as an owner changes their mind and facts.yml stays a single-link reciprocal chain.",
      "Nothing is erased. `tldrx replay` renders the reversal as its own line (`fact.superseded`), `tldrx retro` still lists the old fact and labels it `(superseded by F<n>)`, and the words originally typed stay in questions.md.",
      "Without `--repo`, the fact is scoped by the question's own `affects:` when an entry there names a repo (`api` or `api:src/db.ts`), and by nothing otherwise \u2014 `repos: []` means \u201cno repo was named\u201d, never \u201cevery repo\u201d. An `affects:` entry that looks like `repo:path` and matches no repo is named on stdout \u2014 for every block the invocation captured, not just the one it named, each line carrying its question id. The answer-capture hook reports the same thing through the context it posts.",
      "A recorded answer is checked against the facts already live, on both paths, and a hit RAISES \u2014 it never refuses. The answer stands, this command still exits 0, the new fact carries `conflicts_with`, one question is appended to the same questions.md asking which of the two holds, and one `fact.conflict_raised` goes on the ledger. That block is marked `advisory:`, so it does not hold an auto gate, does not park a run at `awaiting_answer`, is not counted by `skip_if` and is not what `tldrx status` says the run is waiting on \u2014 the gate says how many it skipped, and every reader that LISTS questions (`tldrx questions`, the run close, the decision cards, `tldrx replay`, the status line) names it like any other open question.",
      "What that check can and cannot see, stated because a raise you cannot calibrate is worse than none: it is LEXICAL \u2014 Jaccard \u2265 0.6 on tokens of 4 characters or more, scoring the QUESTION's title against each candidate fact's whole text, and only within the SAME `area`. So it cannot see two differently-worded answers that contradict in meaning, it drops short words entirely, and an answer identical to the recorded one is read as agreement rather than a clash. Refusing on a signal like that could deadlock an unattended run, which is why it raises instead.",
    ],
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
    subcommands: ["lint", "cards"],
    description: "Read this run's open questions as decision cards, or check the file the \u00a72.7 parser reads.",
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
      "tldrx questions cards",
      "tldrx questions cards 260101-checkout",
      "tldrx questions lint",
      "tldrx questions lint --run 260101-checkout --fix",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "A heading that misses `## Qn \u00b7 Title` is not half-read, it is read as ABSENT \u2014 so everything downstream reports \"0 open questions\" and an auto gate signs itself over them. `lint` names every block in that state and exits 2.",
      "`cards` renders each OPEN question as a printable decision card: two lines of context, the question's own `Why asked:` note verbatim (the slot for what the binding docs already decide), and the file's lettered options \u2014 or a NEEDS-OPTIONS marker when it carries none, because inventing the choices would be answering the question in the act of asking it. It reads only: answers still flow through `tldrx answer`, and every card prints the exact line to type. No open question is a sentence and an exit 0.",
    ],
  },
  {
    name: "approve",
    description: "Approve the gate the run is sitting at.",
    args: [],
    flags: [
      runFlag(),
      { name: "note", arg: "<text>", meaning: "What you are approving and why. Kept in the event log." },
      {
        name: "as-agent",
        arg: null,
        meaning: "Sign an `agent` gate with the evidence note at `.agent/<stage>/evidence.md`. The note is validated by the \u00a72.8 machinery first, the gate records the note's `by:` as the actor, and the note is copied to `<phase>/gate-evidence/<stage>.md` where it is committed. Refused (exit 1) on a stage whose policy is not `agent`.",
      },
      {
        name: "evidence",
        arg: "<path>",
        meaning: "Read the evidence note from here instead of `.agent/<stage>/evidence.md`. Only means something with --as-agent.",
      },
      root(),
    ],
    examples: [
      'tldrx approve --note "design lands on real paths"',
      "tldrx approve --as-agent",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_AWAITING_HUMAN],
    notes: [
      "A person may always approve an agent-gated stage with no flag at all. That is an override, it is recorded as a person, and it is the point of the split: an agent gate is one an agent MAY close, never one a person may not.",
      "--as-agent has two refusals and they mean different things. Exit 2 is \"this note is broken\" \u2014 fix the file. Exit 4 is \"a person decides\": the note parsed perfectly and its verdict is `refuse` or `sign-with-fixlist`, which is the agent doing its job.",
    ],
  },
  {
    name: "gate",
    subcommands: ["template"],
    description: "Write the skeleton evidence note an agent gate is closed over.",
    args: [{ name: "[<run>]", meaning: "A run id. Omit it and the one open run is used." }],
    flags: [
      runFlag(),
      {
        name: "force",
        arg: null,
        meaning: "Replace an evidence.md that is already on disk. Without it an existing note is left alone and the command exits 2 \u2014 a written note is the artefact a gate rests on, and a blank form is not worth destroying it for.",
        sub: "template",
      },
      root(),
    ],
    examples: [
      "tldrx gate template",
      "tldrx gate template --run 260101-checkout",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "It writes `.agent/<stage>/evidence.md` with the MEASURED fields filled \u2014 the gate at the cursor, the time, how many citations the \u00a72.8 resolver found in this stage's outputs, and how many touched paths the plan declares \u2014 and every judgement blank. The blank form deliberately does not validate: a template that parsed clean out of the box would be a signature nobody had to earn.",
      "Non-signing. It spends nothing, spawns nothing, approves nothing and moves no cursor.",
    ],
  },
  {
    name: "reject",
    description: "Send the current stage back with a note saying what has to change, or revoke an approval already given.",
    args: [],
    flags: [
      { name: "note", arg: "<text>", meaning: "What has to change. Required — a rejection with no reason is not actionable." },
      {
        name: "and-continue",
        arg: null,
        meaning: "This rejection means \u201credo it this way and carry on\u201d, not \u201cstop, I will look\u201d. The stage goes back to `ready` with the note exactly as a bare rejection leaves it \u2014 what changes is that an unattended `tldrx run auto --wait-gates` re-runs the stage instead of exiting 4, so a rejection sent from a phone does not need a walk to a terminal to take effect. Recorded on the gate, so the waiting loop reads it rather than guessing from the note\u2019s words. Without it a rejection stops the loop, which is the default and always was. Refused with exit 1 beside `--stage`: a revoke leaves that gate pending for a decision nobody has made yet, so there is no rejection for it to describe.",
      },
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
      'tldrx reject --and-continue --note "S2 fell over on a missing binary — redo S2 and waves 3 and 4"',
      'tldrx reject --stage 02-how/design --note "the auto gate signed over four open questions"',
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
  },
  {
    name: "story",
    subcommands: ["reopen", "widen"],
    description: "Give one Build story another run of attempts, open a fix round on a done one, or widen the paths it declares \u2014 each signed with a note.",
    args: [
      { name: "<id>", meaning: "The story id, e.g. S3." },
      { name: "<path>\u2026", meaning: "widen only: one or more repo-relative paths to add to the story's `touches:`. Positional, and repeatable by writing them one after another." },
    ],
    flags: [
      {
        name: "note",
        arg: "<text>",
        meaning: "Why this story must be built anyway \u2014 or, with --for-fix, WHICH DEFECT is being fixed. Required \u2014 a reopen with no reason is not actionable. It is recorded on the story.reopened event and printed by the Build stage when the story runs again.",
        sub: "reopen",
      },
      {
        name: "note",
        arg: "<text>",
        meaning: "WHY the surface grew \u2014 what the story turned out to have to touch, and why that is this story's work and not another's. Required, and recorded on the story.touches_widened event beside the list before and after, so a surface never grows without a stated reason.",
        sub: "widen",
      },
      {
        name: "for-fix",
        arg: null,
        meaning: "Open a FIX ROUND on a story that is `done`: one named defect in work a reviewer already approved. No attempt is consumed, the fix passes the same dod and the same reviewer as the original, and the story's acceptance criteria are not touched \u2014 it is not a way to relitigate scope. Refused when the story is not done, when --note is missing, and when that story already has a fix round open (the bound is one).",
        sub: "reopen",
      },
      runFlag(),
      root(),
    ],
    examples: [
      'tldrx story reopen S3 --note "it gates wave 3 (S4, S6) and the owner has decided it ships"',
      'tldrx story reopen S11 --for-fix --note "linkEmail succeeds then setDisplayName fails: account linked, score never claimable"',
      'tldrx story widen S3 platform/Auth.cs --note "the tenancy check the story is for lives here too"',
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "Reopenable states are `blocked`, `review` and `in_progress`. A `done` story refuses: undoing finished work is a decision about the STAGE, so it is `tldrx reject --stage <phase>/<stage>` \u2014 or, for ONE named defect in it, `--for-fix`. A `todo` story refuses too \u2014 it is already pending.",
      "`--for-fix` is the arc the other two do not cover: `done` \u2192 fix round. It records `story.reopened` with `reason: fix`, consumes no attempt, and the round stays open until the story is `done` again, which is what bounds it to one at a time. It exists because an accepted defect in a done story otherwise has no sanctioned path: rejecting the whole Build stage destroys every other story's closure, and fixing it outside the story machinery leaves an epic-level commit with no story provenance.",
      "The story goes back to `todo` and its attempt counter restarts at 1 of 2. Nothing is erased to make that true: `story.reopened` is a reset boundary the review ledger reads, every earlier attempt stays in events.jsonl, and the event records how many verdicts the closed run consumed.",
      "It runs no agent, spends nothing, deletes nothing and refunds nothing. The story's branch is kept \u2014 that is what carries the last developer's commits forward \u2014 and its worktree is left exactly as the build left it, to be reopened from the branch if the build had removed it.",
      "It does NOT make the stage runnable. If the Build stage is at its gate, `tldrx reject --note \"\u2026\"` sends it back to `ready` first; if the gate is already signed, `tldrx reject --stage` takes that back.",
      "`widen` adds paths to a story's `touches:` \u2014 the sanctioned form of the advice the boundary decision card gives when a Build stage changed a path nobody scoped. Widenable states are `todo`, `in_progress`, `review` and `blocked`. A `done` story refuses: its evidence was written against the surface it DECLARED, and widening it afterwards would make the record say the plan declared a path it did not \u2014 reopen it with `--for-fix` first. A path the story already declares refuses too, because a widening that widened nothing is a record of something that did not happen.",
      "`widen` runs no agent, spends nothing, consumes no attempt, changes no status and moves no cursor \u2014 it declares scope and nothing else. No gate code knows about it: the boundary condition re-reads `touches:` off disk at evaluation time, so the same run, the same branch and the same diff simply stop counting the widened path as outside the surface at the next evaluation. One `story.touches_widened` records the paths, the note and the list before and after.",
    ],
  },
  {
    name: "note",
    description: "Record one operator annotation on a run's event log, at the moment it happened.",
    args: [
      { name: "[<run>]", meaning: "A run id. Omit it and the one open run is used." },
      { name: "<text>", meaning: "The annotation. Required \u2014 an empty note is a usage error." },
    ],
    flags: [
      {
        name: "stage",
        arg: "<id>",
        meaning: "Key the note to one stage of this run, as `plan` or `03-plan/plan`. Absent, the note is about the run. A stage this run does not have is refused and nothing is written.",
      },
      runFlag(),
      root(),
    ],
    examples: [
      'tldrx note "owner-delegated resync of 8 story dod blocks, done by hand"',
      'tldrx note 260829-scoring --stage build "S1..S8 dod blocks resynced from workspace.yml"',
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "It appends exactly one `operator_note` event and touches NOTHING else: run.yml and budget.yml are byte-identical across the call, no gate is signed or revoked, no cursor moves and no money is spent.",
      "It exists because there was no honest carrier for a maintenance action at the moment it happened. The alternatives people reached for were a FUTURE gate note (late, and attached to a decision the note is not about) and `tldrx reject` (which undoes work).",
      "The note shows up in `tldrx run status` (the last few) and in `tldrx replay` (every one, in place).",
    ],
  },
  {
    name: "facts",
    subcommands: ["add"],
    description: "Record one durable, provenanced fact the later prompts will read.",
    args: [
      { name: '"<text>"', meaning: "The assertion, one sentence. Required." },
    ],
    flags: [
      { name: "area", arg: "<id>", meaning: "Which area the fact is about. Required — it is how every reader of facts.yml scopes a match.", sub: "add" },
      { name: "decided-by", arg: "<who>", meaning: "Who decided, as against who typed it. Required — a driver default is never cited as the owner's.", values: FACT_DECIDERS, sub: "add" },
      { name: "kind", arg: "<kind>", meaning: "What sort of fact this is.", values: FACT_KINDS, sub: "add" },
      { name: "confidence", arg: "<level>", meaning: "How well it is known. `measured` means you ran the check.", values: FACT_CONFIDENCES, sub: "add" },
      { name: "repo", arg: "<name>", meaning: "Scope the fact to one repo. Repeatable. A name no repo in workspace.yml answers to is refused before anything is written.", repeatable: true, sub: "add" },
      { name: "run", arg: "<id>", meaning: "Attribute it to this run. An id no run in tldrx-work/ answers to is refused (exit 3) before anything is written — asking for provenance by name and getting `run: null` instead is worse than not asking. Without it, one open run is used; with several open, the fact is still recorded and its run is left absent with a named reason on stdout, because provenance nobody can establish is written as missing, never guessed.", sub: "add" },
      root(),
    ],
    examples: [
      'tldrx facts add "The outbox lives in the billing repo." --area billing --decided-by owner --kind observed --confidence measured',
      'tldrx facts add "Retries are capped at three." --area billing --decided-by driver',
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND],
    notes: [
      "A fact is one assertion, capped at 2000 characters. Over the cap it is cut, ends in `…`, and carries `truncated: true` — and the command says so on stdout, because a marker only a later reader sees is one the author never acts on.",
      "It writes through `FactsStore`, under the workspace lock: load, mint the id, cap, validate, save. Editing `.tldrx/memory/facts.yml` by hand walks past all four.",
      "`--decided-by` is required, never defaulted: a fact gets cited later, and a row that cannot say which of the two decided it must not imply the stronger one (the owner's) by silence.",
      "`--run <id>` that names nothing is exit 3, not a silently unattributed fact: `RunStore.resolve` answers `none` both to 'no run is open' and to 'that id is not here', and writing the second one as the first printed a sentence that is false whenever a run IS open.",
    ],
  },
  {
    name: "ship",
    description: "Open a pull request from the run's epic branch \u2014 one per repo the branch is in \u2014 with a body written from the run's handoff.",
    args: [{ name: "[<run>]", meaning: "A run id. Omit it and the one open run is used." }],
    flags: [
      {
        name: "branch",
        arg: "<name>",
        meaning: "Which epic branch to open the PR from, when the run cut more than one. It must be one of the run's own \u2014 an unrelated branch is refused.",
      },
      {
        name: "repo",
        arg: "<name>",
        meaning: "Ship to ONE repo only. Without it, a branch that exists in several repos gets one PR in each.",
      },
      {
        name: "base",
        arg: "<branch>",
        meaning: "What to open the PR against. Default: that repo's `default_branch` from .tldrx/workspace.yml.",
      },
      { name: "draft", arg: null, meaning: "Open it as a draft PR (`gh pr create --draft`)." },
      { name: "dry-run", arg: null, meaning: "Run every check and print the exact `gh` command, creating nothing." },
      runFlag(),
      root(),
    ],
    examples: [
      "tldrx ship",
      "tldrx ship 260829-scoring --dry-run",
      "tldrx ship --branch epic/leaderboard --draft",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "It pushes ONLY when the run says so. Publishing a branch is a decision, so by default a branch the remote has not seen is a refusal that names the `git push` command rather than running it. The decision is taken once, at `tldrx run new --ship <push|pr|merge>` (#253): then this verb pushes the epic first, through the one push wrapper in the codebase (the Build phase itself still has none, spec \u00a75), and under `merge` arms `gh pr merge --auto --merge` after the PR opens \u2014 unless the PR reports NO check at all, in which case it is left open and run.yml says `merge: absent \u2014 no checks to wait on`. `run auto` calls this verb when it sees the run close and skips a run whose record already carries `shipped_at`; typing `tldrx ship` again is the recovery after a partial failure — a repo whose merge is recorded `failed` is armed again, one recorded `queued` is left alone, and the record is the union, so a recorded failure is never erased. A run without the block is never written.",
      "The body is WRITTEN for a PR (#167): an **Outcome** line saying how much of the plan landed (`partial: 1 of 3 stories delivered; S2 \u2014 \u2026`); what shipped and what did not, from the handoff's own done/not-done split; the reviewer findings still open, read from the run's fix lists; and the LAST phase handoff the run has on disk \u2014 `04-build/handoff.md` on a run that built something \u2014 verbatim and complete, inside a `<details>` block. It goes to `gh` as a file, never as an argument, so a long body cannot overflow an argv limit.",
      "It REFUSES a run that delivered no story (exit 1 \u2014 nothing behind it, #210). `ship` already knew: the body it renders keeps only the handoff bullets that say `done`, and with none it wrote `(nothing settled `done` in this run)` into a PR it opened anyway. The refusal names the counts and the first blocked story's own reason, and `--dry-run` is refused in the same words. A run that delivered at least one story ships exactly as it did before.",
      "It moves no gate and no cursor and appends no event. On a run with no `ship:` block it never writes to the run at all; on a run with one it writes exactly that block\u0027s record (`pr_urls`, `merge`, `merges`, `shipped_at`) and nothing else. To mirror the plan\u0027s epics and stories to a ticket tool, `tldrx tickets sync` is the verb that does that, and it stays separate.",
      "It refuses cleanly, in a sentence, when there is no epic branch, no handoff, no remote, no `gh` on PATH, or when several epic branches leave the choice open.",
      "When the branch exists in SEVERAL repos \u2014 the normal shape of a chained multi-repo run, whose epics share one integration branch \u2014 it opens one PR per repo: the same body, the repo name in the title, and every URL listed at the end. `--repo` narrows it to one.",
      "A partial failure names both sides: the PRs that were opened, with their URLs, and the repos that failed, with the reason. Run it again to retry the rest \u2014 a repo whose PR is already open is skipped, so re-running opens nothing twice.",
      "It refuses an epic branch that carries changes under `tldrx-work/` or `.tldrx/`, and names them. Those paths are written LIVE into the workspace checkout for the length of a run, so a PR that merges them makes the next `git pull` there refuse. The refusal prints the two commands that take them back off the branch \u2014 a forward commit, never a rebase. A path a story at `status: done` DECLARES in its `touches:` is subtracted first and the refusal says which story excused it; an unsettled story's declaration excuses nothing.",
    ],
  },
  {
    name: "plan",
    subcommands: ["sync-dod", "schema"],
    description: "Carry an edited workspace.yml into approved stories' dod blocks, or print the plan schema.",
    args: [],
    flags: [
      {
        name: "dry-run",
        arg: null,
        meaning: "Print the same per-story diff summary and write nothing.",
        sub: "sync-dod",
      },
      {
        name: "story",
        arg: null,
        meaning: "plan schema: print only the story example \u2014 a file the check accepts as it stands.",
        sub: "schema",
      },
      {
        name: "epic",
        arg: null,
        meaning: "plan schema: print only the epic example.",
        sub: "schema",
      },
      {
        name: "waves",
        arg: null,
        meaning: "plan schema: print only the waves.yml example.",
        sub: "schema",
      },
      runFlag(),
      root(),
    ],
    examples: [
      "tldrx plan sync-dod --dry-run",
      "tldrx plan sync-dod --run 260101-checkout",
      "tldrx plan schema --story",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "`plan schema` prints the story/epic/waves contract \u2014 the SAME bytes the Plan agent is given, generated from the validators the `plan` check runs, so it cannot drift from what will be accepted. At most one of --story/--epic/--waves; without one the whole contract is printed. It resolves no workspace and no run, touches no disk and spends nothing, because the question comes before any of those exist.",
      "A story dod command must equal a `workspace.yml` command verbatim, so editing workspace.yml orphans every approved story that cited the old string. This is the mechanical repair, and it does not weaken that rule by a byte.",
      "Four outcomes per line, and only the first three write anything: a line the current workspace still declares is left alone; a line a PREVIOUS version declared under a role the current file still has becomes that role's command; a line whose role is gone is dropped; and a line no version of workspace.yml ever declared is FLAGGED and its story is left untouched \u2014 that is real drift, not a rename, and guessing at it is the one thing this must not do.",
      "The ancestry comes from git's history of `.tldrx/workspace.yml`. In a workspace with no history there are no ancestors, so every non-current line is flagged rather than rewritten.",
      "Nothing else in a story moves: the front matter, the prose and the fences come back byte-identical, the previous version is kept at `<story>.md.bak`, and the result is validated by the same plan check the drift came from. It runs no agent, spends nothing and moves no cursor.",
    ],
  },
  {
    name: "budget",
    subcommands: ["show", "raise", "grant"],
    description: "What the run may still spend, where to move a ceiling from, and what the owner authorized.",
    args: [
      { name: "[<run>]", meaning: "budget show: a run id. Omit it and the one open run is used." },
      { name: "<phase>", meaning: "budget raise: the phase whose ceiling goes up, e.g. 04-build." },
      {
        name: "<usd>",
        meaning: "budget raise: how much to ADD to that phase's ceiling \u2014 a delta, not a new ceiling. `raise 04-build 5` turns a $20 ceiling into $25. budget grant: the CEILING the owner authorized \u2014 a total, not a delta, and it moves no money.",
      },
    ],
    flags: [
      runFlag(),
      json("the budget view", "show"),
      { name: "take-from", arg: "<phase>", meaning: "Move the money out of this phase instead of raising the run's total.", sub: "raise" },
      { name: "note", arg: "<text>", meaning: "Why the ceiling moved. Recorded on the budget.raised event beside the before/after and the actor.", sub: "raise" },
      // A SECOND entry rather than dropping `sub`: `grant` records the note on
      // its own event and `show` records nothing, so "every subcommand" would
      // advertise it where it is ignored — which is the fault this fixes, not a
      // shape to spread.
      { name: "note", arg: "<text>", meaning: "Why the grant was recorded. Kept on the budget.granted event beside the amount, the fact and the actor.", sub: "grant" },
      {
        name: "fact",
        arg: "<F>",
        meaning: "REQUIRED by grant: the live fact id the authorization cites, e.g. F031. A grant with no decision behind it is a number nobody said.",
        sub: "grant",
      },
      {
        name: "phase",
        arg: "<phase>",
        meaning: "Scope the grant to one phase instead of the whole run. The fact id is still recorded at run level.",
        sub: "grant",
      },
      {
        name: "on-exceed",
        arg: "<policy>",
        meaning: "What a ceiling ABOVE the grant does. Default: warn. Never on_exceed, which governs spending past a ceiling rather than writing one.",
        values: ON_GRANT_EXCEED,
        sub: "grant",
      },
      root(),
    ],
    examples: [
      "tldrx budget show",
      "tldrx budget raise 04-build 25 --take-from 02-how",
      "tldrx budget grant 20 --fact F031 --on-exceed block",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "`raise` ADDS. `raise 04-build 25` on a phase already ceilinged at $10 leaves it at $35, not $25 \u2014 the amount is a delta, and the run ceiling grows with it unless --take-from moves the money. `budget show` prints the exact command, already sized to the shortfall, when a stage is blocked; pasting that is the way to raise without doing the arithmetic.",
      "`grant` RECORDS, it does not spend: it writes authorized_usd, authorized_by, authorized_at and on_grant_exceed into budget.yml and appends a budget.granted event. No ceiling moves, and a grant the current ceiling already exceeds is still recorded \u2014 the money is committed, there is nothing left to refuse. `raise` then measures the ceiling it is about to write against it: a PHASE grant against the phase ceiling, the RUN grant against the run ceiling.",
      "Two exit families, two conditions. A bad amount, an unknown phase, an unknown --on-exceed value, or a --fact naming no live fact is a USAGE error: exit 1, nothing written. A ceiling above the recorded grant under on_grant_exceed: block is a GATE refusal: exit 2, budget.yml byte-identical. Under the default warn the ceiling is written and one sentence names the grant, the fact and the figure.",
    ],
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
      {
        name: "stories",
        arg: null,
        meaning: "Per story: what it measurably cost, beside the ceiling its spawn was given (`agent.spawned.max_budget_usd`), and the ratio. Off `events.jsonl` only; no plan document carries a per-story dollar figure, so none is invented.",
      },
      json("the cost breakdown"),
      root(),
    ],
    examples: [
      "tldrx cost",
      "tldrx cost --all",
      "tldrx cost --stories",
      "tldrx cost 260101-checkout --json",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND],
    notes: [
      "Read off `events.jsonl` and nothing else, and the log holds two kinds of number that are never added to each other: the MEASURED dollars a metered turn reported on an `agent.result` line, and — with `--stories` — the SPAWN CEILINGS the executor handed `agent.spawned`, which are caps it computed rather than charges. No token count is ever multiplied by a price — `tldrx run estimate` is the command allowed to guess, and it says ESTIMATE in words.",
      "Attempts are never merged. A stage that failed twice cost three turns, and that retry is usually the money you are looking for.",
      "Work this process never saw a cost for is reported as UNMETERED rather than summed as $0.00 — a missing number and a free turn are not the same claim.",
      "`--all` and `--stories` are two different reports and cannot be combined: the pair is refused (exit 1), never silently resolved in favour of one. `--stories` changes no ceiling and spends nothing. It is the measurement side: the ceiling a story is reported against is the one the executor computed and handed the spawn, never a share of a plan \u2014 story files carry no budget key at all \u2014 and it is the input a recalibration of those ceilings would need.",
    ],
  },
  {
    name: "map",
    subcommands: ["--refresh", "--check"],
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
    subcommands: ["list", "create", "train", "recompute", "rescore", "packs"],
    description: "List or create experts, recompute or rescore their levels, train one, or switch the stack packs on.",
    args: [
      { name: "<name>", meaning: "expert create / train: the expert. expert recompute / rescore: optional — all of them by default." },
      { name: "<enable|disable|status>", meaning: "expert packs: turn the stack packs on or off for this workspace, or print their state." },
    ],
    flags: [
      json("the table", "list"),
      { name: "area", arg: "<id>", meaning: "Seed the new expert's first competency area, at level 0. Without an area there is nothing to train, and `expert train` refuses it.", sub: "create" },
      { name: "title", arg: "<text>", meaning: "Name that area. Light mode greps the words of the area title to choose which files the expert is shown, so it is worth writing.", sub: "create" },
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
      { name: "area", arg: "<area>", meaning: "Rescore only this area. Every area a knowledge file names, by default.", sub: "rescore" },
      json("the results", "rescore"),
      root(),
    ],
    examples: [
      "tldrx expert list",
      "tldrx expert create billing --area money --title \"Invoicing, proration and refunds\"",
      "tldrx expert train billing --area money --mode light --print-prompt",
      "tldrx expert train billing --area money --mode full --model sonnet",
      "tldrx expert recompute --json",
      "tldrx expert rescore",
      "tldrx expert packs enable",
      "tldrx expert packs status",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_AGENT_FAILED],
    notes: [
      "`--max-usd` defaults to $2.00 in light mode and $3.00 in full, because full mode spawns TWO sub-agents and splits the ceiling between them. Measured full trainings cost $1.21-$1.60 end to end on a mid model.",
      "`--prepare` gets the same line and the same arithmetic: it does not spawn, but it freezes the ceiling into `pending.json` and into the prompt a host session spends against. An explicit `--model` that cannot fit is refused there too; an inherited one warns, because tldrx cannot see which model the host session will pick.",
      "An expert with no competency area cannot be trained: `expert train` refuses it and prints the `areas:` block to add to `.tldrx/experts/<name>/competencies.yml`. `create --area <id>` writes that block for you. `create` also writes the front-matter `repos:` from `.tldrx/workspace.yml` — the `## Domain` bullets are paths RELATIVE to those repos, with no repo prefix.",
      "`recompute` and `rescore` are different remedies and neither spends money. `recompute` is arithmetic over the evidence rows already in `competencies.yml`, for a level that drifted. `rescore` RE-READS `knowledge/*.md` and derives their evidence again under today\u0027s rules — the one to reach for after a change to what counts as evidence, so a workspace does not have to buy readings it already paid for. Rescored rows are dated by the file\u0027s own `trained_at`, or by the expert\u0027s `last_trained` when it has none; never by the clock, because \u00a72.6 weighs recency. Each also carries `rescored_at` \u2014 when it was SCORED, as against `at`, when the claim was READ \u2014 and the run appends one `evidence.rescored` line to `training.jsonl` at $0.00, dated when it ran, whenever it actually moved something. Without that record a workspace whose ledger says `evidence_added: 0` would end up holding two files that contradict each other.",
      "With no `--model`, the sub-agent inherits whatever your claude CLI is set to — which can be a premium tier at premium prices. `train` now says which model it resolved and what tier that is BEFORE it spawns, and REFUSES (exit 2, nothing spent) when the per-sub-agent share cannot reach what a pass on that tier costs. Pass `--model sonnet` or an explicit `--max-usd` to proceed.",
      "`packs enable` is the one switch for the stack packs, off by default. It re-runs detection, seeds any missing `<lang>-stack` expert, gives each one whose body is still the seeded stub the shipped pack body (an edited body is kept and said so — delete the body to re-seed), writes every framework overlay detection can prove under `overlays/` with its evidence in `workspace.yml`, and names the project's `.claude/skills`. `disable` removes the overlays and touches neither bodies nor knowledge. `status` prints all of it and always exits 0; `enable` exits 1 when no repo has a detectable language. `disable` is idempotent: no workspace.yml yet means nothing to disable (exit 0, named line, same as `status`) — it exits 1 only when workspace.yml exists but is too broken to read.",
    ],
  },
  {
    name: "dashboard",
    description: "Watch the workspace live in a browser, or export it as one static page.",
    args: [],
    flags: [
      { name: "serve", arg: null, meaning: "Serve the page and keep watching the files \u2014 the default. Refused together with --static." },
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
    description: "Close a run and write down what it learned \u2014 or, with --all, what every run keeps catching.",
    args: [
      {
        name: "[<run-id>]",
        meaning: "Which run to close. Omit it and the newest run is used; several runs open is a refusal (exit 2). Refused together with --all, which reads every run.",
      },
    ],
    flags: [
      { name: "apply", arg: null, meaning: "Also append the practice proposals to .tldrx/memory/practices.md. Refused together with --all, which writes nothing." },
      {
        name: "all",
        arg: null,
        meaning: "Aggregate ACROSS every run under tldrx-work/ instead of closing one, and print the trends table: finding class \u00d7 count \u00d7 how many runs it appeared in \u00d7 one example with its citation. Reads the review logs, the fix lists, retro.md and the story.reopened reasons; writes nothing anywhere.",
      },
      json("the cross-run aggregate (--all only; closing one run writes a file and has nothing to parse)"),
      root(),
    ],
    examples: [
      "tldrx retro",
      "tldrx retro 260101-checkout --apply",
      "tldrx retro --all",
      "tldrx retro --all --json",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND],
    notes: [
      "--all is strictly read-only: no retro.md, no practices.md, no cache, no state. A run missing any of the four sources contributes what it has and is still counted; an empty workspace is an empty answer at exit 0, not a failure.",
      "Classification is deterministic keyword rules over the finding text \u2014 no model runs \u2014 so the same tree always produces the same table. `other` is a real row: a table it dominates is telling you the taxonomy is too small.",
      "A repeat of one finding WITHIN a run is collapsed (retro.md quotes the fix list verbatim); the same finding in two runs is two occurrences, which is what the table is for.",
      "The taxonomy is workspace-extensible: `.tldrx/memory/finding-classes.yml` (version: 1, `classes:` of `{name, rules}`) adds classes for defects the seven do not name. Extensions are tried AFTER every built-in rule, so they can only claim findings that would otherwise be `other`. A file that will not load is a refusal naming the class and the rule, never a silent fallback.",
      "The top three classes (never `other`) are also injected into every adversarial reviewer prompt the Build phase renders, so a review starts from what this team keeps getting wrong instead of from zero. No runs, no findings, or a broken finding-classes.yml \u2014 no section at all.",
    ],
  },
  {
    name: "drive",
    description: "Print the session mandate for driving a run \u2014 the discipline, not the manual.",
    args: [
      {
        name: "[<run>]",
        meaning: "The run id to write into the mandate's <run> slots. Omit it and the one open run of this workspace is used; with no workspace, no run, or two open runs, <run> is left as it is.",
      },
    ],
    flags: [
      {
        name: "run",
        arg: "<id>",
        meaning: "The same thing as the positional, in the spelling every other command takes. The positional wins if both are given. Substituted textually and never validated \u2014 an id that names no run is yours to notice.",
      },
      {
        name: "attended",
        arg: null,
        meaning: "A person is at the keyboard and closes every gate. The mandate tells the session to do the checking anyway and hand the decision over \u2014 it never signs.",
      },
      {
        name: "unattended",
        arg: null,
        meaning: "Nobody is watching. The mandate is for a session driving an `attended_by: host` run with `agent` gates: it drives every turn, signs a gate only over a written evidence note, and wakes a person for the four things that are still theirs.",
      },
      {
        name: "tldr",
        arg: null,
        meaning: "Essentials only, for a run whose trail you will not read. The mandate gains a reporting contract: after every commit and at every gate the session shows what `tldrx run status` prints plus at most three bullets of delta, and nothing else — no recaps, no diff summaries, no `tldrx note`. Sub-agents are briefed to keep handoffs and evidence notes at the minimum `claim-sources` still validates. Prose is trimmed; citations and gates are not. Works with either mode.",
      },
    ],
    examples: [
      "tldrx drive --unattended",
      "tldrx drive --unattended 260901-leaderboard",
      "tldrx drive --unattended --tldr",
      "tldrx drive --attended",
    ],
    exits: [EXIT_OK, EXIT_USAGE],
    notes: [
      "Read-only in the strongest sense: it needs no workspace, opens no run, spawns nothing and writes nothing. The output is plain text to paste into the session that will drive the run.",
      "The mandate's commands all name a run. Given an id it fills every <run> in \u2014 there is no partial substitution, which is the point: a hand find-replace across them only has to miss one to send a session at the wrong run. Given none it looks for the ONE open run here, and where the CLI would refuse to choose between two it declines to substitute and says which ids were on offer, because a mandate silently aimed at the wrong run is worse than a placeholder. It still exits 0 with no workspace at all.",
      "A mode is required and never guessed (exit 1). The two mandates differ in exactly the place a wrong guess costs most \u2014 who may close a gate.",
      "It is versioned with the package: the header carries the framework version that printed it.",
    ],
  },
  {
    name: "watch",
    subcommands: ["list", "check", "arm"],
    description: "List the watcher cards a run produced, work through them as a post-merge checklist, or wait for the shipped PR to merge and print it.",
    args: [{ name: "[<feature>]", meaning: "watch check: which card to check. Omit it and every card in the run is checked; unused by list and arm." }],
    flags: [
      runFlag(),
      json("the card list", "list"),
      {
        name: "execute",
        arg: null,
        meaning: "Re-run the `$ <cmd> \u2192 exit <n>` sources the cards recorded, through the same workspace.yml allowlist a stage check uses, and report the exit each one gets NOW. Off by default: without it every signal is printed, never run. A `## Query` block is never run \u2014 it belongs to the console named under `## Where`. Never offered by `arm`.",
        sub: "check",
      },
      {
        name: "interval",
        arg: "<s>",
        meaning: "How often `arm` asks `gh pr view` whether the PR merged. Default 60. Anything under 10 is REFUSED rather than quietly raised \u2014 a PR does not merge twice, and a tighter loop only hammers the API.",
        sub: "arm",
      },
      {
        name: "timeout",
        arg: "<s>",
        meaning: "How long `arm` keeps asking before it gives up and prints the command that re-arms it. Default 3600, maximum 86400. It holds the terminal it was typed in; there is no background poller.",
        sub: "arm",
      },
      {
        name: "branch",
        arg: "<name>",
        meaning: "Which of the run's epic branches to watch, when Build cut more than one. The same list `tldrx ship` picks from (`build.epic_branch` in run.yml), read by the same code.",
        sub: "arm",
      },
      {
        name: "repo",
        arg: "<name>",
        meaning: "Narrow to one repo of the workspace. By default every repo of the run that has the branch is watched, and the checklist fires only when ALL of their PRs have merged.",
        sub: "arm",
      },
      root(),
    ],
    examples: [
      "tldrx watch list",
      "tldrx watch list --json",
      "tldrx watch check",
      "tldrx watch check checkout-flow",
      "tldrx watch check --execute",
      "tldrx watch arm --run 260101-checkout",
      "tldrx watch arm --interval 120 --timeout 7200",
    ],
    exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_AWAITING_HUMAN],
    notes: [
      "`watch check` exits 1 when a citation no longer resolves \u2014 a check that reported rot on stdout and exited 0 would be invisible to CI.",
      "It exits 3 when there is nothing to check, and says which nothing: a run whose Watch stage never ran, or a Watch stage that shipped no feature. A green that means \"I read no cards\" is the failure this command exists to stop.",
      "`watch arm` is a bounded FOREGROUND poller, not a daemon: it reads the branch Build cut, asks `gh pr view <branch> --json state,mergedAt`, and prints the `watch check` checklist the moment every PR for that branch has merged. It never pushes, opens or merges anything. No epic branch, no PR for the branch, and a PR CLOSED without merging are all refusals with a sentence in them (exit 2); a window that expires with the PR still open exits 4 and says how to re-arm.",
    ],
  },
  {
    name: "tickets",
    subcommands: ["sync", "status"],
    description: "Mirror the plan's epics and stories to a ticket tool. The files stay the source of truth.",
    args: [{ name: "[<run>]", meaning: "A run id. Omit it and the one open run is used." }],
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
    subcommands: [...RUNNABLE_SCRIPTS],
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
/** The verbs `<cmd> --help` lists, and the dispatcher scopes a flag by. Empty when none. */
export function subcommandsOf(name: string): readonly string[] {
  return helpFor(name)?.subcommands ?? [];
}

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
