/**
 * What a map provider produces: sourced bullets, grouped by output document.
 *
 * Providers never write markdown — they return facts, the renderer writes files.
 * That is what makes `graphify` and `static` interchangeable.
 */

export const MAP_DOCS = ["architecture", "domains", "conventions", "commands", "hotspots", "gotchas"] as const;
export type MapDoc = (typeof MAP_DOCS)[number];

export interface MapBullet {
  /** Bullet text WITHOUT the trailing token. */
  readonly text: string;
  /** One or more `src` payloads (spec §2.8); the renderer joins them. */
  readonly srcs: readonly string[];
}

export interface MapFacts {
  readonly repo: string;
  readonly provider: string;
  readonly docs: Readonly<Record<MapDoc, readonly MapBullet[]>>;
  /** Top-level source folders that look like domains; init seeds one expert each. */
  readonly domains: readonly string[];
}

export function emptyDocs(): Record<MapDoc, MapBullet[]> {
  return { architecture: [], domains: [], conventions: [], commands: [], hotspots: [], gotchas: [] };
}
