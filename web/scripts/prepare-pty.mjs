// node-pty 1.1.0's macOS prebuild ships spawn-helper without its executable bit.
// Keep this fix in the install path so a fresh npm ci has the same behavior.
import { chmodSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, isAbsolute } from 'node:path';
const require = createRequire(import.meta.url);
const root = realpathSync(dirname(require.resolve('node-pty/package.json')));
if (process.platform !== 'win32') {
  for (const path of [join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), join(root, 'build', 'Release', 'spawn-helper')]) {
    if (!existsSync(path)) continue;
    const part = relative(root, realpathSync(path));
    if (isAbsolute(part) || part.startsWith('..') || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Unexpected node-pty helper path.');
    chmodSync(path, lstatSync(path).mode | 0o111);
  }
}
