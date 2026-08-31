/**
 * The progress view: what a person sees while a sub-agent is working.
 *
 * Nothing in `src/core/` outside this folder renders anything. The rest of the
 * framework publishes `AgentEvent`s to `bus.ts`; the CLI decides whether anyone
 * is watching and installs a driver if so.
 */
export { setProgressSink, setProgressTitle, setProgressCeiling, emitAgentEvent, progressActive } from "./bus.ts";
export type { ProgressSink } from "./bus.ts";
export { startProgress, FRAME_MS } from "./driver.ts";
export type { ProgressHandle, ProgressOptions } from "./driver.ts";
export { resolveUiMode, isUiModeFlag, UiModeError, UI_MODES, MIN_SCENE_COLS, MIN_SCENE_ROWS } from "./mode.ts";
export type { UiMode, UiModeFlag, UiEnvironment } from "./mode.ts";
export { renderScene, blackboard, wallClock, classroom, footer, BOARD_NOTES } from "./scene.ts";
export type { Frame } from "./scene.ts";
export { renderCompact, SPINNER } from "./compact.ts";
export { palette, colorEnabled, stripAnsi, visibleLength } from "./color.ts";
export type { Ink, Palette, ColorEnvironment } from "./color.ts";
export { renderCampus } from "./campus.ts";
export type { CampusInput } from "./campus.ts";
export { startSteps, silentSteps, SLOW_STEP_MS, HEARTBEAT_MS } from "./steps.ts";
export type { StepReporter, StepRun, StepOptions } from "./steps.ts";
export { plainLine } from "./plain.ts";
export { UiState, RING_CAPACITY, SPEECH_MS } from "./state.ts";
export type { UiSnapshot, UiStateOptions } from "./state.ts";
export { summarize, toolLine, shortPath, command, duration, clockFace, firstSentence, shortModel, SLOW_TOOL_MS } from "./summary.ts";
export type { SummaryContext } from "./summary.ts";
