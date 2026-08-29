/**
 * Runtime selection, once, at import time.
 *
 * Both implementations are imported statically so the bundler can see them; only
 * one is ever exercised. `typeof Bun` is the whole detection — no env var, no
 * flag, nothing a user has to remember to set.
 */
import type { Runtime } from "./Runtime.ts";
import { bunRuntime } from "./bunRuntime.ts";
import { nodeRuntime } from "./nodeRuntime.ts";

const onBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export const runtime: Runtime = onBun ? bunRuntime : nodeRuntime;

export { bunRuntime } from "./bunRuntime.ts";
export { nodeRuntime } from "./nodeRuntime.ts";
export type { Runtime, SpawnOptions, SpawnResult } from "./Runtime.ts";
