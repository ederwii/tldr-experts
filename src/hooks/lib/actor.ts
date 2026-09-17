/** Who a hook records as having acted. `[assumption]`: $USER, else "unknown". */
export function currentActor(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? "";
  return user.trim() === "" ? "unknown" : user.trim();
}

/** RFC3339 UTC to the second, the format every tldrx timestamp uses. */
export function nowRfc3339(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/** Full date-time and offset/`Z`; a bare date (`2026-08-29`) is not RFC3339. */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Is `value` a real RFC3339 instant — the one derivation every caller that
 * needs to trust a hand- or agent-written `at:` string goes through (gh #144
 * F2: `"2026-08-29" < "2026-08-29T09:00:00Z"` is true as a bare string, so a
 * date-only note used to slip past a check comparing timestamps as strings).
 * Shape AND calendar validity both have to hold — `2026-13-40T00:00:00Z`
 * matches the pattern but is not a real instant.
 */
export function isRfc3339(value: string): boolean {
  return RFC3339_RE.test(value) && !Number.isNaN(Date.parse(value));
}
