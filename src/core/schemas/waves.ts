/**
 * Schema for `tldrx-work/<run>/03-plan/waves.yml` (spec §2.15).
 *
 * Concept §9: "stories grouped by dependency; wave N+1 starts only when wave N's
 * epic branch is green", and "independent stories in the same wave run as parallel
 * sub-agents in separate worktrees". Both sentences make the same demand of this
 * file, and it is the one rule the shape cannot enforce on its own:
 *
 *   **every story a wave runs must have all of its `depends_on` in an EARLIER wave.**
 *
 * A dependency inside the same wave is the interesting failure — the two stories
 * would be handed to parallel agents that overwrite each other — so it is an error,
 * not a warning.
 */
import {
  asDocument, isRecord, requireArray, requireKeys, result,
  type ValidationIssue, type ValidationResult,
} from "./validation.ts";
import {
  MAX_PLAN_STORIES, MAX_STORIES_PER_WAVE, MAX_WAVES, STORY_ID_RE, WAVE_ID_RE,
  requirePattern, requireStringList, requireVersion1,
} from "./planCommon.ts";

export interface Wave {
  readonly id: string;
  readonly stories: readonly string[];
}

export interface WavesFile {
  readonly version: number;
  readonly waves: readonly Wave[];
}

/** Shape only: ids, uniqueness, ordering of the wave numbers, caps. */
export function validateWaves(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, ["version", "waves"], "", issues);
  requireVersion1(doc, issues);
  if (!requireArray(doc.waves, "waves", issues)) return result(issues);

  const waves = doc.waves as unknown[];
  if (waves.length === 0) issues.push({ path: "waves", message: "must not be empty" });
  if (waves.length > MAX_WAVES) {
    issues.push({ path: "waves", message: `${waves.length} waves exceeds the ${MAX_WAVES} cap` });
  }

  const seenWave = new Set<string>();
  const seenStory = new Map<string, string>();
  let previousNumber = 0;
  let total = 0;

  waves.forEach((wave, i) => {
    const path = `waves[${i}]`;
    if (!isRecord(wave)) {
      issues.push({ path, message: "expected a mapping" });
      return;
    }
    requireKeys(wave, ["id", "stories"], path, issues);
    requirePattern(wave.id, WAVE_ID_RE, "a wave id like `W1`", `${path}.id`, issues);

    if (typeof wave.id === "string" && WAVE_ID_RE.test(wave.id)) {
      if (seenWave.has(wave.id)) {
        issues.push({ path: `${path}.id`, message: `\`${wave.id}\` is listed twice` });
      }
      seenWave.add(wave.id);
      const number = Number(wave.id.slice(1));
      // The file order IS the execution order, so a W2 before a W1 would read one
      // way and run the other. Ascending ids keep the two the same thing.
      if (number <= previousNumber) {
        issues.push({
          path: `${path}.id`,
          message: `\`${wave.id}\` comes after \`W${String(previousNumber)}\` — waves are listed in execution order, so ids ascend`,
        });
      }
      previousNumber = Math.max(previousNumber, number);
    }

    const stories = requireStringList(wave.stories, `${path}.stories`, issues, {
      nonEmpty: true, max: MAX_STORIES_PER_WAVE,
      pattern: STORY_ID_RE, patternName: "a story id like `S3`", unique: true,
    });
    total += stories.length;
    const waveId = typeof wave.id === "string" ? wave.id : path;
    for (const story of stories) {
      const already = seenStory.get(story);
      if (already !== undefined) {
        issues.push({
          path: `${path}.stories`,
          message: `\`${story}\` is already scheduled in ${already} — a story runs in exactly one wave`,
        });
        continue;
      }
      seenStory.set(story, waveId);
    }
  });

  if (total > MAX_PLAN_STORIES) {
    issues.push({ path: "waves", message: `${total} scheduled stories exceeds the ${MAX_PLAN_STORIES} cap` });
  }
  return result(issues);
}

export function asWavesFile(input: unknown): WavesFile {
  const doc = input as Partial<WavesFile>;
  return { version: doc.version ?? 1, waves: doc.waves ?? [] };
}

/** story id -> the wave it runs in, in file order. */
export function scheduleOf(file: WavesFile): ReadonlyMap<string, number> {
  const at = new Map<string, number>();
  file.waves.forEach((wave, index) => {
    for (const story of wave.stories) if (!at.has(story)) at.set(story, index);
  });
  return at;
}

/**
 * The cross-file half: every `depends_on` must land in an earlier wave.
 *
 * `dependsOn` is story id -> its `depends_on` list, read from the story files.
 * A story that is scheduled but has no entry is simply not checked — a missing
 * story file is the story validator's error to report, not this one's.
 */
export function validateWaveOrder(
  file: WavesFile,
  dependsOn: ReadonlyMap<string, readonly string[]>,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = scheduleOf(file);

  file.waves.forEach((wave, index) => {
    wave.stories.forEach((story, i) => {
      const deps = dependsOn.get(story);
      if (deps === undefined) return;
      const path = `waves[${index}].stories[${i}]`;
      for (const dep of deps) {
        const depIndex = at.get(dep);
        if (depIndex === undefined) {
          issues.push({
            path,
            message: `${story} depends on ${dep}, which no wave runs — add it to a wave before ${wave.id}`,
          });
          continue;
        }
        if (depIndex === index) {
          issues.push({
            path,
            message: `${story} depends on ${dep}, which runs in the same wave (${wave.id}) — ` +
              "a wave's stories run in parallel, so a dependency must be in an earlier wave",
          });
          continue;
        }
        if (depIndex > index) {
          const later = file.waves[depIndex]?.id ?? `waves[${depIndex}]`;
          issues.push({
            path,
            message: `${story} runs in ${wave.id} but depends on ${dep}, which runs later in ${later} — ` +
              "a dependency must be in an earlier wave",
          });
        }
      }
    });
  });
  return issues;
}
