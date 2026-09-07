/**
 * The one place detection starts a child process.
 *
 * Everything that shells out (git, graphify) takes a `CommandRunner`, so tests
 * inject a fake and the real one is exercised once, here. No shell: argv only,
 * so a command can never be string-concatenated into something else. The spawn
 * itself goes through the runtime seam, so this runs unchanged under node.
 */
import { runtime } from "../runtime/index.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The runner killed it at its own deadline. Absent means it finished on its own. */
  readonly timedOut?: boolean;
  /**
   * The process never started — ENOENT, EACCES, a throw out of the spawn (#168).
   *
   * Carried through from `SpawnResult` because `exitCode` cannot say it: the seam settles a
   * failed spawn as 127, and 127 is also a real exit code (`npm run build` whose `vite` is
   * missing). `detect/probeCommands.ts` is what needs the difference — "could not be started"
   * and "exited 127" are different records, and only one of them is a measurement.
   *
   * Absent means it started, the honest default for a fake.
   */
  readonly spawnFailed?: boolean;
}

export interface CommandRunner {
  run(argv: readonly string[], cwd: string): Promise<CommandResult>;
}

export class SpawnCommandRunner implements CommandRunner {
  constructor(private readonly timeoutMs = 120_000) {}

  async run(argv: readonly string[], cwd: string): Promise<CommandResult> {
    const [command, ...args] = argv;
    // Nothing to start, so this 127 is this file's and not a process's — say so (#168).
    if (command === undefined) {
      return { exitCode: 127, stdout: "", stderr: "empty argv", spawnFailed: true };
    }
    const { exitCode, stdout, stderr, timedOut, spawnFailed } = await runtime.spawn(command, args, {
      cwd,
      timeoutMs: this.timeoutMs,
    });
    return { exitCode, stdout, stderr, timedOut, spawnFailed: spawnFailed === true };
  }
}
