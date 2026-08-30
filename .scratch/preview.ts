import { UiState } from "/Users/alanmartinez/tldr-experts-wt/wave-k-ui/src/core/ui/state.ts";
import { renderScene } from "/Users/alanmartinez/tldr-experts-wt/wave-k-ui/src/core/ui/scene.ts";
import type { AgentEvent } from "/Users/alanmartinez/tldr-experts-wt/wave-k-ui/src/core/facilitator/agentEvents.ts";

const t0 = Date.parse("2026-08-29T12:00:00.000Z");
const s = new UiState({ root: "/work/demo", ceilingUsd: 6, title: "what · 260829-tenancy · attempt 1", startedAt: t0, width: 44 });
const events: [AgentEvent, number][] = [
  [{ kind: "start", model: "claude-fable-5-20260501", sessionId: "s1" }, t0 + 500],
  [{ kind: "tool", id: "a", name: "Read", target: "/work/demo/src/core/Tenancy.cs" }, t0 + 1200],
  [{ kind: "tool-done", id: "a", name: "Read", ok: true, ms: 30 }, t0 + 1300],
  [{ kind: "tool", id: "b", name: "Grep", target: "Outbox" }, t0 + 2000],
  [{ kind: "tool-done", id: "b", name: "Grep", ok: true, ms: 120 }, t0 + 2200],
  [{ kind: "text", text: "The tenancy boundary is the row filter, not the schema. I will check the tests next." }, t0 + 3000],
  [{ kind: "tool", id: "c", name: "Bash", target: "dotnet test tests/Unit" }, t0 + 3500],
  [{ kind: "tool-done", id: "c", name: "Bash", ok: true, ms: 12400 }, t0 + 16000],
  [{ kind: "tool", id: "d", name: "Write", target: "/work/demo/tldrx-work/260829-tenancy/01-what/handoff.md" }, t0 + 17000],
];
for (const [e, at] of events) s.apply(e, at);
const now = t0 + 221 * 1000;
const frame = renderScene(s.snapshot(now), { cols: 80, rows: 24, tick: 5 });
console.log("|" + "-".repeat(80) + "|");
for (const line of frame) console.log("|" + line.padEnd(80) + "|");
console.log("|" + "-".repeat(80) + "|");
console.log("rows:", frame.length);
