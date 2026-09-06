# Vite + React single-page app

Detection found `vite` and `react` in package.json with no `next` beside them, so this is a
browser-rendered single-page app built by Vite: environment values that must be exposed on
purpose, route-level code splitting, assets that go through the bundler, a dev proxy for the
API, and a build output that stays out of the tree. The repo's own conventions win over
everything below — a Default applies only where the repo is silent, and a Check's accepted
answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Read browser-visible configuration from the bundler's own env object, and give every such
  variable the prefix the bundler exposes.
  — overridden by: the `envPrefix` set in the repo's vite config
- Keep `process.env` out of code that ships to the browser; it is a build-time substitution
  at best and undefined at worst. — overridden by: a `define` or shim the repo's vite config
  already installs
- Split at the route boundary with a lazy import, so the first paint does not pull every
  screen in the app. — overridden by: the eager or lazy pattern the repo's existing routes
  already follow
- Route with the router the manifest names, and declare routes in the one module the repo
  already declares them in. — overridden by: the router package in package.json and the
  repo's existing route module
- Reference an asset by importing it, so the bundler fingerprints it and the build fails when
  it disappears. — overridden by: a public-directory convention the repo already relies on
  for that asset
- Send development API calls through the dev-server proxy the config declares rather than
  hard-coding an origin at each call site.
  — overridden by: the `server.proxy` block in the repo's vite config
- Keep the build output directory out of commits, out of lint globs and out of test globs.
  — overridden by: the `build.outDir` the config sets and the ignore files already committed
- Declare the shape of the environment surface where the repo declares it, so a missing
  variable is a build-time error rather than an undefined at run time.
  — overridden by: the environment type declaration the repo already keeps

## Checks (always asked in review)

- Does browser code read `process.env`? verify: grep the diff for `process.env` and check
  whether each hit is in application code or in a config or script file
- Is a new environment variable read without the prefix the bundler exposes? verify: grep the
  diff for `import.meta.env` and compare each name against the `envPrefix` in the vite config
- Is a whole route imported eagerly where its siblings are lazy? verify: open the route module
  and compare the new entry against the ones beside it
- Is an asset referenced by a hard-coded string path instead of an import? verify: grep the
  diff for asset file extensions inside string literals
- Does a hard-coded API origin appear in component code instead of the proxy or the env value?
  verify: grep the diff for `http` inside string literals and read each hit
- Do changed paths land inside the build output directory or another generated location?
  verify: compare the changed paths against `build.outDir` in the vite config and the ignore files
