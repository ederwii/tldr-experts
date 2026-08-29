/**
 * How a command reports a failure.
 *
 * One line on stderr, the spec §3 exit code, and NOTHING on stdout — a caller
 * piping stdout must never see half a success. A `UsageError` and a domain error
 * both mean "1: usage/schema error"; the gate and not-found codes are raised by
 * the commands that own them.
 */
import { EXIT_USAGE } from "./exitCodes.ts";

export function fail(command: string, error: unknown, code: number = EXIT_USAGE): number {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`tldrx ${command}: ${message.split("\n")[0] ?? "failed"}\n`);
  return code;
}
