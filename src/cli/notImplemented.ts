/** The single place that reports "this does not exist yet". */
import { EXIT_NOT_IMPLEMENTED } from "./exitCodes.ts";

/**
 * Write the standard not-implemented notice to stderr and return the exit code.
 * `name` should include any subcommand, e.g. "run new".
 */
export function notImplemented(name: string): number {
  process.stderr.write(`tldrx ${name}: not implemented yet (v0 roadmap)\n`);
  return EXIT_NOT_IMPLEMENTED;
}
