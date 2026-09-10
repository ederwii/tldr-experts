import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildModel, liveScript, renderDashboard, startDashboardServer, writeStaticDashboard,
  type DashboardServer,
} from "../src/core/dashboard/index.ts";
import { dashboardCommand } from "../src/cli/commands/dashboard.ts";
import { declaredFlags } from "../src/cli/helpText.ts";
import { EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { makeViewsWorkspace, VIEWS_NOW, VIEWS_RUN, type TempViews } from "./fixtures/views/tempViews.ts";
import { eventWaitMs, spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

/**
 * The live layer (#108): what the server pushes, when it declines to push, and
 * what the page does with it.
 *
 * Every server here binds port 0 and is closed in the same test that opened it,
 * and every stream is cancelled — a parked SSE reader would hang the run.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

interface Frame { readonly event: string; readonly data: string }

/**
 * Whatever `response.body.getReader()` actually gives us here.
 *
 * Bun's reader carries `readMany` and the DOM's does not, so naming either by
 * hand typechecks on one runtime and not the other; and `getReader` is
 * overloaded, so `ReturnType<...["getReader"]>` picks the BYOB overload whose
 * `read` demands a buffer. Going through an un-overloaded function gets the type
 * the call site actually produces.
 */
function bodyReader(response: Response) {
  return response.body!.getReader();
}
type BodyReader = ReturnType<typeof bodyReader>;

/**
 * A minimal SSE client.
 *
 * One outstanding `read()` at a time, deliberately: racing a fresh `read()`
 * against a timeout and abandoning the loser drops whatever chunk that loser
 * later receives, which turns "the event did not arrive" into a coin toss. The
 * pending read is shared, so a timed-out wait leaves the data in the buffer for
 * the next one.
 */
class Sse {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private readonly queue: Frame[] = [];
  private pending: Promise<boolean> | null = null;
  private ended = false;

  private constructor(private readonly reader: BodyReader) {}

  static async open(url: string): Promise<Sse> {
    const response = await fetch(`${url}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const sse = new Sse(bodyReader(response));
    expect(await sse.next("hello", eventWaitMs()), "the stream never said hello").not.toBeNull();
    return sse;
  }

  private pump(): Promise<boolean> {
    this.pending ??= this.reader.read().then((chunk) => {
      this.pending = null;
      if (chunk.done) {
        this.ended = true;
        return false;
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      this.split();
      return true;
    });
    return this.pending;
  }

  private split(): void {
    for (;;) {
      const cut = this.buffer.indexOf("\n\n");
      if (cut === -1) return;
      const raw = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      if (raw.startsWith(":")) continue; // a keep-alive comment, not an event
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      this.queue.push({ event, data });
    }
  }

  /** The next frame of this kind, or `null` once `ms` has passed without one. */
  async next(event: string, ms: number): Promise<Frame | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const at = this.queue.findIndex((frame) => frame.event === event);
      if (at !== -1) return this.queue.splice(at, 1)[0]!;
      if (this.ended) return null;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await Promise.race([this.pump(), sleep(left)]);
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

/** Everything one test opened, closed in the reverse order it was opened. */
const servers: DashboardServer[] = [];
const temps: TempViews[] = [];
const streams: Sse[] = [];

interface OwnOptions {
  readonly debounceMs?: number;
  readonly ageTickMs?: number;
  readonly sweepMs?: number;
  readonly watch?: "auto" | "poll";
}

async function ownServer(
  options: OwnOptions = {},
): Promise<{ server: DashboardServer; temp: TempViews; root: string }> {
  const temp = makeViewsWorkspace();
  temps.push(temp);
  const server = await startDashboardServer({
    root: temp.root,
    port: 0,
    debounceMs: options.debounceMs ?? 20,
    ageTickMs: options.ageTickMs,
    sweepMs: options.sweepMs,
    watch: options.watch,
  });
  servers.push(server);
  return { server, temp, root: temp.root };
}

function track(sse: Sse): Sse {
  streams.push(sse);
  return sse;
}

afterEach(async () => {
  while (streams.length > 0) await streams.pop()!.close();
  while (servers.length > 0) await servers.pop()!.close();
  while (temps.length > 0) temps.pop()!.dispose();
});

/**
 * One real ledger line.
 *
 * The shape matters: `ts` is the field `toStaleness` reads, and a line without
 * one changes nothing the page shows — which the server, correctly, declines to
 * push a reload for. An "event" the product does not recognise is not a test of
 * whether change reaches the browser.
 */
function appendEvent(runDir: string, at: string): void {
  appendFileSync(
    join(runDir, "events.jsonl"),
    `${JSON.stringify({
      ts: at,
      run: basename(runDir),
      stage: "how",
      type: "stage.started",
      actor: "facilitator",
      cost_usd: 0,
      payload: { phase: "02-how" },
    })}\n`,
    "utf8",
  );
}

/** Distinct, ordered stamps — one per appended line, so each one moves the model. */
function stampAt(minute: number): string {
  return `2026-09-01T15:${String(minute).padStart(2, "0")}:00Z`;
}

interface ReloadPayload {
  readonly at: string;
  readonly appended: number;
  readonly runs: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

describe("--serve is the flag the command declares", () => {
  test("`tldrx dashboard --serve` is a flag the CLI knows, not a typo it refuses", () => {
    expect(declaredFlags("dashboard").has("serve")).toBe(true);
  });

  test("--serve and --static together is a refusal, not a silent pick", async () => {
    const temp = makeViewsWorkspace();
    try {
      const code = await dashboardCommand.run(["--serve", "--static", "--root", temp.root]);
      expect(code).toBe(EXIT_USAGE);
    } finally {
      temp.dispose();
    }
  });
});

describe("what the server pushes, and what it declines to push", () => {
  test("a reload names what moved: the run, and how many events were appended", async () => {
    const { server, temp } = await ownServer();
    const sse = track(await Sse.open(server.url));

    appendEvent(temp.runDir, stampAt(1));
    const frame = await sse.next("reload", eventWaitMs());
    expect(frame, "no reload arrived for an appended event").not.toBeNull();

    const payload = JSON.parse(frame!.data) as ReloadPayload;
    expect(payload.appended).toBe(1);
    expect(payload.runs).toEqual([VIEWS_RUN]);
    expect(payload.added).toEqual([]);
    expect(payload.removed).toEqual([]);
    expect(Number.isNaN(Date.parse(payload.at))).toBe(false);
  }, spawnTestTimeout(45_000));

  /**
   * `tldrx dashboard --static` writes into `.tldrx/cache/`, which is inside the
   * watched tree and is read by nothing. Before the change was checked against
   * the model, exporting a page while serving one pushed a reload for every
   * write — the dashboard redrawing itself because it had been photographed.
   */
  test("a write the page does not read pushes nothing", async () => {
    const { server, root } = await ownServer();
    const sse = track(await Sse.open(server.url));

    const cache = join(root, ".tldrx", "cache", "dashboard");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "index.html"), "<!doctype html><p>a snapshot</p>\n", "utf8");

    expect(await sse.next("reload", eventWaitMs(2_000)), "a reload fired for a file nothing reads").toBeNull();
  }, spawnTestTimeout(45_000));

  test("the clock alone moves the page: an age tick arrives with nothing on disk changing", async () => {
    const { server } = await ownServer({ ageTickMs: 120 });
    const sse = track(await Sse.open(server.url));

    const before = (await (await fetch(`${server.url}/model.json`)).json()) as {
      runs: { ageSeconds: number }[];
    };
    const tick = await sse.next("age", eventWaitMs());
    expect(tick, "the stream never ticked, so a quiet run can never go quiet on screen").not.toBeNull();
    expect(Number.isNaN(Date.parse(tick!.data))).toBe(false);

    // The tick is only useful because the age is re-read, not frozen at boot.
    await sleep(1_100);
    const after = (await (await fetch(`${server.url}/model.json`)).json()) as {
      runs: { ageSeconds: number }[];
    };
    expect(after.runs[0]!.ageSeconds).toBeGreaterThan(before.runs[0]!.ageSeconds);
  }, spawnTestTimeout(45_000));
});

describe("runs appearing and disappearing while it watches", () => {
  test("a run created mid-serve is named in the reload and is on the next model", async () => {
    const { server, root } = await ownServer();
    const sse = track(await Sse.open(server.url));

    const fresh = join(root, "tldrx-work", "260902-arrived");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "run.yml"), "id: 260902-arrived\nstatus: open\nlevel: 1\n", "utf8");

    const frame = await sse.next("reload", eventWaitMs());
    expect(frame, "a new run pushed no reload").not.toBeNull();
    expect((JSON.parse(frame!.data) as ReloadPayload).added).toEqual(["260902-arrived"]);

    const model = (await (await fetch(`${server.url}/model.json`)).json()) as { runs: { id: string }[] };
    expect(model.runs.map((run) => run.id)).toContain("260902-arrived");
  }, spawnTestTimeout(45_000));

  test("a run deleted mid-serve is named removed, and the server keeps serving", async () => {
    const { server, root } = await ownServer();
    const sse = track(await Sse.open(server.url));

    const doomed = join(root, "tldrx-work", "260902-doomed");
    mkdirSync(doomed, { recursive: true });
    writeFileSync(join(doomed, "run.yml"), "id: 260902-doomed\nstatus: open\nlevel: 1\n", "utf8");
    expect(await sse.next("reload", eventWaitMs())).not.toBeNull();

    rmSync(doomed, { recursive: true, force: true });
    const frame = await sse.next("reload", eventWaitMs());
    expect(frame, "a deleted run pushed no reload").not.toBeNull();
    expect((JSON.parse(frame!.data) as ReloadPayload).removed).toEqual(["260902-doomed"]);

    const response = await fetch(`${server.url}/model.json`);
    expect(response.status, "the server died when a run was deleted under it").toBe(200);
    const model = (await response.json()) as { runs: { id: string }[] };
    expect(model.runs.map((run) => run.id)).not.toContain("260902-doomed");
  }, spawnTestTimeout(60_000));

  /**
   * The silent death: `tldrx-work/` removed and recreated leaves the recursive
   * watcher bound to an inode that no longer exists. It never errors and it is
   * never replaced, so the page stops updating and says nothing about it.
   */
  test("the work dir replaced wholesale does not leave a dead watcher behind", async () => {
    const { server, root } = await ownServer();
    const sse = track(await Sse.open(server.url));
    const work = join(root, "tldrx-work");

    rmSync(work, { recursive: true, force: true });
    expect(await sse.next("reload", eventWaitMs()), "removing the work dir pushed no reload").not.toBeNull();

    const back = join(work, "260903-again");
    mkdirSync(back, { recursive: true });
    writeFileSync(join(back, "run.yml"), "id: 260903-again\nstatus: open\nlevel: 1\n", "utf8");
    expect(await sse.next("reload", eventWaitMs()), "a run in the recreated work dir pushed no reload").not.toBeNull();

    // The one that actually proves the watcher was rebuilt: a write DEEP inside
    // the replacement, which no watcher on the root would ever see.
    appendEvent(back, stampAt(2));
    expect(
      await sse.next("reload", eventWaitMs()),
      "the watcher died with the old work dir — the page is silently stale",
    ).not.toBeNull();
  }, spawnTestTimeout(90_000));
});

/**
 * #213: what happens when the OS does not tell us.
 *
 * Measured while fixing #193 on a 14-core macOS box: with every deadline scaled,
 * the failures that remained were all directory create/remove events that never
 * arrived AT ALL — 113,942 ms and 82,556 ms with no frame — tracking `fseventsd`
 * at 98-115% CPU (`mdbulkimport` indexing) rather than load average. FSEvents
 * drops and coalesces under queue pressure, and `watchWorkspace` armed its mtime
 * sweep only in `poll` mode, so a dropped notification meant nothing fired,
 * nothing re-armed, and nothing ever swept: a live dashboard silently stale for
 * the life of the process, which is the exact failure this file exists to refuse.
 *
 * You cannot ask macOS to drop an event on demand, so the server exposes
 * `simulateWatcherLoss()` — it closes every `fs.watch` handle and leaves the
 * sweep alone, which is precisely what a dead or overwhelmed FSEvents stream
 * leaves behind. That is the seam; the assertion is the product's.
 */
describe("a notification the OS never delivers (#213)", () => {
  test("a change the watcher missed still reaches the page, by sweep", async () => {
    const { server, root } = await ownServer({ sweepMs: 150 });
    const sse = track(await Sse.open(server.url));

    // Every fs.watch handle is gone from here on: nothing will ever fire.
    server.simulateWatcherLoss();

    const fresh = join(root, "tldrx-work", "260904-unseen");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "run.yml"), "id: 260904-unseen\nstatus: open\nlevel: 1\n", "utf8");

    const frame = await sse.next("reload", eventWaitMs());
    expect(frame, "the watcher was gone and no sweep caught the change — the page is silently stale").not.toBeNull();
    expect((JSON.parse(frame!.data) as ReloadPayload).added).toEqual(["260904-unseen"]);
  }, spawnTestTimeout(45_000));

  /**
   * The other half: the sweep must not double-report what the watcher already
   * told us. One change is one reload frame, whichever path saw it first.
   *
   * A GUARD, not a proof, and measured to be one: it passes with the fix's
   * re-baseline removed, because `onChange`'s model-equality check already
   * refuses to push a page that would draw the same thing. Removing BOTH does
   * go red — but in `a write the page does not read pushes nothing`, not here.
   * So this pins the invariant against a future change that moves the equality
   * check; it did not prove the re-baseline. The re-baseline stays because it
   * stops the next sweep re-probing every change the watcher already handled,
   * which is work, not correctness.
   */
  test("the sweep and the watcher together still push exactly one reload per change", async () => {
    const { server, temp } = await ownServer({ sweepMs: 150 });
    const sse = track(await Sse.open(server.url));

    appendEvent(temp.runDir, stampAt(40));
    expect(await sse.next("reload", eventWaitMs()), "no reload for an appended event").not.toBeNull();
    expect(
      await sse.next("reload", eventWaitMs(1_500)),
      "the same change was pushed twice — the sweep re-reported what the watcher had",
    ).toBeNull();
  }, spawnTestTimeout(45_000));
});

describe("the live client, and the static page that must not carry it", () => {
  test("the live script listens for both a file change and a clock tick", () => {
    const live = liveScript();
    expect(live).toContain('stream.addEventListener("reload", repaint)');
    expect(live).toContain('stream.addEventListener("age", repaint)');
  });

  /**
   * A repaint replaces `#main` wholesale, so the card the reader had focused
   * with j/k stops existing. Scroll and open panels are already restored by
   * `DASHBOARD_JS`; focus is the live layer's to keep, because only the live
   * layer redraws a page nobody asked to redraw.
   */
  test("a repaint puts the reader's focus back where it was", () => {
    const live = liveScript();
    expect(live).toContain('[data-nav="1"]');
    expect(live).toContain("document.activeElement");
    expect(live).toContain(".focus()");
  });

  /**
   * The static export is a snapshot. It has no server to listen to, and a page
   * that tries anyway is a page making requests from a `file://` origin.
   */
  test("--static ships no listener, no fetch and no stream", () => {
    const temp = makeViewsWorkspace();
    try {
      const out = join(temp.root, "out");
      writeStaticDashboard(temp.root, out, "2026-09-01T12:00:00Z", VIEWS_NOW);
      const html = readFileSync(join(out, "index.html"), "utf8");
      for (const marker of ["EventSource", "/events", "/model.json", 'addEventListener("age"']) {
        expect(html, `the static export carries ${marker}`).not.toContain(marker);
      }
    } finally {
      temp.dispose();
    }
  });

  /**
   * The byte pin.
   *
   * The live layer is allowed to change the live page and nothing else, so this
   * hashes the export of a fixed model against the digest `main` produces
   * WITHOUT it — a stray character added to `DASHBOARD_JS`, `render.ts`,
   * `styles.ts` or the model then fails here rather than in somebody's diff
   * review. Changing the static page is allowed; changing it BY ACCIDENT is what
   * this stops, so re-pin deliberately, in the commit that means to, and say
   * what moved.
   *
   * Measured twice on 2026-09-02 and equal both times: `23ba056` (main, before
   * #108) and that branch both rendered 120,818 bytes hashing to `b71d521c…`. The
   * first pin taken for #108 was `be3e7bfa…` at `e68d0af`; #118 landed
   * `startedAt`/`endedAt`/`gateNote` on `StageRowModel` in between, which is a
   * model change and moves the export by design.
   *
   * RE-PINNED 2026-09-02 for #122, deliberately: 120,818 → 121,707 bytes,
   * `b71d521c…` → `14b3b6eb…`. Two model fields (`gateExecutedBy`,
   * `gateAuthority`, null on this fixture) and one more serialised renderer
   * function (`dashSignature`) — the same class of move as #118's, and the +889
   * bytes are almost entirely that function's source riding to the browser.
   *
   * RE-PINNED 2026-09-06 for #165, deliberately: 121,707 → 121,743 bytes,
   * `14b3b6eb…` → `70fcc986…`. `dashPreflightSection` draws an absent exit code
   * as `REFUSED` instead of `String(null)` — a base gate the workspace REFUSED
   * to run has no exit code, and the page carries the absence. The delta is
   * attributed rather than assumed: measured on this branch,
   * `dashPreflightSection.toString()` went 1,749 → 1,785 bytes — exactly the
   * +36 above, so nothing else moved. (Comments are stripped before the source
   * rides to the browser; measured `has comment: false` on the same probe.)
   *
   * The marker moved once more inside the same change, `not run` → `REFUSED`
   * (fix round 1), which is why the hash here is not the one the first pass
   * recorded. Both strings are seven characters, so the BYTE count did not move
   * — measured, `dashPreflightSection.toString()` is 1,785 either way. That is
   * also the reason this pin cannot stand in for a semantic one: it would have
   * passed just as happily if the cell drew `0`. The test that would not is
   * `test/dashboard-leftovers.test.ts`'s "the page draws REFUSED for it,
   * never a 0".
   *
   * RE-PINNED 2026-09-07 for #170, deliberately: 121,743 → 121,912 bytes,
   * `70fcc986…` → `d35af636…`. Four ADDITIVE model fields — `authorizedUsd`,
   * `authorizedBy` and `onGrantExceed` on `BudgetModel`, `authorizedUsd` on
   * `BudgetPhaseModel` — all absent on this fixture, and the page embeds the
   * model as JSON. The delta is attributed rather than assumed: measured on this
   * branch, the run-level trio serialises to 64 bytes
   * (`"authorizedUsd":null,"authorizedBy":null,"onGrantExceed":"warn",`) and the
   * five phase rows to 5 × 21 = 105 (`"authorizedUsd":null,`) — 169 exactly, so
   * nothing else moved. No renderer function changed, and
   * `DASHBOARD_MODEL_VERSION` stays 3: additions never bump it.
   *
   * RE-PINNED 2026-09-07 again for #183 and defect 3 of the same audit:
   * 121,912 → 121,982 bytes, `d35af636…` → `306d1023…`. Attributed exactly, by
   * diffing this fixture's page rendered on `origin/main` against the same page
   * rendered here — five opcodes, no sixth:
   *
   *   + 82  three additive `RunModel` fields serialised into the embedded model:
   *         `"spentFigure":"$5.01","createdWith":"not recorded",`
   *         `"lastWrittenBy":"not recorded",` (one run in this fixture)
   *   − 12  `dashSpendText` and `dashHeroSpend` now read `run.spentFigure`
   *         instead of `dashUsd(run.spentUsd)` — 6 bytes shorter each, and it
   *         shows up in the PAGE because both functions cross into the browser
   *         through `Function.prototype.toString()`, source and all
   *
   * Net +70. The rendered TEXT is unchanged on this fixture: it has no unmetered
   * turn, so `spentFigure` is the plain `$5.01` `dashUsd` produced. That is the
   * guard half of the change working — a fully metered run keeps its figure.
   * `DASHBOARD_MODEL_VERSION` stays 3.
   *
   * **+15 for #210**: `,"outcome":null` — the run's delivery, embedded in the
   * model the page carries. `null` and not a sentence because the fixture's run
   * is still OPEN: a live run has no outcome to report and has not failed to
   * record one. `DASHBOARD_MODEL_VERSION` still stays 3 — additions do not bump
   * it (§7) — and the rendered TEXT is unchanged, since a null outcome draws
   * nothing.
   */
  test("--static is byte-identical to the export main renders without the live layer", () => {
    const temp = makeViewsWorkspace();
    try {
      // The tmpdir path is the one part of the model that is not the fixture's,
      // so it is normalised away; everything else is the fixture, byte for byte.
      const model = {
        ...buildModel(temp.root, "2026-09-01T12:00:00Z", { now: VIEWS_NOW }),
        root: "/w",
        workspace: "views",
      };
      const html = renderDashboard(model);
      expect(model.live, "the static model is not a live one").toBe(false);
      expect(Buffer.byteLength(html, "utf8")).toBe(121_997);
      expect(createHash("sha256").update(html, "utf8").digest("hex"))
        .toBe("f18e4702dae1cf0d028a5d63d46e089bb4dff08944617eb824a860ee1f204e6c");
    } finally {
      temp.dispose();
    }
  });
});

/** The existing suite's fixture, kept alive for the two tests that share one. */
let shared: TempViews;
let sharedServer: DashboardServer;

beforeAll(async () => {
  shared = makeViewsWorkspace();
  sharedServer = await startDashboardServer({ root: shared.root, port: 0, debounceMs: 20 });
});

afterAll(async () => {
  await sharedServer.close();
  shared.dispose();
});

describe("the burst a wave writes is one reload, not twelve", () => {
  test("twelve files written at once collapse into a single push", async () => {
    const sse = await Sse.open(sharedServer.url);
    try {
      for (let i = 0; i < 12; i++) appendEvent(shared.runDir, stampAt(20 + i));
      expect(await sse.next("reload", eventWaitMs())).not.toBeNull();
      expect(await sse.next("reload", eventWaitMs(800)), "the burst was pushed more than once").toBeNull();
    } finally {
      await sse.close();
    }
  }, spawnTestTimeout(45_000));
});
