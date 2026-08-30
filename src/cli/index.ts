/**
 * The tldrx command table and dispatcher.
 *
 * Every v0 command is implemented; a command that ever is not must exit 64 and
 * say so. Nothing here prints success for work it did not do.
 *
 * `--help` is answered here rather than inside each command, so that asking a
 * command what it does never needs a workspace, a run, or anything on disk.
 */
import type { Command } from "./Command.ts";
import { EXIT_NOT_IMPLEMENTED, EXIT_OK } from "./exitCodes.ts";

import { initCommand } from "./commands/init.ts";
import { installCommand } from "./commands/install.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { runCommand } from "./commands/run.ts";
import { statusCommand } from "./commands/status.ts";
import { seedCommand } from "./commands/seed.ts";
import { nextCommand } from "./commands/next.ts";
import { answerCommand } from "./commands/answer.ts";
import { approveCommand } from "./commands/approve.ts";
import { budgetCommand } from "./commands/budget.ts";
import { rejectCommand } from "./commands/reject.ts";
import { mapCommand } from "./commands/map.ts";
import { expertCommand } from "./commands/expert.ts";
import { dashboardCommand } from "./commands/dashboard.ts";
import { replayCommand } from "./commands/replay.ts";
import { retroCommand } from "./commands/retro.ts";
import { watchCommand } from "./commands/watch.ts";
import { ticketsCommand } from "./commands/tickets.ts";
import { interviewCommand } from "./commands/interview.ts";
import { questionsCommand } from "./commands/questions.ts";
import { hookCommand, statuslineCommand } from "./commands/hook.ts";
import { versionCommand } from "./commands/version.ts";
import { makeHelpCommand, renderCommandHelp } from "./commands/help.ts";

/** Commands in the order `tldrx --help` lists them (the shape of the loop). */
export const COMMANDS: readonly Command[] = [
  initCommand,
  installCommand,
  doctorCommand,
  statusCommand,
  runCommand,
  seedCommand,
  nextCommand,
  answerCommand,
  interviewCommand,
  questionsCommand,
  approveCommand,
  rejectCommand,
  budgetCommand,
  mapCommand,
  expertCommand,
  dashboardCommand,
  replayCommand,
  retroCommand,
  watchCommand,
  ticketsCommand,
  hookCommand,
  statuslineCommand,
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
  if (command !== helpCommand && rest.some(isHelpFlag)) {
    process.stdout.write(`${renderCommandHelp(command)}\n`);
    return EXIT_OK;
  }
  return command.run(rest);
}

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

export type { Command } from "./Command.ts";
