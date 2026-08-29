/**
 * The two transports a ticket provider is allowed to touch the outside world
 * through, and nothing else.
 *
 * Why a second seam on top of `src/core/runtime/`: the runtime seam offers
 * `spawn` but **no HTTP** (verified 2026-08-29 — `Runtime` is `readStdin`,
 * `spawn`, `readText`, `writeText`, `exists`, `readJson`, `parseYaml`,
 * `stringifyYaml`). Jira needs REST v3, so the choice was to widen `Runtime` or
 * to declare a narrow interface here. This file does the latter: the real HTTP
 * implementation is four lines over the global `fetch`, which both supported
 * runtimes provide (Node ≥20 and Bun), so nothing here names a runtime global
 * and the seam invariant asserted by `build.test.ts` still holds. Every provider
 * takes its transport as a constructor argument.
 *
 * The consequence that matters: **the test suite never makes a network call and
 * never spawns `gh`.** Every provider is exercised through a fake that records
 * what it was asked to do, which is also the only way to assert the argument
 * shape of a command we must not run.
 */
import { runtime } from "../runtime/index.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Running one external binary as a single argv — never through a shell. */
export interface CommandTransport {
  run(cmd: string, args: readonly string[]): Promise<CommandResult>;
}

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON body, already an object. Absent for GET. */
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly text: string;
}

export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** The real command transport: the runtime seam's `spawn`, no shell, no timeout games. */
export function realCommandTransport(): CommandTransport {
  return {
    async run(cmd, args) {
      const out = await runtime.spawn(cmd, args, { env: process.env });
      return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr };
    },
  };
}

/**
 * The real HTTP transport. `fetch` is a global on both supported runtimes, so
 * this stays runtime-agnostic and the seam invariant in `build.test.ts` holds.
 */
export function realHttpTransport(): HttpTransport {
  return {
    async request(req) {
      const response = await fetch(req.url, {
        method: req.method,
        headers: { ...req.headers },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
      return { status: response.status, text: await response.text() };
    },
  };
}
