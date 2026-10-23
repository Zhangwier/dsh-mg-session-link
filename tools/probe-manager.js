// The exact read interface used by the built-in plugin management page.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT } from './paths.mjs';
import { pathToFileURL } from 'node:url';

export const name = 'mg-session-manager-probe';
export const inject = ['pluginManager', 'settings'];
export async function apply(ctx) {
  try {
    const bundles = await ctx.pluginManager.listBundles();
    const plugins = await ctx.pluginManager.listPlugins();
    const bundle = bundles.find(item => item.name === 'dsh-mg-session-link');
    const entry = plugins.find(item => item.moduleName === 'dsh-mg-session-link');
    const profile = ctx.get('profileContext');
    const { readInstalled } = await import(pathToFileURL(join(profile.dir, 'node_modules/dshmarket/lib/profile.js')).href);
    const marketSource = readInstalled(profile.name, profile.dir)['dsh-mg-session-link'] ?? null;
    const form = ctx.settings.describe().find(item => item.ns.endsWith('mg-session-link'));
    const manager = { bundle: bundle ?? null, entry: entry ?? null, marketSource, totalBundles: bundles.length, handoffSettings: form ? { namespace: form.ns, autoGenerate: form.autoGenerate, value: form.value } : null };
    await writeFile(join(PROJECT, 'verification-manager.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, readOnly: true, manager, ok: !!bundle?.installed && bundle?.enabled === true && !!marketSource && entry?.enabled === true && form?.autoGenerate === true && typeof form?.value?.autoHandoff === 'boolean' }, null, 2));
  } catch (error) {
    await writeFile(join(PROJECT, 'verification-manager.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ok: false, error: error.stack }, null, 2));
  }
}
