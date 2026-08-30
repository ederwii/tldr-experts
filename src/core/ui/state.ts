/**
 * What the renderer draws, and the only thing that changes while an agent runs.
 *
 * Deliberately a plain object graph updated by `apply(event, now)`: every frame
 * is a pure function of this, so a test can build any state by replaying events
 * and never needs a timer, a terminal or a process.
 */
import type { AgentEvent } from "../facilitator/agentEvents.ts";
import { firstSentence, summarize } from "./summary.ts";

/** How many summaries are kept. The scene shows six; the rest is scrollback. */
export const RING_CAPACITY = 40;

/** How long a line of the teacher's speech stays on screen. */
export const SPEECH_MS = 4000;

export interface UiSnapshot {
  readonly title: string;
  /** Oldest first. At most `RING_CAPACITY`. */
  readonly lines: readonly string[];
  /** The most recent line, for the compact one-liner. */
  readonly activity: string;
  /** True while at least one tool is open — the student's arm moves. */
  readonly busy: boolean;
  /** The teacher's current line, or null when nothing was said recently. */
  readonly speech: string | null;
  readonly spentUsd: number;
  readonly ceilingUsd: number;
  readonly elapsedMs: number;
  readonly finished: boolean;
  readonly failed: boolean;
}

export interface UiStateOptions {
  readonly root: string;
  readonly ceilingUsd?: number;
  readonly title?: string;
  /** Epoch millis the run started. */
  readonly startedAt: number;
  /** Longest summary line. Set from the terminal width by the driver. */
  readonly width?: number;
}

export class UiState {
  private title: string;
  private readonly ring: string[] = [];
  private activity = "waiting for the agent";
  private openTools = 0;
  private speech: string | null = null;
  private speechAt = 0;
  private spentUsd = 0;
  private ceilingUsd: number;
  private finished = false;
  private failed = false;
  private readonly root: string;
  private readonly startedAt: number;
  private width: number;

  constructor(options: UiStateOptions) {
    this.root = options.root;
    this.startedAt = options.startedAt;
    this.title = options.title ?? "working";
    this.ceilingUsd = options.ceilingUsd ?? 0;
    this.width = options.width ?? 64;
  }

  setTitle(title: string): void {
    this.title = title;
    // A new stage starts its own turn: the previous stage's tools are not still
    // open, whatever the last stream did or did not say before it ended.
    this.openTools = 0;
    this.finished = false;
  }

  setCeiling(usd: number): void {
    this.ceilingUsd = usd;
  }

  setWidth(width: number): void {
    this.width = Math.max(24, width);
  }

  /** Apply one event. Returns the summary lines it produced (usually 0 or 1). */
  apply(event: AgentEvent, now: number): readonly string[] {
    switch (event.kind) {
      case "tool": this.openTools += 1; break;
      case "tool-done": this.openTools = Math.max(0, this.openTools - 1); break;
      case "text": {
        const said = firstSentence(event.text);
        if (said !== "") { this.speech = said; this.speechAt = now; }
        break;
      }
      case "cost": if (event.usd !== null && event.usd > 0) this.spentUsd += event.usd; break;
      case "done": this.finished = true; this.openTools = 0; if (!event.ok) this.failed = true; break;
      case "error": this.failed = true; break;
      default: break;
    }

    const line = summarize(event, {
      root: this.root,
      elapsedMs: Math.max(0, now - this.startedAt),
      width: this.width,
    });
    if (line === null) return [];
    this.ring.push(line);
    while (this.ring.length > RING_CAPACITY) this.ring.shift();
    // An indented "→ ok" is the tail of the line above it, not a new activity.
    if (!line.startsWith("  ")) this.activity = line;
    return [line];
  }

  snapshot(now: number): UiSnapshot {
    return {
      title: this.title,
      lines: [...this.ring],
      activity: this.activity,
      busy: this.openTools > 0,
      speech: this.speech !== null && now - this.speechAt < SPEECH_MS ? this.speech : null,
      spentUsd: this.spentUsd,
      ceilingUsd: this.ceilingUsd,
      elapsedMs: Math.max(0, now - this.startedAt),
      finished: this.finished,
      failed: this.failed,
    };
  }
}
