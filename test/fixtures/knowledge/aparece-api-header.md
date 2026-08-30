---
expert: aparece-api
area: aparece-api
mode: light
trained_at: 2026-08-29T20:03:35Z
domain: src/Aparece.Api/
---

# aparece-api — the HTTP host of aparece-v2

Scope: the 23 files under `src/Aparece.Api/`. Every file in the domain was read. Claims are labelled
*measured* (I ran it or read the literal code), *inferred* (mechanism + evidence) or *assumed*.

Gate state at training time: `dotnet build` exit 0, 0 warnings, 0 errors — measured, exit code captured
unpiped [src: aparece-v2:.tldrx/workspace.yml:19]. `scripts/test.sh --only unit -- --filter-method '*Api.Security*'`
→ 78/78 passed, exit 0 — measured [src: aparece-v2:scripts/test.sh:105]. `scripts/test.sh --only integration --
--filter-method '*PermissionAuthorizationTests*'` → 15/15 passed, exit 0 — measured
[src: aparece-v2:tests/Integration/Aparece.IntegrationTests/Api/Authorization/PermissionAuthorizationTests.cs:21]
