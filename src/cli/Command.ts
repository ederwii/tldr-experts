/**
 * The shape of every tldrx command in the dispatch table.
 *
 * A command's SUBCOMMANDS are not here: they live in `helpText.ts` with the flags that
 * are scoped by them, and `subcommandsOf(name)` reads them. They used to be declared in
 * both places, which is one list too many for the invariant this repo pins everywhere
 * else — the docs-site generator wanted them too, and a third copy was the point at
 * which two stopped looking survivable.
 */

export interface Command {
  readonly name: string;
  /** One line, shown by `tldrx --help`. */
  readonly summary: string;
  /** Usage line, e.g. `tldrx run <new|status> [args]`. */
  readonly usage: string;
  /** False for v0 stubs — `tldrx --help` marks these so nobody is misled. */
  readonly implemented: boolean;
  /** Returns the process exit code. Must never call process.exit itself. */
  run(argv: readonly string[]): Promise<number>;
}
