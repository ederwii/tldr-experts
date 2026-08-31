#!/usr/bin/env bun
/**
 * tldrx hook: no-re-ask
 * PreToolUse (Write|Edit) on `tldrx-work/**\/questions.md`.
 *
 * Concept §1.2: "Re-asking a known fact is a *test failure* of the framework."
 * Spec §4: tokenise each NEW question heading + `area`, compare against LIVE
 * `facts.yml` rows — neither retired nor SUPERSEDED — Jaccard ≥ 0.6 on ≥4-char
 * tokens ⇒ deny and name the fact. A fact an owner has reversed with `tldrx
 * answer --supersede` is what the workspace used to believe, so re-asking the
 * question it answers is legal, and must be.
 *
 * Only questions that are new to the file are checked — re-writing a question the
 * file already carries is an edit, not an ask.
 *
 * Fails OPEN.
 */
import { existsSync, readFileSync } from "node:fs";
import { runHook, deny, allow } from "./lib/decide.ts";
import { readPayload, filePathOf, isWriteOrEdit } from "./lib/payload.ts";
import { wouldBeContent } from "./lib/wouldBe.ts";
import { locateWork, factsPath } from "./lib/workspace.ts";
import { noReAskDeny } from "./lib/messages.ts";
import { parseQuestions, openBlocks } from "../core/text/questions.ts";
import { FactsStore } from "../core/facts/FactsStore.ts";

await runHook("no-reask", async () => {
  const payload = await readPayload();
  if (!isWriteOrEdit(payload)) return;

  const filePath = filePathOf(payload);
  if (!filePath.endsWith("questions.md")) return;
  const location = locateWork(filePath);
  if (location === null) return;

  const wouldBe = wouldBeContent(payload, filePath);
  if (wouldBe.kind !== "content") return;

  const facts = factsPath(location.root);
  if (!existsSync(facts)) return; // nothing is known yet; nothing can be re-asked
  const store = FactsStore.load(facts);
  if (store.active.length === 0) return;

  // `[assumption]` — "new" means an id the file on disk does not already carry.
  // Re-writing a question that is already there is an edit, not an ask.
  const existing = new Set<string>();
  if (existsSync(filePath)) {
    for (const block of parseQuestions(readFileSync(filePath, "utf8")).blocks) existing.add(block.id);
  }

  for (const block of openBlocks(parseQuestions(wouldBe.text).blocks)) {
    if (existing.has(block.id)) continue;
    const area = block.metadata?.area ?? "";
    const hit = store.findDuplicate(block.title, area);
    if (hit !== null) deny(noReAskDeny(block.id, block.title, hit.fact));
  }
});

allow();
