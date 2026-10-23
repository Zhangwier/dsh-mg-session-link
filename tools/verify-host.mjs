// Real runtime test in a temporary DSH_HOME. No user sessions or credentials.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dshRoot, PROJECT, hostImport } from './paths.mjs';

const phase = process.argv[2];
if (!phase) {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-peer-host-'));
  const passes = [];
  try {
    for (const step of ['write', 'read']) {
      const child = spawnSync(process.execPath, [process.argv[1], step, sandbox], { encoding: 'utf8', timeout: 60000, windowsHide: true });
      // Print only test assertions and errors; boot logs may contain generated auth URLs.
      for (const line of `${child.stdout}\n${child.stderr}`.split(/\r?\n/)) {
        if (/^(PASS |FAIL |Error|AssertionError|\s+at )/.test(line)) console.log(line);
        if (line.startsWith('PASS ')) passes.push(line.slice(5));
      }
      if (child.status !== 0) {
        await writeFile(join(PROJECT, 'host-test-failure.log'), `${child.stdout}\n${child.stderr}`);
        throw new Error(`Host ${step} phase failed (${child.status}); see host-test-failure.log`);
      }
    }
    await writeFile(join(PROJECT, 'verification-host.json'), JSON.stringify({ at: new Date().toISOString(), localFixedOutputModel: true, phases: ['write', 'read'], passed: true, checks: passes }, null, 2));
  } finally {
    const target = await realpath(sandbox);
    const temporaryRoot = await realpath(tmpdir());
    if (!target.toLowerCase().startsWith((temporaryRoot + sep).toLowerCase()) || !basename(target).startsWith('dsh-peer-host-')) throw new Error('Refuse cleanup outside the created temporary sandbox');
    await rm(target, { recursive: true, force: true });
  }
  process.exit(0);
}

const sandbox = process.argv[3];
process.env.DSH_HOME = sandbox;
process.env.DSH_TELEMETRY_DISABLED = '1';
const profile = join(sandbox, 'profiles', 'web');
await mkdir(join(profile, 'node_modules'), { recursive: true });
const pluginLink = join(profile, 'node_modules', 'dsh-mg-session-link');
// The archive manager is an optional third-party plugin. When the local install has one,
// mount it so the exclusion path is exercised against a real implementation.
const archiveName = '@michengai/dsh-archive-manager';
const archiveRoot = process.env.DSH_ARCHIVE_MANAGER || join(process.env.USERPROFILE || '', '.dsh/profiles/web/node_modules', archiveName);
const hasArchive = existsSync(archiveRoot);
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-agent-team-profile', ...(hasArchive ? [archiveName] : []), 'dsh-mg-session-link'];
if (phase === 'write') {
  await symlink(PROJECT, pluginLink, 'junction');
  if (hasArchive) {
    await mkdir(join(profile, 'node_modules/@michengai'), { recursive: true });
    await symlink(archiveRoot, join(profile, 'node_modules', archiveName), 'junction');
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'peer-host-test', private: true, dsh: { profile: { bundles } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'cordis.patch.yml'), `
- id: agent-default-model
  config: { provider: peer-test, model: peer-test }
- id: session-title-llm
  disabled: true
- id: web-runtime
  config: { openBrowser: false, printUrl: false, surfaceContext: false }
- id: mg-session-link
  config: { autoHandoff: true, handoffTokens: 8000, handoffMinTurns: 2 }
`);
}
const { createLaunchEnvironmentSnapshot } = await hostImport('dsh-launch-environment');
const { runProfile } = await import(pathToFileURL(join(dshRoot(), 'lib/profile-boot.js')).href);
const { LlmAdapter, createUserMessage } = await hostImport('dsh-llm');
let ctx;
try {
  ({ ctx } = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_HOME: sandbox, DSH_TELEMETRY_DISABLED: '1' } }]), profile: 'web', patchFiles: [], args: ['--port', '0', '--no-open'] }));
  const get = service => { const value = ctx.get(service); assert.ok(value, `Missing ${service}`); return value; };
  class LocalModel extends LlmAdapter {
    async *stream(options) {
      const output = options.purpose === 'compaction' ? JSON.stringify({ goal: '完成既定接续验证', decisions: ['保留原插件'], constraints: ['只处理授权目标'], artifacts: ['临时工作区成果'], verified: ['收发验证通过'], pending: ['检查后继会话'], next_steps: ['读取交接书继续'], uncertainties: ['没有调用外部模型'] }) : 'HOST-LOCAL-OK';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: output };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  get('llm').registerAdapter(['peer-test'], new LocalModel());
  const controller = get('sessionController');
  const agents = get('agents');
  const run = async (agent, name, args) => {
    const result = await get('tools').execute({ callId: `verify-${crypto.randomUUID()}`, name, arguments: args, agent, signal: new AbortController().signal });
    if (result.isError) throw new Error(JSON.stringify(result));
    const rendered = result.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return JSON.parse(rendered);
  };
  const resolveAgent = async id => {
    const resolved = await controller.resolveAgent(id);
    if (resolved.error) throw resolved.error;
    return resolved.agent;
  };
  const idsPath = join(sandbox, 'ids.json');
  if (phase === 'write') {
    const cwd = join(sandbox, 'workspace');
    const aId = (await controller.create({ cwd })).sessionId;
    const bId = (await controller.create({ cwd })).sessionId;
    const a = await resolveAgent(aId), b = await resolveAgent(bId);
    for (const [agent, title] of [[a, '总调度'], [b, '前端开发']]) {
      await controller.rename({ sessionId: agent.id, title });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Test initialization. Reply OK.' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      assert.ok(agent.session.snapshotEvents().some(event => event.type === 'assistant/message'), 'real model loop produced assistant content');
    }
    assert.ok(get('agentTeams'), 'Teams service remains available');
    assert.ok(get('workspaceRegistry').constructor.name.includes('Archive') || get('workspaceRegistry').constructor.name.includes('Registry'));
    const assembly = await get('systemPrompt').assemble();
    assert.ok(assembly.sections.some(section => section.name === 'mg-session-link:policy'));
    console.log(`PASS Real profile booted with Teams${hasArchive ? ' and installed archive manager' : ''}; policy mounted`);
    const listed = await run(a, 'mg_session_list', {});
    assert.equal(listed.items.find(item => item.id === bId)?.title, '前端开发');
    const task = await run(a, 'mg_session_delegate', { target: bId, task: 'Integration test task. Reply HOST-LOCAL-OK.', request_id: 'native-roundtrip' });
    assert.equal(task.status, 'dispatched');
    await b.whenIdle();
    const status = await run(a, 'mg_session_status', { target: bId });
    assert.equal(status.last_assistant_text, 'HOST-LOCAL-OK');
    const report = await run(b, 'mg_session_report', { task_id: task.id, status: 'completed', result: 'Native host roundtrip verified.' });
    assert.equal(report.notification, 'delivered');
    await a.whenIdle();
    const taskEvents = b.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.taskId === task.id);
    assert.equal(taskEvents.length, 1);
    assert.equal(taskEvents[0].data.source.kind, 'plugin:dsh-mg-session-link');
    assert.equal(taskEvents[0].data.id, task.messageId);
    await get('sessions').flush(a.session);
    await get('sessions').flush(b.session);
    console.log('PASS Real native tools: list, delegate, wake worker, inspect text, report and wake coordinator');
    if (hasArchive) {
      await get('workspaceRegistry').archiveSession(bId);
      assert.ok(!(await run(a, 'mg_session_list', {})).items.some(item => item.id === bId));
      const refused = await get('tools').execute({ callId: 'archive-refusal', name: 'mg_session_send', arguments: { target: bId, message: 'must not deliver' }, agent: a, signal: new AbortController().signal });
      assert.equal(refused.isError, true);
      await get('workspaceRegistry').unarchiveSession(bId);
      console.log('PASS Installed archive-manager exclusion and native archived-message refusal');
    } else {
      console.log('SKIP Archive-manager exclusion (optional third-party plugin not installed)');
    }
    const form = get('settings').describe().find(item => item.ns.endsWith('mg-session-link'));
    assert.ok(form?.autoGenerate, 'handoff settings have a native plugin configuration page');
    assert.equal(form.value.autoHandoff, true);
    const runtimePath = join(sandbox, 'mg-session-link/web/runtime.json');
    const loadedAtBefore = JSON.parse(await readFile(runtimePath, 'utf8')).loadedAt;
    await get('settings').update(form.ns, { autoHandoff: false }, form.revision);
    assert.equal((await run(a, 'mg_session_handoff', { action: 'status' })).master_switch, false);
    const changedForm = get('settings').describe().find(item => item.ns === form.ns);
    await get('settings').update(form.ns, { autoHandoff: true }, changedForm.revision);
    assert.equal((await run(a, 'mg_session_handoff', { action: 'status' })).master_switch, true);
    assert.equal(JSON.parse(await readFile(runtimePath, 'utf8')).loadedAt, loadedAtBefore, 'native switch edits do not remount the plugin');
    console.log('PASS Native settings switch changes live values without remounting the plugin');
    const pendingTask = await run(a, 'mg_session_delegate', { target: bId, task: 'Keep this task pending until the main transfers.' });
    await b.whenIdle();
    await run(a, 'mg_session_handoff', { action: 'enable' });
    a.followup(createUserMessage({ content: [{ type: 'text', text: '继续已有授权目标。' + '用于验证上下文阈值的测试材料。'.repeat(4000) }], source: { kind: 'user' } }));
    await a.whenIdle();
    let handoffRecord;
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      let handoffState;
      try { handoffState = JSON.parse(await readFile(join(sandbox, 'mg-session-link/web/handoffs.json'), 'utf8')); } catch { continue; }
      handoffRecord = handoffState.records?.findLast(record => record.source === aId);
      if (handoffRecord && ['started', 'failed', 'committed-start-pending'].includes(handoffRecord.phase)) break;
    }
    assert.equal(handoffRecord?.phase, 'started', JSON.stringify(handoffRecord));
    assert.equal(handoffRecord.reason, 'context-pressure');
    const successor = await resolveAgent(handoffRecord.target);
    await successor.whenIdle();
    assert.equal(successor.session.header.cwd, a.session.header.cwd);
    assert.ok(successor.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.summary === '主会话交接书'));
    console.log('PASS Native configuration form and idle context-pressure trigger create and seed a fresh main');
    const previousAnswers = a.session.snapshotEvents().filter(event => event.type === 'assistant/message').length;
    a.followup(createUserMessage({ content: [{ type: 'text', text: '用户在旧会话追加要求，请转交。' }], source: { kind: 'user' } }));
    await a.whenIdle();
    await successor.whenIdle();
    assert.equal(a.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, previousAnswers);
    assert.ok(successor.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.summary === '旧主会话输入转交'));
    const routedReport = await run(b, 'mg_session_report', { task_id: pendingTask.id, status: 'completed', result: 'Result after main handoff.' });
    assert.equal(routedReport.notification, 'delivered');
    await successor.whenIdle();
    assert.ok(successor.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.taskId === pendingTask.id));
    console.log('PASS Old-main human input and existing worker reports route to the successor without old-main model calls');
    await get('sessions').flush(successor.session);
    await writeFile(idsPath, JSON.stringify({ aId, bId, successorId: successor.id, taskId: task.id, messageId: task.messageId }));
  } else {
    const { aId, bId, successorId, taskId, messageId } = JSON.parse(await readFile(idsPath, 'utf8'));
    const cold = await controller.inspect(bId);
    assert.equal(cold.events.filter(event => event.type === 'user/message' && event.data.id === messageId).length, 1);
    const a = await resolveAgent(successorId ?? aId);
    const task = (await run(a, 'mg_session_tasks', { task_id: taskId })).items[0];
    assert.equal(task.status, 'completed');
    assert.equal(task.notification, 'delivered');
    await run(a, 'mg_session_send', { target: bId, message: 'Message after a fresh-process cold resume.' });
    const b = agents.get(bId);
    await b.whenIdle();
    await get('sessions').flush(b.session);
    console.log('PASS Fresh-process v4 log replay, task-state recovery, cold resume and subsequent durable send');
    const restored = await run(a, 'mg_session_handoff', { action: 'status' });
    assert.equal(restored.main_session, true);
    assert.ok((await run(a, 'mg_session_tasks', {})).items.some(item => item.sender === aId));
    console.log('PASS Fresh-process handoff registration and inherited task visibility persist');
  }
  await ctx.fiber.dispose();
  process.exit(0);
} catch (error) {
  console.error(`FAIL ${error.stack || error}`);
  try { await ctx?.fiber.dispose(); } catch {}
  process.exit(1);
}
