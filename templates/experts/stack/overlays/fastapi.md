# FastAPI

Detection found `fastapi` in the project's Python dependencies, so the HTTP boundary is
declared with models and dependencies: the framework parses and serialises against the
declared types, injects what a handler asks for, and runs a synchronous handler off the event
loop while a coroutine stays on it. The repo's own conventions win over everything below — a
Default applies only where the repo is silent, and a Check's accepted answer is the project's
existing pattern when it has one.

## Defaults (when the repo is silent)

- Describe every request and response body as a model at the boundary and let the framework
  do the parsing, the validating and the serialising.
  — overridden by: the schema layer the repo already declares its payloads in
- Take collaborators — sessions, clients, the current user — as declared dependencies rather
  than reaching for module-level globals.
  — overridden by: the dependency providers the repo already exports
- Write a handler as a coroutine only when what it awaits is genuinely asynchronous: a
  synchronous handler is run off the event loop, and blocking work inside a coroutine is not.
  — overridden by: an async client or executor the repo already routes that call through
- Group endpoints on a router per module and include the routers once at the application,
  setting the prefix and the tags there.
  — overridden by: the router layout the repo already assembles
- State the response model and the status code on the route instead of letting the return
  value decide the contract.
  — overridden by: the response conventions the sibling routes already use
- Read settings once through the settings object the project defines and depend on it, rather
  than reading the environment at each use site.
  — overridden by: the settings class or configuration module the repo already exports
- Open and close shared resources in the application lifespan rather than at import time, so
  a test can build the app without side effects.
  — overridden by: the startup wiring the repo already performs
- Raise the framework's HTTP error with a detail the client can act on, and let the handler
  the app registers turn it into a response.
  — overridden by: an exception handler the repo already registers
- Exercise routes through the test client the repo already uses, against the app its
  application module builds. — overridden by: the fixtures the repo's existing API tests use

## Checks (always asked in review)

- Is a route declared `async def` when everything under it is synchronous, where a plain `def`
  route would have been handed to the threadpool instead of holding the loop? verify: read each
  route added in the diff against the client or session it calls
- Does a new endpoint go without a response model where its siblings declare one? verify: open
  the router and compare the new decorator against the ones beside it
- Does a handler return a raw dict where a model already exists for that payload? verify: read
  each return statement added in the diff
- Is a client, session or engine created at import time rather than inside a provider or the
  lifespan? verify: read the top-level statements in the modules the diff touches
- Is a body, query or path value used without a model or a validated type? verify: read each
  new handler's parameters and their annotations
- Does an error path return a bare string, or a status code with no detail the caller can act
  on? verify: read each failure path added in the diff
- Does a new endpoint ship without a test where its siblings have one? verify: open the test
  module for that router and look for the new path
