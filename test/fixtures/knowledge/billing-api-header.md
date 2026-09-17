---
expert: billing-api
area: billing-api
mode: light
trained_at: 2026-08-29T20:03:35Z
domain: src/Billing.Api/
---

# billing-api — the HTTP host of northwind-ledger

Scope: the 23 files under `src/Billing.Api/`. Every file in the domain was read. Claims are labelled
*measured* (I ran it or read the literal code), *inferred* (mechanism + evidence) or *assumed*.

Gate state at training time: `dotnet build` exit 0, 0 warnings, 0 errors — measured, exit code captured
unpiped [src: northwind-ledger:.tldrx/workspace.yml:19]. `scripts/test.sh --only unit -- --filter-method '*Api.Security*'`
→ 78/78 passed, exit 0 — measured [src: northwind-ledger:scripts/test.sh:105]. `scripts/test.sh --only integration --
--filter-method '*PermissionAuthorizationTests*'` → 15/15 passed, exit 0 — measured
[src: northwind-ledger:tests/Integration/Billing.IntegrationTests/Api/Authorization/PermissionAuthorizationTests.cs:21]
