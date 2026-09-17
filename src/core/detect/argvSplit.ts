/**
 * The ONE tokenizer shared by every reader of a declared command line: a
 * double-quoted word, a single-quoted word, or a bare (unquoted) word.
 *
 * Extracted from `src/hooks/lib/story.ts` (gh #181's follow-up). Two readers need
 * to tell a metacharacter INSIDE quotes (an argument, like
 * `git commit -m "fix; and more"`, or the documented `sh -c "npm run test | tee
 * out.txt"`) from a BARE one (a shell operator nothing here opens a shell for),
 * and they must never disagree about which is which — before this they didn't
 * even both check: the DoD gate's own `splitArgv`/`unquotedShellSeparator` did,
 * `isSingleArgvCommand` (workspace load/`init` validation) did not, so a command
 * the gate would run happily was refused at load. One regex, read once; each
 * caller still applies its OWN set of banned characters to the bare tokens it
 * gets back (the DoD gate's fifteen, spec §2.1's five, `src/core/detect/
 * commands.ts`) — this file draws no line about WHICH characters are banned,
 * only about quoted vs bare.
 */

const TOKEN_RE = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;

export interface ArgvToken {
  /** The token's text, quotes stripped. */
  readonly text: string;
  /** Came from inside `"…"` or `'…'` — never subject to a bare-metacharacter ban. */
  readonly quoted: boolean;
}

/**
 * Tokenize `command` into quoted/bare words. Callers that care about an
 * embedded literal newline check for one themselves BEFORE calling this (a
 * quoted token's `[^"]`/`[^']` class matches a newline like any other
 * character, which is deliberate — see `splitArgv`'s own comment).
 */
export function tokenizeArgv(command: string): readonly ArgvToken[] {
  const tokens: ArgvToken[] = [];
  for (const match of command.matchAll(TOKEN_RE)) {
    if (match[1] !== undefined || match[2] !== undefined) {
      tokens.push({ text: match[1] ?? match[2] ?? "", quoted: true });
      continue;
    }
    tokens.push({ text: match[3] ?? "", quoted: false });
  }
  return tokens;
}
