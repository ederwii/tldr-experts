/**
 * Jira's credentials, and the rule that a missing one costs nothing.
 *
 * The check runs BEFORE anything is read from `03-plan/` and before any transport
 * exists, so "you forgot `JIRA_API_TOKEN`" can never leave half a mirror behind.
 * The message names all three variables, not just the missing one: someone who
 * set none of them needs the list, and someone who set two needs to see which.
 */

export const JIRA_BASE_URL = "JIRA_BASE_URL";
export const JIRA_EMAIL = "JIRA_EMAIL";
export const JIRA_API_TOKEN = "JIRA_API_TOKEN";

/** In the order the message prints them. */
export const JIRA_ENV_VARS = [JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN] as const;

export interface JiraCredentials {
  /** No trailing slash — every path is joined onto it directly. */
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
}

export type CredentialsResult =
  | { readonly ok: true; readonly credentials: JiraCredentials }
  | { readonly ok: false; readonly missing: readonly string[]; readonly message: string };

export function resolveJiraCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialsResult {
  const missing = JIRA_ENV_VARS.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      message:
        `the jira provider needs ${JIRA_ENV_VARS.join(", ")} in the environment; `
        + `missing: ${missing.join(", ")}. Nothing was written.`,
    };
  }
  return {
    ok: true,
    credentials: {
      baseUrl: (env[JIRA_BASE_URL] ?? "").trim().replace(/\/+$/, ""),
      email: (env[JIRA_EMAIL] ?? "").trim(),
      apiToken: (env[JIRA_API_TOKEN] ?? "").trim(),
    },
  };
}

/** HTTP Basic, the scheme Atlassian Cloud's API tokens use. */
export function basicAuthHeader(credentials: JiraCredentials): string {
  const raw = `${credentials.email}:${credentials.apiToken}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}
