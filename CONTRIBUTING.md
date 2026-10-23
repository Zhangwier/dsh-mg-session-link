# Contributing

Bug reports, host-compatibility reports and focused patches are all welcome. The plugin talks to
undocumented host internals, so a report that names the host version is worth ten that do not.

## Before you change anything

Read these two, in this order:

1. `docs/HANDOFF.md` — the handoff transaction. The ordering there is load-bearing; several steps look
   reorderable and are not.
2. `lib/core.js` — `mutate()` and `deliver()`. Most of the interesting failure behaviour lives in the
   comment above the rollback branch.

## Ground rules

- **No new runtime dependencies.** The plugin runs inside the host process and is mounted as a link into
  the host's own `node_modules`. Adding a dependency changes what the host has to resolve.
- **No renaming of public surface.** Tool names (`mg_session_*`), argument names, return field names,
  state file names and the settings namespace `mg-session-link` are API. Additive fields are fine.
- **Never weaken a "not done" distinction.** `dispatched` must not become "done", a finished turn must not
  become a finished task, and `completed` must stay the worker's claim. These are the plugin's whole point.
- **Write ordering beats write volume.** Any state write that another step depends on has to be durable
  before that step runs. Do not batch a critical write with a non-critical one.
- **Prefer a refusal to a partial success.** If the profile, lockfile or brief does not look the way it
  should, throw and leave the live files untouched. `tools/install.mjs` and `tools/registration.mjs` are
  the reference implementations of that attitude.

## Running things

```bash
npm install                # js-yaml + the host LLM package used by tests
npm test                   # 31 tests, temporary state only
npm run install:status     # read-only: is it installed, is it selected, is a legacy mount present
npm run verify:host        # real isolated host boot; needs a local DSH install, not run in CI
```

`npm test` must never read or write your real conversations, credentials or profile. If a new test needs
host shape, build a fake in `test/` the way `test/core.test.mjs` does with `PeerSessions`.

`npm run verify:host` creates a temporary `DSH_HOME`, boots the real host with Teams and the archive manager,
and drives all seven tools. It writes `verification-host.json` on success — that file is gitignored because it
contains absolute paths and live session IDs.

## If you touch the installer

The installer edits three live files in the user's profile. Two invariants are asserted in
`tools/registration.mjs` and must stay asserted:

1. Every dependency other than this package is byte-identical after the edit.
2. Every lockfile entry other than this package's importer row is deep-equal after the edit.

It also stages the final manifest + lock + patch in a temporary profile and runs the host's own
`--dump-config` before touching anything live. Keep the preflight — it is what stops a bad edit from
bricking a working profile.

## If you touch handoff

Change `handoffTrigger` only with a test that states the numeric expectation. Add a case to
`test/handoff.test.mjs` for each new failure path, with these names spelled out: what changed, what is
preserved, what phase the record ends in. The existing tests are the specification; when one of them fails,
assume the code is wrong, not the test.

## Host compatibility

The adapter surface is not stable. Verified against host `0.2.1-rc.2`. If a host bump breaks something,
`npm run verify:host` fails first — that is by design. When opening an issue, include:

- host version (`dsh --version`) and platform
- which of `npm test` / `npm run install:status` / `npm run verify:host` fails
- the exact error, plus the `phase` from `mg_session_handoff action=status` if it is a handoff problem

## Commits and PRs

Conventional-commit-ish subjects (`fix:`, `feat:`, `docs:`, `test:`) are appreciated, not enforced. One
concern per change. If behaviour changes, `CHANGELOG.md` gets an entry — the version is bumped by the
maintainer, not by the PR.

## License

MIT. By contributing you agree your contribution is licensed the same way.
