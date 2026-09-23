/** Conservative, dependency-free configuration editing. Unsupported TOML is refused before any write. */
const ours = (value) => typeof value === 'string' && /(?:^|[\\/])altcli-turn-complete\.(?:sh|mjs)(?:['"\s]|$)/.test(value);
const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function claudeSettings(text, hook) {
  const settings = text === null ? {} : JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude settings must be an object.');
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('Unsupported Claude hooks object.');
  const hooks = { ...(settings.hooks ?? {}) };
  for (const name of ['UserPromptSubmit', 'Stop', 'SessionStart']) {
    const groups = hooks[name] ?? [];
    if (!Array.isArray(groups)) throw new Error(`Unsupported Claude ${name} hooks.`);
    const kept = groups.map((group) => {
      if (!group || !Array.isArray(group.hooks)) throw new Error('Unsupported Claude hook group.');
      return { ...group, hooks: group.hooks.filter((entry) => !ours(entry.command)) };
    }).filter((group) => group.hooks.length);
    hooks[name] = [...kept, { ...(name === 'SessionStart' ? { matcher: 'startup|resume' } : {}), hooks: [{ type: 'command', command: `${quote(hook)} claude`, timeout: 10 }] }];
  }
  const result = JSON.stringify({ ...settings, hooks }, null, 2) + '\n';
  JSON.parse(result); return result;
}
export function codexHooks(text, hook) {
  const settings = text === null ? {} : JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Codex hooks must be an object.');
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('Unsupported Codex hooks object.');
  const hooks = { ...settings.hooks };
  for (const name of ['UserPromptSubmit', 'SessionStart', 'Interrupt']) {
    const groups = hooks[name] ?? [];
    if (!Array.isArray(groups)) throw new Error(`Unsupported Codex ${name} hooks.`);
    const kept = groups.map((group) => {
      if (!group || !Array.isArray(group.hooks)) throw new Error('Unsupported Codex hook group.');
      return { ...group, hooks: group.hooks.filter((entry) => !ours(entry.command)) };
    }).filter((group) => group.hooks.length);
    hooks[name] = [...kept, { ...(name === 'SessionStart' ? { matcher: 'startup|resume' } : {}),
      hooks: [{ type: 'command', command: `exec ${quote(hook)} codex-start`, timeout: name === 'Interrupt' ? 3 : 10 }] }];
  }
  return JSON.stringify({ ...settings, hooks }, null, 2) + '\n';
}
function stringArray(text, start) {
  let i = start;
  const space = () => { while (i < text.length) { if (/\s/.test(text[i])) i++; else if (text[i] === '#') { while (i < text.length && text[i] !== '\n') i++; } else break; } };
  space(); if (text[i++] !== '[') throw new Error('notify must be a TOML string array.');
  const values = [];
  for (;;) {
    space(); if (text[i] === ']') return { values, end: i + 1 };
    const delimiter = text[i++];
    if (delimiter !== '"' && delimiter !== "'") throw new Error('Unsupported notify value. Nothing was changed.');
    if (text.slice(i, i + 2) === delimiter.repeat(2)) throw new Error('Multiline TOML strings are unsupported; normalize notify manually first.');
    let value = ''; let closed = false;
    while (i < text.length) {
      const c = text[i++];
      if (c === delimiter) { closed = true; break; }
      if (c === '\n' || c === '\r' || c.charCodeAt(0) < 32) throw new Error('Invalid notify string.');
      if (c !== '\\' || delimiter === "'") { value += c; continue; }
      const escape = text[i++];
      const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (escape in escapes) value += escapes[escape];
      else if (escape === 'u' || escape === 'U') {
        const length = escape === 'u' ? 4 : 8; const digits = text.slice(i, i + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) throw new Error('Invalid TOML Unicode escape.');
        const code = parseInt(digits, 16); if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('Invalid Unicode scalar.');
        value += String.fromCodePoint(code); i += length;
      } else throw new Error('Unsupported TOML escape.');
    }
    if (!closed) throw new Error('Unclosed notify string.');
    values.push(value); space();
    if (text[i] === ']') return { values, end: i + 1 };
    if (text[i++] !== ',') throw new Error('Expected comma in notify array.');
  }
}
/** Other root assignments must fit one line. This deliberately refuses ambiguous input instead of guessing. */
function safeOtherLine(value) {
  let delimiter = ''; let escaped = false; const stack = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (delimiter) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\' && delimiter === '"') { escaped = true; continue; }
      if (c === delimiter) delimiter = '';
    } else if (c === '#') break;
    else if (c === '"' || c === "'") { if (value.slice(i, i + 3) === c.repeat(3)) return false; delimiter = c; }
    else if (c === '[' || c === '{') stack.push(c);
    else if (c === ']' || c === '}') { if (stack.pop() !== (c === ']' ? '[' : '{')) return false; }
  }
  return !delimiter && !stack.length;
}
export function codexConfig(text, hook) {
  let offset = 0; let found = null;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset); const end = newline < 0 ? text.length : newline;
    const line = text.slice(offset, end);
    if (/^\s*(?:#.*)?$/.test(line)) { offset = end + 1; continue; }
    if (/^\s*\[/.test(line)) break; // Root notify belongs before the first table. Table-local keys are untouched.
    const assignment = /^\s*([A-Za-z0-9_-]+)\s*=\s*/.exec(line);
    if (!assignment) throw new Error('Unsupported top-level TOML syntax. No config files were changed.');
    if (assignment[1] === 'notify') {
      if (found) throw new Error('Duplicate root notify keys.');
      const parsed = stringArray(text, offset + assignment[0].length);
      const tailEnd = text.indexOf('\n', parsed.end); const tail = text.slice(parsed.end, tailEnd < 0 ? text.length : tailEnd);
      if (!/^\s*(?:#.*)?$/.test(tail)) throw new Error('Unexpected text after notify array.');
      found = { start: offset, end: parsed.end, values: parsed.values };
      offset = tailEnd < 0 ? text.length : tailEnd + 1;
    } else {
      if (!safeOtherLine(line.slice(assignment[0].length))) throw new Error('Unsupported multiline root TOML value. Normalize it before installing hooks.');
      offset = end + 1;
    }
  }
  let previous = found?.values ?? [];
  while (previous.length && ours(previous[0])) { const at = previous.indexOf('--then'); previous = at < 0 ? [] : previous.slice(at + 1); }
  const replacement = `notify = ${JSON.stringify([hook, 'codex', ...(previous.length ? ['--then', ...previous] : [])])}`;
  // Validate the edited value with the same syntax-aware reader before touching disk.
  stringArray(replacement, replacement.indexOf('=') + 1);
  return found ? text.slice(0, found.start) + replacement + text.slice(found.end) : `${replacement}\n${text}`;
}
