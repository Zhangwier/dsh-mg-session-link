# dsh-mg-session-link

[![CI](https://github.com/Zhangwier/dsh-mg-session-link/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhangwier/dsh-mg-session-link/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A522-3c873a)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Hand work from one existing [DeepSeek Harness](https://github.com/deepseek-ai/dsh) conversation to another.
Each conversation keeps its own history, working directory, model and tool permissions;
the dispatching conversation gets told when the working conversation reports back.

No new server, no extra port, no second runtime. It registers seven `mg_session_*` tools and one
paragraph of collaboration policy into the host you already run.

---

## Contents

- [Why](#why)
- [What it is not](#what-it-is-not)
- [Requirements](#requirements)
- [Install](#install)
- [Use](#use)
- [Tools](#tools)
- [Delivery and report semantics](#delivery-and-report-semantics)
- [Opt-in main-session handoff](#opt-in-main-session-handoff)
- [Configuration](#configuration)
- [State files](#state-files)
- [Remove](#remove)
- [Tests](#tests)
- [Repository layout](#repository-layout)
- [Boundaries](#boundaries)
- [Prior art](#prior-art)
- [Contributing](#contributing)
- [中文速查](#中文速查)

## Why

A single conversation that both plans and executes grows long. Compression keeps it alive but loses the
thread, and splitting the work into subagents loses the ability to hand something to a *conversation the
user already has open* — with its own files, its own pinned model, its own permission preset.

This plugin adds exactly that one edge: conversation → conversation. The dispatch is a durable task with
an ID, not a fire-and-forget message. The receiving side has to report `completed` / `blocked` / `failed`
explicitly; a finished turn is never silently treated as a finished task.

## What it is not

- Not a subagent spawner. Subagents are host-owned, ephemeral and not addressable — use the built-in
  `subagent` / Agent Teams tools for those. This plugin deliberately excludes `origin: subagent` sessions.
- Not cross-process. Two separate `dsh` processes, two machines, or two users do not see each other.
- Not a history copier. You send a task brief (scope, paths, acceptance criteria), not a transcript.
- Not Team Lead reassignment. Agent Teams keeps its own tools and rules; this plugin does not shadow
  `send_message` or any Teams tool.

## Requirements

| | |
|---|---|
| Host | DeepSeek Harness `0.2.1-rc.2` (verified against a live install) |
| Node | `>= 22` |
| Profile | Any profile resolvable as `<DSH_HOME>/profiles/<name>`; `web` by default |
| Layout | The plugin directory must survive — it is mounted as a junction/symlink, not copied |

`node_modules` in this repository is a junction to the host's own `node_modules`. The plugin uses the
host's `@deepseek-ai/*` packages directly instead of installing a second runtime. If you copy the
directory to another machine, delete `node_modules` and let the installer recreate the link.

## Install

```bash
git clone https://github.com/Zhangwier/dsh-mg-session-link.git
cd dsh-mg-session-link
node tools/install.mjs --status    # inspect current state, changes nothing
node tools/install.mjs --enable    # register as a managed local bundle
node tools/install.mjs --disable   # stop loading, keep the install and task data
```

`--enable` does not run `pnpm install` and does not upgrade anything. It performs three edits and keeps
every other entry byte-identical:

1. the profile `package.json` gets `"dsh-mg-session-link": "link:<abs path>"` in `dependencies`;
2. the same package name is appended to `dsh.profile.bundles`;
3. the matching root-importer entry is written into `pnpm-lock.yaml`.

Before touching live files it copies them into `<DSH_HOME>/backups/mg-session-link-managed-<stamp>/`, then
stages the *final* manifest + lock + patch into a temporary profile and runs the host's own
`--dump-config` on it. If that preflight fails, the live profile is untouched. It then re-reads the live
files to confirm nothing changed underneath, and refuses if a concurrent edit landed.

If your profile was previously mounted by a hand-written `cordis.patch.yml` block (the marker
`# BEGIN MG SESSION LINK`), the installer removes that block — the managed bundle supersedes it and
loading both would register the tools twice.

The web profile has config hot reload on, so a running session picks the plugin up without a restart.
The management page (Settings → Plugins → Installed) finds it as **会话协作 / Conversation
Collaboration**; refresh the page if it was already open.

## Use

Talk to the dispatching conversation in natural language. The plugin's policy paragraph teaches the model
when to reach for the tools.

> List the sessions in this workspace, find "frontend", and have it do the login page. Give it the scope,
> the input files and the acceptance criteria; report back here. You keep working on the backend.

Follow-ups:

> Tell "frontend" the login endpoint moved to `/api/v2/auth`, field name `accessToken`.

> Where is "frontend" now? Then list the tasks I dispatched and their reports.

Across workspaces:

> Find the session titled "drawing review" in another workspace and ask it what the last calculation was
> based on and where the output went.

Name collisions are resolved by the host, not guessed: with two sessions called "会话2" the tool returns
both candidates and the model has to use the unique `handle` or the full session ID. `mg_session_list`
returns a `handle` like `s-a1b2c3d4e5f6` for exactly this purpose.

To make the receiving side cooperate, it is enough that it follows its own instructions — the delegate
message already carries the task ID, the report requirement and the acceptance criteria. You can also say
it explicitly:

> When you are done, call `mg_session_report` with the task ID, the absolute paths of what you produced,
> what you actually verified, and what is still open.

## Tools

| Tool | Purpose |
|---|---|
| `mg_session_list` | Find peer conversations by title, directory or ID. Returns a unique `handle`. Never wakes anyone. |
| `mg_session_delegate` | Create a durable task and deliver it. Returns a task ID; supports `request_id` for idempotent retries. |
| `mg_session_send` | Ask a question, add a requirement, or answer. Delivery only — not completion. |
| `mg_session_status` | Read-only: run state, last assistant text, active tools, queued count. Does not wake the target. |
| `mg_session_tasks` | The tasks this conversation dispatched or received, with their reports. |
| `mg_session_report` | Worker side: report `completed` / `blocked` / `failed` for an assigned task; notifies the dispatcher. |
| `mg_session_handoff` | `status` / `enable` / `disable` / `now` for opt-in main-session handoff. |

Full parameter and return-shape reference: [docs/TOOLS.md](docs/TOOLS.md).

## Delivery and report semantics

- `dispatched` — the message entered the target's native queue and a durability checkpoint passed.
  This is **not** "read", and definitely not "done".
- `delivery_uncertain` — delivery or persistence is in doubt. Inspect the target and the task record
  before retrying; blind re-dispatch is how you get duplicate work.
- `completed` / `blocked` / `failed` — an explicit report from the assigned conversation. `completed` is
  the worker's own claim; the dispatcher still has to check it against the user's criteria.
- `notification: pending` — the report is saved but the notification has not landed (for example the
  dispatcher was archived). Once it is reachable, re-submitting the same report retries the notification;
  the native message ID de-duplicates it.

`mode` controls *when* the message lands, not whether it interrupts:

| mode | Behaviour |
|---|---|
| `auto` (default) | Target busy → next step; target idle → new turn |
| `queue` | Wait for the next turn |
| `steer` | Deliver at the next step boundary |

No mode cancels a tool call already in flight.

## Opt-in main-session handoff

A separate, **default-off** feature: when a *registered* main conversation approaches its model window,
the plugin summarizes it into a structured brief and continues the work in a fresh main conversation with
the same working directory, agent preset and current default model. The old conversation is kept, gets
its title suffixed `· 接续xxxxxx`, and forwards later human input and worker reports to its successor.

Two switches, on purpose — a global one so no user session is ever migrated by surprise:

1. **Settings → Conversation Collaboration → `autoHandoff`** (namespace `mg-session-link`). Live-editable,
   no plugin reload.
2. In the specific main conversation: *"make this session the main session and enable auto handoff"* →
   the model calls `mg_session_handoff` with `action=enable`.

Trigger defaults (all adjustable in the same form):

| Field | Default | Meaning |
|---|---|---|
| `autoHandoff` | `false` | Master switch; applies only to registered mains |
| `handoffRatio` | `0.75` | Fraction of the known model window |
| `handoffTokens` | `120000` | Absolute context ceiling; the *smaller* of this and the ratio wins. Not cumulative billed tokens |
| `handoffMinTurns` | `4` | Minimum completed turns, so a successor does not immediately chain again |
| `handoffCompactions` | `3` | Or this many native compactions; `0` disables this criterion |

The handoff runs only at an idle safe point. It defers — and says why in `status` — while the main still
owns subagents, active Team members, background jobs, pending input or custom permissions. The host's
normal compaction stays in place as the fallback; an in-flight tool call is never cancelled.

Ordering is brief-first: the validated handoff brief is written to disk, *then* the forwarding route is
committed, *then* the successor starts. New input arriving during summarization invalidates the
uncommitted transfer and leaves the original intact. If the route was committed but the successor failed
to start, the successor ID stays in state so it can be opened instead of being blindly recreated.

`action=now` is one-shot and only on an explicit user request; it executes after the current turn ends and
costs one extra model call to write the brief. `disable` cancels a pending `now` and any future automatic
eligibility, without breaking routes already committed.

Design notes and the state machine: [docs/HANDOFF.md](docs/HANDOFF.md).

## Configuration

Host settings namespace `mg-session-link`; the five fields above are the whole surface. There is no env
var, no config file of its own, and nothing is read from the plugin directory at runtime.

State root: `${DSH_HOME:-~/.dsh}/mg-session-link/<profile>/`.

## State files

| File | Contents |
|---|---|
| `tasks.json` | Tasks, reports, redirect map. Capped at 500 records; eviction prefers the oldest completed *and* notified task. Native messages stay in the host's own session persistence |
| `handoffs.json` | Registered mains, briefs, handoff records |
| `runtime.json` | Load PID and tool names. A stale record after a crash is possible — cross-check the PID |

Writes are atomic (`write temp → rename`). A failed write rolls back to the last durable state, not to the
pre-operation snapshot, so a retry cannot silently duplicate an already-delivered message.

## Remove

```bash
node tools/install.mjs --disable
```

That unselects the bundle and keeps the install record, task data and settings. To remove it completely,
delete the `node_modules/dsh-mg-session-link` link and the `dependencies` / `dsh.profile.bundles` entries
from the profile `package.json`, then restart the host. Restore from the newest
`<DSH_HOME>/backups/mg-session-link-managed-*` directory if a manual edit goes wrong.

## Tests

```bash
npm test          # 31 tests: peer core, handoff state machine, managed registration
npm run verify:host   # real isolated DSH boot (needs a local host install; not run in CI)
```

`npm test` uses temporary state only: it does not read your conversations, credentials or profile. The
coverage is:

| Suite | Tests | Covers |
|---|---|---|
| `test/core.test.mjs` | 13 | Visibility rules (archive/blank/subagent/workspace), addressing and ambiguity, delivery modes, durability, idempotent `request_id`, report routing and notification retry |
| `test/handoff.test.mjs` | 16 | Threshold math, safety stop points, input races, failure fallbacks, route inheritance, cancellation, persistence recovery |
| `test/registration.test.mjs` | 2 | Managed registration is byte-faithful outside this plugin, idempotent, and keeps the package discoverable when disabled |

`npm run verify:host` boots a real host in a temporary `DSH_HOME` with Teams and the archive manager
loaded, exercises all seven tools natively, and checks cold replay from the v4 session log. It requires a
local host install and is intentionally excluded from CI.

## Repository layout

```
lib/index.js            plugin entry: tool definitions, policy section, lifecycle hooks
lib/core.js             JsonStore + PeerSessions (addressing, delivery, task state)
lib/handoff.js          trigger math, brief validation, handoff transaction
lib/handoff-host.js     real-host adapter for the handoff path
tools/install.mjs       managed registration with preflight and backup
tools/registration.mjs  the profile/lockfile edit, pure and unit-tested
tools/verify-host.mjs   isolated real-host integration run
tools/check-live.mjs    read-only live probe (mounts briefly, writes evidence, unmounts)
test/                   31 tests, temporary state only
docs/TOOLS.md           arguments, return shapes, error catalogue
docs/HANDOFF.md         handoff transaction, state machine, recovery
locale/{zh,en}.json     management-page title and description
cordis.patch.yml        bundle row
```

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Version history: [CHANGELOG.md](CHANGELOG.md).

## Boundaries

- Same host process only. Multiple `dsh` processes, other users, remote machines: not connected.
- No automatic file arbitration. Two workers editing one repository need an explicit owner or separate
  worktrees — that is a human/orchestrator decision, not something this plugin can infer.
- "Turn finished" is never "task finished". Without a report, the dispatcher must ask again.
- Handoff quality is summarization quality. Compression and handoff both lose detail; important facts
  belong in files and in the brief, and should be re-read from the original conversation when it matters.
- Rewriting history is out of scope. Handoff notifications and forwarded messages are appended only.
- The tools assume ordinary user conversations. A subagent gets a clear error rather than a half-working
  edge.

## Prior art

Compared before writing this, and deliberately not vendored:

- [dsh-conversation-link](https://github.com/duanyunlun/dsh-conversation-link)
- [dsh-crosstalk](https://github.com/Jesse-njx/dsh-crosstalk)
- [dsh-cross-session](https://github.com/Wha1eChai/dsh-cross-session)

This implementation was written independently and verified against the host interfaces on
`0.2.1-rc.2`. See [docs/HANDOFF.md](docs/HANDOFF.md) for why the handoff transaction is written the way
it is, and [CHANGELOG.md](CHANGELOG.md) for what changed between versions.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Two things will save you a rewrite: the plugin runs inside the
host process and therefore takes no new runtime dependencies, and the tool names / argument names / state
file names / settings namespace are treated as published API.

Bug reports are most useful with the host version and the exact command that failed. The adapter talks to
undocumented host internals, so a report that names `0.2.1-rc.2` versus something else is worth far more
than a stack trace alone.

## 中文速查

**一句话**：让一个已经开着的 DSH 会话，把活派给另一个已经开着的会话，并且必须明确回报。

```bash
node tools/install.mjs --enable    # 登记并热加载
node tools/install.mjs --disable   # 停用（保留安装与任务数据）
npm test                           # 31 项测试，用临时状态，不碰你的会话
```

- 7 个工具：`mg_session_list` / `delegate` / `send` / `status` / `tasks` / `report` / `handoff`。
- `dispatched` 只代表投递进了对方队列，不代表已读、更不代表做完；只有 `completed`/`blocked`/`failed`
  才是工作会话的明确回报，而且 `completed` 仍需按你的验收标准复核。
- 自动交接默认关闭，需要「配置页总开关 + 在主会话里显式 enable」两道；只在空闲安全停点执行，
  旧会话保留，输入与回报自动转发给后继。
- 同一个宿主进程内才通；跨进程、跨机器、跨用户不通。
- 任务记录上限 500 条，淘汰时优先删「已完成且已通知」的最早记录。
