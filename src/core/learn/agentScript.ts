/**
 * What the tutorial's stand-in `claude` will say, written down as data.
 *
 * `tldrx learn` runs the REAL commands, and some of them spawn a sub-agent. A
 * tutorial that spent money — or that needed a network, or an API key, or three
 * minutes of model latency per chapter — would not be a tutorial anybody plays.
 * So the sandbox installs a stand-in and hands it this script: a list of turns,
 * each keyed on something the PROMPT says, each declaring the files that turn
 * writes and the envelope it returns.
 *
 * Keyed on the prompt, not on a call counter, for the same reason
 * `test/fixtures/build/fakeClaude.ts` is: the heading is what the real model
 * keys on too, so a prompt that lost its heading fails the tutorial instead of
 * passing it quietly. `times:` exists for the one shape a heading cannot express
 * — the same stage asked twice, answering differently the second time, which is
 * what chapter 5's retry is made of.
 *
 * Everything here is PURE. `selectTurn` takes a script, a prompt and a tally and
 * returns a turn; nothing reads a file, spawns anything or looks at a clock. The
 * process that executes the chosen turn is `learnAgent.ts`.
 *
 * ## Adding turns for a chapter (chapters 3-8)
 *
 * A chapter declares its turns inline (`ChapterStep.agentTurns`); the engine
 * merges them into the sandbox's script file before it runs the step's command.
 * So a new chapter that needs a sub-agent is DATA — a `match` string, the files
 * the turn writes — and needs no change in this file or in `learnAgent.ts`.
 */

/** One scripted sub-agent turn. */
export interface AgentTurn {
  /**
   * Played when the prompt CONTAINS this text. `"*"` matches any prompt, and is
   * how a chapter says "whatever this stage is, answer it like this".
   */
  readonly match: string;
  /**
   * Files this turn writes, relative to the agent's working directory — which
   * the facilitator has already set to the stage's own directory, exactly as it
   * would for the real thing. The values are the file contents, verbatim.
   */
  readonly writes?: Readonly<Record<string, string>>;
  /**
   * The `structured_output` envelope. Omitted, a successful turn returns the
   * ordinary stage envelope naming the files it wrote, which is what the
   * facilitator's output validation reads.
   */
  readonly structured?: unknown;
  /** What this turn "cost". Fake money, so the money chapter has a ledger to show. */
  readonly costUsd?: number;
  /** Assistant prose, so the progress view has something to narrate. */
  readonly say?: string;
  /**
   * Fail this turn: `is_error`, a non-zero exit and NO envelope — the shape a
   * sub-agent that died mid-turn really leaves behind. Chapter 5 is built on it.
   */
  readonly fails?: boolean;
  /** The failure's one line, as the real CLI would word it. */
  readonly error?: string;
  /**
   * Play this turn at most this many times. Once it is spent the NEXT matching
   * turn takes over, so `[{match: "# Review", times: 1, …changes…}, {match: "# Review", …approve…}]`
   * is "refuse once, then approve" without a counter in the chapter's code.
   */
  readonly times?: number;
}

export interface AgentScript {
  readonly version: 1;
  readonly turns: readonly AgentTurn[];
}

/** How many times each turn (by index) has already been played. */
export type TurnTally = Readonly<Record<string, number>>;

export const EMPTY_SCRIPT: AgentScript = { version: 1, turns: [] };

/**
 * The turn to play for this prompt, or null when the script has nothing to say.
 *
 * Null is a REFUSAL, never a default turn: a stage nobody scripted is a hole in
 * the tutorial, and a stand-in that improvised past it would teach the learner
 * something the framework does not do.
 */
export function selectTurn(
  script: AgentScript,
  prompt: string,
  tally: TurnTally = {},
): { readonly turn: AgentTurn; readonly index: number } | null {
  for (const [index, turn] of script.turns.entries()) {
    if (!matches(turn, prompt)) continue;
    const played = tally[String(index)] ?? 0;
    if (turn.times !== undefined && played >= turn.times) continue;
    return { turn, index };
  }
  return null;
}

function matches(turn: AgentTurn, prompt: string): boolean {
  return turn.match === "*" || prompt.includes(turn.match);
}

/** The tally with one more play recorded against `index`. */
export function recordPlay(tally: TurnTally, index: number): TurnTally {
  return { ...tally, [String(index)]: (tally[String(index)] ?? 0) + 1 };
}

/** Two scripts, in order: `first`'s turns are tried before `second`'s. */
export function mergeScripts(first: AgentScript, second: AgentScript): AgentScript {
  return { version: 1, turns: [...first.turns, ...second.turns] };
}

/**
 * Parse a script file's text. A malformed script THROWS rather than degrading to
 * an empty one: an empty script and a broken script look identical from the
 * sub-agent's side (both refuse), and only one of them is a bug in the tutorial.
 */
export function parseScript(text: string): AgentScript {
  const doc: unknown = JSON.parse(text);
  if (typeof doc !== "object" || doc === null) throw new Error("agent script is not an object");
  const turns = (doc as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) throw new Error("agent script has no `turns` array");
  return { version: 1, turns: turns as readonly AgentTurn[] };
}

export function stringifyScript(script: AgentScript): string {
  return `${JSON.stringify(script, null, 2)}\n`;
}
