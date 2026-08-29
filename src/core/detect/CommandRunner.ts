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
}

export interface CommandRunner {
  run(argv: readonly string[], cwd: string): Promise<CommandResult>;
}

export class SpawnCommandRunner implements CommandRunner {
  constructor(private readonly timeoutMs = 120_000) {}

  async run(argv: readonly string[], cwd: string): Promise<CommandResult> {
    const [command, ...args] = argv;
    if (command === undefined) return { exitCode: 127, stdout: "", stderr: "empty argv" };
    const { exitCode, stdout, stderr } = await runtime.spawn(command, args, {
      cwd,
      timeoutMs: this.timeoutMs,
    });
    return { exitCode, stdout, stderr };
  }
}
