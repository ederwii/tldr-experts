#!/usr/bin/env bun
/**
 * tldrx hook: claim-sources
 * PreToolUse (Write|Edit) — the gate. PostToolUse (Write|Edit) — the twin, feedback only.
 *
 * Spec §4: "`tool_input.file_path` matches `tldrx-work/**\/*.md` … parse the four
 * handoff sections; each must hold at least one list item, and each list item must
 * end with a valid `src` token (§2.8); `file` sources must resolve." A claim
 * without a source is rejected by a hook, not by a prose rule (concept §1.1) — and
 * a section with no claims at all is rejected the same way, because a paragraph
 * saying "nothing found" is exactly how an unchecked claim used to get written.
 *
 * **Two rules, not one** (issue #34). A HANDOFF carries the four-section contract:
 * every bullet is a claim and every claim is sourced. Every OTHER markdown file
 * under `tldrx-work/` carries only the second half of that — a bullet may be
 * prose, but a `[src: …]` it does write must parse and must resolve. Until
 * 2026-08-31 the hook returned early for those files entirely, so the identical
 * violation was refused in `handoff.md` and waved through in `design.md` beside
 * it, to be discovered at the gate after a full paid pass had been spent.
 *
 * Fails OPEN: any internal error allows the write and says so on stderr.
 */
import { runHook, deny, postContext, allow } from "./lib/decide.ts";
import { readPayload, filePathOf, isWriteOrEdit } from "./lib/payload.ts";
import { wouldBeContent } from "./lib/wouldBe.ts";
import { locateWork, loadWorkspace, toSrcContext } from "./lib/workspace.ts";
import {
  claimSourcesDeny, claimSourcesEmptySectionDeny, claimSourcesMalformedDeny,
  claimSourcesUnresolvedDeny,
} from "./lib/messages.ts";
import { isHandoff, validateCitations, validateHandoff } from "../core/text/handoff.ts";

await runHook("claim-sources", async () => {
  const payload = await readPayload();
  if (!isWriteOrEdit(payload)) return;

  const filePath = filePathOf(payload);
  if (!filePath.endsWith(".md")) return;
  const location = locateWork(filePath);
  if (location === null) return;

  const wouldBe = wouldBeContent(payload, filePath);
  if (wouldBe.kind !== "content") return;

  const workspace = loadWorkspace(location.root);
  // The run dir comes from the touched path itself, so the hook resolves a bare
  // `01-what/intent.md:1` exactly as `next` and `approve` later will.
  const srcCtx = toSrcContext(workspace, location.runDir);
  const relPath = `tldrx-work/${location.run}/${location.relative}`;
  const parts: string[] = [];

  const looksLikeHandoff = filePath.endsWith("handoff.md") || isHandoff(wouldBe.text);
  if (looksLikeHandoff) {
    const report = validateHandoff(wouldBe.text, srcCtx);
    if (report.ok) return;
    if (report.unsourced.length > 0) parts.push(claimSourcesDeny(relPath, report.unsourced));
    if (report.malformed.length > 0) parts.push(claimSourcesMalformedDeny(relPath, report.malformed));
    if (report.emptySections.length > 0) {
      parts.push(claimSourcesEmptySectionDeny(relPath, [...report.emptySections]));
    }
    if (report.unresolved.length > 0) parts.push(claimSourcesUnresolvedDeny(relPath, report.unresolved));
  } else {
    const report = validateCitations(wouldBe.text, srcCtx);
    if (report.malformed.length > 0) parts.push(claimSourcesMalformedDeny(relPath, report.malformed));
    if (report.unresolved.length > 0) parts.push(claimSourcesUnresolvedDeny(relPath, report.unresolved));
  }
  if (parts.length === 0) return; // missing sections alone: the file is simply not a handoff yet

  const message = parts.join("\n");
  if (payload.hook_event_name === "PostToolUse") postContext(message);
  deny(message);
});

allow();
