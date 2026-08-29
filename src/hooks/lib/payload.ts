/**
 * The hook stdin payloads, as verified in spec §4 / concept Appendix A
 * (code.claude.com/docs/en/hooks.md, 2026-08-28):
 *
 *   PreToolUse  : session_id, cwd, hook_event_name, tool_name, tool_input, tool_use_id
 *   PostToolUse : + tool_result
 *   SessionStart: session_id, cwd, hook_event_name, source
 *
 * `FileChanged` is wired for answer-capture but its payload shape is NOT in the
 * verified list, so the file path is read from every plausible key. `[assumption]`
 */
import { parseHookInput, readStdin } from "../../core/hooks/passthrough.ts";

export interface ToolInput {
  readonly file_path?: string;
  readonly content?: string;
  readonly old_string?: string;
  readonly new_string?: string;
  readonly replace_all?: boolean;
  readonly command?: string;
}

export interface HookPayload {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_input?: ToolInput;
  readonly tool_use_id?: string;
  readonly tool_result?: unknown;
  readonly file_path?: string;
  readonly path?: string;
  readonly source?: string;
}

export async function readPayload(): Promise<HookPayload> {
  return (parseHookInput(await readStdin()) as HookPayload | null) ?? {};
}

export function toolInput(payload: HookPayload): ToolInput {
  const input = payload.tool_input;
  return input !== undefined && typeof input === "object" ? input : {};
}

/** The file a Write/Edit/FileChanged event is about, or "". */
export function filePathOf(payload: HookPayload): string {
  return toolInput(payload).file_path ?? payload.file_path ?? payload.path ?? "";
}

export function isWriteOrEdit(payload: HookPayload): boolean {
  return payload.tool_name === "Write" || payload.tool_name === "Edit";
}
