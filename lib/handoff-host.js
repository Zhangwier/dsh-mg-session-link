import { createHash } from 'node:crypto';
import { createUserMessage, freezeMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';

const text = value => [{ type: 'text', text: value }];
const SOURCE = 'plugin:dsh-mg-session-link';
const stableId = value => {
  const raw = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
};
const relay = (content, source, id) => {
  const message = createUserMessage({ content, source: { kind: SOURCE, ...source } });
  return id ? freezeMessage({ ...message, id }) : message;
};
const accepted = (agent, id) => agent.session.snapshotEvents().some(event =>
  event.type === 'user/message' && event.data.id === id ||
  event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === id));

export function taskOverview(tasks) {
  const active = tasks.items.filter(task => !['completed', 'failed'].includes(task.status));
  const sampled = active.length ? active : tasks.items;
  return { total: tasks.total, sampled: Math.min(sampled.length, 20), lookup: 'mg_session_tasks', note: '只带必要索引，完整记录仍在任务工具中；不是全部任务正文。',
    items: sampled.slice(0, 20).map(task => ({ id: task.id, target: task.target, status: task.status, task: task.task.slice(0, 200), ...(task.result ? { result: task.result.slice(0, 200) } : {}) })) };
}

export function handoffHost(ctx, peers) {
  const resolve = async id => {
    const result = await ctx.sessionController.resolveAgent(id);
    if (result.error) throw result.error;
    return result.agent;
  };
  return {
    archived: id => ctx.workspaceRegistry.archivedSessionIds.includes(id),
    live: id => ctx.agents.get(id),
    warn: error => { try { ctx.logger?.warn?.(`mg-session-link handoff: ${error.message}`); } catch {} },
    metrics: async agent => {
      const measurement = ctx.tokenMeter.measure(agent.session);
      const events = agent.session.snapshotEvents();
      const capacity = events.findLast(event => event.type === 'request/context')?.data.contextWindow;
      return { tokens: measurement.totalTokens, estimated: measurement.baseline.kind !== 'usage', capacity: capacity ?? 0,
        turns: ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn ?? events.filter(event => event.type === 'turn/end').length,
        compactions: events.filter(event => event.type === 'compaction/summary').length };
    },
    blockers: async agent => {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([]));
      const children = ctx.agents.list().filter(other => ctx.agents.isOwnedBy(other.id, agent));
      const pending = agent.inbox.nextTurn.length + agent.inbox.nextStep.length;
      const teams = ctx.get('agentTeams');
      const membership = teams?.tryMembership(agent);
      const roster = membership?.role === 'lead' && teams.listMembers(agent).length > 1;
      const permissions = ctx.get('permissionPresets');
      const customPermissions = permissions?.current(agent.session) === 'custom';
      return [...activity.map(item => `activity:${item.kind}`), ...children.map(child => `owned-agent:${child.id}`), ...(roster ? ['active-team-roster'] : []), ...(pending ? ['pending-inbox'] : []), ...(customPermissions ? ['custom-permissions-require-manual-transfer'] : [])];
    },
    summarize: async (agent, prompt, signal) => {
      const config = agent.session.requestHeader()?.config ?? agent.options;
      const assembler = new BlockAssembler();
      const abort = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
      for await (const chunk of ctx.llm.stream({ provider: config.provider, model: config.model,
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        messages: [...agent.session.deriveMessages(), { role: 'user', content: text(prompt) }],
        maxTokens: 6000, signal: abort, sessionId: agent.id, purpose: 'compaction' })) assembler.push(chunk);
      if (!['stop', 'completed'].includes(assembler.finish?.kind)) throw new Error(`Summary did not finish normally (${assembler.finish?.kind ?? 'unknown'})`);
      const output = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim();
      const json = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      return JSON.parse(json);
    },
    create: async (source, handoffId) => {
      const presets = ctx.get('agentPresets');
      const preset = presets?.composedPreset(source.ctx) ?? source.session.header.agentPreset;
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(source.id));
      const created = await ctx.sessionController.create({ ...(workspace ? { workspaceId: workspace.id } : { cwd: source.session.header.cwd }), ...(preset ? { agentPreset: preset } : {}) });
      const agent = await resolve(created.sessionId);
      const permissions = ctx.get('permissionPresets');
      if (permissions) permissions.set(agent.session, permissions.current(source.session));
      const oldPlan = presets?.serviceFor(source, 'planMode');
      const newPlan = presets?.serviceFor(agent, 'planMode');
      if (oldPlan && newPlan) newPlan.set(agent, oldPlan.get(source).pending ?? oldPlan.get(source).active);
      const oldTitle = source.session.snapshotEvents().findLast(event => event.type === 'session/title')?.data.title ?? '主会话';
      const title = `${oldTitle.replace(/ · 接续\d+$/, '')} · 接续${Date.now().toString().slice(-6)}`;
      await ctx.sessionController.rename({ sessionId: agent.id, title });
      return { id: agent.id, agent, title, handoffId };
    },
    seed: async (successor, source, record, brief) => {
      const tasks = await peers.tasks(source, { limit: 100 });
      const id = stableId(`${record.id}:seed`);
      if (!accepted(successor.agent, id)) {
        const content = `你是已授权任务的新主会话，接续旧会话 ${source.id}。以下交接书由旧会话摘要生成，必须保留待核边界。\n\n${JSON.stringify(brief, null, 2)}\n\n已有会话协作任务索引：\n${JSON.stringify(taskOverview(tasks), null, 2)}\n\n按成果路径读取必要文件，先恢复断点，继续尚未完成的目标；不要重做已完成工作。任务全部完成时等待用户，不另起目标。旧会话保留，可通过会话查询工具按需查原始证据。你使用当前默认模型与相同 Agent preset；摘要不代表已独立核查。`;
        successor.agent.inject(relay(text(content), { form: 'relay', summary: '主会话交接书', senderSessionId: source.id, handoffId: record.id }, id));
      }
      await ctx.sessions.flush(successor.agent.session);
    },
    start: async (successor, handoffId) => {
      const id = stableId(`${handoffId}:start`);
      if (!accepted(successor.agent, id)) successor.agent.followup(relay(text('交接已提交。请按交接书恢复断点并继续未完成的已授权任务；若已全部完成，告知用户并等待下一条指令。'), { form: 'relay', summary: '开始接续', handoffId }, id));
      await ctx.sessions.flush(successor.agent.session);
    },
    notice: async (source, message, successor) => {
      source.session.append('user/message', relay(text(message), { form: 'notice', summary: '主会话交接状态', ...(successor ? { successorSessionId: successor } : {}) }), { surfaceOp: 'append' });
      await ctx.sessions.flush(source.session);
    },
    discard: async successor => {
      // Only the new, unwoken draft owned by this attempt can be archived.
      if (successor.agent.status === 'idle') await ctx.workspaceRegistry.archiveSession(successor.id);
    },
    forward: async (source, target, messages, signal) => {
      signal?.throwIfAborted();
      const agent = await resolve(target);
      if (ctx.workspaceRegistry.archivedSessionIds.includes(target)) throw new Error(`Successor ${target} is archived; original messages remain in the old log`);
      // Preserve claimed originals in the old transcript before routing them.
      for (const message of messages) if (!source.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === message.id)) source.session.append('user/message', message, { surfaceOp: 'append' });
      await ctx.sessions.flush(source.session);
      const id = stableId(`${source.id}:forward:${messages.map(message => message.id).join(':')}`);
      if (!accepted(agent, id)) agent.followup(relay([
        ...text(`从已交接的旧主会话 ${source.id} 转交的新输入。source.kind=user 的原始输入是用户追加要求，其余为会话通知；保留已有权限边界。`),
        ...messages.flatMap(message => [...text(`[原始来源：${message.source.kind}]`), ...message.content]),
      ], { form: 'relay', summary: '旧主会话输入转交', senderSessionId: source.id }, id));
      await ctx.sessions.flush(agent.session);
    },
  };
}
