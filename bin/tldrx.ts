#!/usr/bin/env bun
/**
 * tldrx — tldr-experts CLI entrypoint.
 *
 * Thin on purpose: parse nothing, decide nothing. Hand argv to the dispatcher
 * and exit with whatever it returns.
 */
import { dispatch } from "../src/cli/index.ts";

process.exit(await dispatch(process.argv.slice(2)));
