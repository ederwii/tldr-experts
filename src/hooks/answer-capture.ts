#!/usr/bin/env bun
/**
 * tldrx hook: answer-capture
 * PostToolUse (Write|Edit) and FileChanged on `tldrx-work/**\/questions.md`.
 *
 * Spec §2.7: a block is answered iff its metadata says `status: open` AND the
 * `[Answer]:` line has a non-empty capture. The recording itself lives in
 * `src/core/answers/` because `tldrx answer` must do byte-for-byte the same thing —
 * this file is the Claude Code doorway to it, nothing more.
 *
 * NEVER blocks — PostToolUse cannot, and this one would not want to.
 */
import { existsSync } from "node:fs";
import { runHook, postContext, allow } from "./lib/decide.ts";
import { readPayload, filePathOf } from "./lib/payload.ts";
import { locateWork, loadWorkspace } from "./lib/workspace.ts";
import { currentActor, nowRfc3339 } from "./lib/actor.ts";
import { captureAnswers, unresolvedEntries } from "../core/answers/captureAnswers.ts";

await runHook("answer-capture", async () => {
  const payload = await readPayload();
  const event = payload.hook_event_name ?? "";
  if (event === "PostToolUse" && payload.tool_name !== "Write" && payload.tool_name !== "Edit") return;

  const filePath = filePathOf(payload);
  if (!filePath.endsWith("questions.md") || !existsSync(filePath)) return;
  const location = locateWork(filePath);
  if (location === null) return;

  // PostToolUse runs after the write, so the file on disk IS the new content.
  //
  // NO `overrides`, deliberately (#169). This hook fires on PostToolUse for an
  // agent's own `Write`/`Edit` AND on a human's `FileChanged` (the guard at the
  // top of this function), so it cannot say which of the two answered — and
  // telling them apart would be an inference written into an audit record. The
  // rows it writes therefore carry no `decided_by` at all, which is the
  // documented absence: "not stated", never "owner". `repoNames` is passed
  // because it states nothing about WHO — it only lets a question's own
  // `affects:` resolve to the repos it already names, and lets an entry that
  // resolved to NOTHING be named below rather than dropped.
  const captured = captureAnswers(filePath, {
    root: location.root,
    runDir: location.runDir,
    run: location.run,
    actor: currentActor(),
    at: nowRfc3339(),
    repoNames: new Set(loadWorkspace(location.root).repos.keys()),
  });
  if (captured.length === 0) return;
  // `postContext` is this hook's ONLY channel to the operator, so the unresolved
  // `affects:` entries go through it (#169, fix round 1). Dropping them here
  // would be the worst place to drop them: this is the framework's primary
  // capture route, so `repos: []` would read as "no repo was named" on most of
  // the facts the workspace ever writes. Same sentence the CLI prints, from the
  // same renderer — a second spelling is the only bug either could have.
  //
  // A raised CONFLICT is deliberately not in this line (#169, fix round 2, and
  // stated rather than closed). `captureAnswers` raises identically on both
  // routes — the fact, the `conflicts_with` link, the `advisory:` question block
  // and the `fact.conflict_raised` event are all written here exactly as they are
  // under `tldrx answer` — but the SENTENCE announcing it is printed only by the
  // CLI path (`cli/commands/answer.ts`). So on this route the raise is visible in
  // `questions.md` and `events.jsonl`, not in the context posted back. Spec §3
  // requires the announcement of `tldrx answer` and of nothing else; widening it
  // is a change to what the framework promises, not a bug fix, so it is written
  // down here rather than slipped in.
  const unresolved = unresolvedEntries(captured);
  postContext(
    `tldrx: recorded ${captured.map((c) => `${c.q} → ${c.fact}`).join(", ")}`
    + (unresolved.length === 0 ? "" : ` — ${unresolved.join("; ")}`),
  );
});

allow();
