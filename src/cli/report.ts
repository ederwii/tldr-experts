/**
 * How a command reports a failure.
 *
 * stderr, the spec §3 exit code, and NOTHING on stdout — a caller piping stdout
 * must never see half a success. A `UsageError` and a domain error both mean
 * "1: usage/schema error"; the gate and not-found codes are raised by the
 * commands that own them.
 *
 * The headline is one line, and for almost every error that is the whole
 * message. An error that deliberately carries MORE than a headline keeps it,
 * indented under the first line — the same shape `tldrx next` already prints. It
 * used to be truncated to line one, and on 2026-08-31 that cost the one error
 * where the rest was the point: a `run.yml` that does not parse names the file,
 * the parser's words, the backup beside it and the fact that recovery is manual,
 * and the operator saw only `does not parse`. An error that has taken the
 * trouble to say what to do next should be allowed to say it.
 */
import { EXIT_USAGE } from "./exitCodes.ts";

export function fail(command: string, error: unknown, code: number = EXIT_USAGE): number {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split("\n");
  const head = lines[0] ?? "failed";
  const rest = lines.slice(1)
    // Already-indented continuations keep their own shape; bare ones get two spaces.
    .map((line) => (line === "" || line.startsWith(" ") ? line : `  ${line}`));
  process.stderr.write(`tldrx ${command}: ${[head, ...rest].join("\n")}\n`);
  return code;
}
