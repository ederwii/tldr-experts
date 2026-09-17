---
expert: ledger-api
area: ledger-api
mode: light
trained_at: 2026-08-29T20:03:35Z
domain: src/ledger_api/
---

# ledger-api — the HTTP host of meridian-holdings

Scope: the 23 files under `src/ledger_api/`. Every file in the domain was read. Claims are labelled
*measured* (I ran it or read the literal code), *inferred* (mechanism + evidence) or *assumed*.

Gate state at training time: `pytest` exit 0, 0 warnings, 0 errors — measured, exit code captured
unpiped [src: meridian-holdings:.tldrx/workspace.yml:19]. `scripts/test.sh --only unit -- --filter-method '*Api.Auth*'`
→ 78/78 passed, exit 0 — measured [src: meridian-holdings:scripts/test.sh:105]. `scripts/test.sh --only integration --
--filter-method '*RoleGuardTests*'` → 15/15 passed, exit 0 — measured
[src: meridian-holdings:tests/integration/ledger_api/auth/role_guard_tests.py:21]
