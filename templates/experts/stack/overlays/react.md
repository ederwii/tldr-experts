# React

Detection found `react` declared in package.json, so this overlay rides beside the language
body: component boundaries, the rules hooks are bound by, state and effects, list keys,
accessible markup, and what a component test asserts. It says nothing about the router, the
data layer or the bundler — those arrive as their own overlays when the manifest names them.
The repo's own conventions win: a Default applies only where the repo is silent, and a
Check's accepted answer is the project's existing pattern when it has one.

## Defaults (when the repo is silent)

- Keep a component a pure function of its props and state, and put the effectful work in an
  event handler or an effect rather than in the render path.
  — overridden by: the rendering convention the surrounding components already follow
- Call hooks unconditionally at the top level of a component or of another hook — never
  inside a branch, a loop, a callback or after an early return — and let the dependency rule
  decide an effect's dependency list, changing the code rather than trimming the array.
  — overridden by: the hook lint rules the repo configures, which are the authority on both
- Derive during render what can be derived, instead of storing it in state and keeping it in
  sync with an effect. — overridden by: a store or state library the repo already routes
  that value through
- Reach for an effect only to synchronise with something outside the component tree; load
  data through whatever data layer the repo already uses.
  — overridden by: the data-fetching hook, client or loader the repo already exports
- Give a list item a key that identifies the item itself and survives reordering, insertion
  and deletion. — overridden by: the key a repo list component already establishes for that
  collection
- Hold state as close to where it is read as the structure allows, and lift it only when a
  second component genuinely needs it. — overridden by: the state container the repo already
  mounts above that subtree
- Add `memo`, `useMemo` or `useCallback` with a measurement beside them, not on suspicion.
  — overridden by: a performance convention the repo already applies in that component tree
- Build interactive UI from the element that already has the behaviour — a button, a link, a
  label bound to its input — before reaching for a plain container and ARIA attributes.
  — overridden by: the component library the repo renders its controls through
- Place an error boundary where the repo already places one, so one failing subtree does not
  blank the page. — overridden by: the boundary placement already used around that route or feature
- Query in tests the way a person finds things — by role, label or visible text — rather than
  by class name or DOM structure. — overridden by: the query convention the repo's existing
  component tests use

## Checks (always asked in review)

- Is an array index used as a key on a list that can reorder, grow or shrink? verify: grep
  the diff for `key={` and read what each key is derived from
- Does the diff fetch inside an effect where the repo already has a data layer? verify: grep
  the diff for `useEffect` and compare against how a sibling component loads its data
- Is a hook called inside a condition, a loop, a callback or after an early return? verify:
  read every hook call added in the diff against its enclosing block, and open the
  rules-of-hooks entry in the repo's lint configuration to see whether it is even enforced
- Is a value stored in state that render could compute from props or other state? verify:
  read each `useState` added in the diff and ask what writes it and when
- Does an effect read something its dependency list omits? verify: read each effect added in
  the diff against its body, and check the dependency rule's severity in the lint configuration
- Does a new component ship without a test where its siblings have one? verify: list the test
  files beside the component's directory and look for the new component's name
- Does the diff make a non-interactive element clickable, or add a form control with no
  associated label? verify: grep the diff for click handlers on plain containers and for new
  inputs without a label
- Is a `memo`, `useMemo` or `useCallback` added with no measurement that motivated it?
  verify: read the memo call in the diff and look for the number or profile in the commit
  message or the story log
