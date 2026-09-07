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
import { captureAnswers } from "../core/answers/captureAnswers.ts";

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
  // `affects:` resolve to the repos it already names.
  const captured = captureAnswers(filePath, {
    root: location.root,
    runDir: location.runDir,
    run: location.run,
    actor: currentActor(),
    at: nowRfc3339(),
    repoNames: new Set(loadWorkspace(location.root).repos.keys()),
  });
  if (captured.length === 0) return;
  postContext(`tldrx: recorded ${captured.map((c) => `${c.q} → ${c.fact}`).join(", ")}`);
});

allow();
