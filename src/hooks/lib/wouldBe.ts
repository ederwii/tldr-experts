/**
 * The would-be content of a file (spec §4).
 *
 * Only PreToolUse can block, so a gating hook must judge the file the tool is
 * ABOUT to write: for Write that is `tool_input.content`; for Edit it is the file
 * on disk with `old_string` replaced by `new_string`. When `old_string` is not in
 * the file, the hook allows — the Edit tool will fail on its own, and a hook must
 * not invent a second failure mode.
 */
import { existsSync, readFileSync } from "node:fs";
import { toolInput, type HookPayload } from "./payload.ts";

export type WouldBe =
  | { readonly kind: "content"; readonly text: string }
  | { readonly kind: "not-applicable"; readonly why: string };

export function wouldBeContent(payload: HookPayload, filePath: string): WouldBe {
  const input = toolInput(payload);
  if (payload.tool_name === "Write") {
    return typeof input.content === "string"
      ? { kind: "content", text: input.content }
      : { kind: "not-applicable", why: "Write payload carried no content" };
  }
  if (payload.tool_name === "Edit") {
    const oldString = input.old_string;
    const newString = input.new_string;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return { kind: "not-applicable", why: "Edit payload carried no old_string/new_string" };
    }
    if (!existsSync(filePath)) {
      return { kind: "not-applicable", why: "Edit target does not exist yet" };
    }
    if (oldString === "") {
      return { kind: "not-applicable", why: "Edit payload carried an empty old_string" };
    }
    const current = readFileSync(filePath, "utf8");
    const at = current.indexOf(oldString);
    if (at === -1) {
      return { kind: "not-applicable", why: "old_string is not in the file; the Edit will fail on its own" };
    }
    // split/join, never String.replace — a `$&` in new_string is literal text, not a pattern.
    const text = input.replace_all === true
      ? current.split(oldString).join(newString)
      : current.slice(0, at) + newString + current.slice(at + oldString.length);
    return { kind: "content", text };
  }
  return { kind: "not-applicable", why: `tool ${String(payload.tool_name)} does not write files` };
}
