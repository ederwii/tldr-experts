# Python

This pack covers Python source, its packaging and its tests: where the tooling is declared,
typing and lint signals, exception and logging discipline, async pitfalls, and the commands
the workspace declares. It is deliberately neutral on architecture — framework conventions
arrive as overlays beside this body. Measured repo conventions win over anything below: a
Default applies only where the repo is silent, and a Check's accepted answer is the
project's own convention when it has one.

## Defaults (when the repo is silent)

- Declare dependencies and tool settings in `pyproject.toml` rather than scattering them
  across ad-hoc config files. — overridden by: the config files already committed —
  `setup.cfg`, `tox.ini`, `requirements*.txt`, a tool's own dotfile
- Install and run through the tool the committed lockfile names, and land the lockfile
  change with the dependency change. — overridden by: which lockfile is in the repo —
  `uv.lock`, `poetry.lock`, `Pipfile.lock`, a pinned requirements file
- Annotate new functions in a module that is already annotated, and keep the checker the
  project configures green. — overridden by: the `[tool.mypy]` / `[tool.pyright]` section
  in pyproject or the checker's own config file
- Leave formatting and import order to the formatter the repo configures instead of styling
  by hand. — overridden by: the `[tool.ruff]` / `[tool.black]` / `[tool.isort]` settings
  already present
- Put tests where the test configuration already discovers them, and name them so that the
  discovery pattern picks them up. — overridden by: the `[tool.pytest.ini_options]` section
  or the repo's `conftest.py` layout
- Catch the specific exception you can handle; never write a bare `except:` and never let
  `except Exception` end in `pass`. — overridden by: an error-handling boundary the repo
  already funnels failures through
- Report through `logging` in library code, not `print`, and pass the message template and
  its arguments to the logger separately so formatting stays lazy.
  — overridden by: a logging module or structured-logging setup the repo already exports
- Format strings with f-strings everywhere formatting is eager.
  — overridden by: the string style the module you are editing already uses
- Model data the way the package already does, rather than adding a second modelling style
  beside the first. — overridden by: whether the repo already uses dataclasses, attrs,
  typed dicts, or a validation library
- Import with absolute paths inside the package and never with a star import.
  — overridden by: the relative-import convention the surrounding modules already follow
- Follow the repo's package layout when adding a module, including whether a directory
  needs an `__init__.py`. — overridden by: the existing layout and the `[tool.setuptools]`
  / `[tool.hatch]` packaging block in pyproject
- Pass `None` as a default and build the value inside the function: a list or dict literal
  in a signature is created once at definition and shared by every call.
  — overridden by: an immutable constant the module already uses as a default, such as a
  shared empty tuple
- Acquire files, sockets, locks and connections with `with`, so they close on the failure
  path too. — overridden by: a context manager or resource helper the repo already exports
- Keep blocking work out of coroutines: run it on a thread or process pool rather than on
  the event loop, and await or keep a reference to every task you create.
  — overridden by: an async runner or task-group helper the repo already owns
- Keep tests hermetic: use the framework's temporary-directory fixture, no network, no
  dependence on the developer's own environment.
  — overridden by: a fixture or harness the repo already provides

## Checks (always asked in review)

- Does the diff add a bare `except:` or an `except Exception` that ends in `pass`? verify:
  grep the diff for `except` and read each block
- Did a dependency change land without the matching manifest and lockfile change? verify:
  check whether pyproject or the requirements file and the lockfile are both in this commit
- Does a new function in an annotated module go without annotations? verify: open the file
  and compare the new signatures against the ones already there
- Is `print` used in library code rather than the logger? verify: grep the diff for `print(`
- Did the developer record, beside each new test, that it was seen to fail — what was broken
  and that it went red? verify: read each new test in the diff for that sentence; a new test
  carrying none is a finding, and the test reading correctly is not a substitute for it
- Does the diff pass an interpolated string to `subprocess` with `shell=True`? verify: grep
  the diff for `subprocess` and read the arguments at each hit
- Does new code create mutable state at import time — a module-level list, dict or client?
  verify: read the top-level statements in the files the diff touches
- Is a mutable default argument introduced? verify: grep the diff for `=[]`, `= []`, `={}`, `= {}`
  and `set()` inside parameter lists
- Are the lint, type-check and test commands green on this change, unfiltered? verify: run
  the lint, typecheck and test commands declared in .tldrx/workspace.yml, read each exit
  code, and say so when the workspace leaves a slot empty rather than letting the check pass
- Is a file, connection or lock opened without `with` and closed only on the happy path?
  verify: read each `open(` and connection call added in the diff
- Does a coroutine call something blocking — a synchronous client, a sleep, heavy CPU work?
  verify: follow each call inside every `async def` added in the diff
- Is a task created and neither awaited nor kept, so its exception disappears? verify: grep
  the diff for `create_task` and `ensure_future` and check where each result is held
- Does the diff add a star import or a relative import that breaks the package's convention?
  verify: grep the diff for `import *` and compare the new imports against the module's existing ones
- Is a failure hidden behind a default return value from a call that failed? verify: read
  each fallback added in the diff and ask what a real failure would look like to the caller
- Does a new test write outside the temporary-directory fixture, or reach the network?
  verify: read the new test's setup for absolute paths, shared directories and network calls
- Does this change alter behaviour with no test that would have caught the old behaviour?
  verify: find the assertion in the diff that covers the changed line, or say there is none
