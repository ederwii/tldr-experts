/**
 * The Node implementation of the runtime seam.
 *
 * Everything here is stdlib except YAML, which comes from the `yaml` npm package.
 * That package is a **devDependency on purpose**: `bun build --target=node` inlines
 * it into `dist/`, so an installed tldrx still resolves zero runtime dependencies.
 * Do not promote it to `dependencies` — that would reintroduce the install step
 * the framework refuses to have.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYamlText, stringify as stringifyYamlValue } from "yaml";
import { killProcessTree } from "./killProcessTree.ts";
import { LineSplitter } from "./lineSplitter.ts";
import { OUTPUT_GRACE_MS } from "./outputGrace.ts";
import type { Runtime, SpawnOptions, SpawnResult } from "./Runtime.ts";

export const nodeRuntime: Runtime = {
  name: "node",

  readStdin(): Promise<string> {
    return new Promise((resolve) => {
      // A TTY stdin never ends; a hook or a pipe always does. Resolving "" rather
      // than hanging is the same behaviour Bun.stdin.text() gives on a closed pipe.
      if (process.stdin.isTTY === true) {
        resolve("");
        return;
      }
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      process.stdin.on("error", () => resolve(""));
    });
  },

  spawn(cmd: string, args: readonly string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
    return new Promise((resolve) => {
      let timedOut = false;
      let settled = false;
      let stdout = "";
      let stderr = "";

      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      const child = nodeSpawn(cmd, [...args], {
        cwd: opts.cwd,
        env: opts.env as NodeJS.ProcessEnv | undefined,
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        // Own process group, so the timeout (or the abort) below can kill the
        // whole tree rather than just the shell in front of it.
        detached: opts.timeoutMs !== undefined || opts.signal !== undefined,
      });

      const onAbort = (): void => { killProcessTree(child.pid, () => child.kill("SIGKILL")); };
      if (opts.signal !== undefined) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      const timer =
        opts.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              killProcessTree(child.pid, () => child.kill("SIGKILL"));
            }, opts.timeoutMs);

      const splitter = opts.onStdoutLine === undefined ? null : new LineSplitter(opts.onStdoutLine);

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        // Deliver the tail BEFORE resolving: a producer whose last line has no
        // newline must still be seen by the progress view, and after `resolve`
        // nobody is listening.
        splitter?.end();
        opts.signal?.removeEventListener("abort", onAbort);
        if (timer !== null) clearTimeout(timer);
        if (graceTimer !== null) clearTimeout(graceTimer);
        resolve({ exitCode, stdout, stderr, timedOut });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        splitter?.push(text);
      });
      child.stdout?.on("end", () => splitter?.end());
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", (error: Error) => {
        stderr += error.message;
        finish(127);
      });
      // `close` waits for the pipes to reach EOF; `exit` does not. Something the
      // child started can outlive it still holding stdout, so `exit` starts a
      // grace period and then settles with whatever was read. See killProcessTree.
      child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        graceTimer = setTimeout(() => finish(exitCodeOf(code, signal)), OUTPUT_GRACE_MS);
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) =>
        finish(exitCodeOf(code, signal)));

      if (opts.stdin !== undefined && child.stdin !== null) {
        child.stdin.end(opts.stdin);
      }
    });
  },

  async readText(path: string): Promise<string> {
    return await readFile(path, "utf8");
  },

  async writeText(path: string, content: string): Promise<void> {
    // `Bun.write` creates missing parents; `writeFile` does not. Match Bun.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  },

  async exists(path: string): Promise<boolean> {
    // Regular files only — `existsSync` would say true for a directory, which
    // `Bun.file(dir).exists()` does not. See Runtime.exists.
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },

  async readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  },

  parseYaml(text: string): unknown {
    return parseYamlText(text) as unknown;
  },

  stringifyYaml(value: unknown, indent = 2): string {
    return indent > 0 ? stringifyYamlValue(value, { indent }) : stringifyYamlValue(value);
  },
};

/** Node reports a signalled death as `code === null`; Bun reports 128 + signal. */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1;
}
