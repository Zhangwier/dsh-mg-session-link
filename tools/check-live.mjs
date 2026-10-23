import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { PROJECT } from './paths.mjs';

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const file = join(home, 'profiles', process.env.DSH_PROFILE || 'web', 'cordis.patch.yml');
const probeName = process.argv[2] === '--manager' ? 'probe-manager.js' : 'probe-live.js';
const output = join(PROJECT, process.argv[2] === '--manager' ? 'verification-manager.json' : 'verification-live.json');
const before = await readFile(file, 'utf8');
if (before.includes('# BEGIN MG LIVE PROBE')) throw new Error('A live probe is already mounted');
const newline = before.includes('\r\n') ? '\r\n' : '\n';
const block = ['# BEGIN MG LIVE PROBE', '- insert:', '    - id: mg-session-link-live-probe', `      name: '${join(PROJECT, 'tools', probeName).replaceAll('\\', '/')}'`, '# END MG LIVE PROBE', ''].join(newline);
const backup = join(home, 'backups', `mg-session-link-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(backup, { recursive: true });
await copyFile(file, join(backup, 'cordis.patch.yml'));
const startedAt = Date.now();
await writeFile(file, before + (before.endsWith('\n') ? '' : newline) + block);
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    await setTimeout(500);
    if (!existsSync(output)) continue;
    let report;
    try { report = JSON.parse(await readFile(output, 'utf8')); } catch { continue; }
    if (Date.parse(report.at) < startedAt) continue;
    console.log(JSON.stringify({ ok: report.ok, pid: report.pid, ...(report.manager ? { manager: report.manager } : { existingSessionsInspected: report.existingSessionsInspected, sessionListCount: report.sessionListCount, noMessagesSent: report.noMessagesSent }), ...(report.error ? { error: report.error } : {}) }, null, 2));
    if (!report.ok) process.exitCode = 1;
    break;
  }
  const report = existsSync(output) ? JSON.parse(await readFile(output, 'utf8')) : null;
  if (!report || Date.parse(report.at) < startedAt) throw new Error('Live probe did not report within 20 seconds. Main plugin remains mounted.');
} finally {
  const current = await readFile(file, 'utf8');
  if (!current.includes(block)) throw new Error('Probe row was edited concurrently; refusing to overwrite the live patch.');
  await writeFile(file, current.replace(block, ''));
}
