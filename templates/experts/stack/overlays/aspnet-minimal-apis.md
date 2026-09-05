# ASP.NET Core minimal APIs

Detection found a web SDK project with no `Controllers/` directory beside it, so the HTTP
surface is declared as mapped endpoints: groups carry the shared prefix and metadata, the
result type is the contract, dependencies arrive as parameters, and the generated API
document is only as good as what each endpoint declares. The repo's own conventions win over
everything below — a Default applies only where the repo is silent, and a Check's accepted
answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Register a related set of endpoints on a group, and hang the shared route prefix, filters
  and metadata on the group rather than repeating them on each endpoint.
  — overridden by: the grouping the repo's endpoint-registration files already establish
- Return the typed result the endpoint actually produces, so the response shape is visible in
  the signature and in the generated API document.
  — overridden by: the result style the sibling endpoints already use
- Validate the request model at the boundary through the mechanism the project already wires
  in, and reject before any work begins.
  — overridden by: the validation package and endpoint filter the project already registers
- Describe a failure as a problem-details payload rather than a bare string or an anonymous
  object, so every client parses errors one way.
  — overridden by: the error-response shape the repo already returns from its endpoints
- Take dependencies as endpoint parameters and let the container supply them, rather than
  resolving them from a service locator inside the body.
  — overridden by: the registrations already in the project's service configuration
- Take a `CancellationToken` parameter on every endpoint that does I/O and pass it into each
  call that accepts one. — overridden by: an interface the repo already fixed without a token
- Attach the API metadata the sibling endpoints attach — the name, the response types, the
  summary — so the generated document stays complete.
  — overridden by: the metadata conventions the repo applies to its endpoint groups
- Keep the project's chosen shape: add an endpoint beside the others rather than introducing
  a controller into a project that has none. — overridden by: a documented decision in the
  repo to run both styles side by side

## Checks (always asked in review)

- Does a new endpoint return an untyped result where its siblings are typed? verify: open the
  registration and compare the new endpoint's return type against the neighbouring ones
- Does an endpoint that does I/O go without a `CancellationToken` parameter? verify: read each
  endpoint added in the diff and follow the token into the calls it makes
- Is an error returned as a bare string or an anonymous object rather than problem details?
  verify: read each failure path added in the diff
- Was an endpoint registered outside the group its siblings belong to? verify: open the
  registration file and locate where the new mapping lands
- Was a controller added to a project that has none? verify: check whether the diff creates a
  controller type or a controllers directory under this project
- Does the endpoint trust its request model without validating it? verify: read the endpoint
  body and find where the model is checked, or the filter that checks it for it
- Does a new endpoint ship without a test where its siblings have one? verify: open the test
  project and look for a test naming the new route
