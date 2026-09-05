# Expo Router

Detection found `expo-router` (or `expo`) in package.json, so navigation comes from the file
tree and the app has a native side the bundle alone cannot change: file-based routes, config
plugins instead of hand-edited native projects, an environment prefix that decides what ships
in the bundle, and updates that only carry JavaScript. The repo's own conventions win over
everything below — a Default applies only where the repo is silent, and a Check's accepted
answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Add a screen as a file under the routes directory the router already scans, and let its
  place in the tree be its route. — overridden by: the routes directory and grouping
  convention already in the repo
- Navigate with the router's own link component and imperative navigation, against a route
  the file tree actually defines. — overridden by: a navigation helper the repo already exports
- Add a platform-specific file — the iOS, Android or web variant — only where behaviour
  genuinely differs, and keep the shared file as the default.
  — overridden by: the platform-file layout the repo already uses for that component
- Keep app configuration in the app config the repo has, and express native setup as a config
  plugin rather than editing generated native directories by hand.
  — overridden by: the app config and plugin list already committed
- Expose a value to the JavaScript bundle only through the `EXPO_PUBLIC_` prefix, and keep
  anything secret behind a server the app calls.
  — overridden by: the configuration module the app already reads its settings through
- Say in the story log when a change adds or updates a native module: the bundle will not
  pick it up on its own, and the reviewer needs to know a native rebuild is part of the change.
  — overridden by: the rebuild and release process the repo documents
- Ship a JavaScript-only change over the update channel the repo configures, and treat
  anything touching native code as a new build.
  — overridden by: the update configuration already in the app config
- Inset content with the safe-area handling the app already mounts rather than padding each
  screen by hand. — overridden by: the safe-area provider or hook the repo already installs

## Checks (always asked in review)

- Does a navigation call name a path the route tree does not define? verify: read each
  navigation target added in the diff and find the matching file under the routes directory
- Was a native dependency added with no note that the native project must be rebuilt? verify:
  read the manifest change in the diff and look for the rebuild note in the story log
- Is a secret exposed through an `EXPO_PUBLIC_` name? verify: grep the diff and the committed
  env files for `EXPO_PUBLIC_` and read what each value actually is
- Is platform-specific behaviour branched inside a shared file where the repo uses platform
  files? verify: grep the diff for platform checks and compare against the sibling files in
  that directory
- Was a generated native directory edited by hand instead of through the app config or a
  plugin? verify: check whether the diff touches the native project directories and, if it
  does, which config change should have produced that edit
- Does a new screen ship without the safe-area or layout treatment its siblings have? verify:
  open a sibling screen in the same directory and compare
