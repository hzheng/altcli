import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError } from '../core/errors.ts';
import type { Config } from './config.ts';

const contains = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
async function optional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw new AppError('CLI_CONFIG', `${path} could not be read, so the installed hooks cannot be verified. Inspect it, then Recheck.`, 409);
  }
}
const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
/** The root `notify` array of config.toml, read the way scripts/lib/hook-config.mjs writes and reads it: strings across lines and
 * comments, basic or literal, with escapes; other root values on one line; nothing inside a table counts. Anything the installer
 * would refuse fails closed here too, so an unverifiable notify never lets a referenced checkout be deleted. Null: no root notify. */
function rootNotify(text: string, path: string): string[] | null {
  const unsupported = (what: string) => new AppError('CLI_CONFIG', `${path} has ${what}, so the installed Codex notify command cannot be verified. Normalize it, then Recheck.`, 409);
  let i = 0;
  const space = () => { for (;;) { if (/\s/.test(text[i] ?? '')) i++; else if (text[i] === '#') { while (i < text.length && text[i] !== '\n') i++; } else return; } };
  const balanced = (line: string) => { // one-line root value: quotes and brackets close on this line
    let delimiter = ''; let escaped = false; const stack: string[] = [];
    for (let k = 0; k < line.length; k++) {
      const c = line[k]!;
      if (delimiter) { if (escaped) escaped = false; else if (c === '\\' && delimiter === '"') escaped = true; else if (c === delimiter) delimiter = ''; }
      else if (c === '#') break;
      else if (c === '"' || c === "'") { if (line.slice(k, k + 3) === c.repeat(3)) return false; delimiter = c; }
      else if (c === '[' || c === '{') stack.push(c);
      else if ((c === ']' || c === '}') && stack.pop() !== (c === ']' ? '[' : '{')) return false;
    }
    return !delimiter && !stack.length;
  };
  for (;;) { // root assignments end at the first table header
    space(); if (i >= text.length || text[i] === '[') return null;
    const key = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*/.exec(text.slice(i)); if (!key) throw unsupported('unsupported top-level syntax');
    i += key[0].length; if (key[1] === 'notify') break;
    const end = text.indexOf('\n', i); const line = text.slice(i, end < 0 ? text.length : end);
    if (!balanced(line)) throw unsupported('a multiline root value'); i = end < 0 ? text.length : end + 1;
  }
  space(); if (text[i++] !== '[') throw unsupported('a notify that is not an array');
  const values: string[] = [];
  for (;;) {
    space(); if (text[i] === ']') return values;
    const delimiter = text[i++];
    if (delimiter !== '"' && delimiter !== "'") throw unsupported('a non-string notify value');
    if (text.slice(i, i + 2) === delimiter.repeat(2)) throw unsupported('a multiline notify string');
    let value = ''; let closed = false;
    while (i < text.length) {
      const c = text[i++];
      if (c === delimiter) { closed = true; break; }
      if (c === '\n' || c === '\r') break;
      if (c !== '\\' || delimiter === "'") { value += c; continue; }
      const escape = text[i++]; const escapes: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (escape !== undefined && escape in escapes) { value += escapes[escape]; continue; }
      const length = escape === 'u' ? 4 : escape === 'U' ? 8 : 0; const digits = text.slice(i, i + length);
      if (!length || !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) throw unsupported('an unsupported notify escape');
      try { value += String.fromCodePoint(parseInt(digits, 16)); } catch { throw unsupported('an invalid notify escape'); } i += length;
    }
    if (!closed) throw unsupported('an unclosed notify string');
    values.push(value); space();
    if (text[i] === ']') return values;
    if (text[i++] !== ',') throw unsupported('a malformed notify array');
  }
}
/** Read-only: the host's installed hook commands and skill links that point into `root`, a canonical worktree path.
 * scripts/install-hooks.mjs and scripts/install-skills.mjs own these files; the server never edits them. */
export async function installedInside(root: string, config: Pick<Config, 'claudeConfigDir' | 'codexHome'>): Promise<string[]> {
  const inside = (text: string) => text.includes(`${root}/`);
  const found: string[] = [];
  for (const path of [join(config.claudeConfigDir, 'settings.json'), join(config.codexHome, 'hooks.json')]) {
    const text = await optional(path); if (text === null) continue;
    let hooks: unknown;
    try { hooks = (JSON.parse(text) as { hooks?: unknown })?.hooks; }
    catch { throw new AppError('CLI_CONFIG', `${path} is not valid JSON, so the installed hooks cannot be verified. Fix it, then Recheck.`, 409); }
    if (!hooks || typeof hooks !== 'object') continue;
    for (const [event, entries] of Object.entries(hooks)) if (strings(entries).some(inside)) found.push(`${path} ${event} hook`);
  }
  const toml = join(config.codexHome, 'config.toml'); const text = await optional(toml);
  if (text !== null && (rootNotify(text, toml) ?? []).some(inside)) found.push(`${toml} notify`);
  for (const home of [config.claudeConfigDir, config.codexHome]) {
    const directory = join(home, 'skills'); let names: string[];
    try { names = await readdir(join(home, 'skills')); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw new AppError('CLI_CONFIG', `${directory} could not be read, so the installed skills cannot be verified. Inspect it, then Recheck.`, 409); }
    for (const name of names) {
      const path = join(directory, name);
      let link: string;
      try { link = await readlink(path); }
      catch (error) { if (['EINVAL', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; /* a real directory, or gone */ throw new AppError('CLI_CONFIG', `${path} could not be read, so the installed skills cannot be verified. Inspect it, then Recheck.`, 409); }
      const target = resolve(directory, link);
      if (contains(root, target) || contains(root, await realpath(target).catch(() => target))) found.push(path);
    }
  }
  return found;
}
