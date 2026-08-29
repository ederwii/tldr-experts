#!/usr/bin/env bun
/**
 * tldrx hook: budget-gate
 * PreToolUse (Bash) — the spawn itself is the thing being refused.
 *
 * Spec §4: trigger on `tool_input.command` matching `^(claude -p|tldrx next)`;
 * deny when `spent + estimate > phase ceiling` (or run ceiling) and
 * `on_exceed: block`; append `budget.blocked`.
 *
 * Concept §1.5: "the facilitator refuses to start work it cannot afford" — this is
 * the refusal, placed where the money is actually spent rather than where it is
 * reported.
 *
 * Fails OPEN: an unreadable budget never blocks a command.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runHook, deny, allow } from "./lib/decide.ts";
import { readPayload, toolInput } from "./lib/payload.ts";
import { findWorkspaceRoot, locateWork, stageYamlPath } from "./lib/workspace.ts";
import { loadRunView, newestActiveRun, cursorStage, type RunView } from "./lib/runFile.ts";
import { budgetGateDeny } from "./lib/messages.ts";
import { currentActor, nowRfc3339 } from "./lib/actor.ts";
import { loadRunBudget } from "../core/budget/loadBudget.ts";
import { wouldExceed } from "../core/budget/wouldExceed.ts";
import { raiseCommand, shortBy } from "../core/budget/budgetView.ts";
import { EventLog } from "../core/events/EventLog.ts";
import { parseYaml } from "../core/yaml.ts";
import { PROJECT_WORK_DIR } from "../core/paths.ts";

const SPAWN_RE = /^(claude -p|tldrx next)\b/;
const RUN_ARG_RE = /--run[= ]([\w.-]+)/;

await runHook("budget-gate", async () => {
  const payload = await readPayload();
  if (payload.tool_name !== "Bash") return;
  const command = (toolInput(payload).command ?? "").trim();
  if (!SPAWN_RE.test(command)) return;

  const cwd = payload.cwd ?? process.cwd();
  const root = findWorkspaceRoot(cwd);
  if (root === null) return;

  const view = resolveRun(root, cwd, command);
  if (view === null || view.cursor === null) return;

  const budget = loadRunBudget(view.dir);
  if (budget === null) return;

  const stage = cursorStage(view);
  const estimate = stage?.budget_usd ?? stageBudgetFromLibrary(root, view.cursor.stage) ?? 0;
  if (estimate <= 0) return; // nothing declared to spend; nothing to refuse

  const decision = wouldExceed(budget, view.cursor.phase, estimate);
  if (!decision.blocked) return;

  new EventLog(join(view.dir, "events.jsonl")).tryAppend({
    ts: nowRfc3339(),
    run: view.run,
    stage: view.cursor.stage,
    type: "budget.blocked",
    actor: `hook:budget-gate`,
    cost_usd: 0,
    payload: {
      phase: view.cursor.phase,
      scope: decision.scope,
      remaining_usd: decision.remaining,
      ceiling_usd: decision.ceiling,
      estimate_usd: decision.estimate,
      blocked_by: currentActor(),
    },
  });

  deny(budgetGateDeny(
    view.cursor.stage, view.cursor.phase, decision.remaining, decision.ceiling, estimate,
    raiseCommand(view.run, view.cursor.phase, shortBy(estimate, decision.remaining)),
  ));
});

/** `--run <id>`, else the run the cwd sits inside, else the newest non-terminal one. */
function resolveRun(root: string, cwd: string, command: string): RunView | null {
  const named = RUN_ARG_RE.exec(command)?.[1];
  if (named !== undefined) {
    const dir = join(root, PROJECT_WORK_DIR, named);
    if (existsSync(dir) && statSync(dir).isDirectory()) return loadRunView(dir);
  }
  const here = locateWork(cwd);
  if (here !== null) {
    const view = loadRunView(here.runDir);
    if (view !== null) return view;
  }
  return newestActiveRun(root);
}

/** `.tldrx/stages/<slug>/stage.yml` `budget_usd`, when run.yml does not carry it. */
function stageBudgetFromLibrary(root: string, stage: string): number | null {
  const path = stageYamlPath(root, stage);
  if (!existsSync(path)) return null;
  try {
    const doc = parseYaml(readFileSync(path, "utf8"));
    const value = (doc as { budget_usd?: unknown } | null)?.budget_usd;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

allow();
