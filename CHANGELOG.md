# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The host version this plugin was verified
against is pinned in `README.md`; a host minor bump can break the adapter contract even when the plugin
version does not change.

## 0.2.0

Opt-in main-session handoff.

- New: `mg_session_handoff` tool with `status` / `enable` / `disable` / `now`.
- New: `lib/handoff.js` — trigger math, brief validation, handoff transaction, forwarding.
- New: `lib/handoff-host.js` — real-host adapter (token meter, blockers, LLM summarization, successor
  creation and seeding).
- New: five live-editable settings (`autoHandoff`, `handoffRatio`, `handoffTokens`, `handoffMinTurns`,
  `handoffCompactions`). Automatic handoff is off by default and additionally requires per-session
  registration.
- New: task routing follows handoff redirects, so a worker's report reaches the successor main session.
- Changed: install is a managed local bundle (profile `dependencies` + `dsh.profile.bundles` + matching
  lockfile importer) instead of a hand-written `cordis.patch.yml` insert. The old mounted block is removed
  on install to avoid double registration. This is what makes the plugin visible on the management page.
- Changed: locale metadata (`locale/zh.json`, `locale/en.json`) so the management page shows a real name
  and description instead of a package ID.
- Fixed: task-state writes restore the last *durable* state on failure rather than the pre-operation
  snapshot, so a retried send cannot duplicate an already delivered message.
- Tests: 31 (13 core, 16 handoff, 2 registration).

## 0.1.0

Initial peer delegation.

- Six tools: `mg_session_list`, `mg_session_delegate`, `mg_session_send`, `mg_session_status`,
  `mg_session_tasks`, `mg_session_report`.
- Addressing by exact ID, short handle, exact title or unique title substring, with explicit ambiguity
  errors.
- Visibility rules: same working directory by default, archives / blank sessions / subagents excluded,
  `all_workspaces` to widen.
- Durable task records with idempotent `request_id`, a 500-record cap and eviction of the oldest
  completed-and-notified task.
- Delivery modes `auto` / `queue` / `steer`, with `dispatched` strictly distinguished from `completed`.
- Report routing with retryable, de-duplicated notification when the dispatcher is unreachable.
