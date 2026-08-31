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
import { EXIT_OK, EXIT_USAGE } from "./exitCodes.ts";
import { firstUnknownFlag, flagNames } from "./argv.ts";
import { declaredFlags, declaredValueFlags, isPassthrough, supportsJson } from "./helpText.ts";
import { installSignalHandlers } from "./signals.ts";

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
import { costCommand } from "./commands/cost.ts";
import { rejectCommand } from "./commands/reject.ts";
import { storyCommand } from "./commands/story.ts";
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
  storyCommand,
  budgetCommand,
  costCommand,
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
  // Ctrl-C has to kill the sub-agent tree, record the attempt and drop the lock
  // before it exits — see `signals.ts`. One line, on purpose.
  installSignalHandlers();

  const [name, ...rest] = argv;

  if (name === undefined || name === "") return helpCommand.run([]);

  const command = lookup(name);
  if (!command) {
    // Exit 1, not 64. A name that was never a command is a USAGE error, and 64
    // means "implemented nowhere yet" — a promise about the roadmap that a
    // mistyped word has no business making. No command in this build is a stub,
    // so 64 is currently unreachable, which is the point of reserving it.
    process.stderr.write(`tldrx: unknown command '${name}'\nRun \`tldrx --help\` for the command list.\n`);
    return EXIT_USAGE;
  }
  if (command !== helpCommand && rest.some(isHelpFlag)) {
    process.stdout.write(`${renderCommandHelp(command)}\n`);
    return EXIT_OK;
  }
  const refusal = flagRefusal(command.name, rest);
  if (refusal !== null) {
    process.stderr.write(refusal);
    return EXIT_USAGE;
  }
  return command.run(rest);
}

/**
 * The line to print instead of running, when argv carries a flag this command
 * cannot read — or `null` when every flag in it is one the command declares.
 *
 * Two refusals, because they are two different mistakes:
 *
 *   `--nope`   is a typo. Nothing reads it, so running would silently do
 *              something other than what was asked.
 *   `--json`   is a real flag this command has no JSON shape for. Accepting and
 *              ignoring it — which is what happened until now — teaches a script
 *              that the output is parseable when it is prose.
 *
 * `--help`/`-h` never reach here; the dispatcher answers them above.
 */
function flagRefusal(name: string, argv: readonly string[]): string | null {
  if (isPassthrough(name)) return null;
  const valueFlags = declaredValueFlags(name);
  const known = new Set([...declaredFlags(name), "json", "help"]);
  const unknown = firstUnknownFlag(argv, known, valueFlags);
  if (unknown !== null) {
    return `tldrx ${name}: unknown flag --${unknown} (see \`tldrx ${name} --help\`)\n`;
  }
  if (!supportsJson(name) && flagNames(argv, valueFlags).includes("json")) {
    return `tldrx ${name}: --json is not supported by ${name} (see \`tldrx ${name} --help\`)\n`;
  }
  return null;
}

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

export type { Command } from "./Command.ts";
