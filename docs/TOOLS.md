# Tool reference

Seven tools, all registered under the `mg_session_*` prefix. They are only available to ordinary user
conversations; a subagent gets a clear error message instead of a half-working edge.

Every tool returns a single JSON text block. Field names are stable; treat unknown fields as additive.

Common argument:

| Name | Type | Meaning |
|---|---|---|
| `all_workspaces` | boolean, default `false` | Explicitly widen the search to every workspace. Without it, only conversations whose `cwd` matches the caller's are visible — on Windows the comparison is case-insensitive and trailing separators are ignored. |

---

## `mg_session_list`

Find peers. Read-only: it never wakes, activates or touches a conversation.

| Arg | Type | Meaning |
|---|---|---|
| `query` | string | Case-insensitive substring over ID, handle, title and cwd |
| `all_workspaces` | boolean | See above |
| `limit` | integer 1–100, default 30 | Result cap |

Returns `{ self, total, items[] }` where each item is:

```json
{
  "id": "session-...",
  "handle": "s-a1b2c3d4e5f6",
  "title": "前端",
  "cwd": "D:\\work\\app",
  "state": "running | idle | closed",
  "self": false
}
```

Excluded by design: archived conversations, blank conversations, subagent sessions, and rows without a
working directory. `total` counts matches before `limit` is applied.

`handle` is a stable short form of the session ID (`s-` plus the first 12 hex characters of the ID with
dashes removed). Prefer it over a title whenever a name could collide.

---

## `mg_session_delegate`

Create a durable task record and deliver it.

| Arg | Type | Required | Meaning |
|---|---|---|---|
| `target` | string | yes | Exact session ID, exact `handle`, exact title, or an unambiguous title substring. 1–300 chars |
| `task` | string | yes | Scope, input paths, output paths, acceptance criteria. 1–24000 chars |
| `mode` | `auto` \| `queue` \| `steer` | no | Delivery timing; see below |
| `all_workspaces` | boolean | no | Widen target resolution |
| `request_id` | string | no | Idempotency key ≤ 200 chars |

Returns the stored task: `id`, `sender`, `target`, `requestedTarget`, `task`, `status`, `messageId`,
`notification`, `createdAt`, `updatedAt`, plus `mode` once delivered, or `error` when delivery is
uncertain, and `duplicate: true` on an idempotent replay.

Resolution order for `target`: exact ID or handle → exact title → unique title substring. Zero matches and
multiple matches both fail, and the ambiguity error carries up to 12 candidate descriptors so the caller
can pick a handle instead of guessing.

`request_id` semantics: a replay with the same `request_id`, same `task` text and same `requestedTarget`
returns the original record with `duplicate: true`. Reusing a `request_id` for different content is an
error. When `request_id` is omitted the host's tool-call ID is used, so a retried identical call is also
deduplicated.

Task history is capped at 500 records. When full, the oldest task that is terminal (`completed` / `failed` /
`blocked`) **and** already notified is evicted. If every record is unfinished the call fails — resolve
tasks instead of silently dropping them.

---

## `mg_session_send`

Ask a question, add a requirement, or answer. Same resolution and `mode` as `delegate`, minus the task
record. Returns `{ delivered, message_id, target, mode, meaning }`.

Use this for conversation. Use `delegate` when you need a tracked obligation and an explicit report.

---

## `mg_session_status`

Read-only progress probe. Does not wake the target.

| Arg | Type | Required |
|---|---|---|
| `target` | string | yes |
| `all_workspaces` | boolean | no |

Returns the `list` descriptor plus:

| Field | Meaning |
|---|---|
| `state` | Live agent status, or `closed` when no agent is resident |
| `last_assistant_text` | Tail of the most recent assistant message (≤ 5000 chars) |
| `last_user_text` | Tail of the most recent user message (≤ 1500 chars) |
| `last_tool` | Name of the most recent tool call |
| `last_turn_end` | Reason of the most recent `turn/end` |
| `pending` | `{ next_turn, next_step }` inbox depth, or `null` when closed |

The `note` field exists because this is the single most common misreading: a finished turn and a plausible
last message do **not** mean the task is done. Only an explicit report does.

---

## `mg_session_tasks`

The task ledger for this conversation — both dispatched and received. Newest first.

| Arg | Type | Meaning |
|---|---|---|
| `task_id` | string | Restrict to one task |
| `limit` | integer 1–100, default 20 | Result cap |

Returns `{ total, items[] }`. `total` is the count before `limit`.

Status progression for a dispatched task:

```
preparing → dispatched ──────────────→ completed | blocked | failed
         ↘ delivery_uncertain
```

`delivery_uncertain` means delivery or durability could not be confirmed. The message may well have
arrived. Inspect the target and the record before re-dispatching — blind retries are how duplicate work
happens.

`notification` is `none`, `pending` or `delivered`. `pending` means the report is saved but the dispatcher
could not be reached (for example it is archived). Once it is reachable, submitting the same report again
retries the notification; the native message ID makes that idempotent.

---

## `mg_session_report`

Worker side. Only the assigned target conversation may report a task.

| Arg | Type | Required | Meaning |
|---|---|---|---|
| `task_id` | string | yes | The ID from the delegate message |
| `status` | `completed` \| `blocked` \| `failed` | yes | Explicit outcome |
| `result` | string | yes | What was actually produced, absolute artifact paths, what was verified, what is still open |

A second, *different* final report on the same task is rejected — delegate a follow-up task instead. An
identical replay is accepted and only retries a pending notification.

`completed` is the worker's own claim, not an independent verification. The dispatcher still has to check
it against the user's acceptance criteria.

---

## `mg_session_handoff`

| Arg | Meaning |
|---|---|
| `action=status` | Master switch, this session's registration, trigger thresholds, current successor, deferral reasons, last record |
| `action=enable` | Register this conversation as a main session eligible for automatic handoff (still requires the global switch) |
| `action=disable` | Unregister and cancel a pending `now`; already-committed routes keep forwarding |
| `action=now` | One explicit handoff, executed at the next idle safe point; costs one model call |

See [HANDOFF.md](HANDOFF.md) for the transaction and the deferral rules.

---

## Errors worth recognising

| Message | Cause |
|---|---|
| `Peer tools require an ordinary user conversation; use Teams for subagents.` | Called from a subagent session |
| `Target is unavailable, archived, a subagent, or outside this workspace.` | Nothing matched, or the row is filtered out |
| `Ambiguous target; use an exact id or handle: [...]` | Multiple title matches — use `handle` |
| `Target must be a different conversation.` | Target resolves to the caller |
| `Target was archived or became a subagent before delivery.` | Archived between resolution and delivery |
| `Message <id> entered the inbox but durability is uncertain. Do not blindly resend; inspect the target.` | Native delivery succeeded, checkpoint failed |
| `Only the assigned target conversation may report this task.` | Wrong reporter |
| `This task already has a final report.` | Second differing final report |
| `Task history is full of unfinished tasks; resolve them before adding more.` | 500 unfinished records |
| `request_id was already used for a different task.` | Idempotency key reused with different content |
| `Cannot read task state <path>; original file preserved` | Corrupt state file; the file is left untouched |
