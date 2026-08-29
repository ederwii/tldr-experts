#!/usr/bin/env bun
/**
 * tldrx hook: DoD-gate
 * PreToolUse (Write|Edit) on `tldrx-work/**\/stories/*.md`.
 *
 * Concept §8, "Done means proven": a story cannot move to `done` unless the file
 * carries a fenced ```dod block AND this hook re-ran every command in it, in the
 * story's repo, with exit 0. The agent's own "ok" is never evidence.
 *
 * This is the ONE hook that fails CLOSED. Once the write is identified as a story
 * being marked done, any internal error denies — an unproven story stays not-done.
 * (Errors *before* that identification still allow: a hook that cannot read its
 * own stdin has no idea what it would be blocking.)
 */
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { deny, allow, failOpen } from "./lib/decide.ts";
import { readPayload, filePathOf, isWriteOrEdit } from "./lib/payload.ts";
import { wouldBeContent } from "./lib/wouldBe.ts";
import { locateWork, loadWorkspace, repoPath } from "./lib/workspace.ts";
import { dodGateDeny, dodGateMissingBlockDeny, dodGateInternalErrorDeny } from "./lib/messages.ts";
import { readStory, runDodCommand } from "./lib/story.ts";

/** Spec §2.3: `timeout_s` defaults to 900. */
const DEFAULT_TIMEOUT_S = 900;

let storyId = "?";
try {
  const payload = await readPayload();
  if (!isWriteOrEdit(payload)) allow();

  const filePath = filePathOf(payload);
  const location = locateWork(filePath);
  if (
    location === null ||
    !filePath.endsWith(".md") ||
    !location.relative.includes("stories/")
  ) {
    allow();
  }

  const wouldBe = wouldBeContent(payload, filePath);
  if (wouldBe.kind !== "content") allow();

  const story = readStory(wouldBe.text);
  if (!story.setsDone) allow();

  // From here the hook is committed: this write marks a story done.
  storyId = basename(filePath, ".md");
  const relPath = `tldrx-work/${location.run}/${location.relative}`;

  if (!story.hasDodBlock || story.dodCommands.length === 0) {
    deny(dodGateMissingBlockDeny(storyId, relPath));
  }

  const workspace = loadWorkspace(location.root);
  // `[assumption]` — a story with no `repo:` runs from the workspace root.
  const repoName = story.repo ?? "";
  const cwd = repoName === "" ? location.root : repoPath(workspace, repoName) ?? join(location.root, repoName);
  if (!existsSync(cwd)) {
    deny(dodGateInternalErrorDeny(storyId, `repo \`${repoName}\` resolves to ${cwd}, which does not exist`));
  }
  const timeoutMs = (story.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000;

  for (const command of story.dodCommands) {
    const outcome = await runDodCommand(command, cwd, timeoutMs);
    if (outcome.timedOut) {
      deny(dodGateDeny(storyId, command, repoName === "" ? "(root)" : repoName, outcome.exitCode,
        `timed out after ${story.timeoutS ?? DEFAULT_TIMEOUT_S}s. ${outcome.tail}`));
    }
    if (outcome.exitCode !== 0) {
      deny(dodGateDeny(storyId, command, repoName === "" ? "(root)" : repoName, outcome.exitCode, outcome.tail));
    }
  }
} catch (error) {
  if (storyId === "?") failOpen("dod-gate", error);
  deny(dodGateInternalErrorDeny(storyId, error instanceof Error ? error.message : String(error)));
}

allow();
