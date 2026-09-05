# Postgres with Testcontainers

Detection found a Postgres driver and a Testcontainers package in the same repo, so the
integration tests are meant to run against a real database in a container. That buys the real
dialect, the real constraints and the real types — and it brings a container lifetime, a
migration step, an isolation strategy and a runtime precondition that has to be stated. The
repo's own conventions win over everything below — a Default applies only where the repo is
silent, and a Check's accepted answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Run the database tests against the real container: a mock or an in-memory substitute has
  neither the constraints, the types nor the SQL dialect the application depends on.
  — overridden by: a documented decision in the repo to substitute the database for a
  specific suite
- Start the container at the lifetime the repo already uses — per test class, per collection,
  per run — rather than adding a second lifetime beside it.
  — overridden by: the fixture or hook the repo already starts its container from
- Apply the migrations to the container before the first test, so the tests meet the schema
  the application will meet. — overridden by: the schema setup step the repo's fixture
  already performs
- Take the connection details from the container after it starts: a fixed host port makes two
  suites collide and a busy machine flaky.
  — overridden by: the connection helper the repo's fixture already exposes
- Isolate each test's data the way the repo already does — a fresh schema, a fresh database, a
  rolled-back transaction, a reset step between tests — so execution order stops mattering.
  — overridden by: the isolation the repo's existing database tests already apply
- Name the container runtime as a precondition in the story log and in the definition of done:
  these tests do not run where it is absent, and a skipped suite must never read as a pass.
  — overridden by: the preconditions the repo already records for its test run
- Stop and remove the container in teardown on the failure path as well as the happy one.
  — overridden by: the lifecycle the repo's fixture already manages
- Keep the container tests grouped apart from the fast unit tests the way the repo already
  separates them, so one slow suite does not gate every change.
  — overridden by: the test grouping and filters the repo already declares

## Checks (always asked in review)

- Does a database test run against a mock, a fake or an in-memory substitute instead of the
  container? verify: read the new test's setup and find where its connection comes from
- Is a host, a port or a database name hard-coded rather than read from the started container?
  verify: grep the diff for `localhost`, for a port number and for a connection-string literal
- Do the migrations run against the container before the tests that need them? verify: read
  the fixture's setup and find the migration step
- Do two tests share state, so their order decides the result? verify: run the new tests alone
  and then together with the test command declared in .tldrx/workspace.yml, and say so when
  the workspace leaves that slot empty rather than letting the check pass
- Does a schema change land without that migration running in the test container? verify: read
  the fixture's setup against the migration the diff adds
- Is the container runtime precondition stated where a reader will meet it? verify: read the
  story log and the definition of done for this change
- Does the suite pass quietly when the container cannot start, instead of failing or reporting
  a skip? verify: read the fixture's error path and what the runner prints when the runtime is
  absent
- Is the container stopped on the failure path too? verify: read the teardown and ask what
  happens when a test throws before it
