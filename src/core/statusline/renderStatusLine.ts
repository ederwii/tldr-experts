/**
 * Renders the tldrx status line from Claude Code's statusLine stdin payload.
 *
 * Payload shape verified against the official docs:
 * https://code.claude.com/docs/en/statusline  (§ "Available data" / example JSON)
 *   - model.display_name              string
 *   - context_window.used_percentage  number, "may be null early in the session"
 *   - cost.total_cost_usd             number
 *
 * v0 renders only what the harness gives us for free. The richer line from the
 * concept doc (run · PHASE · progress bar · budget ceiling) needs run.yml, which
 * does not exist yet — so it is deliberately NOT rendered rather than faked.
 */

export const NO_SESSION_DATA = "[tldrx] no session data";

/** The subset of the statusLine payload this renderer reads. */
export interface StatusLinePayload {
  readonly model?: { readonly display_name?: unknown } | null;
  readonly context_window?: { readonly used_percentage?: unknown } | null;
  readonly cost?: { readonly total_cost_usd?: unknown } | null;
}

export function renderStatusLine(input: unknown): string {
  if (typeof input !== "object" || input === null) return NO_SESSION_DATA;
  const payload = input as StatusLinePayload;

  const model = payload.model?.display_name;
  const pct = payload.context_window?.used_percentage;
  const cost = payload.cost?.total_cost_usd;

  if (typeof model !== "string" || model === "") return NO_SESSION_DATA;
  if (typeof pct !== "number" || Number.isNaN(pct)) return NO_SESSION_DATA;
  if (typeof cost !== "number" || Number.isNaN(cost)) return NO_SESSION_DATA;

  // `used_percentage` may be fractional; the docs' own jq example truncates it.
  return `[tldrx] ${model} ctx:${Math.floor(pct)}% $${cost.toFixed(2)}`;
}

/** Parse raw stdin text, then render. Never throws. */
export function renderStatusLineFromText(text: string): string {
  try {
    return renderStatusLine(JSON.parse(text));
  } catch {
    return NO_SESSION_DATA;
  }
}
