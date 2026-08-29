/** One retro bullet, with the events.jsonl line that justifies it. */

export interface Proposal {
  /** The sentence, without its source token. */
  readonly text: string;
  /** 1-based line in `tldrx-work/<run>/events.jsonl`. */
  readonly line: number;
}

/** Spec §2.8 `file` production, relative to the workspace root. */
export function eventSrc(run: string, line: number): string {
  return `[src: tldrx-work/${run}/events.jsonl:${line}]`;
}

export function renderProposal(run: string, proposal: Proposal): string {
  return `- ${proposal.text} ${eventSrc(run, proposal.line)}`;
}
