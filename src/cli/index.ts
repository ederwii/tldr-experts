/**
 * The tldrx command table and dispatcher.
 *
 * v0 truth: only `--version`, `--help` and `doctor` do anything. Every other
 * command is a declared placeholder that exits 64. Nothing here prints success
 * for work it did not do.
 */
import type { Command } from "./Command.ts";
import { EXIT_NOT_IMPLEMENTED } from "./exitCodes.ts";

import { initCommand } from "./commands/init.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { runCommand } from "./commands/run.ts";
import { nextCommand } from "./commands/next.ts";
import { answerCommand } from "./commands/answer.ts";
import { approveCommand } from "./commands/approve.ts";
import { rejectCommand } from "./commands/reject.ts";
import { mapCommand } from "./commands/map.ts";
import { expertCommand } from "./commands/expert.ts";
import { dashboardCommand } from "./commands/dashboard.ts";
import { replayCommand } from "./commands/replay.ts";
import { retroCommand } from "./commands/retro.ts";
import { versionCommand } from "./commands/version.ts";
import { makeHelpCommand } from "./commands/help.ts";

/** Commands in the order `tldrx --help` lists them (the shape of the loop). */
export const COMMANDS: readonly Command[] = [
  initCommand,
  doctorCommand,
  runCommand,
  nextCommand,
  answerCommand,
  approveCommand,
  rejectCommand,
  mapCommand,
  expertCommand,
  dashboardCommand,
  replayCommand,
  retroCommand,
];

const helpCommand = makeHelpCommand(() => COMMANDS);

const TABLE: ReadonlyMap<string, Command> = new Map<string, Command>([
  ...COMMANDS.map((command) => [command.name, command] as const),
  ["version", versionCommand],
  ["--version", versionCommand],
  ["-v", versionCommand],
  ["help", helpCommand],
  ["--help", helpCommand],
  ["-h", helpCommand],
]);

export function lookup(name: string): Command | undefined {
  return TABLE.get(name);
}

/** Dispatch argv (without node/bun and script path). Returns the exit code. */
export async function dispatch(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined || name === "") return helpCommand.run([]);

  const command = lookup(name);
  if (!command) {
    process.stderr.write(`tldrx: unknown command '${name}'\nRun \`tldrx --help\` for the command list.\n`);
    return EXIT_NOT_IMPLEMENTED;
  }
  return command.run(rest);
}

export type { Command } from "./Command.ts";
