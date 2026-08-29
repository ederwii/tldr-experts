/**
 * What an expert DECLARES it speaks for, read off `expert.md` and nothing else.
 *
 * There are exactly two declarations, both written by `init` and both editable by
 * the team:
 *
 *  - front matter `repos: [api, lab]` — `src/core/init/renderExpert.ts:25`
 *  - the `## Domain` section — `src/core/init/renderExpert.ts:39-43`, whose
 *    bullets are either `- \`src/Checkout/\`` (a repo-RELATIVE folder, for a
 *    domain expert) or `- repo \`api\`` (a whole-repo claim).
 *
 * `tldrx expert create --domain <slug>` writes neither: it turns the slug into a
 * competency AREA (`src/core/experts/createExpert.ts:51`) and leaves the template's
 * `## Domain` placeholder in place. So a hand-created expert is repo-scoped until
 * somebody edits its `## Domain` section, which is the honest reading — a slug is
 * not a path, and guessing a path from one would be a claim nothing can check.
 */
import { readExpertDocument, section } from "./expertDocument.ts";

export interface ExpertDomain {
  readonly name: string;
  readonly exists: boolean;
  /** `kind:` front matter — `domain` | `stack` | `product` | `role` | "". */
  readonly kind: string;
  /** `repos:` front matter, in declared order. */
  readonly repos: readonly string[];
  /** `## Domain` bullets that name a path, repo-relative, no trailing slash. */
  readonly paths: readonly string[];
}

/** The template's own placeholders — prose, not a path anybody meant. */
const PLACEHOLDER_PATHS: ReadonlySet<string> = new Set(["path/to/module", "path/to/other"]);

export function readExpertDomain(root: string, name: string): ExpertDomain {
  const doc = readExpertDocument(root, name);
  if (!doc.exists) return { name, exists: false, kind: "", repos: [], paths: [] };
  return {
    name,
    exists: true,
    kind: doc.frontMatter.get("kind") ?? "",
    repos: parseList(doc.frontMatter.get("repos") ?? ""),
    paths: domainPaths(section(doc.body, "Domain")),
  };
}

/** `[api, lab]` or `api, lab` -> `["api", "lab"]`. Empty in, empty out. */
export function parseList(value: string): readonly string[] {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item !== "");
}

/**
 * The path bullets of a `## Domain` section.
 *
 * `- repo \`api\`` is deliberately NOT a path: it is the whole-repo claim, and it
 * is already carried by the front matter `repos:`. Turning it into the path `api`
 * would make every repo-wide expert match every file in the workspace by prefix,
 * which is the opposite of a domain.
 */
export function domainPaths(body: string): readonly string[] {
  const paths: string[] = [];
  for (const line of body.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet === null) continue;
    const text = (bullet[1] ?? "").trim();
    if (/^repo\s/i.test(text)) continue;
    const code = /`([^`]+)`/.exec(text);
    const raw = (code?.[1] ?? text.split(/\s+—\s+/)[0] ?? "").trim();
    const path = normalisePath(raw);
    if (path === "" || PLACEHOLDER_PATHS.has(path) || !path.includes("/")) continue;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** `api:src/Checkout/` and `./api/src/Checkout` both normalise to `api/src/Checkout`. */
export function normalisePath(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z0-9-]+:(?=[^/])/i, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .replace(/\\/g, "/");
}

/**
 * Do two paths name the same place, or one inside the other?
 *
 * Prefix matching at a SEGMENT boundary, both directions: a domain of
 * `api/src/Checkout` is intersected by the cited file `api/src/Checkout/Cart.cs`,
 * and a domain of `api/src/Checkout/Cart.cs` is intersected by the cited folder
 * `api/src`. `api/src/Check` never matches `api/src/Checkout`, which is the whole
 * reason this is not `startsWith`.
 */
export function pathsIntersect(a: string, b: string): boolean {
  const left = normalisePath(a);
  const right = normalisePath(b);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
