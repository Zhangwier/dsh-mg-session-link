import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, sep } from 'node:path';
import { JsonStore, PeerSessions, SOURCE, shortId } from '../lib/core.js';

function fixture() {
  const agents = new Map();
  const rows = [];
  const deliveries = [];
  const archive = [];
  let durable = { version: 1, tasks: [] };
  const store = { load: async () => structuredClone(durable), save: async state => { durable = structuredClone(state); } };
  function add(id, title, cwd = 'D:/work/project', options = {}) {
    const agent = { id, status: 'idle', session: { header: { cwd, ...options } }, inbox: { nextTurn: [], nextStep: [] } };
    agents.set(id, agent);
    rows.push({ sessionId: id, cwd, blank: false, agentAvailable: true, projections: { values: { title } }, ...options });
    return agent;
  }
  const a = add('session-aaaaaaaa-1111-4444-bbbb-000000000001', '总调度');
  const b = add('session-bbbbbbbb-2222-4444-cccc-000000000002', '前端');
  const c = add('session-cccccccc-3333-4444-dddd-000000000003', '后端');
  const host = {
    list: async () => rows,
    archived: () => archive,
    agent: async id => agents.get(id), live: id => agents.get(id),
    inspect: async () => ({ events: [{ type: 'assistant/message', data: { content: [{ type: 'text', text: '处理中' }] } }] }),
    message: input => ({ id: randomUUID(), role: 'user', ...input }),
    hasMessage: (agent, id) => deliveries.some(d => d.agent.id === agent.id && d.message.id === id),
    deliver: (agent, message, mode) => { deliveries.push({ agent, message, mode }); agent.inbox[mode === 'steer' ? 'nextStep' : 'nextTurn'].push(message); },
    checkpoint: async () => {},
  };
  return { a, b, c, add, host, rows, agents, deliveries, archive, store, peers: new PeerSessions(host, store) };
}

test('visible list follows archive, blank, subagent and workspace rules', async () => {
  const f = fixture();
  f.add('hidden-child', 'child', 'D:/work/project', { origin: 'subagent' });
  f.add('blank', 'blank', 'D:/work/project', { blank: true });
  f.add('other', 'other', 'D:/Other');
  f.archive.push(f.c.id);
  assert.equal((await f.peers.list(f.a)).total, 2);
  assert.equal((await f.peers.list(f.a, { all_workspaces: true })).total, 3);
  await assert.rejects(f.peers.send(f.a, { target: f.c.id, message: 'hi' }), /unavailable/);
  assert.equal(f.deliveries.length, 0);
});

test('ambiguous titles fail without a delivery, unique handles work', async () => {
  const f = fixture();
  f.add('session-bbbbbbbb-5555-4444-cccc-000000000005', '前端');
  await assert.rejects(f.peers.send(f.a, { target: '前端', message: 'hi' }), /Ambiguous/);
  const result = await f.peers.send(f.a, { target: shortId(f.b.id), message: 'hi' });
  assert.equal(result.target, f.b.id);
  assert.equal(f.deliveries.length, 1);
});

test('idle delivery queues a new turn; running delivery steers', async () => {
  const f = fixture();
  assert.equal((await f.peers.send(f.a, { target: '前端', message: 'hi' })).mode, 'queue');
  f.b.status = 'running';
  assert.equal((await f.peers.send(f.a, { target: '前端', message: 'more' })).mode, 'steer');
  assert.equal((await f.peers.send(f.a, { target: '前端', message: 'later', mode: 'queue' })).mode, 'queue');
  assert.equal(f.deliveries[0].message.source.kind, SOURCE);
  assert.match(f.deliveries[0].message.content[0].text, /发送方会话 ID/);
});

test('status is read-only and does not activate a closed conversation', async () => {
  const f = fixture();
  let activated = 0;
  f.host.agent = async () => { activated++; return f.b; };
  f.agents.delete(f.b.id);
  const result = await f.peers.status(f.a, { target: '前端' });
  assert.equal(result.state, 'closed');
  assert.equal(result.last_assistant_text, '处理中');
  assert.equal(activated, 0);
});

test('delegation, explicit completion, native notification and durable reload', async () => {
  const f = fixture();
  const task = await f.peers.delegate(f.a, { target: '前端', task: '修改页面', request_id: 'req-1' });
  assert.equal(task.status, 'dispatched');
  assert.equal(f.deliveries[0].message.id, task.messageId);
  assert.match(f.deliveries[0].message.content[0].text, /mg_session_report/);
  const result = await f.peers.report(f.b, { task_id: task.id, status: 'completed', result: '已保存，未运行测试' });
  assert.equal(result.notification, 'delivered');
  assert.equal(f.deliveries[1].agent.id, f.a.id);
  assert.equal((await new PeerSessions(f.host, f.store).tasks(f.a)).items[0].status, 'completed');
  await f.peers.report(f.b, { task_id: task.id, status: 'completed', result: '已保存，未运行测试' });
  assert.equal(f.deliveries.length, 2, 'repeated report does not wake the coordinator again');
});

test('only the assigned worker can report; task history is participant-only', async () => {
  const f = fixture();
  const task = await f.peers.delegate(f.a, { target: '前端', task: '处理' });
  await assert.rejects(f.peers.report(f.c, { task_id: task.id, status: 'completed', result: 'done' }), /Only the assigned/);
  assert.equal((await f.peers.tasks(f.c)).total, 0);
  assert.equal((await f.peers.tasks(f.b)).total, 1);
});

test('concurrent retries with one request id produce exactly one task and message', async () => {
  const f = fixture();
  const args = { target: '前端', task: '处理', request_id: 'same' };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.peers.delegate(f.a, args)));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.equal(f.deliveries.length, 1);
  await assert.rejects(f.peers.delegate(f.a, { ...args, task: 'another' }), /different task/);
});

test('archive race after cold resolution rejects before delivery', async () => {
  const f = fixture();
  f.host.agent = async () => { f.archive.push(f.b.id); return f.b; };
  await assert.rejects(f.peers.send(f.a, { target: '前端', message: 'hi' }), /archived/);
  assert.equal(f.deliveries.length, 0);
});

test('flush failure preserves uncertain status; retry never blindly resends', async () => {
  const f = fixture();
  f.host.checkpoint = async () => { throw new Error('disk unavailable'); };
  const args = { target: '前端', task: '处理', request_id: 'retry' };
  const task = await f.peers.delegate(f.a, args);
  assert.equal(task.status, 'delivery_uncertain');
  assert.equal((await f.peers.delegate(f.a, args)).duplicate, true);
  assert.equal(f.deliveries.length, 1);
});

test('report stays saved when coordinator is archived, retry sends once when restored', async () => {
  const f = fixture();
  const task = await f.peers.delegate(f.a, { target: '前端', task: '处理' });
  f.archive.push(f.a.id);
  const args = { task_id: task.id, status: 'blocked', result: '缺资源' };
  assert.equal((await f.peers.report(f.b, args)).notification, 'pending');
  assert.equal((await f.peers.tasks(f.a)).items[0].result, '缺资源');
  f.archive.length = 0;
  assert.equal((await f.peers.report(f.b, args)).notification, 'delivered');
  assert.equal(f.deliveries.length, 2);
});

test('uncertain report delivery is deduplicated by durable message identity', async () => {
  const f = fixture();
  const task = await f.peers.delegate(f.a, { target: '前端', task: '处理' });
  let failed = false;
  f.host.checkpoint = async () => { if (!failed) { failed = true; throw new Error('disk busy'); } };
  const args = { task_id: task.id, status: 'completed', result: 'done' };
  assert.equal((await f.peers.report(f.b, args)).notification, 'pending');
  assert.equal((await f.peers.report(f.b, args)).notification, 'delivered');
  assert.equal(f.deliveries.length, 2);
});

test('aborted calls, self-targets, subagent callers and cross-workspace defaults are rejected', async () => {
  const f = fixture();
  const signal = AbortSignal.abort(new Error('stopped'));
  await assert.rejects(f.peers.send(f.a, { target: '前端', message: 'hi' }, signal), /stopped/);
  await assert.rejects(f.peers.send(f.a, { target: f.a.id, message: 'hi' }), /different conversation/);
  const child = f.add('child', 'child', 'D:/work/project', { origin: 'subagent' });
  await assert.rejects(f.peers.list(child), /ordinary/);
  f.add('remote', 'other workspace', 'D:/Other');
  await assert.rejects(f.peers.send(f.a, { target: 'remote', message: 'hi' }), /unavailable/);
  await f.peers.send(f.a, { target: 'remote', message: 'hi', all_workspaces: true });
  assert.equal(f.deliveries.length, 1);
});

test('atomic file store survives reload and refuses corrupt state without overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-peer-store-'));
  try {
    const file = join(dir, 'nested', 'tasks.json');
    const store = new JsonStore(file);
    assert.deepEqual(await store.load(), { version: 1, tasks: [] });
    await store.save({ version: 1, tasks: [{ id: 'task-1' }] });
    assert.equal((await new JsonStore(file).load()).tasks[0].id, 'task-1');
    await writeFile(file, '{corrupt');
    await assert.rejects(store.load(), /original file preserved/);
    assert.equal(await readFile(file, 'utf8'), '{corrupt');
  } finally {
    const target = await realpath(dir);
    const temporaryRoot = await realpath(tmpdir());
    if (!target.toLowerCase().startsWith((temporaryRoot + sep).toLowerCase()) || !basename(target).startsWith('dsh-peer-store-')) throw new Error('Refuse cleanup outside the created temporary sandbox');
    await rm(target, { recursive: true, force: true });
  }
});
