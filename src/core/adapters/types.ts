/**
 * The ticket mirror's vocabulary (concept v0.2 addendum, "MCP detection →
 * optional ticket adapter").
 *
 * Two guard-rails are encoded in these types rather than left to prose:
 *
 *  1. **Files are the source of truth.** A provider can only `write` an issue out
 *     and `readStatus` back. There is no method that returns a local `status`, no
 *     method that advances a run, and nothing here can mark a story done — the
 *     only thing that flows *in* is an opaque remote status string, which lands in
 *     `external_status` and nowhere else.
 *  2. **Filing a ticket is never "done."** `RemoteIdentity` carries a key and a
 *     url. It deliberately does NOT carry a `PlanStatus`, so no amount of provider
 *     code can be plumbed into the story's `status:` field by accident.
 */

/** The providers this adapter actually implements. `linear` is in `process.yml`'s enum but has no adapter. */
export const TICKET_PROVIDERS = ["github", "jira"] as const;
export type TicketProviderKind = (typeof TICKET_PROVIDERS)[number];

export function isTicketProviderKind(value: string): value is TicketProviderKind {
  return (TICKET_PROVIDERS as readonly string[]).includes(value);
}

/** Which Plan artefact an issue mirrors. */
export type MirrorKind = "epic" | "story";

/** Everything a provider needs to create or update one remote issue. */
export interface IssueInput {
  readonly kind: MirrorKind;
  /** The Plan id, e.g. `S3` — used in the summary so a human can find it. */
  readonly id: string;
  /** The issue title, already prefixed with the id. */
  readonly title: string;
  /** The rendered body, footer included. */
  readonly body: string;
}

/** What a remote write gives back. No status: see guard-rail 2 above. */
export interface RemoteIdentity {
  /** The provider's own key — a GitHub issue number, a Jira `APP-14`. */
  readonly key: string;
  readonly url: string;
}

/**
 * A provider is exactly two operations. Both go through an injected transport, so
 * a test exercises the real argument shaping without a real network.
 */
export interface TicketProvider {
  readonly kind: TicketProviderKind;
  /** Create when `key` is null, update the named issue when it is not. */
  write(input: IssueInput, key: string | null): Promise<RemoteIdentity>;
  /**
   * The remote's own status string, VERBATIM (`OPEN`, `Done`, `In Progress`).
   * Never translated to a `PlanStatus`: it is written to `external_status` as-is.
   * `null` when the remote does not report one.
   */
  readStatus(key: string): Promise<string | null>;
}

/**
 * The `external:` block stored in a story's / epic's YAML front matter.
 *
 * `[assumption: field name]` — the wave brief specifies the four keys but not the
 * containing key's name; `external` is chosen to pair with `external_status`,
 * which spec §2.12 already names.
 */
export interface ExternalRef {
  readonly provider: string;
  readonly key: string;
  readonly url: string;
  /** RFC3339 UTC, the format every tldrx timestamp uses. */
  readonly synced_at: string;
}

export class TicketAdapterError extends Error {}
