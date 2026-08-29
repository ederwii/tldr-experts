/**
 * Several runs open at once, described once.
 *
 * `tldrx run new` has always allowed a second open run (`newRun.ts` only refuses a
 * duplicate run dir), and each one carries its own budget.yml, events.jsonl and
 * epic branch — so the answer is not "forbid it", it is "stop guessing which one
 * was meant". Every command that refuses on ambiguity, and the multi-run
 * `run status` screen, render from the rows built here, so they can never
 * disagree about a run's status, cursor or what it is waiting on.
 */
import type { RunStore } from "./RunStore.ts";
import { whatIsWaiting, type WaitingKind } from "./runStatus.ts";

export interface OpenRunRow {
  readonly id: string;
  readonly status: string;
  /** `<phase>/<stage>` — the cursor, as one column. */
  readonly cursor: string;
  readonly waiting: WaitingKind;
  readonly spentUsd: number;
  readonly ceilingUsd: number;
}

export function openRunRow(store: RunStore): OpenRunRow {
  const run = store.run;
  return {
    id: run.run,
    status: run.status,
    cursor: `${run.cursor.phase}/${run.cursor.stage}`,
    waiting: whatIsWaiting(run, store.runDir).kind,
    spentUsd: run.budget.spent_usd,
    ceilingUsd: run.budget.ceiling_usd,
  };
}

export function openRunRows(stores: readonly RunStore[]): readonly OpenRunRow[] {
  return stores.map(openRunRow);
}

/**
 * The body of the refusal, UNPREFIXED: line 0 is the headline, every later line
 * is one run. The caller owns the `tldrx <cmd>: ` prefix and the two-space indent
 * (`src/cli/resolveRun.ts`), because `tldrx next` already applies exactly that
 * shape to whatever the facilitator hands back.
 */
export function ambiguousRunLines(stores: readonly RunStore[]): readonly string[] {
  const rows = openRunRows(stores);
  return [`${String(rows.length)} runs are open — pass one:`, ...rows.map(rowLine(rows))];
}

/** `<id>  <status>  <phase/stage cursor>  <waiting kind>`, columns aligned. */
function rowLine(rows: readonly OpenRunRow[]): (row: OpenRunRow) => string {
  const id = width(rows, (r) => r.id);
  const status = width(rows, (r) => r.status);
  const cursor = width(rows, (r) => r.cursor);
  return (row) =>
    `${row.id.padEnd(id)}  ${row.status.padEnd(status)}  ${row.cursor.padEnd(cursor)}  ${row.waiting}`;
}

/**
 * The `tldrx run status` screen when more than one run is open: every open run on
 * one line, and no per-phase detail — that is what `run status <id>` is for.
 */
export function renderOpenRuns(rows: readonly OpenRunRow[]): string {
  const header = { id: "RUN", status: "STATUS", cursor: "CURSOR", waiting: "WAITING", money: "SPENT/CEILING" };
  const idW = Math.max(header.id.length, ...rows.map((r) => r.id.length));
  const statusW = Math.max(header.status.length, ...rows.map((r) => r.status.length));
  const cursorW = Math.max(header.cursor.length, ...rows.map((r) => r.cursor.length));
  const waitingW = Math.max(header.waiting.length, ...rows.map((r) => r.waiting.length));

  const lines = [
    `${String(rows.length)} runs are open — \`tldrx run status <id>\` for one of them`,
    "",
    `${header.id.padEnd(idW)}  ${header.status.padEnd(statusW)}  ${header.cursor.padEnd(cursorW)}  `
      + `${header.waiting.padEnd(waitingW)}  ${header.money}`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.id.padEnd(idW)}  ${row.status.padEnd(statusW)}  ${row.cursor.padEnd(cursorW)}  `
        + `${row.waiting.padEnd(waitingW)}  ${money(row.spentUsd)} / ${money(row.ceilingUsd)}`,
    );
  }
  lines.push(
    "",
    "Every command that changes a run needs one of these ids: `tldrx next <id>`, "
      + "`tldrx approve --run <id>`, `tldrx answer Q1 \"…\" --run <id>`.",
  );
  return lines.join("\n");
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function width(rows: readonly OpenRunRow[], of: (row: OpenRunRow) => string): number {
  return Math.max(0, ...rows.map((row) => of(row).length));
}
