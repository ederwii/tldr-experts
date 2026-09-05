# MediatR CQRS

Detection found MediatR referenced by a project file or by the central package file, so the
application layer is organised as requests and handlers: one handler per request, commands
separated from queries, cross-cutting work in pipeline behaviours, and endpoints that send
rather than decide. The repo's own conventions win over everything below — a Default applies
only where the repo is silent, and a Check's accepted answer is the project's existing
pattern when it has one.

## Defaults (when the repo is silent)

- Give every request exactly one handler, and keep the pair together under the feature the
  repo organises by. — overridden by: the folder and naming layout the repo's existing
  features already use
- Separate a command that changes state from a query that reads it, in the name and in the
  placement, so a reader can tell them apart without opening the handler.
  — overridden by: the naming convention the repo's existing requests follow
- Put cross-cutting work — validation, logging, transactions, metrics — in a pipeline
  behaviour registered once, rather than repeating it at the top of each handler.
  — overridden by: the behaviours the repo already registers in its pipeline
- Keep a handler from sending another request: lift the shared work into a service that both
  handlers call. — overridden by: a composition pattern the repo already documents for its handlers
- Let the endpoint or controller bind, send and map the result; the decision belongs in the
  handler. — overridden by: the layering the repo's existing endpoints already follow
- Flow the cancellation token the pipeline hands the handler into every call the handler
  makes. — overridden by: an interface the repo already fixed without a token
- Register handlers through the assembly scan the startup already configures rather than
  adding registrations one at a time.
  — overridden by: the registration the project's service configuration already performs
- Keep a query free of writes: a read path that must persist something is a command.
  — overridden by: a documented exception the repo already makes for that path

## Checks (always asked in review)

- Does a handler dispatch another request instead of calling a shared service? verify: read
  each new handler for a send or publish call and follow what it dispatches
- Does an endpoint or controller carry a decision that belongs in a handler? verify: read each
  endpoint changed in the diff and count what it does beyond binding, sending and mapping
- Does a query write? verify: read each new query handler for a save, an insert or an update
- Does a new request type go without a handler, or gain a second one? verify: grep the repo
  for the request type's name and count the handler implementations
- Is validation written inside a handler where a validation behaviour is already registered?
  verify: read the new handler's first statements against the behaviours the startup registers
- Does the handler drop the cancellation token it was given? verify: read each awaited call in
  the new handler against the parameters its handle method receives
- Does a new request type ship without a handler test where its siblings have one? verify:
  open the test project and look for a test naming the new request
- Are the build and test commands green on this change, unfiltered? verify: run the build and
  test commands declared in .tldrx/workspace.yml and read each exit code — and say so when
  the workspace leaves that slot empty rather than letting the check pass
