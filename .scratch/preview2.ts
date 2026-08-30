import { UiState } from "/Users/alanmartinez/tldr-experts-wt/wave-k-ui/src/core/ui/state.ts";
import { renderScene } from "/Users/alanmartinez/tldr-experts-wt/wave-k-ui/src/core/ui/scene.ts";
const t0 = Date.parse("2026-08-29T12:00:00.000Z");
const s = new UiState({ root: "/work/demo", ceilingUsd: 6, title: "how · 260829-tenancy · attempt 1", startedAt: t0, width: 44 });
s.apply({ kind: "tool", id: "a", name: "Bash", target: "bun test" }, t0 + 1000);
s.apply({ kind: "text", text: "Checking the outbox worker before I touch the schema. It looks fine." }, t0 + 2000);
for (const [cols, rows, now, tick] of [[80,24,t0+4000,3],[72,20,t0+4000,1],[100,26,t0+65000,7]] as const) {
  console.log(`--- ${cols}x${rows} tick=${tick} ---`);
  const f = renderScene(s.snapshot(now), { cols, rows, tick });
  console.log("|" + "=".repeat(cols) + "|");
  for (const l of f) console.log("|" + l.padEnd(cols) + "|");
  console.log("|" + "=".repeat(cols) + "|  rows=" + f.length);
}
