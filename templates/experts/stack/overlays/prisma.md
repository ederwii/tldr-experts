# Prisma

Detection found a Prisma package in package.json, so the schema file is the source of truth
for the database and every schema change owes a migration: the client is generated, the
migration history is append-only, and a query says what it loads. The repo's own conventions
win over everything below — a Default applies only where the repo is silent, and a Check's
accepted answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Change the database by changing the schema file, and let everything downstream — the
  client, the types, the migration — follow from it.
  — overridden by: a schema owner or migration tool the repo declares elsewhere
- Land a schema change together with the migration it generates, in the same commit, so any
  checkout can reach the schema it describes.
  — overridden by: the migration workflow the repo documents
- Keep the push-style schema sync for local prototyping; the path that reaches a shared
  environment applies the committed migrations.
  — overridden by: the deployment scripts the repo already runs against its environments
- Treat a committed migration as immutable and correct a mistake with a new migration rather
  than by editing one that has already run somewhere.
  — overridden by: a reset procedure the repo documents for environments it can rebuild
- Construct one client for the process and share it, rather than one per request, per module
  or per handler. — overridden by: the client module the repo already exports
- Say what a query returns on a request path — a `select`, or an `include` chosen on purpose
  — instead of loading whole records and their relations by default.
  — overridden by: the query conventions the repo already applies in that module
- Group writes that must land together into one transaction, so a failure halfway through
  leaves nothing behind. — overridden by: a unit-of-work or repository layer the repo already
  funnels its writes through
- Generate the client as part of install or build rather than committing generated output.
  — overridden by: whether the repo commits its generated client, and the script it generates from
- Parameterise raw SQL through the tagged-template form that binds its arguments; never
  concatenate a value into the statement.
  — overridden by: a query builder the repo already uses for its raw access

## Checks (always asked in review)

- Does the diff change the schema without adding the migration that produces it? verify:
  check whether the schema file and a new migration directory are both in this commit
- Was an existing migration edited rather than superseded by a new one? verify: read the diff
  for changes to files under the migrations directory
- Is a client constructed per request, per module or inside a handler? verify: grep the diff
  for `new PrismaClient` and read where each instance is held
- Do two writes that depend on each other run outside a transaction? verify: read each
  sequence of writes added in the diff and ask what a failure between them leaves behind
- Does a raw query interpolate a value into the SQL string? verify: grep the diff for the raw
  query calls and read how each value reaches the statement
- Does a query on a request path load relations the response never uses? verify: read each
  `include` added in the diff against what the handler actually returns
- Is a query issued inside a loop where one query with a filter would do? verify: read each
  database call added in the diff for an enclosing loop or `map`
- Are the build and test commands green on this change, unfiltered? verify: run the build and
  test commands declared in .tldrx/workspace.yml and read each exit code — and say so when
  the workspace leaves that slot empty rather than letting the check pass
