/**
 * The contracts a stage's `checks:` enforce, spliced into that stage's prompt
 * (gh #35, gh #38).
 *
 * The pattern behind three issues in two days — #35 (front-matter schema), #36
 * (review verdict enum), #38 (the list caps) — is one sentence: **the contract
 * the checker enforces is not the contract the prompt states.** A stage declares
 * `checks: [plan]`, the check parses four files against ~200 lines of validator,
 * and the sub-agent is handed a `stage.md` that names the output FILENAMES. The
 * shape is then discovered by failing, once per fresh workspace, at the price of
 * a paid attempt.
 *
 * So a check may publish its own contract, and the facilitator splices it in
 * under an H2 the framework owns. Two rules keep this from becoming another
 * place for a schema to drift:
 *
 *   - the body is GENERATED from the validator's own constants, never written
 *     out here (see `plan/schemaContract.ts`);
 *   - it is emitted only for a stage the check actually runs on, so a What or
 *     How prompt pays nothing for a schema it will never write.
 *
 * It goes into `stage.md` rather than after the inputs on purpose: `prompt.ts`
 * orders the document most-stable-first for the prompt cache, and a contract
 * computed from constants is exactly as stable as the stage body it joins.
 */
import { PLAN_CONTRACT_HEADING, renderPlanSchemaContract } from "../plan/schemaContract.ts";
import { writesPlanArtefacts } from "../plan/validatePlan.ts";
import { SRC_GRAMMAR_HEADING, renderSrcGrammarContract } from "../text/srcGrammarContract.ts";
import { replaceSection } from "./prompt.ts";

/** What a contract needs to know about the stage it might be rendered for. */
export interface ContractStage {
  /** The check ids the stage declares. */
  readonly checks: readonly string[];
  /** The stage's declared output paths. */
  readonly outputs: readonly string[];
}

export interface CheckContract {
  /** The check whose rules this states. */
  readonly check: string;
  /** The H2 it is spliced under. */
  readonly heading: string;
  readonly body: string;
}

interface ContractSource {
  readonly check: string;
  readonly heading: string;
  /** Whether this stage is one the check will actually run on. */
  readonly applies: (stage: ContractStage) => boolean;
  readonly render: () => string;
}

const SOURCES: readonly ContractSource[] = [{
  check: "plan",
  heading: PLAN_CONTRACT_HEADING,
  // Both halves: the stage must declare the check AND write the artefacts —
  // `checkPlan` skips a stage with no `waves.yml` output, and a contract for a
  // check that will skip is bytes for nothing.
  applies: (stage) => stage.checks.includes("plan") && writesPlanArtefacts(stage.outputs),
  render: renderPlanSchemaContract,
}, {
  check: "claim-sources",
  heading: SRC_GRAMMAR_HEADING,
  // Same two halves. `checkClaimSources` skips outright for a stage with no `.md`
  // output ("the stage declares no .md output"), and the hook only ever fires on
  // `.md`, so a stage writing only `waves.yml` pays nothing.
  //
  // Every other stage pays ~7.5 KB, in the most-stable part of the prompt and so
  // cached, and gh #77 is the receipt: run `260830-ordering-inventory` spent three
  // story attempts discovering three rules by having attempts refused, because the
  // grammar existed only as regexes in `srcToken.ts` and as a symptom in the deny.
  applies: (stage) => stage.checks.includes("claim-sources")
    && stage.outputs.some((path) => path.endsWith(".md")),
  render: renderSrcGrammarContract,
}];

/** The contracts this stage's checks publish, in declaration order. */
export function checkContractsFor(stage: ContractStage): readonly CheckContract[] {
  return SOURCES
    .filter((source) => source.applies(stage))
    .map((source) => ({ check: source.check, heading: source.heading, body: source.render() }));
}

/**
 * `stage.md` with each applicable contract spliced in. Unchanged, byte for byte,
 * for a stage whose checks publish none — which is every stage but Plan today.
 */
export function applyCheckContracts(stageMd: string, stage: ContractStage): string {
  let out = stageMd;
  for (const contract of checkContractsFor(stage)) {
    out = replaceSection(out, contract.heading, contract.body);
  }
  return out;
}
