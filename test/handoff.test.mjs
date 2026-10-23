import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Handoffs, handoffTrigger, HANDOFF_DEFAULTS, validateBrief } from '../lib/handoff.js';
import { PeerSessions } from '../lib/core.js';
import { taskOverview } from '../lib/handoff-host.js';

const brief = () => ({ goal: '继续已有项目', decisions: ['保留原插件'], constraints: ['不重复已完成工作'], artifacts: ['D:/project/result.txt'], verified: ['原生队列已核查'], pending: ['完成界面'], next_steps: ['先读进度文件'], uncertainties: ['外部模型未验证'] });

test('a large task history becomes a bounded index rather than bloating the fresh context', () => {
  const overview = taskOverview({ total: 500, items: Array.from({ length: 100 }, (_, index) => ({ id: `task-${index}`, target: 'worker', status: 'dispatched', task: '长任务'.repeat(8000), result: '长结果'.repeat(8000) })) });
  assert.equal(overview.items.length, 20);
  assert.ok(overview.items.every(item => item.task.length <= 200 && item.result.length <= 200));
  assert.ok(JSON.stringify(overview).length < 14000);
  assert.equal(overview.total, 500);
});
function memoryStore() {
  let saved = { version: 1, tasks: [] };
  return { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } };
}
function fixture(config = {}) {
  const agents = new Map(), rows = [], deliveries = [], notices = [], discarded = [], forwarded = [];
  function add(id, title = id) {
    const agent = { id, status: 'idle', session: { seq: 10, header: { cwd: 'D:/project' } }, inbox: { nextTurn: [], nextStep: [] } };
    agents.set(id, agent);
    rows.push({ sessionId: id, cwd: 'D:/project', agentAvailable: true, blank: false, projections: { values: { title } } });
    return agent;
  }
  const source = add('source', '主会话'), worker = add('worker', '工作会话');
  const peerStore = memoryStore();
  const peers = new PeerSessions({ list: async () => rows, archived: () => [], agent: async id => agents.get(id), live: id => agents.get(id), message: input => ({ id: randomUUID(), ...input }), hasMessage: (a, id) => deliveries.some(item => item.message.id === id), deliver: (agent, message, mode) => deliveries.push({ agent, message, mode }), checkpoint: async () => {} }, peerStore);
  const store = memoryStore();
  const calls = { summaries: 0, creates: 0, seeds: 0, starts: 0 };
  const host = {
    live: id => agents.get(id),
    archived: () => false,
    warn: error => { throw error; },
    metrics: async () => ({ tokens: 90000, capacity: 100000, turns: 5, compactions: 0 }),
    blockers: async () => [],
    summarize: async () => { calls.summaries++; return brief(); },
    create: async () => { calls.creates++; const agent = add(`successor-${calls.creates}`); return { id: agent.id, agent, title: '主会话 · 接续' }; },
    seed: async () => { calls.seeds++; },
    start: async () => { calls.starts++; },
    notice: async (agent, message) => { notices.push(message); },
    discard: async successor => { discarded.push(successor.id); },
    forward: async (agent, target, messages) => { forwarded.push({ target, messages }); },
  };
  const handoffs = new Handoffs(host, peers, store, config);
  return { agents, add, source, worker, peers, store, peerStore, host, handoffs, calls, deliveries, notices, discarded, forwarded };
}

test('trigger uses current pressure, respects minimum turns, and can use repeated compactions', () => {
  assert.equal(handoffTrigger({ tokens: 70000, capacity: 100000, turns: 5, compactions: 0 }, HANDOFF_DEFAULTS), null);
  assert.equal(handoffTrigger({ tokens: 80000, capacity: 100000, turns: 5, compactions: 0 }, HANDOFF_DEFAULTS), 'context-pressure');
  assert.equal(handoffTrigger({ tokens: 130000, capacity: 1000000, turns: 5, compactions: 0 }, HANDOFF_DEFAULTS), 'context-pressure');
  assert.equal(handoffTrigger({ tokens: 130000, capacity: 1000000, turns: 1, compactions: 10 }, HANDOFF_DEFAULTS), null);
  assert.equal(handoffTrigger({ tokens: 1000, capacity: 1000000, turns: 8, compactions: 3 }, HANDOFF_DEFAULTS), 'repeated-compaction');
});

test('default switch is off and enabling it only affects explicitly registered main sessions', async () => {
  const f = fixture();
  await f.handoffs.control(f.source, 'enable');
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.summaries, 0);
  f.handoffs.config.autoHandoff = true;
  await f.handoffs.consider(f.worker);
  assert.equal(f.calls.summaries, 0);
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.starts, 1);
  assert.equal((await f.handoffs.control(f.agents.get('successor-1'))).main_session, true);
});

test('idle handoff saves a validated brief before route commit and starts exactly one successor', async () => {
  const f = fixture({ autoHandoff: true });
  await f.handoffs.control(f.source, 'enable');
  await Promise.all([f.handoffs.consider(f.source), f.handoffs.consider(f.source)]);
  assert.equal(f.calls.creates, 1);
  assert.equal(f.calls.seeds, 1);
  assert.equal(f.calls.starts, 1);
  assert.equal(f.peers.destination('source'), 'successor-1');
  const saved = await f.store.load();
  assert.deepEqual(saved.records[0].brief, brief());
  assert.equal(saved.records[0].phase, 'started');
  assert.equal(saved.mains.source.enabled, false);
  assert.equal(saved.mains['successor-1'].enabled, true);
});

test('running turns, owned agents and background activity defer handoff without cancelling work', async () => {
  const f = fixture({ autoHandoff: true });
  await f.handoffs.control(f.source, 'enable');
  f.source.status = 'running';
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.creates, 0);
  f.source.status = 'idle';
  f.host.blockers = async () => ['owned-agent:child', 'activity:job'];
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.summaries, 0);
  assert.deepEqual((await f.store.load()).mains.source.deferred, ['owned-agent:child', 'activity:job']);
});

test('new input during summary invalidates the transfer and leaves the original main intact', async () => {
  const f = fixture({ autoHandoff: true });
  await f.handoffs.control(f.source, 'enable');
  f.host.summarize = async () => { f.source.session.seq++; return brief(); };
  const result = await f.handoffs.consider(f.source);
  assert.equal(result.phase, 'failed');
  assert.equal(f.calls.creates, 0);
  assert.equal(f.peers.destination('source'), 'source');
  assert.equal((await f.store.load()).mains.source.enabled, true);
});

test('input during successor creation archives only the unwoken draft', async () => {
  const f = fixture({ autoHandoff: true });
  await f.handoffs.control(f.source, 'enable');
  const create = f.host.create;
  f.host.create = async (...args) => { const successor = await create(...args); f.source.session.seq++; return successor; };
  await f.handoffs.consider(f.source);
  assert.deepEqual(f.discarded, ['successor-1']);
  assert.equal(f.calls.starts, 0);
  assert.equal(f.peers.destination('source'), 'source');
});

test('invalid summary and failed seed durability never redirect the original', async () => {
  const f = fixture({ autoHandoff: true });
  await f.handoffs.control(f.source, 'enable');
  f.host.summarize = async () => ({ goal: 'missing fields' });
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.creates, 0);
  f.source.session.seq++;
  f.host.summarize = async () => brief();
  f.host.seed = async () => { throw new Error('disk unavailable'); };
  await f.handoffs.consider(f.source);
  assert.equal(f.peers.destination('source'), 'source');
  assert.equal(f.calls.starts, 0);
  assert.equal(f.discarded.length, 1);
});

test('post-commit start failure preserves the durable successor and records recovery state', async () => {
  const f = fixture({ autoHandoff: true });
  await f.handoffs.control(f.source, 'enable');
  f.host.start = async () => { throw new Error('wake checkpoint uncertain'); };
  await f.handoffs.consider(f.source);
  assert.equal(f.peers.destination('source'), 'successor-1');
  assert.equal((await f.store.load()).records[0].phase, 'committed-start-pending');
  assert.equal(f.discarded.length, 0);
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.creates, 1);
});

test('worker results and task visibility follow the successor after a main-session handoff', async () => {
  const f = fixture({ autoHandoff: true });
  const task = await f.peers.delegate(f.source, { target: 'worker', task: '待回报的工作' });
  await f.handoffs.control(f.source, 'enable');
  await f.handoffs.consider(f.source);
  const result = await f.peers.report(f.worker, { task_id: task.id, status: 'completed', result: '成果已保存' });
  assert.equal(result.notification, 'delivered');
  assert.equal(f.deliveries.at(-1).agent.id, 'successor-1');
  assert.equal((await f.peers.tasks(f.agents.get('successor-1'))).items[0].id, task.id);
});

test('archiving the old main does not break worker reports to its durable successor', async () => {
  const f = fixture({ autoHandoff: true });
  const task = await f.peers.delegate(f.source, { target: 'worker', task: '待回报' });
  await f.handoffs.control(f.source, 'enable');
  await f.handoffs.consider(f.source);
  f.peers.host.archived = () => ['source'];
  const result = await f.peers.report(f.worker, { task_id: task.id, status: 'completed', result: '已完成' });
  assert.equal(result.notification, 'delivered');
  assert.equal(f.deliveries.at(-1).agent.id, 'successor-1');
});

test('disabling the live switch while summarizing cancels the uncommitted handoff', async () => {
  const f = fixture({ autoHandoff: true });
  await f.handoffs.control(f.source, 'enable');
  f.host.summarize = async () => { f.handoffs.config.autoHandoff = false; return brief(); };
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.creates, 0);
  assert.equal(f.peers.destination('source'), 'source');
});

test('human messages in an old main are forwarded even after future auto handoffs are disabled', async () => {
  const f = fixture({ autoHandoff: true });
  await f.handoffs.control(f.source, 'enable');
  await f.handoffs.consider(f.source);
  f.handoffs.config.autoHandoff = false;
  const input = [{ id: 'human-1', content: [{ type: 'text', text: '追加要求' }], source: { kind: 'user' } }];
  assert.equal(await f.handoffs.beforeStep(f.source, input), true);
  assert.equal(f.forwarded[0].target, 'successor-1');
  assert.equal(await f.handoffs.beforeStep(f.worker, []), false);
});

test('explicit now waits for idle and bypasses the disabled automatic switch', async () => {
  const f = fixture();
  f.source.status = 'running';
  assert.equal((await f.handoffs.control(f.source, 'now')).main_session, false);
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.starts, 0);
  f.source.status = 'idle';
  f.host.blockers = async () => ['owned-agent:child'];
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.starts, 0);
  f.host.blockers = async () => [];
  await f.handoffs.reconsider();
  await f.handoffs.active.get(f.source.id);
  assert.equal(f.calls.starts, 1);
  assert.equal((await f.handoffs.control(f.agents.get('successor-1'))).main_session, false);
});

test('disable cancels a pending explicit request as well as automatic eligibility', async () => {
  const f = fixture();
  await f.handoffs.control(f.source, 'now');
  const state = await f.handoffs.control(f.source, 'disable');
  assert.equal(state.manual_request, false);
  await f.handoffs.consider(f.source);
  assert.equal(f.calls.starts, 0);
});

test('handoff state and peer routing survive service reconstruction; malformed briefs fail', async () => {
  const f = fixture({ autoHandoff: true });
  await f.handoffs.control(f.source, 'enable');
  await f.handoffs.consider(f.source);
  const restored = new Handoffs(f.host, f.peers, f.store, { autoHandoff: true });
  assert.equal((await restored.control(f.agents.get('successor-1'))).main_session, true);
  assert.throws(() => validateBrief({ ...brief(), artifacts: [123] }), /artifacts/);
});
