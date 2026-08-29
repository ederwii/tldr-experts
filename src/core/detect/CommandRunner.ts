/**
 * The one place a child process is started.
 *
 * Everything that shells out (git, graphify) takes a `CommandRunner`, so tests
 * inject a fake and the real one is exercised once, here. No shell: argv only,
 * so a command can never be string-concatenated into something else.
 */

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
    try {
      const proc = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), this.timeoutMs);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      return { exitCode, stdout, stderr };
    } catch (error) {
      return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  }
}
