import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
export function dshRoot() {
  const candidates = [process.env.DSH_PKG_ROOT, join(homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh'), '/usr/local/lib/node_modules/@deepseek-ai/dsh'];
  const root = candidates.find(candidate => candidate && existsSync(join(candidate, 'lib/bin.js')));
  if (!root) throw new Error('Cannot locate DSH. Set DSH_PKG_ROOT to its installed package directory.');
  return root;
}
export const hostImport = packageName => import(pathToFileURL(join(dshRoot(), 'node_modules', '@deepseek-ai', packageName, 'lib/index.js')).href);
