import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { registration, PACKAGE } from '../tools/registration.mjs';

const manifest = JSON.stringify({ dependencies: { existing: '^1.0.0' }, dsh: { profile: { bundles: ['existing'], patchReload: 'live' } } });
const lock = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n\nimporters:\n\n  .:\n    dependencies:\n      existing:\n        specifier: ^1.0.0\n        version: 1.0.0\n\npackages:\n  existing@1.0.0: {}\n";
const legacy = '# keep this\n- id: unrelated\n  disabled: true\n# BEGIN MG SESSION LINK\n- insert:\n    - id: mg-session-link\n      name: dsh-mg-session-link\n# END MG SESSION LINK\n';

test('managed registration is discoverable, has a matching pnpm link and removes duplicate legacy mount', () => {
  const next = registration(manifest, lock, legacy, 'D:/work/dsh-mg-session-link', true);
  assert.equal(JSON.parse(next.manifest).dependencies[PACKAGE], next.spec);
  assert.ok(JSON.parse(next.manifest).dsh.profile.bundles.includes(PACKAGE));
  assert.deepEqual(yaml.load(next.lock).importers['.'].dependencies[PACKAGE], { specifier: next.spec, version: next.spec });
  assert.equal(next.patch, '# keep this\n- id: unrelated\n  disabled: true\n');
  assert.ok(!next.patch.includes('mg-session-link'));
});

test('registration is idempotent and disabling keeps the plugin installed and discoverable', () => {
  const one = registration(manifest, lock, legacy, 'D:/work/dsh-mg-session-link', true);
  const two = registration(one.manifest, one.lock, one.patch, 'D:/work/dsh-mg-session-link', true);
  assert.deepEqual(two, one);
  const disabled = registration(two.manifest, two.lock, two.patch, 'D:/work/dsh-mg-session-link', false);
  assert.ok(JSON.parse(disabled.manifest).dependencies[PACKAGE]);
  assert.ok(!JSON.parse(disabled.manifest).dsh.profile.bundles.includes(PACKAGE));
  assert.equal(disabled.lock, two.lock);
});
