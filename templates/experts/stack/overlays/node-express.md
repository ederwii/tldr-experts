# Express on Node

Detection found `express` in package.json, so the request path is a middleware chain whose
ORDER is the behaviour: what parses, what authorises, what routes, what answers when nothing
matched, and what turns a thrown error into a response. The repo's own conventions win over
everything below — a Default applies only where the repo is silent, and a Check's accepted
answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Mount middleware in the order the request needs it: parsers and request context first, then
  authentication, then routes, then the not-found handler, and the error handler last.
  — overridden by: the mounting order the repo's application setup already establishes
- Give the error handler the four-parameter signature the framework recognises; a
  three-parameter function is registered as ordinary middleware and never sees an error.
  — overridden by: an error-handling package the repo already installs for this
- Check whether a rejected promise from an async handler reaches the error handler on its own
  before relying on it: the older majors of the framework do not forward one, and on those a
  handler needs the wrapper the repo uses or an explicit catch that calls into the error path.
  — overridden by: the express major declared in package.json, and the async wrapper or router
  the repo already routes its handlers through
- Validate the body, query and params at the boundary with the validator the repo already
  depends on, and hand the handler a value it can trust.
  — overridden by: the validation library and schema location already in the repo
- Choose the status code deliberately on every path, the failure paths included, rather than
  letting a default stand in. — overridden by: a response helper the repo already sends its
  responses through
- Keep stack traces and internal messages out of the response body; log the detail and send
  the client a stable error shape. — overridden by: the error serialiser the repo already installs
- Read secrets and connection strings from the environment through the repo's configuration
  module, never from a literal in the source.
  — overridden by: a configuration module the repo already exports
- Handle the termination signal: stop accepting connections, let in-flight requests finish,
  then release the pools. — overridden by: a shutdown handler the repo already registers
- Log requests through the logging middleware the app already mounts rather than adding a
  second one beside it. — overridden by: the request logger already mounted in the
  application setup

## Checks (always asked in review)

- Can an async handler in the diff reject without reaching the error handler? verify: read the
  express major in package.json first — the older majors do not forward a rejected promise on
  their own — then read each async handler added for the wrapper or catch it relies on
- Is a route mounted after the not-found handler or after the error handler? verify: read the
  application setup file in order and locate where the new mount lands
- Is a request body, query or param used without being validated first? verify: read each use
  of the request's body, query and params added in the diff
- Does an error response carry a stack trace or an internal message to the client? verify:
  read the error handler and every explicit error response in the diff
- Does the error handler still take four parameters? verify: open the handler and count its
  parameters
- Does a new route ship without a test where its siblings have one? verify: list the test
  files for the neighbouring routes and look for the new path
- Is a secret or a connection string written as a literal in the source? verify: grep the diff
  for quoted strings that look like URLs, keys or passwords
