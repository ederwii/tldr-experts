/**
 * The Bun implementation of the runtime seam.
 *
 * This is the ONLY file in `src/` allowed to name `Bun`, together with
 * `index.ts`'s one-line runtime detection. Nothing here runs unless
 * `typeof Bun !== "undefined"`, so importing it under Node is inert — the `Bun`
 * references live inside function bodies, never at module scope.
 */
import { registerChild, unregisterChild } from "./children.ts";
import { killProcessTree } from "./killProcessTree.ts";
import { LineSplitter } from "./lineSplitter.ts";
import { OUTPUT_GRACE_MS } from "./outputGrace.ts";
import type { Runtime, SpawnOptions, SpawnResult } from "./Runtime.ts";

export const bunRuntime: Runtime = {
  name: "bun",

  async readStdin(): Promise<string> {
    try {
      return await Bun.stdin.text();
    } catch {
      return "";
    }
  },

  async spawn(cmd: string, args: readonly string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
    let timedOut = false;
    try {
      const proc = Bun.spawn([cmd, ...args], {
        cwd: opts.cwd,
        env: opts.env as Record<string, string | undefined> | undefined,
        stdout: "pipe",
        stderr: "pipe",
        stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
        // Own process group, so the timeout below — and the CLI's signal handler
        // — can kill the whole tree. The cost of detaching is that the terminal's
        // Ctrl-C no longer reaches this child on its own, which is precisely why
        // it is registered below: `src/cli/signals.ts` kills it explicitly.
        detached: opts.timeoutMs !== undefined,
      });
      registerChild(proc.pid);
      // Drain before awaiting exit: a child that fills the pipe buffer blocks on
      // write, and would never exit if nothing were reading.
      const collected: Promise<[string, string]> = Promise.all([
        // Only the line-callback path reads chunk by chunk. Without a callback
        // this is the same one-shot read it always was, so nothing about the
        // buffered behaviour is inferred from the streaming rewrite.
        opts.onStdoutLine === undefined
          ? new Response(proc.stdout).text()
          : drainLines(proc.stdout, opts.onStdoutLine),
        new Response(proc.stderr).text(),
      ]);
      const timer =
        opts.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              killProcessTree(proc.pid, () => proc.kill(9));
            }, opts.timeoutMs);
      const exitCode = await proc.exited;
      unregisterChild(proc.pid);
      if (timer !== null) clearTimeout(timer);
      // The process is gone; anything still holding its pipes is not ours to
      // wait for. Settle on what was read rather than hang. See killProcessTree.
      const [stdout, stderr] = await withinGrace(collected);
      return { exitCode, stdout, stderr, timedOut };
    } catch (error) {
      return { exitCode: 127, stdout: "", stderr: messageOf(error), timedOut };
    }
  },

  async readText(path: string): Promise<string> {
    return await Bun.file(path).text();
  },

  async writeText(path: string, content: string): Promise<void> {
    await Bun.write(path, content);
  },

  async exists(path: string): Promise<boolean> {
    return await Bun.file(path).exists();
  },

  async readJson(path: string): Promise<unknown> {
    return (await Bun.file(path).json()) as unknown;
  },

  parseYaml(text: string): unknown {
    return Bun.YAML.parse(text);
  },

  stringifyYaml(value: unknown, indent = 2): string {
    return indent > 0 ? Bun.YAML.stringify(value, null, indent) : Bun.YAML.stringify(value);
  },
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve `collected`, or give up on it after the grace period and report "". */
function withinGrace(collected: Promise<[string, string]>): Promise<[string, string]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(["", ""]), OUTPUT_GRACE_MS);
    void collected.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(["", ""]); },
    );
  });
}

/**
 * Read a stream to the end, handing each complete line to `onLine` as it arrives
 * and still returning the whole text. Both views come off the same bytes — the
 * caller is never asked to choose between progress and a result.
 */
async function drainLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  const splitter = new LineSplitter(onLine);
  let text = "";
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      splitter.push(chunk);
    }
    const tail = decoder.decode();
    if (tail !== "") { text += tail; splitter.push(tail); }
  } finally {
    splitter.end();
    reader.releaseLock();
  }
  return text;
}
