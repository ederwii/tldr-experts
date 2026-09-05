# Next.js App Router

Detection found `next` in package.json together with an `app/` directory — at the root or
under `src/` — so this project routes through the App Router: server components by default,
client components opted into explicitly, route handlers, per-segment loading and error
files, and caching that is a decision rather than an accident. The repo's own conventions
win over everything below — a Default applies only where the repo is silent, and a Check's
accepted answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Leave a component on the server and mark it `"use client"` only where a browser API, an
  event handler or client state actually needs it — at the smallest component that needs it,
  not at the layout above it. — overridden by: the client/server split the repo already
  draws in that segment
- Load data in a server component or a route handler and pass the result down, rather than
  fetching from the browser after mount. — overridden by: a client-side data layer the repo
  already mounts for that screen
- Make caching and revalidation an explicit decision on every route that reads data — the
  segment's own export, or the options passed at the fetch — rather than inheriting whatever
  the default happens to be. — overridden by: the caching configuration the repo already
  sets for that route
- Give a new segment the loading and error files its sibling segments have, so a slow or
  failing subtree does not take the whole layout with it.
  — overridden by: the segment file set the repo already uses
- Describe a page's title and social metadata through the framework's metadata export rather
  than by writing head tags by hand. — overridden by: a metadata helper the repo already exports
- Keep server-only modules — database clients, secrets, signing keys — out of anything a
  client component imports, directly or transitively.
  — overridden by: the server/client module boundary the repo already enforces
- Expose a value to the browser only through the `NEXT_PUBLIC_` prefix, and read everything
  else on the server. — overridden by: the environment module the repo already reads its
  configuration through
- Navigate and read route state with the App Router's own navigation hooks; the pages-router
  `next/router` does not work inside the app directory.
  — overridden by: a navigation wrapper the repo already exports
- Put cross-cutting request work — auth redirects, rewrites, headers — in the request
  middleware file the framework loads, not repeated in each page.
  — overridden by: the middleware or proxy file already committed at the project root
- Treat a server action or route handler as a public endpoint: authorise it and validate its
  input on the server, whatever the calling component already checked.
  — overridden by: the authorisation and validation layer the repo already routes requests through

## Checks (always asked in review)

- Does a client component import a module that reaches a database client, a secret or a
  server-only helper? verify: follow the imports of every file carrying `"use client"` in the diff
- Is a secret exposed through a `NEXT_PUBLIC_` name? verify: grep the diff and the committed
  env files for `NEXT_PUBLIC_` and read what each value actually is
- Does a new route handler or data-reading page go without an explicit caching or
  revalidation decision? verify: open the segment and look for its cache or revalidate export
  and the options on its fetch calls
- Does `next/router` appear anywhere under the app directory? verify: grep the diff and the
  app directory for `next/router`
- Was `"use client"` added at a layout or a page where a leaf component would have done?
  verify: read the file carrying the directive and ask which part of it needs the browser
- Does a new segment go without the error boundary its siblings have? verify: list the files
  in the sibling segments and compare
- Does a server action or route handler trust its input, or its caller's authorisation?
  verify: read each exported handler added in the diff and find where the body, the params
  and the session are checked
- Are the build and test commands green on this change, unfiltered? verify: run the build and
  test commands declared in .tldrx/workspace.yml and read each exit code — and say so when
  the workspace leaves that slot empty rather than letting the check pass
