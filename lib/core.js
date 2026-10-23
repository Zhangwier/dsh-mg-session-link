import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const SOURCE = 'plugin:dsh-mg-session-link';
const TERMINAL = new Set(['completed', 'blocked', 'failed']);
const clone = value => structuredClone(value);
const textOf = message => (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
export const shortId = id => `s-${id.replace(/^session-/, '').replaceAll('-', '').slice(0, 12)}`;
const normalizedPath = p => {
  const value = resolve(p || '.').replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
const boundedText = (value, name, max = 24000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must contain 1-${max} characters`);
  return value.trim();
};

/** Single-runtime atomic state. The host already owns exclusive session writers. */
export class JsonStore {
  constructor(file) { this.file = file; }
  async load() {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.tasks)) throw new Error('unsupported task state');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, tasks: [] };
      throw new Error(`Cannot read task state ${this.file}; original file preserved`, { cause: error });
    }
  }
  async save(state) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, this.file);
  }
}

/** Host interface: list, agent, inspect, message, deliver and checkpoint. */
export class PeerSessions {
  constructor(host, store, options = {}) {
    this.host = host;
    this.store = store;
    this.maxTasks = options.maxTasks ?? 500;
    this.tail = Promise.resolve();
    this.ready = store.load().then(state => { this.state = state; });
  }
  async settled() { await this.ready; await this.tail; }
  mutate(fn) {
    const operation = this.tail.then(async () => {
      await this.ready;
      // Rollback failed state-file writes rather than retaining unpersisted state.
      const previous = clone(this.state);
      try { return await fn(); } catch (error) {
        // A send may already have happened. Restore the last durable outbox,
        // not the pre-operation snapshot, so a retry cannot silently duplicate it.
        try { this.state = await this.store.load(); } catch { this.state = previous; }
        throw error;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  assertCaller(caller) {
    if (!caller?.id || caller.session?.header.origin === 'subagent') throw new Error('Peer tools require an ordinary user conversation; use Teams for subagents.');
    if (!caller.session?.header.cwd) throw new Error('Calling conversation has no working directory.');
  }
  destination(id) {
    const seen = new Set();
    while (this.state?.redirects?.[id]) {
      if (seen.has(id)) throw new Error('Invalid session handoff cycle');
      seen.add(id);
      id = this.state.redirects[id];
    }
    return id;
  }
  redirect(source, successor) {
    return this.mutate(async () => {
      if (source === successor || this.destination(successor) === source) throw new Error('Invalid session handoff destination');
      this.state.redirects ??= {};
      this.state.redirects[source] = this.destination(successor);
      for (const id of Object.keys(this.state.redirects)) this.state.redirects[id] = this.destination(id);
      await this.store.save(this.state);
    });
  }
  async visible(caller, allWorkspaces = false, signal) {
    this.assertCaller(caller);
    signal?.throwIfAborted();
    const rows = await this.host.list(signal);
    const archived = new Set(this.host.archived());
    return rows.filter(row => row.origin !== 'subagent' && !archived.has(row.sessionId) && !row.blank && row.cwd &&
      (allWorkspaces || normalizedPath(row.cwd) === normalizedPath(caller.session.header.cwd)));
  }
  describe(row, caller) {
    return {
      id: row.sessionId, handle: shortId(row.sessionId),
      title: row.projections?.values?.title || '(未命名会话)', cwd: row.cwd,
      state: row.running ? 'running' : row.agentAvailable ? 'idle' : 'closed',
      self: row.sessionId === caller.id,
    };
  }
  async list(caller, args = {}, signal) {
    const rows = await this.visible(caller, args.all_workspaces, signal);
    const query = (args.query ?? '').trim().toLowerCase();
    const items = rows.map(row => this.describe(row, caller)).filter(row => !query ||
      [row.id, row.handle, row.title, row.cwd].some(s => s.toLowerCase().includes(query)));
    const limit = Math.min(100, Math.max(1, args.limit ?? 30));
    return { self: caller.id, total: items.length, items: items.slice(0, limit) };
  }
  async target(caller, target, allWorkspaces, signal) {
    await this.ready;
    const query = this.destination(boundedText(target, 'target', 300)).toLowerCase();
    const rows = await this.visible(caller, allWorkspaces, signal);
    const exact = rows.filter(row => row.sessionId.toLowerCase() === query || shortId(row.sessionId).toLowerCase() === query);
    const named = rows.filter(row => (row.projections?.values?.title ?? '').toLowerCase() === query);
    const candidates = exact.length ? exact : named.length ? named : rows.filter(row =>
      (row.projections?.values?.title ?? '').toLowerCase().includes(query));
    if (candidates.length !== 1) {
      if (candidates.length > 1) throw new Error(`Ambiguous target; use an exact id or handle: ${JSON.stringify(candidates.slice(0, 12).map(row => this.describe(row, caller)))}`);
      throw new Error('Target is unavailable, archived, a subagent, or outside this workspace. List conversations first; all_workspaces=true explicitly allows other workspaces.');
    }
    const row = candidates[0];
    if (row.sessionId === caller.id) throw new Error('Target must be a different conversation.');
    return row;
  }
  async deliver(caller, row, text, { mode = 'auto', taskId, kind = 'message', messageId, signal } = {}) {
    if (!['auto', 'queue', 'steer'].includes(mode)) throw new Error('mode must be auto, queue, or steer');
    signal?.throwIfAborted();
    await this.ready;
    const agent = await this.host.agent(this.destination(row.sessionId));
    signal?.throwIfAborted();
    // Recheck after a cold resume, since archiving can race with activation.
    if (this.host.archived().includes(row.sessionId) || agent.session.header.origin === 'subagent') throw new Error('Target was archived or became a subagent before delivery.');
    const actualMode = mode === 'auto' ? (agent.status === 'running' ? 'steer' : 'queue') : mode;
    if (messageId && this.host.hasMessage(agent, messageId)) {
      await this.host.checkpoint(agent);
      return { delivered: true, duplicate: true, message_id: messageId, target: agent.id, mode: actualMode };
    }
    const heading = `[跨会话${kind === 'task' ? '任务' : kind === 'report' ? '回报' : '消息'}，来自 ${shortId(caller.id)}]\n发送方会话 ID: ${caller.id}\n${taskId ? `任务 ID: ${taskId}\n` : ''}`;
    const instruction = kind === 'task'
      ? '\n这是用户授权的会话协作请求。保留自己的上下文、工具权限和既定范围；遇到冲突先说明。完成或受阻后调用 mg_session_report，使用上述任务 ID，附成果路径、实际验证和未完成项。'
      : kind === 'report'
        ? '\n这是工作会话的自述回报，协调方应按用户要求判断是否需要复核；无需为收到回报再发确认消息。'
        : '\n这是平级会话发来的消息；需要回答时用 mg_session_send 发给上述发送方 ID。';
    const message = this.host.message({
      ...(messageId ? { id: messageId } : {}),
      content: [{ type: 'text', text: `${heading}\n${text}${instruction}` }],
      source: { kind: SOURCE, form: 'relay', summary: `会话协作 · ${kind}${taskId ? ` · ${taskId}` : ''}`, senderSessionId: caller.id, ...(taskId ? { taskId } : {}), relayKind: kind },
    });
    this.host.deliver(agent, message, actualMode);
    try { await this.host.checkpoint(agent); } catch (error) {
      // Already in the native inbox: never pretend the send failed cleanly.
      throw new Error(`Message ${message.id} entered the inbox but durability is uncertain. Do not blindly resend; inspect the target. ${error.message}`);
    }
    return { delivered: true, message_id: message.id, target: agent.id, mode: actualMode, meaning: '已进入目标会话队列并完成持久化检查；不表示工作已完成。' };
  }
  async send(caller, args, signal) {
    const text = boundedText(args.message, 'message');
    const row = await this.target(caller, args.target, args.all_workspaces, signal);
    return this.deliver(caller, row, text, { mode: args.mode, signal });
  }
  delegate(caller, args, signal, callId) {
    return this.mutate(async () => {
      this.assertCaller(caller);
      const message = boundedText(args.task, 'task');
      const requestId = args.request_id || callId;
      if (requestId) {
        boundedText(requestId, 'request_id', 200);
        const previous = this.state.tasks.find(task => this.destination(task.sender) === caller.id && task.requestId === requestId);
        if (previous) {
          if (previous.task !== message || previous.requestedTarget !== args.target) throw new Error('request_id was already used for a different task.');
          return { ...clone(previous), duplicate: true };
        }
      }
      const row = await this.target(caller, args.target, args.all_workspaces, signal);
      if (!['auto', 'queue', 'steer', undefined].includes(args.mode)) throw new Error('Invalid mode');
      if (this.state.tasks.length >= this.maxTasks) {
        const removable = this.state.tasks.findIndex(task => TERMINAL.has(task.status) && task.notification === 'delivered');
        if (removable < 0) throw new Error('Task history is full of unfinished tasks; resolve them before adding more.');
        this.state.tasks.splice(removable, 1);
      }
      const task = {
        id: `task-${randomUUID()}`, sender: caller.id, target: row.sessionId,
        requestedTarget: args.target, ...(requestId ? { requestId } : {}),
        task: message, status: 'preparing', createdAt: Date.now(), updatedAt: Date.now(),
        messageId: randomUUID(), notification: 'none',
      };
      this.state.tasks.push(task);
      await this.store.save(this.state);
      try {
        const receipt = await this.deliver(caller, row, message, { mode: args.mode, taskId: task.id, kind: 'task', messageId: task.messageId, signal });
        task.status = 'dispatched';
        task.mode = receipt.mode;
      } catch (error) {
        task.status = 'delivery_uncertain';
        task.error = String(error.message).slice(0, 1200);
      }
      task.updatedAt = Date.now();
      await this.store.save(this.state);
      return clone(task);
    });
  }
  report(caller, args, signal) {
    return this.mutate(async () => {
      this.assertCaller(caller);
      const task = this.state.tasks.find(item => item.id === args.task_id);
      if (!task || this.destination(task.target) !== caller.id) throw new Error('Only the assigned target conversation may report this task.');
      const status = args.status ?? 'completed';
      if (!TERMINAL.has(status)) throw new Error('status must be completed, blocked, or failed');
      const result = boundedText(args.result, 'result');
      if (TERMINAL.has(task.status) && (task.result !== result || task.status !== status)) throw new Error('This task already has a final report. Ask the coordinator to delegate a follow-up task.');
      task.status = status;
      task.result = result;
      task.updatedAt = Date.now();
      task.notification = task.notification === 'delivered' ? 'delivered' : 'pending';
      task.reportMessageId ??= randomUUID();
      await this.store.save(this.state);
      if (task.notification !== 'delivered') {
        try {
          const row = await this.target(caller, task.sender, true, signal);
          await this.deliver(caller, row, `任务状态：${status}\n\n${result}`, { kind: 'report', taskId: task.id, messageId: task.reportMessageId, signal });
          task.notification = 'delivered';
          delete task.notificationError;
        } catch (error) {
          // Saved results remain available even when the coordinator is archived.
          task.notification = 'pending';
          task.notificationError = String(error.message).slice(0, 1200);
        }
        await this.store.save(this.state);
      }
      return clone(task);
    });
  }
  async tasks(caller, args = {}) {
    this.assertCaller(caller);
    await this.settled();
    const items = this.state.tasks.filter(task => (this.destination(task.sender) === caller.id || this.destination(task.target) === caller.id) && (!args.task_id || task.id === args.task_id));
    return { total: items.length, items: clone(items.slice(-(Math.min(100, Math.max(1, args.limit ?? 20))))).reverse() };
  }
  async status(caller, args, signal) {
    const row = await this.target(caller, args.target, args.all_workspaces, signal);
    const inspection = await this.host.inspect(row.sessionId, signal);
    const events = inspection.events;
    const last = type => events.findLast(event => event.type === type);
    const agent = this.host.live(row.sessionId);
    const inbox = agent?.inbox;
    return {
      ...this.describe(row, caller),
      state: agent ? agent.status : 'closed',
      last_assistant_text: textOf(last('assistant/message')?.data.message ?? last('assistant/message')?.data).slice(-5000),
      last_user_text: textOf(last('user/message')?.data).slice(-1500),
      last_tool: last('tool/call')?.data.name ?? null,
      last_turn_end: last('turn/end')?.data.reason ?? null,
      pending: inbox ? { next_turn: inbox.nextTurn.length, next_step: inbox.nextStep.length } : null,
      note: '只读快照，未唤醒目标。最后文本和轮次结束不等于任务已完成；请查任务的明确回报。',
    };
  }
}
