/** `tldrx --help` / `tldrx help`. Implemented. Honest about what is a stub. */
import type { Command } from "../Command.ts";
import { EXIT_OK } from "../exitCodes.ts";
import { frameworkVersion } from "../../core/frameworkVersion.ts";

export function renderHelp(version: string, commands: readonly Command[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const lines: string[] = [
    `tldrx ${version} — tldr-experts, a file-based AI development workflow. PRE-ALPHA.`,
    "",
    "Usage: tldrx <command> [args]",
    "",
    "Commands:",
  ];

  for (const command of commands) {
    const mark = command.implemented ? " " : "*";
    lines.push(`  ${mark} ${command.name.padEnd(width)}  ${command.summary}`);
  }

  lines.push(
    "",
    "  * = not implemented yet. These exit 64 and say so; they never pretend to work.",
    "",
    "Flags:",
    "  --version    Print the version",
    "  --help       Print this help",
    "",
    "The loop, in five lines:",
    "  tldrx init                 detect the workspace, map the code, ask only the gaps",
    "  tldrx run new --scope X    open a piece of work",
    "  tldrx next                 run the next stage; it stops at a gate",
    "  tldrx answer / approve     answer the unknowns, approve the gate",
    "  tldrx retro                close the run and keep what was learned",
  );
  return lines.join("\n");
}

export function makeHelpCommand(commands: () => readonly Command[]): Command {
  return {
    name: "help",
    summary: "Print this help",
    usage: "tldrx --help",
    subcommands: [],
    implemented: true,
    async run(): Promise<number> {
      process.stdout.write(renderHelp(await frameworkVersion(), commands()) + "\n");
      return EXIT_OK;
    },
  };
}
