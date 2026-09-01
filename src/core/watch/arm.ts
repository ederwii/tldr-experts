/**
 * `tldrx watch arm --run <id>` — the detector half of gh #65 (gh #69).
 *
 * `watch check` answers "what do I check now?". This answers "the PR just merged,
 * go and check it" — the half that happens without a human remembering. The
 * failure #65 was filed about IS a memory failure: the owner's own CD gap, where
 * a merged branch was read as a deployed one, cost 19 destroyed records. v1's
 * manual command would not have caught it either, because nobody ran it.
 *
 * ## Bounded, local, and not a daemon
 *
 * Owner decision, 2026-09-01: a bounded local poller over `gh pr view`, no GitHub
 * Actions. So it is a FOREGROUND loop with a hard deadline, a floor on the
 * interval and a hard cap on the number of polls — three independent bounds, any
 * one of which ends it. The framework has no background process and this issue is
 * not the reason to grow one: `arm` occupies the terminal it was typed in, says
 * so, and when it gives up it prints the command that re-arms it.
 *
 * ## What it will not do
 *
 * It never PUSHES, never opens a PR, and never merges one. It reads `run.yml` for
 * the branch Build cut (the same `build.epic_branch` `tldrx ship` reads, through
 * the same `pickBranch`/`findRepos`, so the two verbs cannot disagree about which
 * branch a run shipped) and asks `gh` about it. A run with no branch, or a branch
 * with no PR, is a REFUSAL with a sentence in it — those are ordinary situations,
 * not errors, and the operator's next move differs for each.
 *
 * ## The clock is injected
 *
 * `now` and `sleep` are parameters. Not for purity: it is the only way a test can
 * cover a one-hour timeout in a millisecond and the only way the suite can
 * guarantee this loop never hangs it. The default `sleep` is a plain `setTimeout`
 * — no runtime seam is involved, because there is nothing runtime-specific about
 * waiting.
 */
import { RunStore } from "../run/RunStore.ts";
import { ambiguousRunLines } from "../run/openRuns.ts";
import { findRepos, pickBranch, type ShipRepo, type ShipTransport } from "../run/ship.ts";
import { GH_BIN } from "../adapters/github.ts";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { loadWorkspace, toSrcContext } from "../../hooks/lib/workspace.ts";
import { cardChecklist, checklistOk, nothingToCheck, renderChecklist } from "./signalChecklist.ts";
import { loadCards } from "./watchViews.ts";

/** Spec §3 codes, spelled here so `core/` does not import the CLI's table. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;
/** The PR is still open and a person has to merge it. That is code 4's meaning. */
const EXIT_AWAITING = 4;

/** How often to ask, when the caller does not say. A minute is polite to `gh`. */
export const DEFAULT_INTERVAL_S = 60;
/**
 * The floor, and it is a REFUSAL rather than a silent clamp.
 *
 * A caller who typed `--interval 1` believes it is asking every second; raising
 * it quietly to ten would make the poller's own behaviour a thing the operator
 * has to know the source to predict. Ten seconds is also the point below which
 * this is hammering somebody's API for no gain — a PR does not merge twice.
 */
export const MIN_INTERVAL_S = 10;
/** How long to keep asking, when the caller does not say. */
export const DEFAULT_TIMEOUT_S = 3600;
/** Nothing may arm for longer than a day; past that, re-arm deliberately. */
export const MAX_TIMEOUT_S = 86_400;
/**
 * A bound that does not depend on the clock.
 *
 * The deadline is the intended stop; this is the one that holds if `now` is
 * frozen, non-monotonic, or injected wrong. A loop with a single bound has none.
 */
export const MAX_POLLS = 10_000;

/** One `gh pr view --json state,mergedAt` answer, per repo. */
export interface PrState {
  readonly repo: string;
  /** `MERGED`, `OPEN`, `CLOSED` — whatever `gh` said, uppercased. */
  readonly state: string;
  /** RFC-3339, or null when it has not merged. */
  readonly mergedAt: string | null;
}

export interface ArmOptions {
  readonly root: string;
  readonly runId?: string;
  /** `--branch`: which epic branch, when the run cut more than one. */
  readonly branch?: string;
  /** `--repo`: narrow to one repo of the workspace. */
  readonly repo?: string;
  readonly intervalS?: number;
  readonly timeoutS?: number;
  readonly transport: ShipTransport;
  /** Epoch milliseconds. Injected so a test can cover an hour instantly. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called with each poll's one-line progress note. Defaults to nothing. */
  readonly onPoll?: (line: string) => void;
}

export interface ArmOutcome {
  readonly code: number;
  readonly lines: readonly string[];
  /** True only when every watched PR reported `MERGED`. */
  readonly merged: boolean;
  /** How many times `gh pr view` was asked. Always ≥ 1 once polling starts. */
  readonly polls: number;
}

function refuse(lines: readonly string[], polls = 0): ArmOutcome {
  return { code: EXIT_REFUSED, lines, merged: false, polls };
}

const realSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export async function armRun(options: ArmOptions): Promise<ArmOutcome> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? realSleep;

  const intervalS = options.intervalS ?? DEFAULT_INTERVAL_S;
  if (!Number.isFinite(intervalS) || intervalS < MIN_INTERVAL_S) {
    return refuse([
      `--interval ${String(intervalS)} is below the ${String(MIN_INTERVAL_S)}-second floor`,
      "  a PR does not merge twice, and a tighter loop only hammers the API. Pass a larger interval.",
    ]);
  }
  const timeoutS = options.timeoutS ?? DEFAULT_TIMEOUT_S;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS > MAX_TIMEOUT_S) {
    return refuse([
      `--timeout ${String(timeoutS)} is not a window between 1 and ${String(MAX_TIMEOUT_S)} seconds`,
      "  `arm` holds the terminal it was typed in; a poller nobody can see running is the daemon",
      "  this issue deliberately did not build.",
    ]);
  }

  // --- what to watch, read off disk before a single process is spawned -------

  const resolution = RunStore.resolve(options.root, options.runId);
  if (resolution.kind === "ambiguous") return refuse([...ambiguousRunLines(resolution.open)]);
  if (resolution.kind === "none") {
    return {
      code: EXIT_NOT_FOUND,
      merged: false,
      polls: 0,
      lines: [options.runId === undefined || options.runId === ""
        ? `no non-terminal run in ${PROJECT_WORK_DIR}/`
        : `no run '${options.runId}' in ${PROJECT_WORK_DIR}/`],
    };
  }
  const store = resolution.store;

  const claimed = store.run.build?.epic_branch ?? [];
  if (claimed.length === 0) {
    return refuse([
      `${store.runId} has cut no epic branch, so no PR was ever opened from it and there is`,
      "  nothing to watch for a merge.",
      "  `build.epic_branch` in run.yml is written by the Build stage; `tldrx ship` opens the PR",
      "  from it. Neither has happened here.",
    ]);
  }
  const branch = pickBranch(claimed, options.branch);
  if (typeof branch !== "string") return refuse(branch.lines);

  const repos = await findRepos(options, store, branch);
  if ("code" in repos) return refuse(repos.lines);

  // `gh` is asked to identify itself BEFORE any `pr view`, for the same reason
  // `tldrx ship` does it: without this, an uninstalled `gh` exits 127, every repo
  // reads as "no PR", and the operator is told to go and re-ship a branch whose
  // only problem is that the CLI is missing. A wrong sentence costs more than a
  // spawn.
  const gh = await options.transport.run(GH_BIN, ["--version"], options.root);
  if (gh.exitCode !== 0) {
    const first = (gh.stderr.split("\n").find((line) => line.trim() !== "") ?? "").trim();
    return refuse([
      "`gh` is not usable here, and it is what answers whether the PR merged",
      `  \`${GH_BIN} --version\` exited ${String(gh.exitCode)}${first === "" ? "" : `: ${first}`}`,
      "  install it (`brew install gh`, or https://cli.github.com) and `gh auth login`, then try again.",
      "  Nothing was watched and nothing was checked.",
    ]);
  }

  // --- poll -----------------------------------------------------------------

  const deadline = now() + timeoutS * 1000;
  let polls = 0;
  let states: readonly PrState[] = [];

  // Three independent bounds: the deadline, the poll cap, and the fact that every
  // path through the body either returns or sleeps a positive interval. Any one of
  // them ends the loop on its own.
  while (polls < MAX_POLLS) {
    polls++;
    const read = await readPrs(options.transport, repos, branch);
    if ("missing" in read) {
      return refuse(noPrLines(branch, read.missing, store.runId), polls);
    }
    states = read.states;

    const closed = states.filter((one) => one.state === "CLOSED");
    if (closed.length > 0) {
      return {
        code: EXIT_REFUSED,
        merged: false,
        polls,
        lines: [
          `the PR for \`${branch}\` was CLOSED without merging`
            + ` (${closed.map((one) => one.repo).join(", ")})`,
          "  it will never merge, so waiting for it would be a poller that can only time out.",
          "  Re-open it or open a new one, then arm again.",
        ],
      };
    }

    // `length > 0` is not redundant: `[].every(…)` is TRUE, so a future change that
    // let `repos` reach here empty would report a merge nobody made — the one lie
    // this command exists to prevent. `findRepos` refuses an empty list today; the
    // guard is what keeps that a local fact rather than a two-function-away one.
    if (states.length > 0 && states.every((one) => one.state === "MERGED")) {
      return merged(options.root, store.runDir, store.runId, branch, states, polls);
    }

    options.onPoll?.(
      `${new Date(now()).toISOString()} — \`${branch}\` still `
      + `${states.map((one) => `${one.repo}: ${one.state.toLowerCase()}`).join(", ")}`,
    );

    if (now() + intervalS * 1000 > deadline) break;
    await sleep(intervalS * 1000);
  }

  return {
    code: EXIT_AWAITING,
    merged: false,
    polls,
    lines: [
      `\`${branch}\` did not merge within ${String(timeoutS)}s (${String(polls)} poll(s),`
        + ` every ${String(intervalS)}s) — nothing was checked, because nothing merged.`,
      ...states.map((one) => `  ${one.repo}: ${one.state.toLowerCase()}`),
      `  re-arm: tldrx watch arm --run ${store.runId} --timeout ${String(timeoutS)}`,
      `  or check by hand once it lands: tldrx watch check --run ${store.runId}`,
    ],
  };
}

/** Which repos have no PR for this branch, or every repo's state. */
async function readPrs(
  transport: ShipTransport,
  repos: readonly ShipRepo[],
  branch: string,
): Promise<{ readonly states: readonly PrState[] } | { readonly missing: readonly string[] }> {
  const states: PrState[] = [];
  const missing: string[] = [];
  for (const repo of repos) {
    const seen = await transport.run(GH_BIN, ["pr", "view", branch, "--json", "state,mergedAt"], repo.dir);
    if (seen.exitCode !== 0) {
      missing.push(repo.name);
      continue;
    }
    const parsed = parseView(seen.stdout);
    if (parsed === null) {
      missing.push(repo.name);
      continue;
    }
    states.push({ repo: repo.name, state: parsed.state, mergedAt: parsed.mergedAt });
  }
  // Strict: a run that shipped to two repos and has a PR in one is not a run whose
  // merge can be detected. Arming on the half that exists would report "merged"
  // over work the other repo has not landed.
  return missing.length > 0 ? { missing } : { states };
}

function parseView(stdout: string): { readonly state: string; readonly mergedAt: string | null } | null {
  let row: unknown;
  try {
    row = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof row !== "object" || row === null) return null;
  const state = (row as { state?: unknown }).state;
  if (typeof state !== "string" || state === "") return null;
  const at = (row as { mergedAt?: unknown }).mergedAt;
  return { state: state.toUpperCase(), mergedAt: typeof at === "string" && at !== "" ? at : null };
}

function noPrLines(branch: string, missing: readonly string[], runId: string): readonly string[] {
  return [
    `no open or merged PR for \`${branch}\` in ${missing.join(", ")} — there is nothing to watch`,
    "  `gh pr view` found none. Either `tldrx ship` has not run for this branch, or the branch was",
    "  never pushed (tldrx does not publish branches — that decision is yours):",
    `    git push -u origin ${branch}`,
    `    tldrx ship --run ${runId} --branch ${branch}`,
  ];
}

/**
 * The merge, then the checklist — the same one `tldrx watch check` prints.
 *
 * Built from `loadCards` / `cardChecklist` / `renderChecklist`, the three
 * functions the CLI's `check` uses, so the two screens cannot drift. `--execute`
 * is deliberately NOT offered here: a poller that has been sitting in a terminal
 * for an hour must not start running the workspace's build commands the moment a
 * merge lands. Re-running a recorded command stays an explicit, typed decision.
 */
function merged(
  root: string,
  runDir: string,
  runId: string,
  branch: string,
  states: readonly PrState[],
  polls: number,
): ArmOutcome {
  const when = states.map((one) => one.mergedAt).find((at) => at !== null) ?? "an unrecorded time";
  const head = [
    `\`${branch}\` merged at ${when} (${states.map((one) => one.repo).join(", ")}),`
      + ` detected on poll ${String(polls)}.`,
    "",
  ];

  const ctx = toSrcContext(loadWorkspace(root), runDir);
  const cards = loadCards(runDir, ctx);
  const refusal = nothingToCheck(runDir, runId, cards);
  if (refusal !== null) {
    return {
      code: EXIT_NOT_FOUND,
      merged: true,
      polls,
      lines: [...head, `nothing to check: ${refusal}`],
    };
  }
  const lists = cards.map((card) => cardChecklist(card, ctx));
  return {
    code: checklistOk(lists, new Map()) ? EXIT_OK : EXIT_FAILED,
    merged: true,
    polls,
    lines: [...head, ...renderChecklist(runId, lists).split("\n")],
  };
}
