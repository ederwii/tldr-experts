/**
 * The Jira provider: REST v3, through the HTTP transport.
 *
 * Endpoints (Atlassian Cloud platform REST v3):
 *   POST   /rest/api/3/issue          -> {id, key, self}
 *   PUT    /rest/api/3/issue/{key}    -> 204, no body
 *   GET    /rest/api/3/issue/{key}?fields=status -> {fields: {status: {name}}}
 *
 * v3 takes `description` as **ADF** (Atlassian Document Format), not wiki markup
 * or Markdown, so the rendered body is wrapped one paragraph per line rather than
 * posted as a string. `[assumption]` — a code block or a bullet list would render
 * more prettily; plain paragraphs are chosen because they cannot lose a character
 * of the body, and the body is the thing that has to be faithful.
 *
 * `[assumption]` — issue type is `Task` for a story and `Epic` for an epic. Those
 * are the default Jira Software names; a project with renamed types will need a
 * `ticket_tool` field this wave did not add.
 *
 * NOT exercised against a real Jira by any test: every call in this file goes
 * through the injected transport, and the suite injects a fake.
 */
import { basicAuthHeader, type JiraCredentials } from "./credentials.ts";
import type { HttpRequest, HttpTransport } from "./transport.ts";
import { TicketAdapterError, type IssueInput, type RemoteIdentity, type TicketProvider } from "./types.ts";

export const JIRA_ISSUE_PATH = "/rest/api/3/issue";

/** `[assumption]` — the default Jira Software type names. */
export const JIRA_ISSUE_TYPES = { story: "Task", epic: "Epic" } as const;

export interface JiraOptions {
  readonly transport: HttpTransport;
  readonly credentials: JiraCredentials;
  /** `ticket_tool.project` — the Jira project KEY, e.g. `APP`. */
  readonly project: string;
}

export function createJiraProvider(options: JiraOptions): TicketProvider {
  const { transport, credentials, project } = options;
  const headers = {
    Authorization: basicAuthHeader(credentials),
    "Content-Type": "application/json",
    Accept: "application/json",
  } as const;
  const base = `${credentials.baseUrl}${JIRA_ISSUE_PATH}`;

  return {
    kind: "jira",

    async write(input: IssueInput, key: string | null): Promise<RemoteIdentity> {
      if (key === null) {
        const body = {
          fields: {
            project: { key: project },
            summary: input.title,
            description: adf(input.body),
            issuetype: { name: JIRA_ISSUE_TYPES[input.kind] },
          },
        };
        const response = await send(transport, { method: "POST", url: base, headers, body });
        const created = parseJson(response.text, "create");
        const issueKey = stringField(created, "key");
        if (issueKey === null) {
          throw new TicketAdapterError(`Jira create returned no \`key\`: ${response.text.slice(0, 200)}`);
        }
        return { key: issueKey, url: browseUrl(credentials, issueKey) };
      }
      const body = { fields: { summary: input.title, description: adf(input.body) } };
      await send(transport, { method: "PUT", url: `${base}/${encodeURIComponent(key)}`, headers, body });
      return { key, url: browseUrl(credentials, key) };
    },

    async readStatus(key: string): Promise<string | null> {
      const response = await send(transport, {
        method: "GET",
        url: `${base}/${encodeURIComponent(key)}?fields=status`,
        headers,
      });
      const doc = parseJson(response.text, "view");
      const fields = doc === null ? null : (doc as Record<string, unknown>).fields;
      if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return null;
      const status = (fields as Record<string, unknown>).status;
      if (typeof status !== "object" || status === null || Array.isArray(status)) return null;
      return stringField(status as Record<string, unknown>, "name");
    },
  };
}

/** The human-facing URL. Jira's `self` is the API URL, which nobody wants in a story file. */
export function browseUrl(credentials: JiraCredentials, key: string): string {
  return `${credentials.baseUrl}/browse/${key}`;
}

/** Minimal ADF: one paragraph per line, blank lines dropped. */
export function adf(body: string): Record<string, unknown> {
  const paragraphs = body.split("\n").filter((line) => line.trim() !== "");
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
  };
}

async function send(transport: HttpTransport, request: HttpRequest) {
  const response = await transport.request(request);
  if (response.status < 200 || response.status >= 300) {
    throw new TicketAdapterError(
      `Jira ${request.method} ${strip(request.url)} returned ${response.status}: ${response.text.slice(0, 200)}`,
    );
  }
  return response;
}

function parseJson(text: string, what: string): Record<string, unknown> | null {
  if (text.trim() === "") return null;
  try {
    const doc: unknown = JSON.parse(text);
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
    return doc as Record<string, unknown>;
  } catch {
    throw new TicketAdapterError(`Jira ${what} did not return JSON: ${text.slice(0, 200)}`);
  }
}

function stringField(doc: Record<string, unknown> | null, key: string): string | null {
  if (doc === null) return null;
  const value = doc[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Keep a base URL out of an error message that may end up in a log. */
function strip(url: string): string {
  const at = url.indexOf(JIRA_ISSUE_PATH);
  return at === -1 ? url : url.slice(at);
}
