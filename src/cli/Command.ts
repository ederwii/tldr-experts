/** The shape of every tldrx command in the dispatch table. */

export interface Command {
  readonly name: string;
  /** One line, shown by `tldrx --help`. */
  readonly summary: string;
  /** Usage line, e.g. `tldrx run <new|status> [args]`. */
  readonly usage: string;
  /** Recognised subcommands, for help text. Empty when the command takes none. */
  readonly subcommands: readonly string[];
  /** False for v0 stubs — `tldrx --help` marks these so nobody is misled. */
  readonly implemented: boolean;
  /** Returns the process exit code. Must never call process.exit itself. */
  run(argv: readonly string[]): Promise<number>;
}
