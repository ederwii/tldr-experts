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
  /**
   * Kill the child after this many milliseconds. Omitted = wait forever.
   *
   * A timed spawn is detached into its own process group and the timeout kills
   * that whole group, so a shell's grandchildren die with it (see
   * `killProcessTree`). An untimed spawn stays in the caller's group and keeps
   * the terminal's normal Ctrl-C behaviour.
   */
  readonly timeoutMs?: number;
  /** Written to the child's stdin, which is then closed. */
  readonly stdin?: string;
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
   * Always settles: `stdout` and `stderr` are strings even when a timed-out
   * command left something behind holding the pipes.
   */
  spawn(cmd: string, args: readonly string[], opts?: SpawnOptions): Promise<SpawnResult>;

  readText(path: string): Promise<string>;
  /** Writes `content`, creating parent directories — the same on both runtimes. */
  writeText(path: string, content: string): Promise<void>;
  /**
   * True when a REGULAR FILE exists at `path`. A directory is false, on both
   * runtimes: `Bun.file(dir).exists()` says false, so `existsSync` (which says
   * true) is not the node equivalent, and the seam would silently diverge.
   */
  exists(path: string): Promise<boolean>;
  readJson(path: string): Promise<unknown>;

  parseYaml(text: string): unknown;
  stringifyYaml(value: unknown, indent?: number): string;
}
