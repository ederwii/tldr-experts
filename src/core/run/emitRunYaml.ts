/**
 * Block-style YAML for `run.yml` and `budget.yml`.
 *
 * Same reasoning as `emitFactsYaml`: these are committed, human-read, diffed files,
 * and the runtime seam's two YAML implementations do not agree on layout. Hand-
 * emitting the two shapes we own means a run.yml written under Node and one written
 * under Bun are byte-identical, so a diff only ever shows what actually changed.
 */
import { yamlScalar } from "../facts/emitFactsYaml.ts";
import {
  DEFAULT_ECONOMY, type RunBudget, DEFAULT_ON_HOST_TOKENS_EXCEED, DEFAULT_ON_GRANT_EXCEED,
} from "../budget/RunBudget.ts";
import type { GatesPolicy } from "./gatePolicy.ts";
import type {
  RunFile, RunGate, RunGateAuthority, RunGateEvidence, RunGateExecutor, RunStage, RunTask,
} from "./RunFile.ts";

function inlineList(values: readonly string[]): string {
  return `[${values.map((v) => yamlScalar(v)).join(", ")}]`;
}

function money(n: number): string {
  return n.toFixed(2);
}

/**
 * `gates_policy: {what: human, how: auto}` — one flow mapping, stage order kept.
 *
 * Emitted only when the run HAS a policy, so a fixture or a hand-written run.yml
 * from before 0.3.0 round-trips byte-for-byte through a save.
 */
function gatesPolicy(policy: GatesPolicy): string {
  const entries = Object.entries(policy).map(([id, value]) => `${yamlScalar(id)}: ${yamlScalar(value)}`);
  return `{${entries.join(", ")}}`;
}

/**
 * `evidence: {path, role, verdict, sampled, of, resolved, refuted, outside_surface}`
 * — what an `agent` gate was signed over (design §A.5).
 *
 * Emitted only when the gate HAS it, which is only ever an agent-closed gate, so
 * every other gate — human, auto, pending, rejected — round-trips byte-for-byte
 * through a save exactly as it did before this key existed.
 */
function gateEvidence(e: RunGateEvidence): string {
  return `{path: ${yamlScalar(e.path)}, role: ${yamlScalar(e.role)}, verdict: ${yamlScalar(e.verdict)}, ` +
    `sampled: ${String(e.sampled)}, of: ${String(e.of)}, resolved: ${String(e.resolved)}, ` +
    `refuted: ${String(e.refuted)}, outside_surface: ${String(e.outside_surface)}}`;
}

/**
 * `executed_by: {type, id}` — which entity actually evaluated the gate (#122).
 *
 * `id` is omitted for `auto`: the facilitator is a role, not an identity, and
 * `by: auto` already carries it. Emitted only when the gate has the key, so every
 * run.yml written before #122 round-trips byte-for-byte.
 */
function gateExecutor(e: RunGateExecutor): string {
  const id = e.id === undefined ? "" : `, id: ${yamlScalar(e.id)}`;
  return `{type: ${yamlScalar(e.type)}${id}}`;
}

/**
 * `authority: {type, policy, authorized_by, source}` — under whose authority, and
 * how that was established (#122).
 *
 * `authorized_by: null` is written out rather than omitted: paired with
 * `source: unrecorded` it is the record SAYING it does not know, which is a
 * different fact from a key nobody wrote.
 */
function gateAuthority(a: RunGateAuthority): string {
  return `{type: ${yamlScalar(a.type)}, policy: ${yamlScalar(a.policy)}, ` +
    `authorized_by: ${yamlScalar(a.authorized_by)}, source: ${yamlScalar(a.source)}}`;
}

/**
 * The gate mapping. It carried exactly five keys until `evidence` arrived — and a
 * sixth one held in memory but not written here would be DROPPED by the next
 * save, silently, which is the failure this emitter has to be extended for rather
 * than worked around. `executed_by` and `authority` (#122) are the seventh and
 * eighth, and carry the same warning. `and_continue` (#242) is the ninth.
 */
function gate(g: RunGate): string {
  const evidence = g.evidence === undefined ? "" : `, evidence: ${gateEvidence(g.evidence)}`;
  const executor = g.executed_by === undefined ? "" : `, executed_by: ${gateExecutor(g.executed_by)}`;
  const authority = g.authority === undefined ? "" : `, authority: ${gateAuthority(g.authority)}`;
  // The ninth key (#242), written ONLY when a rejection asked the loop to carry on:
  // a gate from before it existed, and every gate a bare rejection wrote, is
  // byte-identical to what it was.
  const andContinue = g.and_continue === undefined ? "" : ", and_continue: true";
  return `{type: ${yamlScalar(g.type)}, status: ${yamlScalar(g.status)}, by: ${yamlScalar(g.by)}, ` +
    `at: ${yamlScalar(g.at)}, note: ${yamlScalar(g.note)}${evidence}${executor}${authority}${andContinue}}`;
}

function task(t: RunTask, indent: string): string {
  const inner = `${indent}   `;
  // `cost_usd: null` + `metered: false` is the unmetered in-session turn. Both
  // keys are written together so a reader never has to infer one from the other,
  // and `metered:` is omitted entirely for an ordinary metered task so a run.yml
  // written before this existed round-trips byte-for-byte.
  const cost = t.cost_usd === null ? "null" : money(t.cost_usd);
  const metered = t.metered === false ? ", metered: false" : "";
  const tokens = t.tokens === undefined ? "" : `, tokens: ${String(t.tokens)}`;
  // Written only when the turn reported them. A run.yml from before this field
  // existed, and a turn whose result document carried no usage, are byte-identical
  // to what they were.
  const inTokens = t.input_tokens === undefined ? "" : `, input_tokens: ${String(t.input_tokens)}`;
  const outTokens = t.output_tokens === undefined ? "" : `, output_tokens: ${String(t.output_tokens)}`;
  // The same rule, one counter at a time (#222): a cache write and a cache read
  // are separate quantities at separate prices, so neither waits on the other
  // and neither is ever written as a zero nobody measured.
  const cacheWrite = t.cache_creation_input_tokens === undefined
    ? "" : `, cache_creation_input_tokens: ${String(t.cache_creation_input_tokens)}`;
  const cacheRead = t.cache_read_input_tokens === undefined
    ? "" : `, cache_read_input_tokens: ${String(t.cache_read_input_tokens)}`;
  // The turn's own role, next to the stage's expert it is so easily confused
  // with (#234). Written only when an executor recorded one, so a row from
  // before the key existed — and any turn nothing could attribute — round-trips
  // byte-for-byte and stays silent rather than guessing.
  const role = t.role === undefined ? "" : `, role: ${yamlScalar(t.role)}`;
  return [
    `${indent} - {id: ${yamlScalar(t.id)}, status: ${yamlScalar(t.status)}, expert: ${yamlScalar(t.expert)}${role}, ` +
      `model: ${yamlScalar(t.model)}, cost_usd: ${cost}${metered}${tokens}${inTokens}${outTokens}` +
      `${cacheWrite}${cacheRead},`,
    `${inner}error: ${yamlScalar(t.error)}, session_id: ${yamlScalar(t.session_id)},`,
    `${inner}started_at: ${yamlScalar(t.started_at)}, ended_at: ${yamlScalar(t.ended_at)},`,
    // Written only when a limit stopped the attempt: every existing run.yml stays
    // byte-identical, and the key's presence is itself the signal.
    ...(t.stopped_by === undefined || t.stopped_by === null
      ? []
      : [`${inner}stopped_by: ${yamlScalar(t.stopped_by)},`]),
    // Both additive, both written only when present — a row from before either
    // existed, or one that never earned either, round-trips byte-for-byte.
    ...(t.banked_before_refusal === undefined ? [] : [`${inner}banked_before_refusal: true,`]),
    ...(t.dedupe === undefined ? [] : [`${inner}dedupe: ${yamlScalar(t.dedupe)},`]),
    // The measured span and WHICH span it is, written together or not at all
    // (#184). Never one without the other: a bare number would be averaged with
    // the other basis, and a bare basis would name the basis of nothing. Absent
    // on every row written before this existed, which stays byte-identical.
    ...(t.duration_ms === undefined
      ? []
      : [`${inner}duration_ms: ${String(Math.round(t.duration_ms))}, `
        + `duration_basis: ${yamlScalar(t.duration_basis ?? null)},`]),
    `${inner}outputs: ${inlineList(t.outputs)}}`,
  ].join("\n");
}

function stage(s: RunStage): string {
  const lines = [
    `      - id: ${yamlScalar(s.id)}`,
    `        status: ${yamlScalar(s.status)}`,
    `        expert: ${yamlScalar(s.expert)}`,
    `        model: ${yamlScalar(s.model)}`,
    `        budget_usd: ${money(s.budget_usd)}`,
    `        cost_usd: ${money(s.cost_usd)}`,
    `        started_at: ${yamlScalar(s.started_at)}`,
    `        ended_at: ${yamlScalar(s.ended_at)}`,
    `        inputs: ${inlineList(s.inputs)}`,
    `        outputs: ${inlineList(s.outputs)}`,
    `        gate: ${gate(s.gate)}`,
  ];
  // Additive (§2.2): emitted only when true, so a run that never had a gate
  // revoked round-trips byte-for-byte through a save.
  if (s.stale === true) lines.push("        stale: true");
  if (s.tasks.length === 0) {
    lines.push("        tasks: []");
  } else {
    lines.push("        tasks:");
    for (const t of s.tasks) lines.push(task(t, "       "));
  }
  return lines.join("\n");
}

export function emitRunYaml(run: RunFile): string {
  const lines = [
    "# tldrx-work/<run>/run.yml — the execution path and the only resume point (spec §2.2).",
    "# Written by the facilitator alone. Hand-edit at your own risk: every write revalidates.",
    `version: ${run.version}`,
    // The framework's two version stamps, right under the FORMAT's (#183) — the
    // adjacency is the point: a reader who has been confused about which number
    // `version:` is has the answer on the next line. Emitted only when set, so a
    // run.yml written before they existed round-trips byte-for-byte, which is
    // the same rule `triage`, `attended_by` and `build.branch_model` follow.
    ...(run.created_with === undefined ? [] : [`created_with: ${yamlScalar(run.created_with)}`]),
    ...(run.last_written_by === undefined ? [] : [`last_written_by: ${yamlScalar(run.last_written_by)}`]),
    `run: ${yamlScalar(run.run)}`,
    `title: ${yamlScalar(run.title)}`,
    `scope: ${yamlScalar(run.scope)}`,
    `workflow: ${yamlScalar(run.workflow)}`,
    `repos: ${inlineList(run.repos)}`,
    `created_at: ${yamlScalar(run.created_at)}`,
    `updated_at: ${yamlScalar(run.updated_at)}`,
    `status: ${yamlScalar(run.status)}`,
    `cursor: {phase: ${yamlScalar(run.cursor.phase)}, stage: ${yamlScalar(run.cursor.stage)}, ` +
      `task: ${yamlScalar(run.cursor.task)}}`,
    `budget: {ceiling_usd: ${money(run.budget.ceiling_usd)}, spent_usd: ${money(run.budget.spent_usd)}, ` +
      `per_agent_max_usd: ${money(run.budget.per_agent_max_usd)}}`,
  ];
  // Optional §6.2 provenance. Emitted only when it is there, so a run.yml written
  // by `run new` is byte-identical to the one it wrote before triage existed.
  if (run.triage !== undefined) {
    // Emitted only when it is set, so a run.yml written before this key existed
    // round-trips byte-for-byte — the same rule `triage` itself and
    // `build.branch_model` follow two lines down.
    const basis = run.triage.budget_basis === undefined
      ? ""
      : `, budget_basis: ${yamlScalar(run.triage.budget_basis)}`;
    lines.push(
      `triage: {split: ${yamlScalar(run.triage.split)}, depends_on: ${inlineList(run.triage.depends_on)}${basis}}`,
    );
  }
  if (run.build !== undefined && run.build.epic_branch.length > 0) {
    // Same rule as `triage`: the optional key is emitted only when it is set, so
    // a run.yml written before `branch_model` existed (issue #57) round-trips
    // byte-for-byte through a save.
    const model = run.build.branch_model === undefined
      ? ""
      : `, branch_model: ${yamlScalar(run.build.branch_model)}`;
    lines.push(`build: {epic_branch: ${inlineList(run.build.epic_branch)}${model}}`);
  }
  // Same rule as `triage`: emitted only when it is there, so a run.yml written
  // before `run cancel` existed round-trips byte-for-byte through a save.
  if (run.cancelled !== undefined) {
    lines.push(
      `cancelled: {by: ${yamlScalar(run.cancelled.by)}, at: ${yamlScalar(run.cancelled.at)}, ` +
        `note: ${yamlScalar(run.cancelled.note)}}`,
    );
  }
  // Same rule a fourth time (#210): written once, when the run closes, and
  // absent on every run.yml that predates the key — so those stay byte-identical
  // and read `OUTCOME_NOT_RECORDED` rather than a delivery nobody measured. The
  // counts are omitted for `n/a`: a docs-scope run has no plan, and
  // `stories_total: 0` there would be a confident zero about one (§7).
  if (run.outcome !== undefined) {
    const o = run.outcome;
    const parts = [`kind: ${yamlScalar(o.kind)}`];
    if (o.stories_done !== undefined) parts.push(`stories_done: ${String(o.stories_done)}`);
    if (o.stories_total !== undefined) parts.push(`stories_total: ${String(o.stories_total)}`);
    if (o.stories_blocked !== undefined) parts.push(`stories_blocked: ${String(o.stories_blocked)}`);
    if (o.first_blocked !== undefined) parts.push(`first_blocked: ${yamlScalar(o.first_blocked)}`);
    if (o.why !== undefined) parts.push(`why: ${yamlScalar(o.why)}`);
    lines.push(`outcome: {${parts.join(", ")}}`);
  }
  // Same rule again: emitted only when set, so a run.yml written before
  // `attended_by` existed — which is every run.yml written before 0.3.0 — round-
  // trips byte-for-byte through a save.
  if (run.attended_by !== undefined) {
    lines.push(`attended_by: ${yamlScalar(run.attended_by)}`);
  }
  // Emitted only when TRUE: `keep_worktrees: false` and an absent key mean the
  // same thing, and writing the noisy half would change every run.yml on disk.
  if (run.keep_worktrees === true) {
    lines.push("keep_worktrees: true");
  }
  if (run.gates_policy !== undefined && Object.keys(run.gates_policy).length > 0) {
    lines.push(`gates_policy: ${gatesPolicy(run.gates_policy)}`);
  }
  lines.push("phases:");
  for (const phase of run.phases) {
    lines.push(`  - id: ${yamlScalar(phase.id)}`);
    lines.push(`    status: ${yamlScalar(phase.status)}`);
    if (phase.stages.length === 0) {
      lines.push("    stages: []");
    } else {
      lines.push("    stages:");
      for (const s of phase.stages) lines.push(stage(s));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function emitBudgetYaml(budget: RunBudget): string {
  const lines = [
    "# tldrx-work/<run>/budget.yml — the ceiling the facilitator refuses to exceed (spec §2.11).",
    "# Actuals are rolled up from run.yml task costs; never typed by hand.",
    `version: ${budget.version}`,
    `run: ${yamlScalar(budget.run)}`,
    `ceiling_usd: ${money(budget.ceiling_usd)}`,
    `per_agent_max_usd: ${money(budget.per_agent_max_usd)}`,
    `warn_at_pct: ${budget.warn_at_pct}`,
    `on_exceed: ${yamlScalar(budget.on_exceed)}`,
    // Emitted only when it is not the default. `budget raise` rewrites this file
    // through this emitter, so a label that did not round-trip would be ERASED by
    // the one command an operator reaches for when a ceiling binds — and the
    // erasure would turn a token budget back into dollars silently. Skipping the
    // default line keeps a file with no label byte-identical to what it was.
    ...(budget.economy === DEFAULT_ECONOMY ? [] : [`economy: ${yamlScalar(budget.economy)}`]),
    // Same rule, same reason (issue #22): `on_host_tokens_exceed: block` is the
    // ONLY thing that makes a token ceiling stop anything, and `budget raise`
    // rewrites this file through here. A key that did not round-trip would be
    // erased by the one command an operator reaches for when a ceiling binds —
    // silently downgrading their enforcement to a note.
    ...(budget.on_host_tokens_exceed === DEFAULT_ON_HOST_TOKENS_EXCEED
      ? []
      : [`on_host_tokens_exceed: ${yamlScalar(budget.on_host_tokens_exceed)}`]),
    // Same rule again (issue #61). A token ceiling is NOT `ceiling_usd` and
    // cannot be recovered from it, so a rewrite that dropped the key would erase
    // the only number bounding a host-token run — and `budget raise` rewrites
    // this file through here. Absent stays absent: a file that never declared one
    // is byte-identical to what it was.
    ...(budget.ceiling_host_tokens === null
      ? []
      : [`ceiling_host_tokens: ${tokens(budget.ceiling_host_tokens)}`]),
    // Same rule a fourth time, and this one is the sharpest case of it (#170).
    // What the owner AUTHORIZED cannot be recovered from anything else in this
    // file, and `budget raise` — the one command an operator reaches for when a
    // ceiling binds, and now the command that RECONCILES against these keys —
    // rewrites the file through here. A key that did not round-trip would be
    // erased by the very act it governs: the first raise after a grant would
    // silently un-record the grant it had just been checked against, and every
    // unit test of the reconciliation would still pass. Absent stays absent, so
    // a file that never declared a grant is byte-identical to what it was.
    ...(budget.authorized_usd === null ? [] : [`authorized_usd: ${money(budget.authorized_usd)}`]),
    ...(budget.authorized_by === null ? [] : [`authorized_by: ${yamlScalar(budget.authorized_by)}`]),
    ...(budget.authorized_at === null ? [] : [`authorized_at: ${yamlScalar(budget.authorized_at)}`]),
    ...(budget.on_grant_exceed === DEFAULT_ON_GRANT_EXCEED
      ? []
      : [`on_grant_exceed: ${yamlScalar(budget.on_grant_exceed)}`]),
    // Same rule a fifth time, and it is what makes the two keys safe: they are
    // emitted only when there IS something unmetered, so a fully metered run and
    // every budget.yml written before they existed are byte-identical to what
    // they were (`test/budget-grant.test.ts` pins exactly that for the legacy
    // file). Absent therefore means one thing and not two — `asRunBudget` reads
    // it as `0` / `complete`, which is what such a file already MEANT by
    // printing a bare figure — and present means the total is a floor and the
    // file says by how many turns.
    ...(budget.unmetered_tasks > 0
      ? [
        `unmetered_tasks: ${String(budget.unmetered_tasks)}`,
        `spent_basis: ${yamlScalar(budget.spent_basis)}`,
      ]
      : []),
    "phases:",
  ];
  for (const phase of budget.phases) {
    const economy = phase.economy === null ? "" : `, economy: ${yamlScalar(phase.economy)}`;
    const hostTokens = phase.ceiling_host_tokens === null
      ? ""
      : `, ceiling_host_tokens: ${tokens(phase.ceiling_host_tokens)}`;
    // A phase's own authorization, appended only when it has one — same reason
    // as the run-level keys, and the same "absent stays absent" guarantee.
    const grant = phase.authorized_usd === null
      ? ""
      : `, authorized_usd: ${money(phase.authorized_usd)}`;
    lines.push(
      `  - {id: ${yamlScalar(phase.id)}, ceiling_usd: ${money(phase.ceiling_usd)}, ` +
        `spent_usd: ${money(phase.spent_usd)}${economy}${hostTokens}${grant}}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A host-token count, written as a whole number.
 *
 * Deliberately not `money()`: two decimals on a token allowance would say the
 * unit is dollars, which is the whole thing issue #61 is about. A fractional
 * token does not exist, so a value that somehow carries one is truncated rather
 * than printed as `10000.50`.
 */
function tokens(value: number): string {
  return String(Math.trunc(value));
}
