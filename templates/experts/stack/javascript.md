# JavaScript

This pack covers JavaScript source, its build and its tests: module and package-manager
coherence, async and error discipline, what happens at an untyped boundary, and the
commands the workspace declares. It is deliberately neutral on architecture — framework
conventions arrive as overlays beside this body. Measured repo conventions win over
anything below: a Default applies only where the repo is silent, and a Check's accepted
answer is the project's own convention when it has one.

## Defaults (when the repo is silent)

- Keep a new file's module syntax coherent with what actually loads it, rather than mixing
  `import` and `require` in one graph. — overridden by: the `type` field in package.json,
  the file's own extension, and the style of its neighbours
- Validate a value crossing a trust boundary — request bodies, `JSON.parse` results,
  environment reads — before it reaches business logic; nothing here is checked for you.
  — overridden by: a validation layer the repo already routes its boundaries through
- Compare with strict equality and convert deliberately when you need a conversion.
  — overridden by: the equality rule in the repo's linter config, which may allow a loose
  null check on purpose
- Declare every binding; never assign to an undeclared name. — overridden by: the
  undeclared-variable rule in the repo's linter config
- Document a function's parameters and return with JSDoc where the surrounding files
  already do, so the editor and any checker keep working.
  — overridden by: whether the module you are editing already carries JSDoc
- Await or return every promise you create; a dropped promise loses its ordering and leaves
  its rejection unhandled. — overridden by: a fire-and-forget helper the repo already uses
- Pick one asynchrony style per API — promises or callbacks — and do not expose both on the
  same function. — overridden by: the style the module's existing exports already use
- Throw `Error` instances, and let a `catch` either handle the failure or rethrow it with
  context — never discard it. — overridden by: an error or result shape the repo already
  returns from its fallible calls
- Use the package manager the committed lockfile names, and land the lockfile change in the
  same commit as the manifest change. — overridden by: the lockfile in the repo, and a
  `packageManager` field in package.json when there is one
- Run the test, lint and format tools the manifest already declares; do not add a second
  tool alongside one that is configured. — overridden by: the devDependencies, the `scripts`
  block and the tool config files already in the repo
- Do not build code from strings at run time with `eval` or `new Function`.
  — overridden by: an existing, deliberate sandbox or template compiler in the repo
- Keep mutable state out of module scope; a module is instantiated once and every importer
  shares it. — overridden by: a store or container module the repo already owns
- Send diagnostics through the logger the surrounding code imports, and keep `console` out
  of library paths. — overridden by: a logging module the repo already exports
- Read configuration once through the repo's config module rather than reading
  `process.env` at each use site. — overridden by: a config or environment module the repo
  already exports
- Keep tests hermetic: no shared temp directory, no network, no dependence on the host's
  own settings files. — overridden by: a test harness or fixture helper the repo provides

## Checks (always asked in review)

- Is every promise in the diff awaited or returned? verify: read each call to an `async`
  function in the diff and check where its result goes
- Does a `catch` added here drop the error without handling, wrapping or rethrowing it?
  verify: read every `catch` block in the diff
- Does a new function take a callback and also return a promise, so a caller can use it
  two ways? verify: read the signatures the diff exports and their return paths
- Does a default parameter or a cached constant hand every caller the same mutable object
  or array? verify: read the default expressions in the diff and check whether each builds
  a fresh value per call
- Does new code keep mutable state at module scope, shared by every importer? verify: read
  the top-level declarations in the files the diff touches
- Did a dependency change land without the matching lockfile change? verify: check whether
  the manifest and the lockfile are both in this commit
- Does the diff mix `require` and `import` for the same module graph? verify: grep the diff
  for `require(` and `import ` and compare against the `type` field in package.json
- Is a value from outside used without a check on its shape? verify: follow each new
  boundary read in the diff to its first use
- Is a loose equality comparison added where the operands can differ in type? verify: grep
  the diff for `==` and `!=` and read every hit that is not `===` or `!==`
- Did the developer record, beside each new test, that it was seen to fail — what was broken
  and that it went red? verify: read each new test in the diff for that sentence; a new test
  carrying none is a finding, and the test reading correctly is not a substitute for it
- Are the test and lint commands green on this change, unfiltered? verify: run the test and
  lint commands declared in .tldrx/workspace.yml and read each exit code — and say so when
  the workspace leaves that slot empty rather than letting the check pass
- Is a `console` call left on a path that ships? verify: grep the diff for `console.`
- Does the diff build code from a string at run time? verify: grep the diff for `eval(`
  and `new Function(`
- Is `process.env` read directly in new code instead of through the repo's config module?
  verify: grep the diff for `process.env`
- Is a failure hidden behind a fallback value returned from a call that failed? verify:
  read each fallback added in the diff and ask what a real failure would look like to the caller
- Does this change alter behaviour with no test that would have caught the old behaviour?
  verify: find the assertion in the diff that covers the changed line, or say there is none
