/**
 * Optional MCP probe for `tldrx doctor --mcp`.
 *
 * `claude mcp list` runs a live health check per server, so it can take 30s+ when
 * one times out. It is NEVER run without the flag. Output lines are shaped
 * `name: <transport> - <status>`.
 */
import { runtime } from "../runtime/index.ts";
import { claudeBin } from "../facilitator/spawnAgent.ts";

const ANSI_ESCAPE = /\[[0-9;]*m/g;
const SERVER_LINE = /^([A-Za-z0-9._@/-]+):\s+(.+?)\s+-\s+(.+)$/;

export interface McpServer {
  readonly name: string;
  readonly transport: string;
  readonly status: string;
}

export interface McpProbeResult {
  readonly ran: boolean;
  readonly servers: readonly McpServer[];
  readonly error: string | null;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/** Parse `claude mcp list` stdout. Lines that do not match the shape are ignored. */
export function parseMcpList(output: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const rawLine of output.split("\n")) {
    const line = stripAnsi(rawLine).trim();
    const match = line.match(SERVER_LINE);
    if (!match) continue;
    const [, name, transport, status] = match;
    if (!name || !transport || !status) continue;
    servers.push({ name, transport: transport.trim(), status: status.trim() });
  }
  return servers;
}

export class McpProbe {
  constructor(private readonly timeoutMs = 60_000) {}

  async probe(): Promise<McpProbeResult> {
    try {
      const { stdout, stderr } = await runtime.spawn(claudeBin(), ["mcp", "list"], {
        timeoutMs: this.timeoutMs,
      });

      const servers = parseMcpList(stdout);
      if (servers.length === 0) {
        const detail = stripAnsi(stderr).trim() || stripAnsi(stdout).trim();
        return { ran: true, servers, error: detail === "" ? "no servers reported" : detail };
      }
      return { ran: true, servers, error: null };
    } catch (error) {
      return { ran: false, servers: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
}
