import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { JsonStore, PeerSessions } from './core.js';
import { Handoffs, HANDOFF_DEFAULTS } from './handoff.js';
import { handoffHost } from './handoff-host.js';

export const name = 'mg-session-link';
export const inject = ['tools', 'sessionController', 'agents', 'sessions', 'workspaceRegistry', 'systemPrompt', 'tokenMeter', 'sessionProjections', 'llm'];
export const Config = z.object({
  autoHandoff: z.boolean().default(false).description('自动交接总开关：仅作用于已登记的主会话，默认关闭。').volatile(),
  handoffRatio: z.number().min(0.2).max(0.95).default(0.75).description('当前上下文占模型窗口的触发比例。').volatile(),
  handoffTokens: z.number().step(1).min(8000).max(1000000).default(120000).description('当前上下文 token 上限，与比例阈值取较小者；不是累计费用。').volatile(),
  handoffMinTurns: z.number().step(1).min(2).max(100).default(4).description('至少完成多少轮后才自动交接，避免新会话连续接力。').volatile(),
  handoffCompactions: z.number().step(1).min(0).max(100).default(3).description('压缩达到此次数也触发交接；0 表示不按压缩次数触发。').volatile(),
});
export const POLICY = `## 已有会话之间协作
用户要求另一个已有会话干活、询问或协同时，使用 mg_session_* 工具。先 mg_session_list 找到正确标题及 handle；同名时用唯一 ID，不猜会话编号。已有普通会话和 Teams 子代理分别寻址，保留现有 Teams 工具及其规则。
mg_session_delegate 派可跟踪的任务，mg_session_send 发送问题或追加要求，mg_session_status 只读进度，mg_session_tasks 查看明确回报。默认当前目录，用户明确涉及其他工作区时使用 all_workspaces=true。不要把整个会话历史复制给对方；发送任务范围、必要文件路径和验收要求，避免并发修改同一文件。
收到任务后沿用自身上下文、工具权限和用户要求，结束前调用 mg_session_report 报 completed/blocked/failed，写清实际产物、验证和未完成项。派活返回 dispatched 只表示消息已投递；只有显式 completed 才是工作会话的完成自述，协调方按用户要求复核。delivery_uncertain 时先检查消息和任务，不盲目重派。收到回报无需发“已收到”造成来回唤醒。
用户要求把本会话设为自动交接的主会话时，调用 mg_session_handoff action=enable；关闭本会话用 disable，查看用 status。自动交接还须在插件配置中开启 autoHandoff 总开关。用户明确要求现在交接时才用 now，它在本轮结束后的安全停点执行，会调用一次模型整理交接书并建立新会话；不要自行启用 now。旧会话和原始证据保留，后继使用相同工作目录和 Agent preset、当前默认模型。`;

const target = { type: 'string', required: true, description: '目标已有普通会话的完整 ID、唯一 handle 或唯一标题；先 list 确认。' };
const all = { type: 'boolean', description: '用户明确涉及其他工作区时置 true；默认只查当前工作目录。' };
const mode = { type: 'string', enum: ['auto', 'queue', 'steer'], description: 'auto 默认：忙时下步送达，闲时新轮；queue 等下一轮，steer 下步送达。' };
const limit = { type: 'integer', description: '最多返回条数，1 至 100。' };

export function hostAdapter(ctx) {
  return {
    list: async signal => (await ctx.sessionController.list({}, signal)).items,
    archived: () => ctx.workspaceRegistry.archivedSessionIds,
    agent: async id => {
      const result = await ctx.sessionController.resolveAgent(id);
      if (result.error) throw result.error;
      return result.agent;
    },
    live: id => ctx.agents.get(id),
    inspect: (id, signal) => ctx.sessionController.inspect(id, signal),
    message: input => {
      const { id, ...body } = input;
      const message = createUserMessage(body);
      return id ? freezeMessage({ ...message, id }) : message;
    },
    hasMessage: (agent, id) => agent.session.snapshotEvents().some(event =>
      event.type === 'user/message' && event.data.id === id ||
      event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === id)),
    deliver: (agent, message, delivery) => delivery === 'steer' ? agent.steer(message) : agent.followup(message),
    checkpoint: agent => ctx.sessions.flush(agent.session),
  };
}

export function definitions(peers, handoffs) {
  const entries = [
    ['mg_session_list', '列出已有普通会话，按标题查找可派活的平级会话。排除归档、空白和 Teams 子代理；不会唤醒会话。', { query: { type: 'string', description: '按标题、目录或 ID 过滤。' }, all_workspaces: all, limit }, (a, e) => peers.list(e.agent, a, e.signal)],
    ['mg_session_delegate', '向另一个已有普通会话派任务并保存任务 ID。对方保留自己的上下文；返回投递状态，不代表完成。', { target, task: { type: 'string', required: true, description: '任务目标、范围、输入路径、输出路径和验收要求。' }, mode, all_workspaces: all, request_id: { type: 'string', description: '可选幂等键；重试同一任务时保持相同值。' } }, (a, e) => peers.delegate(e.agent, a, e.signal, e.callId)],
    ['mg_session_send', '给已有普通会话发送问题、补充要求或答复。投递成功不表示已读或完成；正式派活用 delegate。', { target, message: { type: 'string', required: true, description: '要发送的文本。' }, mode, all_workspaces: all }, (a, e) => peers.send(e.agent, a, e.signal)],
    ['mg_session_status', '只读另一个已有会话的运行状态、最近文本、工具与排队数，不会唤醒它。任务是否完成请查看 tasks 的明确回报。', { target, all_workspaces: all }, (a, e) => peers.status(e.agent, a, e.signal)],
    ['mg_session_tasks', '查看本会话发出或接到的任务及回报。包含完成、受阻、失败、投递待核和回报通知状态。', { task_id: { type: 'string', description: '可选，仅查某个任务。' }, limit }, (a, e) => peers.tasks(e.agent, a)],
    ['mg_session_report', '工作会话明确报告被分配任务的结果，保存后通知派活会话。只有被分配的会话能回报。', { task_id: { type: 'string', required: true }, status: { type: 'string', enum: ['completed', 'blocked', 'failed'], required: true }, result: { type: 'string', required: true, description: '实际完成内容、成果绝对路径、实际验证、未完成项或受阻原因。不要把未验证当成功。' } }, (a, e) => peers.report(e.agent, a, e.signal)],
  ];
  if (handoffs) entries.push(['mg_session_handoff', '登记/关闭本主会话的上下文自动交接，查看配置和交接结果。now 仅在用户明确要求立即交接时使用；需要安全停点且可能产生一次摘要模型调用。', { action: { type: 'string', required: true, enum: ['status', 'enable', 'disable', 'now'] } }, async (args, exec) => {
    const result = await handoffs.control(exec.agent, args.action);
    if (args.action === 'now') exec.concludeTurn();
    return result;
  }]);
  return entries.map(([toolName, description, parameters, execute]) => defineTool({
    name: toolName, description, parameters,
    output: { schema: { type: 'object', properties: { json: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.json }] },
    async execute(args, exec) { return { json: JSON.stringify(await execute(args, exec), null, 2) }; },
  }));
}

export function apply(ctx, config = {}) {
  const profile = ctx.get('profileContext')?.name || process.env.DSH_PROFILE || 'web';
  const file = config.stateFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'mg-session-link', profile, 'tasks.json');
  const peers = new PeerSessions(hostAdapter(ctx), new JsonStore(file));
  const values = () => Object.fromEntries(Object.entries(HANDOFF_DEFAULTS).map(([key, fallback]) => [key, typeof config[key]?.get === 'function' ? config[key].get() : config[key] ?? fallback]));
  const handoffs = new Handoffs(handoffHost(ctx, peers), peers, new JsonStore(join(dirname(file), 'handoffs.json')), values);
  const tools = definitions(peers, handoffs);
  for (const tool of tools) ctx.tools.register(tool);
  ctx.systemPrompt.section({ name: 'mg-session-link:policy', order: 2810, text: POLICY, interpolate: false });
  const runtimeFile = join(dirname(file), 'runtime.json');
  const loadedAt = Date.now();
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') void handoffs.consider(agent); });
  ctx.on('agent/disposed', () => { void handoffs.reconsider().catch(error => ctx.logger?.warn?.(`mg-session-link handoff: ${error.message}`)); });
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => await handoffs.beforeStep(agent, messages, signal) ? { kind: 'reject' } : next(), { prepend: true });
  const readiness = Promise.all([peers.ready, handoffs.ready]).then(() => new JsonStore(runtimeFile).save({ version: 1, plugin: 'dsh-mg-session-link', pid: process.pid, loadedAt, tools: tools.map(tool => tool.name), autoHandoffAtLoad: values().autoHandoff }));
  ctx.on('dispose', async () => {
    await readiness.catch(() => {});
    await handoffs.dispose();
    await peers.settled().catch(() => {});
    try {
      const record = JSON.parse(await readFile(runtimeFile, 'utf8'));
      if (record.pid === process.pid && record.loadedAt === loadedAt) await unlink(runtimeFile);
    } catch (error) { if (error.code !== 'ENOENT') ctx.logger?.warn?.(`mg-session-link cleanup: ${error.message}`); }
  });
  // Loading invalid local state must be observable without failing the whole host.
  readiness.catch(error => ctx.logger?.warn?.(`mg-session-link: ${error.message}`));
}
