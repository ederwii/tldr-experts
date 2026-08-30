/**
 * One line of English per `AgentEvent` — derived, never asked for.
 *
 * The whole point is that this costs NOTHING: no second model call, no summary
 * agent, no extra tokens. Everything on screen is a rearrangement of bytes the
 * sub-agent was already sending. A progress view that itself cost money would be
 * the most expensive kind of decoration there is.
 *
 * Pure functions with an explicit context, so every line is testable without a
 * clock, a terminal or a process.
 */
import type { AgentEvent } from "../facilitator/agentEvents.ts";

export interface SummaryContext {
  /** Workspace root, so an absolute `file_path` prints as a repo-relative one. */
  readonly root: string;
  /** Milliseconds since the agent started, for the cost line's `· 3m10s`. */
  readonly elapsedMs: number;
  /** Longest line to produce. Everything is cut to this with an ellipsis. */
  readonly width?: number;
}

const DEFAULT_WIDTH = 64;

/**
 * A tool that finished faster than this gets no "→ ok" line: the interesting
 * fact about a 12 ms `Read` is that it happened, and a second line saying it
 * stopped happening is noise in a six-line window.
 */
export const SLOW_TOOL_MS = 1000;

/** The line for one event, or null when the event is not worth a line. */
export function summarize(event: AgentEvent, ctx: SummaryContext): string | null {
  const width = ctx.width ?? DEFAULT_WIDTH;
  switch (event.kind) {
    case "start":
      return event.model === null ? null : cut(`model ${shortModel(event.model)}`, width);
    case "tool":
      return cut(toolLine(event.name, event.target, ctx.root), width);
    case "tool-done":
      if (event.ok && (event.ms === null || event.ms < SLOW_TOOL_MS)) return null;
      return cut(`  → ${event.ok ? "ok" : "failed"}${event.ms === null ? "" : ` (${duration(event.ms)})`}`, width);
    case "text": {
      const sentence = firstSentence(event.text);
      return sentence === "" ? null : cut(sentence, width);
    }
    case "question":
      return cut(`asked Q${String(event.index)}: ${event.text}`, width);
    case "cost":
      // Token counts arrive on every assistant turn; a DOLLAR figure only arrives
      // with the final result. Only the latter is worth a line — "$0.00 so far"
      // during a run that has certainly spent something is a false statement.
      return event.usd === null || event.usd <= 0
        ? null
        : cut(`$${event.usd.toFixed(2)} so far · ${duration(ctx.elapsedMs)}`, width);
    case "done":
      // The cost line immediately before this one already says it finished and
      // what it cost. A second "done" would be the same fact twice.
      return null;
    case "error":
      return cut(`error: ${event.message}`, width);
    default:
      return null;
  }
}

/**
 * `reading src/Foo.cs`, `$ dotnet test → running`, `grep "Outbox"`.
 *
 * The verb is chosen per tool because "Read src/Foo.cs" reads like a command and
 * "reading src/Foo.cs" reads like a report, and a report is what this is.
 */
export function toolLine(name: string, target: string | null, root: string): string {
  const path = target === null ? null : shortPath(target, root);
  switch (name) {
    case "Read": return path === null ? "reading a file" : `reading ${path}`;
    case "Write": return path === null ? "writing a file" : `writing ${path}`;
    case "Edit": case "MultiEdit": case "NotebookEdit":
      return path === null ? "editing a file" : `editing ${path}`;
    case "Bash": case "BashOutput":
      return target === null ? "$ (a command) → running" : `$ ${command(target)} → running`;
    case "Grep": return target === null ? "grep" : `grep "${target}"`;
    case "Glob": return target === null ? "glob" : `glob ${target}`;
    case "WebFetch": return target === null ? "fetching" : `fetching ${target}`;
    case "WebSearch": return target === null ? "searching" : `searching "${target}"`;
    case "Task": case "Agent": return target === null ? "sub-agent" : `sub-agent: ${target}`;
    case "TodoWrite": return "updating the todo list";
    default: return target === null ? name : `${name} ${path ?? target}`;
  }
}

/** How long a path may be before it is cut back to its last few segments. */
const PATH_WIDTH = 44;

/**
 * A path relative to the workspace when it is inside it, shortened when it is long.
 *
 * A path too long to fit is cut at a SEGMENT boundary, not mid-name: `…/260828-
 * demo/01-what/handoff.md` tells you what was written and `…8-demo/01-what/hand`
 * does not, and the file name is the part that identifies the work.
 */
export function shortPath(path: string, root: string): string {
  let rel = path;
  if (root !== "" && rel.startsWith(`${root}/`)) rel = rel.slice(root.length + 1);
  if (rel.startsWith("./")) rel = rel.slice(2);
  if (rel.length <= PATH_WIDTH) return rel;

  const parts = rel.split("/").filter((part) => part !== "");
  const kept: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] ?? "";
    const width = [part, ...kept].join("/").length + 2;
    if (kept.length > 0 && width > PATH_WIDTH) break;
    kept.unshift(part);
  }
  const tail = kept.join("/");
  // One segment that is itself longer than the budget: there is nothing to keep
  // but its end.
  return tail.length + 2 > PATH_WIDTH
    ? `…${tail.slice(tail.length - (PATH_WIDTH - 1))}`
    : `…/${tail}`;
}

/** One line of a command, whitespace collapsed. */
export function command(text: string): string {
  const line = text.split("\n")[0] ?? "";
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length <= 44 ? collapsed : `${collapsed.slice(0, 43)}…`;
}

/** `12 s`, `3m10s`, `1h04m` — always three-to-five characters of truth. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${String(total)} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${String(minutes)}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** `mm:ss`, for the wall clock. Rolls over past an hour rather than growing. */
export function clockFace(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60) % 100;
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The first sentence of a model's prose.
 *
 * A paragraph does not fit on a blackboard and the first sentence is almost
 * always the topic one. Abbreviations are not special-cased: a wrong cut in a
 * progress view costs nothing, and the machinery to get it right would.
 */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  const stop = /[.!?](\s|$)/.exec(flat);
  return stop === null ? flat : flat.slice(0, stop.index + 1).trim();
}

/** `claude-haiku-4-5-20251001` → `haiku-4-5`: the part that tells them apart. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function cut(text: string, width: number): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").trimEnd();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1))}…`;
}
