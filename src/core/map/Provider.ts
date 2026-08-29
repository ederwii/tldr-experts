/**
 * The map provider interface (spec §5, decision (b)).
 *
 * `graphify` first; when it is not on PATH the `static` provider takes over and
 * `workspace.yml` records which one ran. The framework degrades, never installs.
 */
import type { DetectedRepo } from "../detect/types.ts";
import type { MapFacts } from "./MapFacts.ts";

export interface MapContext {
  readonly repo: DetectedRepo;
  /** Absolute directory this provider may write its own artefacts into. */
  readonly outDir: string;
  /** Absolute workspace root (the directory the repos live under). */
  readonly root: string;
}

export interface MapProvider {
  readonly name: string;
  /** Cheap probe. False ⇒ the caller falls back to the next provider. */
  isAvailable(context: MapContext): Promise<boolean>;
  collect(context: MapContext): Promise<MapFacts>;
}
