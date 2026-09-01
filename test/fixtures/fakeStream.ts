/**
 * Where the fake `claude`'s output USED to be written, and now only re-exported from.
 *
 * The writer moved to `src/core/facilitator/fakeTranscript.ts` when `tldrx learn`
 * (#30) started needing it at RUNTIME: the tutorial's sandbox spawns a stand-in
 * `claude` that has to speak the same `stream-json` the real one does, and
 * `test/` is not in package.json's `files` list, so a shipped command cannot
 * import from here. It sits beside `agentEvents.ts` — the READER of that format —
 * because drift between the two is the only way either can be wrong.
 *
 * This file stays because four test fakes import it by this path and a rename is
 * not what any of them is about.
 */
export {
  claudeOutput, toolPairLines, wantsStream,
} from "../../src/core/facilitator/fakeTranscript.ts";
export type { FakeResult, FakeTool } from "../../src/core/facilitator/fakeTranscript.ts";
