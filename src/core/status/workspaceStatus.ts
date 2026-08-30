/**
 * `tldrx status` — everything in this workspace that is waiting on a human.
 *
 * Four sources, asked in the order they block each other (`PendingItem.ts`), and
 * nothing else. No model, no network, no writes: the pending work is already on
 * disk, and the whole problem this solves is that it was on disk in four places
 * nobody read as one list.
 *
 * Three of them BLOCK and land in `items`. The fourth — experts a stage will load
 * that have never been trained — lands in `advice`, one line, uncounted.
 *
 * Every source is wrapped: a broken `split.yml` or an unreadable expert folder
 * costs its own section and nothing more. A report that dies on the first bad file
 * is a report you stop trusting, and the sections are genuinely independent.
 */
import { initQuestionsItem } from "./initQuestionsItem.ts";
import { seedSplitItems } from "./seedSplitItems.ts";
import { runItems } from "./runItems.ts";
import { expertAdvice } from "./expertItems.ts";
import type { PendingItem, WorkspaceStatus } from "./PendingItem.ts";

/** The one item an idle workspace gets, so `items` is never empty. */
export const NOTHING_PENDING: PendingItem = {
  kind: "none",
  summary: "nothing pending — open work with `tldrx run new <slug> --seed <path>` or `tldrx seed triage <path>`",
  command: "",
  details: [],
};

export function buildWorkspaceStatus(root: string): WorkspaceStatus {
  const items = [
    ...safely(() => {
      const item = initQuestionsItem(root);
      return item === null ? [] : [item];
    }),
    ...safely(() => seedSplitItems(root)),
    ...safely(() => runItems(root)),
  ];
  // Advice is built the same way and kept apart. It is never counted in
  // `pending`: "4 things waiting on you" of which three were untrained experts
  // described a workspace that was fine as one that was stuck.
  const advice = safely(() => expertAdvice(root));
  return items.length === 0
    ? { root, items: [NOTHING_PENDING], advice, pending: 0 }
    : { root, items, advice, pending: items.length };
}

/** One section's items, or none when that section could not be read. */
function safely(build: () => readonly PendingItem[]): readonly PendingItem[] {
  try {
    return build();
  } catch {
    return [];
  }
}
