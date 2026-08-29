/**
 * The two write modes `init` is allowed to use, and the record of which one ran.
 *
 * Re-running `init` must be safe: detection output (`workspace.yml`, `map/**`)
 * is regenerated, but anything a human may have touched — facts, experts,
 * process, conventions, an answered questions file — is KEPT, and the report
 * says so out loud rather than silently doing nothing.
 */
import { runtime } from "../runtime/index.ts";

export type WriteOutcome = "written" | "created" | "kept";

/** Text files end with a newline: a missing one makes every later diff noisy. */
export function endWithNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export interface WriteRecord {
  /** Workspace-relative path. */
  readonly path: string;
  readonly outcome: WriteOutcome;
}

export class WriteLog {
  private readonly records: WriteRecord[] = [];

  /** Always overwrite: derived output with no human edits to lose. */
  async overwrite(absPath: string, relPath: string, content: string): Promise<WriteOutcome> {
    await runtime.writeText(absPath, endWithNewline(content));
    return this.record(relPath, "written");
  }

  /** Write only when absent; an existing file is kept untouched. */
  async createIfAbsent(absPath: string, relPath: string, content: string): Promise<WriteOutcome> {
    if (await runtime.exists(absPath)) return this.record(relPath, "kept");
    await runtime.writeText(absPath, endWithNewline(content));
    return this.record(relPath, "created");
  }

  private record(path: string, outcome: WriteOutcome): WriteOutcome {
    this.records.push({ path, outcome });
    return outcome;
  }

  get entries(): readonly WriteRecord[] {
    return this.records;
  }

  paths(outcome: WriteOutcome): string[] {
    return this.records.filter((record) => record.outcome === outcome).map((record) => record.path);
  }
}
