# TypeScript

This pack covers TypeScript source, its build and its tests: the type system at the
boundaries, module and package-manager coherence, async and error discipline, and the
commands the workspace declares. It is deliberately neutral on architecture — framework
conventions arrive as overlays beside this body. Measured repo conventions win over
anything below: a Default applies only where the repo is silent, and a Check's accepted
answer is the project's own convention when it has one.

## Defaults (when the repo is silent)

- Write to the strictest compiler settings the project already turns on, and never relax
  one so a change compiles. — overridden by: the `compilerOptions` block in the repo's tsconfig
- Type values crossing a trust boundary — request bodies, `JSON.parse` results, environment
  reads — as `unknown` and narrow them before use, never as `any`.
  — overridden by: a validation layer the repo already routes its boundaries through
- Narrow with a runtime check the compiler can follow instead of an `as` assertion; keep
  assertions for what the type system genuinely cannot see, and say why beside them.
  — overridden by: a guard or assertion helper the repo already exports
- Handle every member of a discriminated union explicitly, so that adding a member breaks
  the build rather than falling through silently.
  — overridden by: an exhaustiveness helper the repo already uses
- Import types with a type-only import, so nothing survives in the emitted module graph
  that existed only for a type. — overridden by: the tsconfig's module-syntax settings and
  the import style of the neighbouring files
- Keep a new file's module syntax coherent with what actually loads it, including whether
  import specifiers carry a file extension. — overridden by: the `type` field in
  package.json and the tsconfig's `module` / `moduleResolution`
- Use the package manager the committed lockfile names, and land the lockfile change in the
  same commit as the manifest change. — overridden by: the lockfile in the repo, and a
  `packageManager` field in package.json when there is one
- Await or return every promise you create; a dropped promise loses its ordering and leaves
  its rejection unhandled. — overridden by: a fire-and-forget helper the repo already uses
- Throw `Error` instances, and let a `catch` either handle the failure or rethrow it with
  context — never discard it. — overridden by: an error or result type the repo already
  returns from its fallible calls
- Export the public surface from the entry the manifest declares rather than letting
  consumers reach into deep paths. — overridden by: the `exports` / `types` map in package.json
- Run the test, lint and format tools the manifest already declares; do not add a second
  tool alongside one that is configured. — overridden by: the devDependencies, the `scripts`
  block and the tool config files already in the repo
- Send diagnostics through the logger the surrounding code imports, and keep `console` out
  of library paths. — overridden by: a logging module the repo already exports
- Model a closed set the way the module around you already does, and do not introduce the
  second style beside it. — overridden by: the prevailing use of `enum` or of a `const`
  object with a literal union in that area
- Read configuration once through the repo's config module rather than reading
  `process.env` at each use site. — overridden by: a config or environment module the repo
  already exports
- Keep tests hermetic: no shared temp directory, no network, no dependence on the host's
  own settings files. — overridden by: a test harness or fixture helper the repo provides

## Checks (always asked in review)

- Does the diff add an `any`, an `as` cast, a non-null `!`, or a `@ts-expect-error` where
  narrowing would have done? verify: grep the diff for `: any`, ` as `, `!.` and `@ts-`
- Is every promise in the diff awaited or returned? verify: read each call to an `async`
  function in the diff and check where its result goes
- Does a `catch` added here drop the error without handling, wrapping or rethrowing it?
  verify: read every `catch` block in the diff
- Did a dependency change land without the matching lockfile change? verify: check whether
  the manifest and the lockfile are both in this commit
- Does a `switch` over a union cover every member, and break the build when a member is
  added? verify: open the union's declaration and count its members against the arms
- Can each new test fail? verify: change the line under test, re-run only that test's file —
  the full command declared in .tldrx/workspace.yml runs once, at the Definition of Done — and
  confirm it goes red; and say so when the workspace leaves that slot empty rather than letting
  the check pass
- Are the typecheck and lint commands green on this change, unfiltered? verify: run the
  typecheck and lint commands declared in .tldrx/workspace.yml and read each exit code —
  and say so when the workspace leaves that slot empty rather than letting the check pass
- Did a changed exported type leave a consumer unadjusted? verify: grep the repo for the
  exported name and open each hit
- Is a `console` call left on a path that ships? verify: grep the diff for `console.`
- Does a new file's import style match its neighbours — extension in the specifier,
  type-only imports, relative path or alias? verify: open a sibling file in the same directory
- Does the diff introduce an `enum` where the surrounding code models a closed set as a
  `const` object with a literal union, or the reverse? verify: grep the diff for `enum `
  and for `as const`, and compare against the prevailing style in that directory
- Is `process.env` read directly in new code instead of through the repo's config module?
  verify: grep the diff for `process.env`
- Does the change widen the package's public surface unintentionally? verify: open the
  `exports` map in package.json and check what the new export is now reachable from
- Does a new test touch a shared directory, the network, or the developer's own settings?
  verify: read the new test's setup for absolute paths, shared temp directories and network calls
- Is a failure hidden behind a fallback value — an empty array, a zero, a default object —
  returned from a call that failed? verify: read each fallback added in the diff and ask
  what a real failure would look like to the caller
- Does this change alter behaviour with no test that would have caught the old behaviour?
  verify: find the assertion in the diff that covers the changed line, or say there is none
