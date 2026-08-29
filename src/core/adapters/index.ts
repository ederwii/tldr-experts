/**
 * The optional ticket adapter (concept v0.2 addendum).
 *
 * Files are the source of truth. This module mirrors epics and stories OUT to a
 * ticket tool and pulls each issue's status back IN as `external_status`. It
 * never advances `run.yml`, never changes a story's `status:`, and never marks
 * anything done — filing a ticket is not "done".
 */
export type {
  TicketProvider, TicketProviderKind, IssueInput, RemoteIdentity, ExternalRef, MirrorKind,
} from "./types.ts";
export { TICKET_PROVIDERS, isTicketProviderKind, TicketAdapterError } from "./types.ts";

export type { CommandTransport, HttpTransport, HttpRequest, HttpResponse, CommandResult } from "./transport.ts";
export { realCommandTransport, realHttpTransport } from "./transport.ts";

export { TICKET_FOOTER, renderIssueBody, issueTitle } from "./body.ts";
export type { IssueBodyInput } from "./body.ts";

export { readExternal, applyExternal, EXTERNAL_KEY, EXTERNAL_STATUS_KEY } from "./external.ts";
export type { ExternalFields, ExternalPatch } from "./external.ts";

export { readTicketToolConfig, processPath, DISABLED } from "./processConfig.ts";
export type { TicketToolConfig } from "./processConfig.ts";

export { createGithubProvider, parseIssueUrl, issueNumber, GH_BIN, REPO_RE } from "./github.ts";
export type { GithubOptions } from "./github.ts";

export { createJiraProvider, adf, browseUrl, JIRA_ISSUE_PATH, JIRA_ISSUE_TYPES } from "./jira.ts";
export type { JiraOptions } from "./jira.ts";

export {
  resolveJiraCredentials, basicAuthHeader, JIRA_ENV_VARS, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,
} from "./credentials.ts";
export type { JiraCredentials, CredentialsResult } from "./credentials.ts";

export { collectMirrorItems, PLAN_PHASE } from "./collect.ts";
export type { MirrorItem, CollectResult } from "./collect.ts";

export { syncTickets, planSync } from "./sync.ts";
export type { SyncOptions, SyncOutcome, SyncResult, SyncAction } from "./sync.ts";

export { statusRows, renderStatusTable, divergenceOf, isRemoteDone, isLocalDone, DONE_LIKE } from "./statusTable.ts";
export type { StatusRow, Divergence } from "./statusTable.ts";
