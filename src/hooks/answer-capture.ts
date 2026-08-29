#!/usr/bin/env bun
/**
 * tldrx hook: answer-capture
 * PostToolUse (Write|Edit) and FileChanged on `tldrx-work/**\/questions.md`.
 *
 * Spec §2.7: a block is answered iff its metadata says `status: open` AND the
 * `[Answer]:` line has a non-empty capture. This hook flips the status, appends
 * the footer, appends a `facts.yml` entry (`kind: answer`, `source.q: Q<n>`) and a
 * `question.answered` event, and echoes one line back as context.
 *
 * NEVER blocks — PostToolUse cannot, and this one would not want to.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runHook, postContext, allow } from "./lib/decide.ts";
import { readPayload, filePathOf } from "./lib/payload.ts";
import { locateWork, factsPath } from "./lib/workspace.ts";
import { currentActor, nowRfc3339 } from "./lib/actor.ts";
import {
  parseQuestions, serializeQuestions, detectAnswered, recordAnswer, replaceBlock,
  type QuestionsDoc,
} from "../core/text/questions.ts";
import { FactsStore } from "../core/facts/FactsStore.ts";
import { MAX_FACT_CHARS } from "../core/facts/Fact.ts";
import { EventLog } from "../core/events/EventLog.ts";

await runHook("answer-capture", async () => {
  const payload = await readPayload();
  const event = payload.hook_event_name ?? "";
  if (event === "PostToolUse" && payload.tool_name !== "Write" && payload.tool_name !== "Edit") return;

  const filePath = filePathOf(payload);
  if (!filePath.endsWith("questions.md") || !existsSync(filePath)) return;
  const location = locateWork(filePath);
  if (location === null) return;

  // PostToolUse runs after the write, so the file on disk IS the new content.
  let doc: QuestionsDoc = parseQuestions(readFileSync(filePath, "utf8"));
  const answered = detectAnswered(doc.blocks);
  if (answered.length === 0) return;

  const store = FactsStore.loadOrEmpty(factsPath(location.root));
  const log = EventLog.forRun(location.runDir);
  const actor = currentActor();
  const at = nowRfc3339();
  const recorded: string[] = [];

  for (const block of answered) {
    // `[assumption]` — the spec stores the answer verbatim but does not say what the
    // fact reads. Taken: "<question> — <answer>", so the fact carries the tokens the
    // no-re-ask hook will later match a re-ask against.
    const text = `${block.title} — ${block.answer}`.slice(0, MAX_FACT_CHARS);
    const fact = store.append({
      fact: text,
      area: block.metadata?.area ?? "unscoped",
      repos: [],
      kind: "answer",
      confidence: "stated",
      source: { who: actor, when: at, run: location.run, q: block.id },
    });
    doc = replaceBlock(doc, recordAnswer(block, { answered_by: actor, answered_at: at, fact: fact.id }));
    log.tryAppend({
      ts: at,
      run: location.run,
      stage: null,
      type: "question.answered",
      actor,
      cost_usd: 0,
      payload: { q: block.id, answer: block.answer, fact: fact.id },
    });
    log.tryAppend({
      ts: at,
      run: location.run,
      stage: null,
      type: "fact.added",
      actor,
      cost_usd: 0,
      payload: { fact: fact.id, area: fact.area, kind: fact.kind, q: block.id },
    });
    recorded.push(`${block.id} → ${fact.id}`);
  }

  store.save();
  writeFileSync(filePath, serializeQuestions(doc), "utf8");
  postContext(`tldrx: recorded ${recorded.join(", ")}`);
});

allow();
