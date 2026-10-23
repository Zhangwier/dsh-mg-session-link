# Main-session handoff

Optional, default-off. This document explains what actually happens, why the order of operations is what it
is, and which states a handoff can get stuck in.

## The problem it solves

A long-running conversation eventually hits its model window. The host's own compaction summarizes older
turns in place and keeps going — it is lossy but it never stops you mid-task. What compaction cannot do is
give the work a *fresh, clean context* with the same files, the same permissions and the same preset.

Handoff is the other tool: at a safe idle point, write a structured brief, open a new main conversation in
the same workspace with the same preset and current default model, seed it with the brief, and route future
input and peer reports there. The old conversation is kept and archived-in-name-only: its title gets a
`· 接续xxxxxx` suffix and it becomes a forwarding relay.

Both mechanisms stay installed. Compaction is the fallback; handoff is opt-in.

## Two switches, deliberately

| Switch | Where | Scope |
|---|---|---|
| `autoHandoff` | Settings → Conversation Collaboration | Global last resort. `false` by default, live-editable |
| This session | `mg_session_handoff action=enable` | One conversation becomes eligible |

Automatic handoff requires **both**. This is not ceremony: a plugin that can migrate any of a user's
conversations cannot have a single global switch as its only guard, and a session-level flag alone would let
a stray enable survive a config change. `action=now` bypasses the *automatic* switch because it is an
explicit instruction, but it is still one-shot — it does not register future eligibility.

## Trigger

`handoffTrigger(metrics, config)` is a small pure function, unit-tested without a host:

```js
if (metrics.turns < config.handoffMinTurns) return null;
if (config.handoffCompactions > 0 && metrics.compactions >= config.handoffCompactions) return 'repeated-compaction';
const threshold = Math.min(config.handoffTokens, metrics.capacity > 0 ? metrics.capacity * config.handoffRatio : Infinity);
return metrics.tokens >= threshold ? 'context-pressure' : null;
```

| Config | Default | Range | Note |
|---|---|---|---|
| `handoffRatio` | 0.75 | 0.2–0.95 | Fraction of the model window |
| `handoffTokens` | 120000 | 8000–1000000 | Absolute ceiling |
| `handoffMinTurns` | 4 | 2–100 | Stops successor chains |
| `handoffCompactions` | 3 | 0–100 | `0` disables the compaction criterion |

The smaller of `handoffTokens` and `capacity × ratio` wins, so a small-window model is never asked to grow
past its own limit and a large-window model still hands off at a sane absolute size. `metrics.tokens` is the
**current context pressure** from the host's token meter, not cumulative billed tokens. With an unknown
capacity (`capacity === 0`) the ratio branch is infinite and only the absolute ceiling applies.

## The transaction

Eight steps, in this order on purpose:

```
1  guard         registered main? idle? not archived? not a subagent? no redirect yet?
2  metrics       measure tokens/turns/compactions
3  reason        manual request, or handoffTrigger()
4  blockers      background activity, owned agents, Team roster, pending inbox, custom permissions
5  mark attempt  record {phase: 'summarizing', sourceRevision}
6  summarize     validateBrief(JSON from one model call)
7  prepare       record {brief, phase: 'prepared'}; create the successor draft (not started)
8  commit        seed brief → flush → redirect(old→new) → record {phase:'committed'} → start successor
```

### Why the brief is written to disk before the route is committed

The brief is the only thing that makes the successor usable. If the process dies between "route committed"
and "brief persisted", the user has a live successor with no instruction and an old conversation that
forwards everything into it. So the brief goes to disk first, then the seed is injected and **flushed**, and
only then is `redirects[old] = new` persisted.

### Why every step re-checks `stable()`

```js
const stable = async () => await this.unchanged(agent, revision) && (reason === 'manual'
  ? this.state.mains[agent.id]?.requested
  : this.config.autoHandoff && this.state.mains[agent.id]?.enabled);
```

`unchanged` requires, simultaneously: the plugin has not been disposed, the agent is still idle, the session
sequence number still equals the revision captured before summarizing, the session is not archived, and
there are still zero blockers. The extra half of `stable()` re-reads the switch that justified the handoff,
so disabling it mid-summary aborts cleanly instead of completing a handoff the user just cancelled.

Summarization takes seconds. New input, a new background job, or a config toggle inside that window are all
realistic. A handoff that races them and wins is worse than one that defers.

### Failure outcomes

| Failure point | `phase` | Consequence |
|---|---|---|
| Guard, blockers, no trigger | — (no record) | Nothing happens; blockers are written into `deferred` for `status` to show |
| `summarize` throws or the brief fails validation | `failed` | Original untouched; nothing created |
| Source changed before `seed` | `failed` | Successor draft archived (it was never woken); original untouched |
| `seed` flush fails | `failed` | Draft discarded; no redirect installed |
| Source changed before commit | `failed` | Draft discarded; original untouched |
| `redirect` throws | `failed` | Draft discarded |
| Commit succeeded, `start` throws | `committed-start-pending` | Successor ID is preserved in the record so it can be opened, not recreated |

The draft is only discarded when it is still an unwoken draft this attempt owns (`discard` checks
`status === 'idle'` and only archives). A committed-but-not-started successor is never archived — losing the
brief would be worse than leaving a draft lying around.

### Forwarding

Once `redirects[old] = new` exists, `beforeStep` on the old conversation returns `{kind: 'reject'}` and
relays the incoming messages to the successor. Claimed originals are appended to the old transcript before
relaying, so the old log is still the record of what arrived. Relay IDs are derived deterministically from
`sha256(source:forward:messageIds)` and skipped if already present — a retried forward does not duplicate.

Peer-task routing follows the same redirect map, so a worker reporting a task to a handed-off main reaches
the successor. Archiving the old main does not break that: `PeerSessions.destination()` walks the map and
the reporter resolves the *destination*, not the original.

### Cycles

`redirect()` refuses a self-redirect, refuses a redirect whose destination maps back to the source, and
re-flattens every existing entry through `destination()` afterwards. `destination()` also detects a cycle
if one is ever loaded from disk.

## Deferral, in detail

`blockers(agent)` collects any of:

- `activity:<kind>` — the host's `workspace/session-activity` reports something in flight
- `owned-agent:<id>` — the main still owns subagents
- `active-team-roster` — this main is a Team lead with more than one member
- `pending-inbox` — unprocessed messages in `nextTurn` or `nextStep`
- `custom-permissions-require-manual-transfer` — the permission preset is `custom`, which cannot be
  transferred safely without a human decision

Any blocker defers the attempt and is surfaced in `status.deferred`. The next `agent/status: idle` event, or
`agent/disposed` firing `reconsider()`, retries.

## State

`handoffs.json`, under `${DSH_HOME}/mg-session-link/<profile>/`:

```json
{
  "version": 1,
  "mains": {
    "session-...": { "enabled": true, "requested": false, "inheritedFrom": "session-...", "lastAttemptSeq": 412, "deferred": ["pending-inbox"] }
  },
  "records": [
    { "id": "handoff-...", "source": "...", "phase": "started", "reason": "context-pressure",
      "metrics": { "tokens": 128340, "turns": 37, "compactions": 1, "capacity": 200000 },
      "sourceRevision": 412, "target": "...", "brief": { "goal": "...", "decisions": [] } }
  ]
}
```

The successor inherits `enabled` from the source (`continueEnabled` is captured before the source is cleared),
so a continuous task keeps getting handoffs. `mg_session_handoff action=now` writes `requested: true` and
leaves `enabled` alone; `disable` clears both.

Writes are serialized through one promise chain and are rollback-aware: a failed write restores the last
durable file rather than the in-memory pre-operation snapshot, so a retry cannot resurrect a state that
never landed.

## Brief schema

`validateBrief` enforces it before anything is created:

| Field | Type | Content |
|---|---|---|
| `goal` | non-empty string | The current user objective |
| `decisions` | string[] | Chosen options, accepted corrections |
| `constraints` | string[] | User requirements, permissions, prohibitions |
| `artifacts` | string[] | Absolute paths, workspace, input versions, key evidence |
| `verified` | string[] | What was actually verified, kept distinct from what was merely done |
| `pending` | string[] | Unfinished work and the concrete reason it is blocked |
| `next_steps` | string[] | Specific next actions |
| `uncertainties` | string[] | Unknowns, unverified items, details the earlier summaries may have dropped |

Serialized size is capped at 40000 characters. The summary call runs with `maxTokens: 6000` and
`purpose: 'compaction'`, with a 180 s timeout, and the model is instructed to output JSON only, run no tools
and write no user-facing answer. Fences are stripped before parsing; anything that is not a valid object
with the required shape fails the handoff rather than seeding a successor with garbage.

## Recovering a stuck handoff

Check `mg_session_handoff action=status` → `last`. Then:

| `phase` | What to do |
|---|---|
| `committed-start-pending` | Open the successor ID in the record. The brief is on disk and the route is live. If it is unusable, `disable` on the old main stops forwarding |
| `failed` | Nothing to repair. Read `error`, fix the cause (usually a blocker or a config window), then enable again |
| `prepared` with no `target` | The draft was discarded. Re-enable |
| `started` | Done. The old conversation is now a relay |

Do not hand-edit `handoffs.json` while the plugin is loaded — in-memory state wins and the next write
clobbers your edit.

## What this does not solve

- **Brief quality is summary quality.** A model that drops a constraint drops it. Anything load-bearing
  belongs in a file, and the brief should point at the file rather than restate it.
- **No mid-turn migration.** A handoff never cancels an in-flight tool call; it waits for idle.
- **No cross-process, cross-machine or cross-user handoff**, same as the rest of the plugin.
- **No history rewrite.** Notices and relays are appended only.
