# .NET

This pack covers C# projects, their build properties and their tests: SDK and package
pinning, nullability and analyzer settings, async and cancellation discipline, dependency
injection lifetimes, logging and configuration idioms, and the commands the workspace
declares. It is deliberately neutral on architecture — framework conventions arrive as
overlays beside this body. Measured repo conventions win over anything below: a Default
applies only where the repo is silent, and a Check's accepted answer is the project's own
convention when it has one.

## Defaults (when the repo is silent)

- Build against the SDK and target framework the repo pins rather than whatever happens to
  be installed. — overridden by: a `global.json` in the repo and the `TargetFramework`
  property in the project files
- Put shared build properties in the repo's shared props file rather than repeating them in
  each project file. — overridden by: `Directory.Build.props` and any `.props` the projects
  already import
- Write code that compiles clean under nullable reference types, and fix the warning rather
  than annotating it away. — overridden by: the `Nullable` property in the project file or
  `Directory.Build.props`
- Treat compiler and analyzer warnings as failures on the paths where the repo already does.
  — overridden by: the `TreatWarningsAsErrors` / `AnalysisMode` properties and the
  `.editorconfig` severities already committed
- Declare package versions centrally when the repo manages them centrally, and leave the
  project file carrying only the package name.
  — overridden by: the presence of `Directory.Packages.props` and its `PackageVersion` items
- Make an I/O path async end to end, take a `CancellationToken` parameter and pass it on to
  every call that accepts one. — overridden by: a call chain that is synchronous by design
  in the surrounding code, or an interface the repo already fixed without a token
- Never block on a task with `.Result`, `.Wait()` or `GetAwaiter().GetResult()`, and use
  `async void` only for an event handler.
  — overridden by: an existing synchronous entry point the repo documents as such
- Resolve a service at the lifetime its state implies, and never capture a shorter-lived
  service inside a longer-lived one. — overridden by: the registrations already in the
  repo's service-configuration file
- Read settings through an `IOptions<T>` the repo binds rather than reaching into the
  configuration root at each use site. — overridden by: the options classes and `Configure`
  calls already registered
- Log through the injected `ILogger<T>` with a constant message template and the values as
  arguments, so the structured fields survive. — overridden by: a logging abstraction the
  repo already wraps its logger in
- Catch the specific exception you can act on; never let a broad `catch` end without
  handling, rethrowing or logging. — overridden by: an exception-handling middleware or
  boundary the repo already installs
- Dispose what you create: `using` for anything disposable, and let injected dependencies be
  disposed by whoever owns them. — overridden by: a factory or pooled resource the repo
  already manages
- Model data that does not change as an immutable type, and seal types that are not designed
  for inheritance. — overridden by: the prevailing use of `record`, `class` and `sealed` in
  the area you are editing
- Write tests with the framework the test project already references; do not add a second
  one. — overridden by: the `PackageReference` items in the test project file
- Keep tests hermetic: no shared directory, no network the test did not start, no dependence
  on the developer's own environment. — overridden by: a fixture or harness the repo
  already provides

## Checks (always asked in review)

- Does the diff add a `.Result`, a `.Wait()`, a `GetAwaiter().GetResult()`, or an
  `async void` outside an event handler? verify: grep the diff for `.Result`, `.Wait()` and
  `async void`
- Does an I/O call in the diff go without the cancellation token that is already in scope?
  verify: read each awaited call added in the diff against its enclosing method's parameters
- Was a `Version` attribute added to a project file while the repo manages versions
  centrally? verify: check whether `Directory.Packages.props` exists and open the changed
  project file
- Is a shorter-lived service captured by a longer-lived one — a scoped dependency injected
  into a singleton? verify: open the registration for both types in the service-configuration file
- Is a log message template built by string interpolation, so the values stop being
  structured fields? verify: grep the diff for a logger call and read the first argument
- Does the diff add public behaviour with no test covering it? verify: look for the test
  project's change beside this one, and open the test that names the new type or method
- Does a `catch` added here swallow the exception without handling, rethrowing or logging it?
  verify: read every `catch` block in the diff
- Is a nullable warning silenced with the null-forgiving operator rather than handled?
  verify: grep the diff for `!` directly after an identifier or member access —
  `!.`, `!;`, `!)`, `!,` — and read what each value can actually be
- Are the build, test and lint commands green on this change, unfiltered? verify: run the
  build, test and lint commands declared in .tldrx/workspace.yml and read each exit code —
  and say so when the workspace leaves that slot empty rather than letting the check pass
- Is a disposable created without `using` or an explicit dispose on every path? verify: read
  each `new` of a disposable type added in the diff
- Does new code read configuration straight from the configuration root instead of the bound
  options type? verify: grep the diff for `IConfiguration` and for indexer reads such as
  `Configuration["…"]`
- Does a new project file skip the repo's shared properties or analyzer package? verify:
  compare the new project file against an existing sibling project file
- Did the developer record, beside each new test, that it was seen to fail — what was broken
  and that it went red? verify: read each new test in the diff for that sentence; a new test
  carrying none is a finding, and the test reading correctly is not a substitute for it
- Is a failure hidden behind a default return value from a call that failed? verify: read
  each fallback added in the diff and ask what a real failure would look like to the caller
- Does this change alter behaviour with no test that would have caught the old behaviour?
  verify: find the assertion in the diff that covers the changed line, or say there is none
