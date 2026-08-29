/**
 * The runtime seam.
 *
 * Portability decision (2026-08-28): **Bun to build, Node or Bun to run.** The
 * framework is written against Bun's ergonomics but must execute on a plain Node
 * install, because `npx tldrx` and a CI container are not going to have Bun.
 *
 * Every host capability that is not identical on both runtimes lives behind this
 * interface, and NOWHERE else. `grep -rn 'Bun\.' src` outside `src/core/runtime/`
 * must come back empty — that grep is the invariant this file exists to protect.
 *
 * Node's YAML comes from the `yaml` npm package, which is a **devDependency**:
 * `bun build --target=node` inlines it into `dist/`, so a published install still
 * has zero runtime dependencies.
 */

export interface SpawnOptions {
  readonly cwd?: string;
  /** Kill the child after this many milliseconds. Omitted = wait forever. */
  readonly timeoutMs?: number;
  /** Written to the child's stdin, which is then closed. */
  readonly stdin?: string;
  /**
   * Environment for the child, INCLUDING the `PATH` its executable is looked up
   * on. Omitted = whatever the host runtime defaults to, which on Bun is the
   * environment as it was at process start — not `process.env` as it is now.
   * A caller that changed `process.env` and expects the child to see it must
   * pass it here. `[assumption]` — the seam's task shape did not list `env`, but
   * "spawn `claude` from PATH" is not reproducible without it.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * `[assumption]` — not in the task's stated shape, but the DoD gate has to tell
   * "your test suite failed" from "your test suite hung", so the seam reports it.
   */
  readonly timedOut: boolean;
}

export interface Runtime {
  /** Which implementation this is — for diagnostics and the doctor report. */
  readonly name: "bun" | "node";

  /** All of stdin as text. Returns "" when stdin is closed, empty or unreadable. */
  readStdin(): Promise<string>;

  /**
   * Run one command as a single argv — never through a shell unless the caller
   * makes `sh -c` explicit. Never throws: a spawn failure comes back as exit 127.
   */
  spawn(cmd: string, args: readonly string[], opts?: SpawnOptions): Promise<SpawnResult>;

  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readJson(path: string): Promise<unknown>;

  parseYaml(text: string): unknown;
  stringifyYaml(value: unknown, indent?: number): string;
}
