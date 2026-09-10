/**
 * The gate signer — the turn that WRITES the evidence note an `agent` gate is
 * closed over (gh #198).
 *
 * Three pieces were built and never joined. `gates_policy: agent` says who MAY
 * sign. `evaluateAgentGate` (`core/run/agentGate.ts`) validates a note that
 * exists and `approve --as-agent` closes the gate over it. And the only thing
 * that ever WROTE `.agent/<stage>/evidence.md` was `tldrx gate template`, a
 * blank form filled in by a host session at somebody's keyboard. So an
 * engine-driven `run auto` over a run whose every gate was moved to `agent`
 * still stopped at each one with exit 4 — measured on tldrx 0.13.1, issue #198 —
 * because the signer only existed inside a host session and never inside the
 * loop.
 *
 * This module is the signer's DATA half: who it is, what it may touch, what it
 * costs, and the document it is handed. The orchestration — spawn, record,
 * re-evaluate, approve — is `runNext.finishStage`, beside the evaluator it feeds.
 *
 * ## Why no flag turns it on
 *
 * `gates_policy: agent` is already the owner's explicit, recorded choice that an
 * agent may close this gate — `tldrx run gates set` says so in its own reply, and
 * a run is opened with the policy frozen (§A.7). A second opt-in would mean the
 * policy alone never does what it says, which is exactly the gap #198 measured. So
 * the signer runs whenever the policy is `agent` and the ENGINE is driving
 * (headless mode); `--gate-agent` keeps changing rendering and nothing else, and
 * nothing here ever looks at a `human` gate.
 *
 * ## What it may do
 *
 * Read, and write ONE file. `REVIEWER_TOOLS` is the precedent — Build's reviewer
 * gets `Read, Grep, Glob, Bash(git diff *)` and cannot write at all — and the
 * signer is the same shape plus the single write its whole job is. `Write` is not
 * scoped to a path by the provider, so the path is named in the prompt and the
 * ENGINE is what enforces it: nothing but `.agent/<stage>/evidence.md` is read
 * back, and the note goes through the unchanged validator either way. A signer
 * that scribbled elsewhere would have written into a stage whose outputs have
 * already been validated and whose checks have already passed.
 */
import type { EvidenceTemplateInput } from "../text/evidence.ts";
import { EVIDENCE_SECTIONS, GUIDANCE, renderEvidenceTemplate } from "../text/evidence.ts";
import { STAGE_TUNING_DEFAULTS } from "../schemas/stageTuning.ts";

/** `agent.spawned` / `agent.result` `role:` — the third one, beside `developer` and `reviewer`. */
export const GATE_SIGNER_ROLE = "gate-signer";

/**
 * Read-only, plus the one write the turn exists for.
 *
 * Deliberately NOT `BASE_TOOLS`: the signer has no business editing the stage's
 * outputs, and `Edit` is how it would. `Bash(git diff *)` is the same grant
 * `REVIEWER_TOOLS` carries and for the same reason — the Build gate's own
 * question is what the diff did.
 */
export const GATE_SIGNER_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "Bash(git diff *)", "Write"];

/**
 * `[assumption]` — the share of the stage's per-agent ceiling one signer turn gets.
 *
 * A quarter, the same figure `REVIEWER_SHARE` settled on for the same shape of
 * work: read what somebody else produced, check it, and write a short structured
 * verdict. It is NOT that constant imported — `REVIEWER_SHARE` is a fraction of a
 * STORY's price inside the Build phase's own arithmetic (`core/build/caps.ts`),
 * and borrowing it here would tie two ceilings that answer different questions to
 * one number. The size is the precedent; the derivation is this one.
 *
 * The signer's turn is spent INSIDE the stage's envelope, which has a consequence
 * worth naming rather than hiding: its cost lands on the stage's task rows, so the
 * auto gate's `budget` condition — `spent <= stage.budget_usd` — sees it. A stage
 * already at its ceiling can therefore be tipped over it by the very turn sent to
 * sign it, and the gate falls to a person with `budget` named. That is the honest
 * direction to fail in. The alternative — a turn the run paid for that the run's
 * own ceiling cannot see — is the kind of invisible spend `spentFigure` exists to
 * stop.
 */
export const GATE_SIGNER_SHARE = STAGE_TUNING_DEFAULTS.gateSignerShare;

/**
 * The first words of the signer's prompt. Tests assert THIS export rather than an
 * English phrase they typed themselves (AGENTS.md §8), and it is what a fake agent
 * matches on to tell a signer turn from a stage turn.
 */
export const GATE_SIGNER_MARKER = "You are the tldrx gate signer";

/** Everything the prompt is rendered from — DATA the facilitator already owns. */
export interface GateSignerPrompt {
  /** `<phase>/<stage>` — the gate this note will be evidence for. */
  readonly gate: string;
  readonly run: string;
  /** Where the note goes, as a path the sub-agent can write VERBATIM from its cwd. */
  readonly notePath: string;
  /** The stage's declared outputs, expanded, so "read these" is a list and not a search. */
  readonly outputs: readonly string[];
  /** The `auto` conditions as `evaluateAutoGate` measured them, `id` and `detail`. */
  readonly conditions: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[];
  /** The skeleton the note must be filled in from — `renderEvidenceTemplate`'s own bytes. */
  readonly skeleton: string;
}

/**
 * The skeleton, from the ONE function that renders it.
 *
 * `gate template` writes exactly these bytes to disk for a person; the signer is
 * handed exactly these bytes in its prompt. One spelling of the form, so a note
 * written by the engine and a note written by a person are the same document.
 */
export function gateSignerSkeleton(input: EvidenceTemplateInput): string {
  return renderEvidenceTemplate(input);
}

/**
 * The signer's brief.
 *
 * Short and imperative, for the reason `renderStagePreamble` is (gh #196): a
 * sub-agent handed a pile of context and no request answers the one
 * imperative-shaped sentence it can find. Every judgement word here is a rule the
 * validator already enforces — the verdict enum, the `[src: …]` on every bullet,
 * the sample counts matching the front matter — so the prompt and
 * `validateEvidence` cannot drift into disagreeing about what a signature is.
 */
export function renderGateSignerPrompt(input: GateSignerPrompt): string {
  const lines: string[] = [
    `${GATE_SIGNER_MARKER} for gate \`${input.gate}\` of run \`${input.run}\`.`,
    "This prompt is the entire request: there is no other message to find, and no operator to reply to.",
    "",
    "The stage's work is finished and its checks have passed. The gate's policy says an agent may",
    "close it — but only over a structured evidence note whose claims are sourced. Writing that note",
    "is your whole job. You do not approve anything: the engine reads your note, validates it, and",
    "closes or holds the gate itself.",
    "",
    "Do this now:",
    "",
    "1. Read every declared output of this stage, at exactly these paths:",
    ...input.outputs.map((path) => `   - \`${path}\``),
    `2. Check the conditions listed under \`## Gate conditions\` below — each one yourself, against the files, not against this list.`,
    `3. Write the filled-in note to \`${input.notePath}\`, and write nothing else, anywhere.`,
    "",
    "The rules your note is judged by, and they are enforced, not advisory:",
    "",
    "- `verdict: sign` ONLY when every condition holds and every claim you make carries a `[src: …]`",
    "  token that resolves. Otherwise `verdict: refuse` (or `sign-with-fixlist`), with the reasons",
    "  written out — a held gate goes to a person, which is the correct outcome and not a failure.",
    "- Every list item in every section must END with a `[src: …]` token naming a file you actually",
    "  opened, at a line you actually read. A citation nothing can check refuses the whole note.",
    "- `citations.sampled` must equal what you list under `## Citations checked`. Do not report a",
    "  sample you did not take.",
    "- Do not invent a number to fill a field. If you could not check something, say so in `caveats`",
    "  and do not sign over it.",
    "",
    "## Gate conditions",
    "",
    "These are what the framework measured. `ok: false` on any of them means this gate cannot close",
    "whatever your verdict says — report it honestly rather than signing around it.",
    "",
    ...input.conditions.map((c) => `- \`${c.id}\` — ok: ${String(c.ok)} — ${c.detail}`),
    "",
    "## The note",
    "",
    "Fill this in and write it to the path above. Replace every blank; keep every key and heading.",
    "",
    "```markdown",
    input.skeleton.trimEnd(),
    "```",
    "",
    "## What each section must contain",
    "",
    ...EVIDENCE_SECTIONS.map((name) => `- \`## ${name}\` — ${GUIDANCE[name]}`),
    "",
  ];
  return lines.join("\n");
}
