// Enable the new configuration surface while leaving automatic handoff OFF.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PROJECT, dshRoot } from './paths.mjs';

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const profile = process.env.DSH_PROFILE || 'web';
const patch = join(home, 'profiles', profile, 'cordis.patch.yml');
const before = await readFile(patch, 'utf8');
if (before.includes('# BEGIN MG HANDOFF CONFIG')) { console.log('Handoff configuration already deployed; leaving user selections unchanged'); process.exit(0); }
const backup = join(home, 'backups', `mg-session-link-handoff-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(backup, { recursive: true });
await copyFile(patch, join(backup, 'cordis.patch.yml'));
await copyFile(join(home, 'profiles', profile, 'package.json'), join(backup, 'package.json'));
await copyFile(join(home, 'profiles', profile, 'pnpm-lock.yaml'), join(backup, 'pnpm-lock.yaml'));
const overlay = join(backup, 'handoff-preflight.patch.yml');
const block = '# BEGIN MG HANDOFF CONFIG\n- id: mg-session-link\n  config:\n    autoHandoff: false\n    handoffRatio: 0.75\n    handoffTokens: 120000\n    handoffMinTurns: 4\n    handoffCompactions: 3\n# END MG HANDOFF CONFIG\n';
await writeFile(overlay, block);
const check = spawnSync(process.execPath, [join(dshRoot(), 'lib/bin.js'), '--profile', profile, '--patch', overlay, '--dump-config'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
if (check.status !== 0) throw new Error(`Preflight failed; live patch untouched: ${check.stderr}`);
if (await readFile(patch, 'utf8') !== before) throw new Error('Live configuration changed; retry against the new baseline');
const newline = before.includes('\r\n') ? '\r\n' : '\n';
await writeFile(patch, before + (before.endsWith('\n') ? '' : newline) + block.replaceAll('\n', newline));
await writeFile(join(backup, 'DEPLOY.json'), JSON.stringify({ at: new Date().toISOString(), project: PROJECT, version: '0.2.0', autoHandoff: false, existingPatchPrefixUnchanged: true, changes: 'Only append the own-plugin configuration; dependencies, models and other plugins unchanged' }, null, 2));
console.log(JSON.stringify({ backup, autoHandoff: false, version: '0.2.0' }, null, 2));
