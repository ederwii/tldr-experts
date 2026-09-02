/** `tldrx --help` / `tldrx help`. Implemented. Honest about what is a stub. */
import type { Command } from "../Command.ts";
import { EXIT_OK } from "../exitCodes.ts";
import { frameworkVersion } from "../../core/frameworkVersion.ts";
import {
  ALL_EXIT_CODES, exitLines, helpFor, renderFlagTable, supportsJson, wrap, type FlagHelp,
} from "../helpText.ts";

export function renderHelp(version: string, commands: readonly Command[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const lines: string[] = [
    `tldrx ${version} — tldr-experts, an evidence-first, file-based AI development framework. Beta.`,
    "",
    "Usage: tldrx <command> [args]",
    "",
    "Commands:",
  ];

  for (const command of commands) {
    const mark = command.implemented ? " " : "*";
    lines.push(`  ${mark} ${command.name.padEnd(width)}  ${command.summary}`);
  }

  // Only explain the marker when a command actually carries it. Printing the
  // legend over a list with no `*` in it is itself a false claim.
  if (commands.some((command) => !command.implemented)) {
    lines.push("", "  * = not implemented yet. These exit 64 and say so; they never pretend to work.");
  }

  lines.push(
    "",
    "Flags:",
    "  --version    Print the version",
    "  --help       Print this help; `tldrx <command> --help` for one command's flags,",
    "               allowed values, examples and exit codes",
    "  --ui <mode>  What to show while a sub-agent runs, on the commands that spawn one",
    "               (next, run auto, expert train, seed triage --propose):",
    "               scene (the classroom) · compact (one line) · plain (log lines) · off.",
    "               Default: auto — scene on a terminal 72x20 or larger, compact on a",
    "               smaller one, plain in a pipe or when NO_COLOR/CI is set. Every byte",
    "               of it goes to stderr; stdout is never touched. TLDRX_UI sets it too.",
    "",
    "Exit codes:",
    ...exitLines(ALL_EXIT_CODES),
    "  Which of these a given command can return is listed by `tldrx <command> --help`.",
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

/**
 * `tldrx <command> --help`. Every command answers it, and answers it without a
 * workspace: help is a question about the CLI, not about a project.
 *
 * The body comes from `helpText.ts` — the same registry the argv guard rejects
 * unknown flags from — so a flag that is documented here is by construction one
 * the parser will accept, and vice versa.
 */
export function renderCommandHelp(command: Command): string {
  const help = helpFor(command.name);
  const lines = [`tldrx ${command.name} — ${help?.description ?? command.summary}`, "", "Usage:"];
  // Not `trimStart()`: the usage strings align their continuation lines by hand,
  // and flattening them turns one wrapped invocation into two that look separate.
  for (const line of command.usage.split("\n")) lines.push(`  ${line}`);
  if (command.subcommands.length > 0) {
    lines.push("", `Subcommands: ${command.subcommands.join(", ")}`);
  }

  if (help !== undefined) {
    if (help.args.length > 0) {
      const width = Math.max(...help.args.map((arg) => arg.name.length)) + 2;
      lines.push("", "Arguments:");
      for (const arg of help.args) lines.push(`  ${arg.name.padEnd(width)}${arg.meaning}`);
    }
    // `--help` is answered by the dispatcher for every command, and `--json` is
    // answered by the argv guard, so neither lives in the registry — but a flag
    // table that leaves them out is the same silence this file exists to end.
    const always: FlagHelp[] = [
      { name: "help", arg: null, meaning: "Print this and stop. Needs no workspace, no run and no network." },
    ];
    if (!supportsJson(command.name)) {
      always.push({
        name: "json",
        arg: null,
        meaning: `Not supported by \`${command.name}\` — passing it is an error (exit 1), not a silent no-op.`,
      });
    }
    const flags = renderFlagTable([...help.flags, ...always]);
    if (flags.length > 0) lines.push("", "Flags:", ...flags);
    if (help.examples.length > 0) {
      lines.push("", "Examples:");
      for (const example of help.examples) lines.push(`  ${example}`);
    }
    lines.push("", "Exit codes:", ...exitLines(help.exits));
    const notes = help.notes ?? [];
    if (notes.length > 0) {
      lines.push("", "Notes:");
      for (const note of notes) lines.push(...wrap(note, 96).map((line) => `  ${line}`));
    }
  }

  if (!command.implemented) {
    lines.push("", "Not implemented yet: this command exits 64 and says so.");
  }
  return lines.join("\n");
}

export function makeHelpCommand(commands: () => readonly Command[]): Command {
  return {
    name: "help",
    summary: "Print this help",
    usage: "tldrx --help\n       tldrx <command> --help",
    subcommands: [],
    implemented: true,
    async run(): Promise<number> {
      process.stdout.write(renderHelp(await frameworkVersion(), commands()) + "\n");
      return EXIT_OK;
    },
  };
}
