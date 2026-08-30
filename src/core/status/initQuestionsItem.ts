/**
 * Item 1: the install interview never finished.
 *
 * `tldrx init` writes what detection could NOT establish to
 * `.tldrx/init-questions.md` and stops. Those answers become `facts.yml` rows that
 * every later stage cites, so leaving them open does not merely skip a screen — it
 * makes every run guess the same four things again. Read through the same
 * `parseQuestions`/`openBlocks` pair the answer-capture hook and `tldrx interview`
 * use, so "open" means exactly what it means everywhere else.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openBlocks, parseQuestions } from "../text/questions.ts";
import { QUESTIONS_FILE } from "../init/questions.ts";
import type { PendingItem } from "./PendingItem.ts";

/** How many question titles the item spells out before it stops listing. */
const MAX_LISTED = 5;

export function initQuestionsItem(root: string): PendingItem | null {
  const path = join(root, ...QUESTIONS_FILE.split("/"));
  if (!existsSync(path)) return null;

  let open;
  try {
    open = openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks);
  } catch {
    // An unreadable questions file is not a pending item — it is a broken file,
    // and inventing "1 question is open" out of a parse failure would be worse
    // than saying nothing. `tldrx doctor` is where a broken file belongs.
    return null;
  }
  if (open.length === 0) return null;

  const details = open
    .slice(0, MAX_LISTED)
    .map((block) => `${block.id} · ${block.title}`);
  if (open.length > MAX_LISTED) {
    details.push(`… and ${String(open.length - MAX_LISTED)} more in ${QUESTIONS_FILE}`);
  }
  details.push("these are facts about your project the tool could not detect; every run reuses the answers");

  return {
    kind: "init-questions",
    summary: `${String(open.length)} setup question${open.length === 1 ? "" : "s"} `
      + "about your project have never been answered",
    command: "tldrx interview --init",
    details,
  };
}
