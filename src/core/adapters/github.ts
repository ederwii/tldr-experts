/**
 * The GitHub provider: the `gh` CLI, through the command transport.
 *
 * `gh` rather than the REST API on purpose — it already holds the user's auth, so
 * the adapter never asks for a token and never stores one.
 *
 * Verified against `gh` 2.x's documented surface (2026-08-29, from `gh issue
 * --help`; NOT exercised against a real repo by any test — see the module header
 * of `transport.ts`):
 *   - `gh issue create` prints the new issue's URL on stdout and has **no**
 *     `--json` flag, so the key is parsed out of that URL;
 *   - `gh issue edit <n>` likewise prints the URL;
 *   - `gh issue view <n> --json state,url,number` is the one that speaks JSON.
 * `[assumption]` — that create/edit print exactly one URL line. If a future `gh`
 * prints more, `parseIssueUrl` takes the last URL-looking line, which is where
 * the URL is today.
 */
import type { CommandTransport } from "./transport.ts";
import { TicketAdapterError, type IssueInput, type RemoteIdentity, type TicketProvider } from "./types.ts";

export const GH_BIN = "gh";

/** `owner/repo`. Anything else is a `process.yml` mistake, caught before any call. */
export const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export interface GithubOptions {
  readonly transport: CommandTransport;
  /** `ticket_tool.project`, which for GitHub is `owner/repo`. */
  readonly repo: string;
}

export function createGithubProvider(options: GithubOptions): TicketProvider {
  const { transport, repo } = options;
  if (!REPO_RE.test(repo)) {
    throw new TicketAdapterError(
      `ticket_tool.project must be \`owner/repo\` for the github provider, got \`${repo}\``,
    );
  }

  return {
    kind: "github",

    async write(input: IssueInput, key: string | null): Promise<RemoteIdentity> {
      const args = key === null
        ? ["issue", "create", "--repo", repo, "--title", input.title, "--body", input.body]
        : ["issue", "edit", key, "--repo", repo, "--title", input.title, "--body", input.body];
      const out = await run(transport, args);
      const url = parseIssueUrl(out);
      return { key: key ?? issueNumber(url), url };
    },

    async readStatus(key: string): Promise<string | null> {
      const out = await run(transport, ["issue", "view", key, "--repo", repo, "--json", "state,url,number"]);
      let doc: unknown;
      try {
        doc = JSON.parse(out.trim());
      } catch {
        throw new TicketAdapterError(`gh issue view ${key} did not return JSON: ${firstLine(out)}`);
      }
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
      const state = (doc as Record<string, unknown>).state;
      return typeof state === "string" && state !== "" ? state : null;
    },
  };
}

async function run(transport: CommandTransport, args: readonly string[]): Promise<string> {
  const result = await transport.run(GH_BIN, args);
  if (result.exitCode === 127) {
    throw new TicketAdapterError(
      "`gh` is not on PATH — install the GitHub CLI (https://cli.github.com) and run `gh auth login`",
    );
  }
  if (result.exitCode !== 0) {
    throw new TicketAdapterError(
      `gh ${args[0]} ${args[1]} exited ${result.exitCode}: ${firstLine(result.stderr) || firstLine(result.stdout)}`,
    );
  }
  return result.stdout;
}

/** The last `https://…` line of `gh`'s output. */
export function parseIssueUrl(stdout: string): string {
  const urls = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("https://"));
  const url = urls[urls.length - 1];
  if (url === undefined) {
    throw new TicketAdapterError(`gh printed no issue URL: ${firstLine(stdout) || "(no output)"}`);
  }
  return url;
}

/** `https://github.com/o/r/issues/12` -> `12`. */
export function issueNumber(url: string): string {
  const match = /\/issues\/(\d+)\s*$/.exec(url);
  if (match === null || match[1] === undefined) {
    throw new TicketAdapterError(`cannot read an issue number out of \`${url}\``);
  }
  return match[1];
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}
