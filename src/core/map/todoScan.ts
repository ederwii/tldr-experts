/**
 * Gotchas the code admits to itself: TODO / FIXME / HACK / XXX markers.
 *
 * Bounded on purpose — this runs during `init`, not during a review. The cap is
 * a budget, and the rendered bullet says how many were read.
 */
import { join } from "node:path";
import { runtime } from "../runtime/index.ts";
import type { WalkedFile } from "../detect/walk.ts";

const MARKER = /\b(TODO|FIXME|HACK|XXX)\b:?\s*(.{0,120})/;
const MAX_FILES = 1_500;
const MAX_FILE_BYTES = 200_000;
const MAX_HITS = 8;

export interface TodoHit {
  readonly path: string;
  readonly line: number;
  readonly marker: string;
  readonly text: string;
}

export interface TodoScan {
  readonly hits: readonly TodoHit[];
  readonly filesScanned: number;
  readonly totalHits: number;
}

export async function scanTodos(repoDir: string, sourceFiles: readonly WalkedFile[]): Promise<TodoScan> {
  const hits: TodoHit[] = [];
  let filesScanned = 0;
  let totalHits = 0;

  for (const file of sourceFiles.slice(0, MAX_FILES)) {
    if (file.size > MAX_FILE_BYTES) continue;
    filesScanned += 1;
    const text = await readText(join(repoDir, file.path));
    if (text === null || !text.includes("TODO") && !text.includes("FIXME")
      && !text.includes("HACK") && !text.includes("XXX")) continue;

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      const match = MARKER.exec(line);
      const marker = match?.[1];
      if (marker === undefined) continue;
      totalHits += 1;
      if (hits.length < MAX_HITS) {
        hits.push({ path: file.path, line: i + 1, marker, text: clean(match?.[2] ?? "") });
      }
    }
  }
  return { hits, filesScanned, totalHits };
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[*/]+$/, "").trim().slice(0, 100);
}

async function readText(absPath: string): Promise<string | null> {
  try {
    return await runtime.readText(absPath);
  } catch {
    return null;
  }
}
