// Register as a normal managed local bundle. No pnpm install, no unrelated upgrades.
import { readFile, writeFile, mkdir, copyFile, symlink, realpath, mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PROJECT, dshRoot } from './paths.mjs';
import { PACKAGE, registration, legacyBlock } from './registration.mjs';

const command = process.argv[2] || '--status';
if (!['--enable', '--disable', '--status'].includes(command)) throw new Error('Use --enable, --disable or --status');
const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileName = process.env.DSH_PROFILE || 'web';
if (!/^[a-z0-9_-]+$/i.test(profileName)) throw new Error('Invalid profile name');
const profile = join(home, 'profiles', profileName);
const files = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'];
const previous = await Promise.all(files.map(file => readFile(join(profile, file), 'utf8')));
const manifest = JSON.parse(previous[0]);
const installed = !!manifest.dependencies?.[PACKAGE];
const selected = (manifest.dsh?.profile?.bundles ?? []).includes(PACKAGE);
if (command === '--status') {
  let runtime = null;
  try { runtime = JSON.parse(await readFile(join(home, 'mg-session-link', profileName, 'runtime.json'), 'utf8')); } catch {}
  console.log(JSON.stringify({ installed, selected, legacyMount: legacyBlock.test(previous[2]), project: PROJECT, profile: profileName, runtime }, null, 2));
  process.exit(0);
}
const deps = join(PROJECT, 'node_modules');
if (!existsSync(deps)) await symlink(join(dshRoot(), 'node_modules'), deps, 'junction');
const packageLink = join(profile, 'node_modules', PACKAGE);
if (!existsSync(packageLink)) await symlink(PROJECT, packageLink, 'junction');
else if ((await realpath(packageLink)).toLowerCase() !== (await realpath(PROJECT)).toLowerCase()) throw new Error(`Refuse to overwrite another package at ${packageLink}`);
const next = registration(...previous, PROJECT, command === '--enable');
const updated = [next.manifest, next.lock, next.patch];
if (updated.every((text, index) => text === previous[index])) { console.log('Already in requested managed state'); process.exit(0); }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(home, 'backups', `mg-session-link-managed-${stamp}`);
await mkdir(backup, { recursive: true });
for (const file of files) await copyFile(join(profile, file), join(backup, file));

// Test final manifest and patch together before the live watcher sees them.
const sandbox = await mkdtemp(join(tmpdir(), 'mg-managed-preflight-'));
try {
  const stagedProfile = join(sandbox, 'profiles', profileName);
  await mkdir(stagedProfile, { recursive: true });
  await symlink(join(profile, 'node_modules'), join(stagedProfile, 'node_modules'), 'junction');
  await writeFile(join(stagedProfile, 'cordis.yml'), '[]\n');
  for (let index = 0; index < files.length; index++) await writeFile(join(stagedProfile, files[index]), updated[index]);
  if (existsSync(join(home, 'cordis.patch.yml'))) await copyFile(join(home, 'cordis.patch.yml'), join(sandbox, 'cordis.patch.yml'));
  const check = spawnSync(process.execPath, [join(dshRoot(), 'lib/bin.js'), '--profile', profileName, '--dump-config'], { env: { ...process.env, DSH_HOME: sandbox }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (check.status !== 0) throw new Error(`Managed composition preflight failed; live files untouched: ${check.stderr}`);
} finally {
  const target = await realpath(sandbox), temporaryRoot = await realpath(tmpdir());
  if (!target.toLowerCase().startsWith((temporaryRoot + sep).toLowerCase()) || !basename(target).startsWith('mg-managed-preflight-')) throw new Error('Unsafe cleanup target');
  await rm(target, { recursive: true, force: true });
}
for (let index = 0; index < files.length; index++) {
  if (await readFile(join(profile, files[index]), 'utf8') !== previous[index]) throw new Error('Profile changed during preflight; retry against the new baseline');
}
// Consecutive synchronous writes keep watched files in one short operation.
writeFileSync(join(profile, 'pnpm-lock.yaml'), next.lock);
writeFileSync(join(profile, 'package.json'), next.manifest);
writeFileSync(join(profile, 'cordis.patch.yml'), next.patch);
const hash = text => createHash('sha256').update(text).digest('hex');
await writeFile(join(backup, 'INSTALL.json'), JSON.stringify({ at: new Date().toISOString(), command, profile, source: next.spec, package: PACKAGE, changedFiles: files.filter((_, i) => previous[i] !== updated[i]), before: previous.map(hash), after: updated.map(hash), otherDependenciesAndLockEntriesUnchanged: true }, null, 2));
console.log(JSON.stringify({ command, backup, registeredBundle: PACKAGE, source: next.spec, otherDependenciesAndLockEntriesUnchanged: true, legacyMountRemoved: !legacyBlock.test(next.patch) }, null, 2));
