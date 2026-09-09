/**
 * The owner-declared `notify:` hook (§2.18), as a hermetic fixture.
 *
 * ONE notifier for every test that asserts what a run told a person — the same
 * rule `fakeTranscript.ts` holds for the agent boundary, for the same reason:
 * two scripts that each claim to record what was delivered are two answers to
 * one question, and the looser of them wins the argument at exactly the moment a
 * notification is being asserted about.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_YML } from "../tempRunWorkspace.ts";

/**
 * A notifier that appends its whole stdin to the file named in `argv[2]`, one JSON
 * per line, and exits with `exitCode`.
 *
 * A real script on disk, executed as argv — not a shell string the framework
 * assembled. The declaration names its absolute path, which is what an owner's own
 * wrapper would be.
 *
 * Node, reached by absolute path, exactly the way the fixture's fake `claude` is:
 * these tests put ONLY the fake bin directory on PATH, so a notifier written as a
 * shell script calling `cat` would depend on whether the host's `sh` happens to
 * find one. It measured differently in two tests of one file, which is the
 * instrument being wrong about the thing under test.
 */
export function writeNotifier(root: string, exitCode = 0): string {
  const impl = join(root, "notifier.js");
  writeFileSync(
    impl,
    [
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => {",
      "  require('node:fs').appendFileSync(process.argv[2], Buffer.concat(chunks).toString('utf8') + '\\n');",
      `  process.exit(${String(exitCode)});`,
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const path = join(root, "notifier.sh");
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(impl)} "$@"\n`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

/** `.tldrx/workspace.yml` with a `notify:` block appended to the shared fixture. */
export function workspaceYamlWithNotify(command: string, events?: readonly string[]): string {
  const list = events === undefined ? "" : `\n  events: [${events.join(", ")}]`;
  return `${WORKSPACE_YML}notify:\n  command: "${command}"${list}\n`;
}

/** Everything the notifier was handed, in delivery order. */
export function deliveredTo(outbox: string): readonly Record<string, unknown>[] {
  if (!existsSync(outbox)) return [];
  return readFileSync(outbox, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
