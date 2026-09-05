# ASP.NET Core controllers

Detection found a web SDK project with a `Controllers/` directory beside it, so the HTTP
surface is declared by controller types and attribute routes: the framework binds and
validates the model, the action's declared return type is the contract, and cross-cutting
behaviour belongs in a filter rather than at the top of every action. The repo's own
conventions win over everything below — a Default applies only where the repo is silent, and
a Check's accepted answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Mark an API controller with the API controller attribute and route it with attribute
  routing, so the route reads beside the action it serves.
  — overridden by: the routing convention the repo's existing controllers already use
- Declare what the action returns with the typed action result rather than an untyped one, so
  the response type is visible to callers and to the generated API document.
  — overridden by: the return-type style the sibling controllers already use
- Let the framework's model-validation pipeline reject an invalid model instead of repeating
  the check by hand at the top of the action.
  — overridden by: a validation filter or package the project already registers
- Return failures as problem details so every client parses errors one way.
  — overridden by: the error shape the repo's existing controllers already return
- Keep the action thin — bind, delegate, map the result — and leave the business rules behind
  the controller. — overridden by: the layering the repo's existing controllers follow
- Put cross-cutting behaviour such as authorisation, logging and exception mapping in a
  filter or in middleware rather than repeating it in each action.
  — overridden by: the filters the project already registers in its pipeline
- Take a `CancellationToken` parameter on an action that does I/O and pass it down into the
  calls it makes. — overridden by: an interface the repo already fixed without a token
- Name and group a new route the way the existing controllers do, so the public surface stays
  predictable. — overridden by: the routing and API versioning scheme already applied to the
  sibling controllers

## Checks (always asked in review)

- Does an action carry business logic that belongs behind the controller? verify: read each
  action added in the diff and count what it does beyond binding, delegating and mapping
- Does the diff check the model state by hand where the pipeline already rejects an invalid
  model? verify: grep the diff for `ModelState` and read the action around each hit
- Does an action return an untyped result where its siblings are typed? verify: open the
  controller and compare the new signature against the ones beside it
- Does the new route template collide with or duplicate an existing one? verify: grep the repo
  for the route template and open each hit
- Does an action that does I/O go without the cancellation token already in scope? verify:
  read each awaited call in the new actions against the action's parameters
- Is an error returned as a bare string or an anonymous object rather than problem details?
  verify: read each failure path added in the diff
- Does a new controller or action ship without a test where its siblings have one? verify:
  open the test project and look for a test naming the new route
- Are the build and test commands green on this change, unfiltered? verify: run the build and
  test commands declared in .tldrx/workspace.yml and read each exit code — and say so when
  the workspace leaves that slot empty rather than letting the check pass
