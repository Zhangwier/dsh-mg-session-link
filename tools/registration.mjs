import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// Prefer the host's own js-yaml so registration and the host parse identically;
// fall back to a locally installed copy so the suite also runs outside an install.
async function loadYaml() {
  try {
    const { dshRoot } = await import('./paths.mjs');
    const root = dshRoot();
    if (existsSync(join(root, 'node_modules', 'js-yaml'))) return createRequire(join(root, 'package.json'))('js-yaml');
  } catch {}
  return (await import('js-yaml')).default;
}
const yaml = await loadYaml();

export const PACKAGE = 'dsh-mg-session-link';
export const legacyBlock = /# BEGIN MG SESSION LINK[\s\S]*?# END MG SESSION LINK\r?\n?/;

/** Change only this package's registration; all other dependency/lock records survive. */
export function registration(manifestText, lockText, patchText, source, enabled) {
  const before = JSON.parse(manifestText);
  const manifest = structuredClone(before);
  const spec = `link:${source.replaceAll('\\', '/')}`;
  manifest.dependencies ??= {};
  manifest.dependencies[PACKAGE] = spec;
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  const bundles = manifest.dsh.profile.bundles ?? [];
  manifest.dsh.profile.bundles = enabled ? [...bundles.filter(name => name !== PACKAGE), PACKAGE] : bundles.filter(name => name !== PACKAGE);
  const originalLock = yaml.load(lockText);
  if (!originalLock?.importers?.['.']?.dependencies) throw new Error('Expected a pnpm root importer with dependencies; original lock preserved');
  const newline = lockText.includes('\r\n') ? '\r\n' : '\n';
  const ownLock = yaml.dump({ [PACKAGE]: { specifier: spec, version: spec } }, { lineWidth: -1 }).trimEnd().split('\n').map(line => `      ${line}`).join(newline) + newline;
  const existing = /^      (?:dsh-mg-session-link|'dsh-mg-session-link'|"dsh-mg-session-link"):\r?\n(?: {8}[^\r\n]*(?:\r?\n|$))*/m;
  let lock;
  if (existing.test(lockText)) lock = lockText.replace(existing, ownLock);
  else {
    const rootDependencies = /(^importers:\r?\n(?:\r?\n)*  \.:\r?\n    dependencies:\r?\n)/m;
    if (!rootDependencies.test(lockText)) throw new Error('Unsupported lock formatting; original lock preserved');
    lock = lockText.replace(rootDependencies, `$1${ownLock}`);
  }
  const parsed = yaml.load(lock);
  assert.deepEqual(parsed.importers['.'].dependencies[PACKAGE], { specifier: spec, version: spec });
  const compareBefore = structuredClone(originalLock), compareAfter = structuredClone(parsed);
  delete compareBefore.importers['.'].dependencies[PACKAGE];
  delete compareAfter.importers['.'].dependencies[PACKAGE];
  if (!isDeepStrictEqual(compareBefore, compareAfter)) throw new Error('Refuse an unrelated lockfile change');
  const oldDeps = { ...before.dependencies }, newDeps = { ...manifest.dependencies };
  delete oldDeps[PACKAGE]; delete newDeps[PACKAGE];
  assert.deepEqual(newDeps, oldDeps);
  assert.deepEqual(manifest.dsh.profile.bundles.filter(name => name !== PACKAGE), (before.dsh?.profile?.bundles ?? []).filter(name => name !== PACKAGE));
  const cleanPatch = patchText.replace(legacyBlock, '');
  return { manifest: JSON.stringify(manifest, null, 2) + '\n', lock, patch: cleanPatch.trim() ? cleanPatch : '[]\n', spec };
}
