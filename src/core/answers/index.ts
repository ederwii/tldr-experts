export {
  captureAnswers, supersedeAnswer, writeAnswerSlot,
  factTextFor, factWasTruncated, TRUNCATION_MARK, AnswerError,
} from "./captureAnswers.ts";
export type { CaptureContext, CapturedAnswer, SupersededAnswer } from "./captureAnswers.ts";
export {
  affectedDocs, isStamped, stampSuperseded, stampText, AFFECTS_KEY, STAMP_MARKER,
} from "./stampSuperseded.ts";
export type { AffectedDoc } from "./stampSuperseded.ts";
