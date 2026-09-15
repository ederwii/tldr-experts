/**
 * The run-level fix-list sweep: re-check every still-open finding against the
 * EPIC tip, once the whole run's stories have landed (#163, sub-fix 2).
 *
 * ## What it is for
 *
 * Measured, transcript N (2026-09-05, a Next.js workspace, L358). At a Build gate
 * all 6 `fix-now` findings carried a resolving sha and the 3 `defer-with-log`
 * entries read `Resolved: no` — "correct PER STORY", in the host agent's own
 * words. Two of those three defects had in fact been closed later in the same run
 * by a DIFFERENT story, which the host verified by reading the code. Exactly one
 * finding had genuinely shipped unfixed. The record could not tell those two
 * apart, so a human narrated the difference by hand at the gate.
 *
 * The reason the record could not is structural: `verifyResolutions` asks whether
 * a claim's sha is reachable from the STORY's own branch, and it asks it at the
 * moment that story settles. A fix that lands later, on another story's branch,
 * and reaches the epic through a merge, is not on this story's branch and did not
 * exist when the question was asked. There is no third answer for it, so it was
 * recorded as the second: `claimed-unverified`, or `no`.
 *
 * ## The rule this obeys
 *
 * A finding is RE-MARKED only when a sha the record already names turns out to be
 * reachable from the epic tip. Never on inference, never on "the file changed",
 * never on a heading that looks like another story's work. §7 — an audit record
 * may not lie in either direction, and "this defect is closed" is the expensive
 * direction to be wrong in.
 *
 * What that buys, precisely: the claim that `verifyResolutions` had to withdraw
 * because it pointed off-branch is REINSTATED, as what it actually is.
 *
 * ## The weaker question, asked separately and never as a close
 *
 * That is not enough on its own, and it is worth saying why out loud. Transcript
 * N's three entries named NO commit — nobody had claimed one — so a sweep that
 * only re-checks named shas has nothing to say about the exact findings a human
 * had to read the code for. So a finding nothing evidenced a close for is asked
 * the question that human started with: did a commit on the EPIC, and not on this
 * story's own branch, CHANGE the file this finding cites?
 *
 * The answer is recorded and it resolves nothing. A changed file is not a fixed
 * defect; writing `Resolved: yes` off one would be the same lie the sweep exists
 * to stop, arrived at from the other side. So `touched` is a separate field from
 * `closed`, its `Swept:` sentence says in words that it is not a close, and the
 * verdict word on the line does not move. What it replaces is a person grepping
 * the run's commits by hand at the gate — not a person's judgement about them.
 *
 * A finding whose record names no commit AND whose file nobody else changed stays
 * open, and says so: a `Swept:` line naming what was measured is the difference
 * between a `Resolved: no` checked against the whole run and one that only ever
 * meant "correct per story".
 *
 * ## The two kinds of close are spelled apart
 *
 * `Resolved: yes <sha>` is the story's own close. `Resolved: yes-on-epic <sha>`
 * is a close a LATER story landed. They are different facts about who owns the
 * fix and where it lives, and flattening them into one word is exactly what made
 * the gate unreadable. `yes-on-epic` is not `yes`, so `parseFixlistFile` reads it
 * with `resolved: false` and `isOpen` holds the story exactly as it did before —
 * this sweep RECORDS, and changes nothing a gate decides.
 *
 * ## Bounded, and never silently skipped
 *
 * At most two `shaReachability` calls and one `canonicalSha` per CANDIDATE
 * finding, plus one `git log` capped at `TOUCHING_SCAN_MAX` commits for the ones
 * no close was evidenced for; a candidate is a finding that is not already closed
 * with evidence. Everything else is one `fullShaOf` for the epic tip. A run with
 * no open findings runs no git at all. When the tip cannot be
 * resolved — no epic branch was recorded, the branch was never cut, the repo is
 * not there — nothing is swept and every examined finding says so by name (§7,
 * absent-with-reason); a clean sweep is never reported over a sweep that did not
 * happen.
 *
 * The derivations are reused, not rebuilt (§7): `shaReachability`, `canonicalSha`
 * and `commitsTouching` from `git.ts`, `readResolvedSha`'s grammar through
 * `parseFixlistFile`'s `claimedSha`, `parseSrcToken` for the one `[src:]` grammar,
 * and `markSwept` for the text edit beside its siblings in `fixlist.ts`.
 */
import { CLOSED_ON_EPIC, markSwept, type FixFinding, type FixlistOnDisk } from "./fixlist.ts";
import { canonicalSha, commitsTouching, fullShaOf, shaReachability } from "./git.ts";
import { parseSrcToken } from "../text/srcToken.ts";

/** Everything the sweep needs about ONE story — data, never a session (§12). */
export interface SweepScope {
  readonly storyId: string;
  /** The workspace repo name, for a sentence a human can act on. */
  readonly repo: string;
  readonly repoDir: string;
  /** The story's own branch — the reachability `verifyResolutions` already asked. */
  readonly branch: string;
  /** The epic every story in this run merges into. `""` when none was recorded. */
  readonly epicBranch: string;
}

/** One finding this sweep found a LATER story's close for. */
export interface SweptClose {
  readonly n: number;
  /** The full 40-hex object id, canonicalised — never the abbreviation. */
  readonly sha: string;
}

/**
 * One still-open finding whose cited FILE a later story in this run changed.
 *
 * Evidence, not a close, and the two must never collapse into each other: the
 * commits here changed the file the finding points at, which is where the human
 * at transcript N's gate STARTED reading — not where they finished. A caller that
 * turned this into `Resolved: yes` would be asserting a fix from a diff nobody
 * read, which is §7's dangerous direction exactly.
 */
export interface TouchedHint {
  readonly n: number;
  /** The repo-relative path from the finding's own `[src:]` citation. */
  readonly path: string;
  /** Newest first, capped by `TOUCHING_SCAN_MAX`. Never empty — no hint is recorded for none. */
  readonly commits: readonly string[];
}

/**
 * One still-open finding whose later-change probe git REFUSED to answer (#163).
 *
 * Told apart from "nothing touched it" on purpose, and this is the whole point of
 * the distinction: an unresolvable story ref and a file nobody changed produce the
 * same empty list, and only one of them is a measurement. §7 — a value that cannot
 * be derived is named with WHY, never reported as a confident zero.
 */
export interface UnmeasuredProbe {
  readonly n: number;
  readonly path: string;
  /** git's own words. Never blank. */
  readonly reason: string;
}

export interface SweepOutcome {
  readonly storyId: string;
  /** Run-relative path of the fix list, the spelling every other bullet cites. */
  readonly rel: string;
  /** The epic tip this was measured against, or null when it could not be read. */
  readonly epicTip: string | null;
  readonly closed: readonly SweptClose[];
  /**
   * The findings still open whose cited file a LATER story changed (#163).
   *
   * Kept apart from `closed` because it is a weaker fact by design: `closed` is
   * "a commit this record names is on the epic and not on this branch", `touched`
   * is "somebody else changed this file". One resolves a finding, the other only
   * tells a person where to look — and the whole defect this sweep exists for was
   * two facts of different strengths being written down with the same word.
   */
  readonly touched: readonly TouchedHint[];
  /**
   * The findings whose later-change probe git would not answer (#163).
   *
   * Not folded into `touched` (which is evidence) nor into `absence` (which is the
   * WHOLE sweep failing): this is one finding's one question going unanswered while
   * the rest of the sweep measured fine, and a reader has to be able to see exactly
   * that much missing rather than all of it or none.
   */
  readonly unmeasured: readonly UnmeasuredProbe[];
  /** How many findings were LOOKED at — the denominator of `closed`. */
  readonly examined: number;
  /**
   * Why no sweep could be taken, or null when one was.
   *
   * Never blank and never inferred. A caller that reports a clean sweep over a
   * non-null `absence` is reporting a measurement nobody took.
   */
  readonly absence: string | null;
}

/**
 * A finding is a CANDIDATE when nothing has closed it with evidence yet.
 *
 * The same clause `isOpen` and `carriedFindings` both spend, and deliberately
 * neither of them: those two answer "does this hold a story" and "does somebody
 * owe this", which are routing questions. This one is "is there still a close to
 * look for", and it is true for a `fix-now` and a `defer-with-log` alike — the
 * findings transcript N got wrong were `defer-with-log`.
 */
function isCandidate(finding: FixFinding): boolean {
  return !(finding.resolved && finding.resolvedSha !== null);
}

export async function sweepFixlistAgainstEpic(
  scope: SweepScope,
  fixlist: FixlistOnDisk,
  text: string,
  at: string,
): Promise<{ text: string | null; outcome: SweepOutcome }> {
  const candidates = fixlist.findings.filter(isCandidate);
  const base = { storyId: scope.storyId, rel: fixlist.rel };
  if (candidates.length === 0) {
    return {
      text: null,
      outcome: {
        ...base, epicTip: null, closed: [], touched: [], unmeasured: [], examined: 0, absence: null,
      },
    };
  }

  const { tip, absence } = await epicTipOf(scope);
  if (absence !== null) {
    let body = text;
    for (const finding of candidates) {
      body = markSwept(body, finding.n, { resolved: null, swept: `${at} — not taken: ${absence}` });
    }
    return {
      text: body === text ? null : body,
      outcome: {
        ...base, epicTip: null, closed: [], touched: [], unmeasured: [], examined: candidates.length,
        absence,
      },
    };
  }

  const against = `swept against \`${scope.epicBranch}\` @ ${tip}`;
  const closed: SweptClose[] = [];
  const touched: TouchedHint[] = [];
  const unmeasured: UnmeasuredProbe[] = [];
  let body = text;
  for (const finding of candidates) {
    const mark = await markFor(scope, finding, at, against, tip);
    if (mark.close !== null) closed.push(mark.close);
    if (mark.touch !== null) touched.push(mark.touch);
    if (mark.unmeasured !== null) unmeasured.push(mark.unmeasured);
    body = markSwept(body, finding.n, mark.mark);
  }
  return {
    text: body === text ? null : body,
    outcome: {
      ...base, epicTip: tip, closed, touched, unmeasured, examined: candidates.length, absence: null,
    },
  };
}

/**
 * The tip to measure against, or WHY there is none. One `rev-parse`, one answer.
 *
 * Both fields, rather than a throw or a bare `""`: the caller has to be able to
 * write the reason down, and a sweep that reports nothing because it measured
 * nothing must not read like a sweep that measured and found nothing.
 */
async function epicTipOf(scope: SweepScope): Promise<{ tip: string; absence: string | null }> {
  if (scope.epicBranch === "") {
    return {
      tip: "",
      absence: `no epic branch was recorded for ${scope.storyId}, so there is no tip to re-check its `
        + "findings against — a defect a later story closed would still read open here",
    };
  }
  const tip = await fullShaOf(scope.repoDir, scope.epicBranch);
  if (tip === "") {
    return {
      tip: "",
      absence: `\`${scope.epicBranch}\` could not be resolved to a commit in repo ${scope.repo}, so `
        + "no run-level re-check was taken — this is not a clean sweep, it is no sweep",
    };
  }
  return { tip, absence: null };
}

/** One finding's sweep result: the line to write, the close and the hint it evidences. */
type Mark = {
  mark: { resolved: string | null; swept: string };
  close: SweptClose | null;
  touch: TouchedHint | null;
  /** Set only when git refused the later-change probe — never beside a `touch`. */
  unmeasured: UnmeasuredProbe | null;
};

async function markFor(
  scope: SweepScope,
  finding: FixFinding,
  at: string,
  against: string,
  tip: string,
): Promise<Mark> {
  const sha = finding.claimedSha;
  if (sha === null) {
    return await stillOpen(scope, finding, at, against, "this finding's record names no commit, so "
      + "no commit could be checked");
  }
  // The story's OWN branch first, always. A close this story landed is this
  // story's close, and re-spelling it as an epic close would flatten the two
  // facts in the other direction — which is the same lie, mirrored.
  if (await shaReachability(scope.repoDir, sha, scope.branch) === "reachable") {
    return {
      mark: {
        resolved: null,
        swept: `${at} — ${against}: \`${sha}\` is reachable from \`${scope.branch}\`, so this is `
          + `${scope.storyId}'s own close and not a later story's`,
      },
      close: null,
      touch: null,
      unmeasured: null,
    };
  }
  const onEpic = await shaReachability(scope.repoDir, sha, scope.epicBranch);
  if (onEpic !== "reachable") {
    return await stillOpen(scope, finding, at, against, `\`${sha}\` is `
      + (onEpic === "absent"
        ? `not a commit in repo ${scope.repo}`
        : `a commit, and it is not reachable from \`${scope.epicBranch}\``)
      + ", so nothing here evidences a close");
  }
  // Records name one commit, never a prefix of one (#130 follow-up): the same
  // canonicalisation `canonicalizeResolutions` applies to a claim that verified.
  const full = await canonicalSha(scope.repoDir, sha) ?? sha;
  return {
    mark: {
      resolved: `${CLOSED_ON_EPIC} ${full} — closed on \`${scope.epicBranch}\` @ ${tip}`,
      swept: `${at} — ${against}: \`${full}\` is reachable from \`${scope.epicBranch}\` and NOT from `
        + `\`${scope.branch}\`, so a later story in this run closed this, not ${scope.storyId}`,
    },
    close: { n: finding.n, sha: full },
    touch: null,
    unmeasured: null,
  };
}

/**
 * A finding nothing evidenced a close for — and the weaker question that is worth
 * asking anyway: did a LATER story change the file it cites (#163)?
 *
 * This is the half that reaches transcript N's actual case. Those three
 * `defer-with-log` entries named no commit at all, because nobody had claimed one;
 * a sweep that only re-checks shas the record already names has nothing to say
 * about them, and they are exactly the findings a human had to read the code for.
 *
 * What comes back is named, never resolved. `mark.resolved` stays null on every
 * path through here, so the verdict word does not move and no gate outcome does
 * either — a changed file is not a fixed defect, and the one direction §7 refuses
 * to be wrong in is "this defect is gone".
 */
async function stillOpen(
  scope: SweepScope,
  finding: FixFinding,
  at: string,
  against: string,
  why: string,
): Promise<Mark> {
  const path = citedPath(scope, finding);
  if (path === null) {
    return {
      mark: {
        resolved: null,
        swept: `${at} — ${against}: ${why}, and this finding cites no file in repo ${scope.repo}, so `
          + "no later change to it could be looked for either — the finding stays open",
      },
      close: null,
      touch: null,
      unmeasured: null,
    };
  }
  const scan = await commitsTouching(scope.repoDir, path, scope.epicBranch, scope.branch);
  // A question git REFUSED is not a question that came back empty, and the two may
  // not share a sentence: "no later commit changed this" over an unresolvable ref
  // would be a measurement nobody took, written in the words of one that was (§7).
  if (scan.error !== null) {
    return {
      mark: {
        resolved: null,
        swept: `${at} — ${against}: ${why}, and whether a later commit on \`${scope.epicBranch}\` `
          + `changed \`${path}\` outside \`${scope.branch}\` could not be measured — git refused the `
          + `question: ${scan.error}. The finding stays open, and this is not a clean probe`,
      },
      close: null,
      touch: null,
      unmeasured: { n: finding.n, path, reason: scan.error },
    };
  }
  if (scan.commits.length === 0) {
    return {
      mark: {
        resolved: null,
        swept: `${at} — ${against}: ${why}, and no later commit on \`${scope.epicBranch}\` changed `
          + `\`${path}\` outside \`${scope.branch}\` — the finding stays open`,
      },
      close: null,
      touch: null,
      unmeasured: null,
    };
  }
  return {
    mark: {
      resolved: null,
      swept: `${at} — ${against}: ${why}, BUT a later commit on \`${scope.epicBranch}\` changed `
        + `\`${path}\` outside \`${scope.branch}\`: ${scan.commits.map((sha) => `\`${sha}\``).join(", ")} — `
        + "a changed file is not a closed defect, so this is recorded and not resolved, and a person "
        + "decides whether the work is still owed",
    },
    close: null,
    touch: { n: finding.n, path, commits: scan.commits },
    unmeasured: null,
  };
}

/**
 * The repo-relative path this finding's `Where:` cites, IN THIS STORY'S REPO, or
 * null with nothing guessed.
 *
 * Repo-then-path, the rule `unownedFindings.ts` already states and for the same
 * reason: a finding at `api:src/db.ts` is not a finding about the `lab` checkout
 * this sweep happens to hold, and probing the wrong repo would name commits that
 * have nothing to do with it. The `[src:]` grammar is read through `parseSrcToken`
 * and nowhere else (§7, one implementation).
 */
function citedPath(scope: SweepScope, finding: FixFinding): string | null {
  const token = parseSrcToken(finding.where, new Set([scope.repo]));
  const file = token?.refs.find((ref) => ref.kind === "file") ?? null;
  if (file === null || file.kind !== "file") return null;
  return file.repo === scope.repo ? file.path : null;
}
