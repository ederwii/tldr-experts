/**
 * The citation for "we looked and did not find it".
 *
 * `absent:<path>` means "looked here, found nothing" (spec §2.8), so the path
 * has to be the file we ACTUALLY read. For a .NET repo that is the solution
 * file, not `package.json` — citing a file we never opened would be a fabricated
 * source, which is the exact failure this grammar exists to prevent.
 */
import type { DetectedRepo } from "./types.ts";

export function gapSrc(repo: Pick<DetectedRepo, "path" | "manifests">, fallback = "package.json"): string {
  const manifest = repo.manifests[0] ?? fallback;
  return `absent:${repo.path === "." ? manifest : `${repo.path}/${manifest}`}`;
}
