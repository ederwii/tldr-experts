#!/usr/bin/env bun
/**
 * tldrx hook: claim-sources
 * PreToolUse (Write|Edit) — the gate. PostToolUse (Write|Edit) — the twin, feedback only.
 *
 * Spec §4: "`tool_input.file_path` matches `tldrx-work/**\/*.md` … parse the four
 * handoff sections; each `- ` line must end with a valid `src` token (§2.8);
 * `file` sources must resolve." A claim without a source is rejected by a hook,
 * not by a prose rule (concept §1.1).
 *
 * Fails OPEN: any internal error allows the write and says so on stderr.
 */
import { runHook, deny, postContext, allow } from "./lib/decide.ts";
import { readPayload, filePathOf, isWriteOrEdit } from "./lib/payload.ts";
import { wouldBeContent } from "./lib/wouldBe.ts";
import { locateWork, loadWorkspace, toSrcContext } from "./lib/workspace.ts";
import { claimSourcesDeny, claimSourcesUnresolvedDeny } from "./lib/messages.ts";
import { isHandoff, validateHandoff } from "../core/text/handoff.ts";

await runHook("claim-sources", async () => {
  const payload = await readPayload();
  if (!isWriteOrEdit(payload)) return;

  const filePath = filePathOf(payload);
  if (!filePath.endsWith(".md")) return;
  const location = locateWork(filePath);
  if (location === null) return;

  const wouldBe = wouldBeContent(payload, filePath);
  if (wouldBe.kind !== "content") return;

  // Only handoffs carry the four-section contract. Everything else under
  // tldrx-work/ is free prose and this hook has no opinion about it.
  const looksLikeHandoff = filePath.endsWith("handoff.md") || isHandoff(wouldBe.text);
  if (!looksLikeHandoff) return;

  const workspace = loadWorkspace(location.root);
  // The run dir comes from the touched path itself, so the hook resolves a bare
  // `01-what/intent.md:1` exactly as `next` and `approve` later will.
  const report = validateHandoff(wouldBe.text, toSrcContext(workspace, location.runDir));
  if (report.ok) return;

  const relPath = `tldrx-work/${location.run}/${location.relative}`;
  const parts: string[] = [];
  if (report.unsourced.length > 0) parts.push(claimSourcesDeny(relPath, report.unsourced));
  if (report.unresolved.length > 0) parts.push(claimSourcesUnresolvedDeny(relPath, report.unresolved));
  if (parts.length === 0) return; // missing sections alone: the file is simply not a handoff yet

  const message = parts.join("\n");
  if (payload.hook_event_name === "PostToolUse") postContext(message);
  deny(message);
});

allow();
