/**
 * `--effort <level>`, shared by `tldrx next` and `tldrx expert train`.
 *
 * Validated at the edge rather than at the spawn: the whole point of the flag is
 * to make a run cheaper, and `claude` given an unknown level would either refuse
 * (a wasted process) or fall back to its default (a silent, expensive no-op). A
 * typo is a usage error, here, before anything is read.
 */
import { stringFlag, UsageError, type ParsedArgs } from "./argv.ts";
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel } from "../core/schemas/stage.ts";

export function effortFlag(args: ParsedArgs, name = "effort"): EffortLevel | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  if (!isEffortLevel(value)) {
    throw new UsageError(`--${name} must be one of ${EFFORT_LEVELS.join(" | ")} (got '${value}')`);
  }
  return value;
}
