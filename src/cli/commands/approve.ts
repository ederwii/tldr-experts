/** `tldrx approve` — Approve the current gate
 *
 * Spec §3, §5. Only valid when the cursor stage is `awaiting_gate`. The stage's
 * declared checks are RE-RUN against what is on disk; a failure exits 2 and names
 * the check. On a pass the gate is recorded (`by`, `at`), the stage is `done`, and
 * the cursor advances to the next stage as `ready`.
 *
 * `--as-agent` is the second door onto the SAME verb (design §A.6): an agent that
 * wrote an evidence note signs with it, the note is validated by the §2.8
 * machinery before anything is recorded, and the gate ends up carrying the note's
 * counts and a pointer at the committed copy. It is refused on a stage whose
 * policy is not `agent` — a policy is what a run was OPENED with, and a flag that
 * could upgrade one at approve time would make the frozen policy decorative.
 *
 * A person may still `approve` an agent-gated stage with no flag at all. That is
 * an override, it is recorded as a person, and it is the whole point of the split:
 * an agent gate is a gate an agent MAY close, never one a person may not.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_AWAITING_HUMAN, EXIT_GATE_REFUSED, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { isResolved, resolveRunOrExplain } from "../resolveRun.ts";
import { approve, GateError, type GateEvidenceInput } from "../../core/run/gates.ts";
import { describeStateCommit } from "../../core/run/closeRun.ts";
import { gatePolicyFor } from "../../core/run/gatePolicy.ts";
import { evidencePath } from "../../core/facilitator/paths.ts";
import { describeEvidenceIssues, validateEvidence } from "../../core/text/evidence.ts";
import { loadWorkspace, toSrcContext } from "../../hooks/lib/workspace.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";
import type { RunStore } from "../../core/run/RunStore.ts";

/** What `--as-agent` produced: the evidence to record, or the exit that stops it. */
type AgentEvidence =
  | { readonly kind: "ok"; readonly actor: string; readonly evidence: GateEvidenceInput; readonly note: string }
  | { readonly kind: "stop"; readonly exit: number };

export const approveCommand: Command = {
  name: "approve",
  summary: "Approve the current gate",
  usage: "tldrx approve [--run <id>] [--as-agent] [--evidence <path>] [--note <text>] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, ["run", "note", "evidence", "root"]);
      const root = workspaceRootFrom(args);
      const wanted = stringFlag(args, "run");
      const resolved = resolveRunOrExplain("tldrx approve", root, wanted);
      if (!isResolved(resolved)) return resolved.exit;
      const store = resolved.store;

      let actor = currentActor();
      let note = stringFlag(args, "note") ?? "";
      let evidence: GateEvidenceInput | undefined;

      if (boolFlag(args, "as-agent")) {
        const read = readAgentEvidence(root, store, stringFlag(args, "evidence"));
        if (read.kind === "stop") return read.exit;
        actor = read.actor;
        evidence = read.evidence;
        // An explicit --note still wins: a host that wants to say why in its own
        // words may, and the structured record is beside it either way.
        note = note === "" ? read.note : note;
      } else if (stringFlag(args, "evidence") !== undefined) {
        process.stderr.write(
          "tldrx approve: --evidence only means something with --as-agent — "
            + "a note nobody signs with is not evidence for anything.\n",
        );
        return EXIT_USAGE;
      }

      const outcome = await approve(store, { root, actor, at: nowRfc3339(), note, ...(evidence === undefined ? {} : { evidence }) });

      if (!outcome.ok) {
        const failed = outcome.failed;
        process.stderr.write(
          `tldrx approve: refused — check \`${failed?.id ?? "unknown"}\` failed on ` +
            `${outcome.phase}/${outcome.stage}: ${failed?.detail ?? ""}\n`,
        );
        return EXIT_GATE_REFUSED;
      }

      const lines = [
        `approved ${outcome.phase}/${outcome.stage} (${describe(outcome.checks)})`,
        ...(outcome.evidencePath === null ? [] : [`  signed by ${actor} (agent) — evidence → ${outcome.evidencePath}`]),
      ];
      lines.push(
        outcome.advancedTo === null
          ? outcome.runDone
            ? `run ${store.runId} is done — every stage is terminal`
            : `no stage follows ${outcome.stage}`
          : `cursor → ${outcome.advancedTo.phase}/${outcome.advancedTo.stage} (ready)`,
      );
      // Where the run's own state went, said out loud (#102): an operator who is
      // not told will commit it themselves, and half the time onto the epic.
      const closing = outcome.closed === null ? null : describeStateCommit(outcome.closed.state);
      if (closing !== null) lines.push(`  ${closing}`);
      process.stdout.write(`${lines.join("\n")}\n`);
      return EXIT_OK;
    } catch (error) {
      if (error instanceof GateError) return fail("approve", error, EXIT_GATE_REFUSED);
      return fail("approve", error);
    }
  },
};

/**
 * Read and judge the note `--as-agent` signs with.
 *
 * Two exits, and they mean different things. **`2`** is "this note is broken" —
 * unreadable front matter, a section with no list item, a bullet with no `src`
 * token or one that does not resolve, arithmetic that cannot be true, a note
 * pasted from another gate. **`4`** is "a person decides": the note parsed
 * perfectly and its verdict is `refuse` or `sign-with-fixlist`, which is the
 * agent doing its job, not failing at it (design §10).
 */
function readAgentEvidence(root: string, store: RunStore, override: string | undefined): AgentEvidence {
  const entry = store.cursorEntry();
  if (entry === null) {
    process.stderr.write(
      `tldrx approve: ${store.run.cursor.phase}/${store.run.cursor.stage} does not resolve to a stage\n`,
    );
    return { kind: "stop", exit: EXIT_GATE_REFUSED };
  }
  const policy = gatePolicyFor(store.run.gates_policy, entry.stage.id);
  if (policy !== "agent") {
    // Two routes out, and naming only one of them was the bug: `--gates` is chosen
    // at `run new` and frozen there, so it told an operator mid-run to throw the
    // run away. The delegated approve works on the run in front of them (gh #19).
    const note = evidencePath(store.runDir, entry.stage.id);
    process.stderr.write(
      `tldrx approve: --as-agent refused — ${entry.phase.id}/${entry.stage.id} is a \`${policy}\` gate, `
        + "not an `agent` one. A run keeps the policy it was opened with; a flag that upgraded one at "
        + "approve time would make the frozen policy decorative.\n"
        + "Two ways on, and neither needs this run recreated:\n"
        + "  · delegated approve — read the agent's evidence note yourself, then sign as you: "
        + `tldrx approve --note "delegated: <agent> reviewed this, evidence at ${relative(root, note)}". `
        + `The gate stays \`${policy}\`, the note carries the provenance, and the verdict is a person's.\n`
        + `  · or open the NEXT run with \`--gates ${entry.stage.id}:agent\` — the policy is chosen there.\n`,
    );
    return { kind: "stop", exit: EXIT_USAGE };
  }

  const path = override === undefined ? evidencePath(store.runDir, entry.stage.id) : override;
  if (!existsSync(path)) {
    process.stderr.write(
      `tldrx approve: --as-agent refused — no evidence note at ${relative(root, path)}. `
        + "Write one (`tldrx gate template` puts the blank form there), then sign with it.\n",
    );
    return { kind: "stop", exit: EXIT_GATE_REFUSED };
  }
  const text = readFileSync(path, "utf8");
  const gate = `${entry.phase.id}/${entry.stage.id}`;
  const validation = validateEvidence(text, toSrcContext(loadWorkspace(root), store.runDir), { gate });

  // `verdict` is the ONE kind that means "a person decides" rather than "this
  // note is broken". Reported on its own, at its own exit, because the operator's
  // next move is different: read the fix list, not fix the file.
  const refusals = validation.issues.filter((issue) => issue.kind === "verdict");
  const broken = validation.issues.filter((issue) => issue.kind !== "verdict");
  if (broken.length > 0) {
    process.stderr.write(
      [
        `tldrx approve: --as-agent refused — ${relative(root, path)} is not a valid evidence note `
          + `(${String(broken.length)} problem(s)):`,
        ...describeEvidenceIssues(broken),
        "Nothing was signed.",
        "",
      ].join("\n"),
    );
    return { kind: "stop", exit: EXIT_GATE_REFUSED };
  }
  if (refusals.length > 0) {
    process.stderr.write(
      [
        `tldrx approve: ${gate} falls to a person — the evidence note does not sign:`,
        ...describeEvidenceIssues(refusals),
        `Read ${relative(root, path)}, then \`tldrx approve\` as yourself if you decide to ship over it.`,
        "",
      ].join("\n"),
    );
    return { kind: "stop", exit: EXIT_AWAITING_HUMAN };
  }

  const front = validation.front;
  if (front === null) {
    // Unreachable while `broken` is empty — front matter problems are all
    // `front-matter` kind — but a null here would otherwise sign a gate with no
    // actor, and that is not a failure mode worth leaving to a comment.
    process.stderr.write(`tldrx approve: --as-agent refused — ${relative(root, path)} has no readable front matter\n`);
    return { kind: "stop", exit: EXIT_GATE_REFUSED };
  }
  const c = front.citations;
  return {
    kind: "ok",
    actor: front.by,
    note: `agent-gate: evidence=${front.verdict} by ${front.by}, read ${String(front.read.length)} file(s), `
      + `sampled ${String(c.sampled)} of ${String(c.of)} citation(s) `
      + `(${String(c.resolved)} resolved, ${String(c.refuted)} refuted), `
      + `audited ${String(front.touches.audited)} touched path(s) `
      + `(${String(front.touches.outside_surface)} outside the surface), `
      + `diff vs stories ${front.diff_vs_stories}`,
    evidence: {
      text,
      record: {
        role: front.role,
        verdict: front.verdict,
        sampled: c.sampled,
        of: c.of,
        resolved: c.resolved,
        refuted: c.refuted,
        outside_surface: front.touches.outside_surface,
      },
    },
  };
}

function describe(checks: readonly { id: string; status: string }[]): string {
  if (checks.length === 0) return "no checks declared";
  return checks.map((c) => `${c.id}:${c.status}`).join(", ");
}
