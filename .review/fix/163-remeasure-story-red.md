verdict: merge
reviewed-by: Claude Sonnet 5 (fresh sub-agent, did not write the code) — read the diff at 93688b3e75edd8f4dfefd098981086b5094137dd; confirmed no silent pass (green is computed before the recheck and never reassigned), the absent/exit-code either-or is structurally unrepresentable as both-or-neither, measureOnce removed the duplication rather than adding a third copy, and a pre-change ledger record reads back as "not asked" rather than a false reproduction; no findings
against: 93688b3e75edd8f4dfefd098981086b5094137dd
