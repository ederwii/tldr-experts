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
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse as parseYamlText, stringify as stringifyYamlValue } from "yaml";
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

      const child = nodeSpawn(cmd, [...args], {
        cwd: opts.cwd,
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });

      const timer =
        opts.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, opts.timeoutMs);

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut });
      };

      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", (error: Error) => {
        stderr += error.message;
        finish(127);
      });
      child.on("close", (code: number | null) => finish(code ?? (timedOut ? 137 : 1)));

      if (opts.stdin !== undefined && child.stdin !== null) {
        child.stdin.end(opts.stdin);
      }
    });
  },

  async readText(path: string): Promise<string> {
    return await readFile(path, "utf8");
  },

  async writeText(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf8");
  },

  async exists(path: string): Promise<boolean> {
    return existsSync(path);
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
