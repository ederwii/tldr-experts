# EF Core on Npgsql

Detection found an EF Core package and an Npgsql package in the same project graph, so the
model is the source of truth for a Postgres schema: migrations are committed artefacts, the
change tracker costs something on read paths, a relation loaded per row is an N+1, and
Postgres has column types worth choosing on purpose. The repo's own conventions win over
everything below — a Default applies only where the repo is silent, and a Check's accepted
answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Change the schema by changing the model and generating the migration, and commit the
  migration together with the model change.
  — overridden by: a migration workflow the repo documents
- Treat an applied migration as immutable and correct it with a new migration rather than by
  editing one that has already run.
  — overridden by: a reset procedure the repo documents for environments it can rebuild
- Resolve the context at a scope that matches one unit of work, and never hold one across
  requests or capture it inside a longer-lived service.
  — overridden by: the context registration already in the service configuration
- Read without tracking on a path that only reads, so the change tracker does not carry
  entities nothing will ever save.
  — overridden by: the read conventions the repo's existing queries already follow
- Load a relation in one query — a projection, or an include chosen on purpose — rather than
  letting a loop pull one row at a time.
  — overridden by: the loading strategy the repo configures on its context
- Choose the Postgres-native column type where it matters — a timestamp with time zone, a
  JSON column, an array — and configure it in the model instead of leaving it to a default.
  — overridden by: the mappings the model configuration already applies
- Let the model's naming convention decide table and column names rather than naming them one
  at a time. — overridden by: the naming convention the context already applies
- Declare an index in the model beside the query that needs it, so the migration carries it.
  — overridden by: indexes the repo manages in SQL outside the model
- Read the connection string from configuration and configure the retry behaviour the
  deployment needs, in the one place the context is built.
  — overridden by: the context configuration already in the service registration
- Save asynchronously with the cancellation token in scope, and parameterise raw SQL through
  the form that binds its arguments.
  — overridden by: the data-access helpers the repo already routes its queries through

## Checks (always asked in review)

- Does the diff change an entity or a mapping without adding the migration for it? verify:
  check whether the model change and a new migration file are both in this commit
- Was an existing migration edited rather than superseded by a new one? verify: read the diff
  for changes to files under the migrations directory
- Is a query issued inside a loop where one query would do? verify: read each database call
  added in the diff for an enclosing loop or projection over another query's results
- Does a read-only query track its results? verify: read each query added on a read path and
  look for the no-tracking call its siblings use
- Does a date-time value reach a timestamp-with-time-zone column without an explicit UTC
  kind? verify: open the property's mapping in the model configuration and read where the
  value is produced
- Is the context resolved or captured by something longer-lived than a request? verify: open
  the registration for the context and for the type that takes it
- Does raw SQL concatenate a value into the statement? verify: grep the diff for the raw SQL
  calls and read how each value reaches the query
- Does a save go without the cancellation token already in scope? verify: read each save call
  added in the diff against its enclosing method's parameters
- Are the build and test commands green on this change, unfiltered? verify: run the build and
  test commands declared in .tldrx/workspace.yml and read each exit code — and say so when
  the workspace leaves that slot empty rather than letting the check pass
