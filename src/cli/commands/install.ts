/**
 * `tldrx install --claude` — the third way to get the facilitator into Claude Code.
 *
 * The other two stay: `claude --plugin-dir ./plugin` for a one-off session out of a
 * checkout, and plain Bash with nothing installed at all (every hook is a script
 * and every command is a CLI). This one is for the case those two do not cover — a
 * project, or a machine, that should just have it, in files Claude Code already
 * reads and that a team can commit.
 *
 * Deliberately narrow. It writes one skill file and merges two keys into
 * `settings.json`. It never touches `permissions` — pre-approving tools is a
 * decision about someone's blast radius and is not ours to make from a subcommand —
 * and it installs nothing else.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_OK } from "../exitCodes.ts";
import { boolFlag, parseArgs, UsageError } from "../argv.ts";
import { fail } from "../report.ts";
import { PLUGIN_DIR } from "../../core/paths.ts";
import { nowRfc3339 } from "../../hooks/lib/actor.ts";
import {
  applyInstall, chainStatusLineHint, planInstall, renderInstallSummary,
  type InstallOptions, type InstallScope,
} from "../../core/install/installClaude.ts";
import { SKILL_RELATIVE } from "../../core/install/skillFile.ts";

export const installCommand: Command = {
  name: "install",
  summary: "Install the tldrx skill, hooks and status line into .claude/",
  usage:
    "tldrx install --claude [--project | --user] [--skill-only] [--no-hooks] [--no-statusline]\n"
    + "               [--force-statusline] [--uninstall] [--dry-run]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv);
      if (!boolFlag(args, "claude")) {
        throw new UsageError("install needs a target; `--claude` is the only one today");
      }
      if (boolFlag(args, "project") && boolFlag(args, "user")) {
        throw new UsageError("--project and --user are alternatives; pass one");
      }
      const scope: InstallScope = boolFlag(args, "user") ? "user" : "project";
      const skillOnly = boolFlag(args, "skill-only");
      const options: InstallOptions = {
        scope,
        cwd: process.cwd(),
        home: process.env.HOME ?? process.env.USERPROFILE ?? homedir(),
        skill: true,
        hooks: !skillOnly && !boolFlag(args, "no-hooks"),
        statusline: !skillOnly && !boolFlag(args, "no-statusline"),
        forceStatusline: boolFlag(args, "force-statusline"),
        uninstall: boolFlag(args, "uninstall"),
        pluginSkill: join(PLUGIN_DIR, ...SKILL_RELATIVE.split("/")),
        at: nowRfc3339(),
      };

      const dryRun = boolFlag(args, "dry-run");
      const plan = planInstall(options);
      if (!dryRun) applyInstall(plan);

      process.stdout.write(renderInstallSummary(plan, dryRun));
      if (plan.statusLine === "skipped-foreign") {
        process.stdout.write(`${chainStatusLineHint(plan.foreignStatusLine)}\n`);
      }
      return EXIT_OK;
    } catch (error) {
      return fail("install", error, EXIT_FAILED);
    }
  },
};
