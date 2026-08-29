/**
 * Write the static export: one `index.html`, nothing beside it.
 *
 * Two steps, the same two the live server takes: build the model, render it.
 * Default output is `.tldrx/cache/dashboard/`, which spec §1 already marks
 * gitignored — a generated snapshot is not a committed artefact.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { buildModel } from "./model.ts";
import { renderDashboard } from "./render.ts";

export const DEFAULT_OUT_DIR = join(PROJECT_FRAMEWORK_DIR, "cache", "dashboard");
export const INDEX_FILE = "index.html";

export interface StaticExport {
  readonly path: string;
  readonly bytes: number;
  readonly runs: number;
  readonly experts: number;
}

export function writeStaticDashboard(
  root: string,
  outDir: string,
  generatedAt: string,
  now: Date = new Date(),
): StaticExport {
  const model = buildModel(root, generatedAt, { now });
  const html = renderDashboard(model);
  const path = join(outDir, INDEX_FILE);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, html, "utf8");
  return {
    path,
    bytes: Buffer.byteLength(html, "utf8"),
    runs: model.runs.length,
    experts: model.experts.length,
  };
}
