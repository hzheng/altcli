// The trusted runner's native invocation boundary. No shell, terminal scraping, or reusable provider conversation.
import { spawn } from 'node:child_process';
export const VERIFIED_CLAUDE_VERSIONS = ['2.1.288 (Claude Code)', '2.1.289 (Claude Code)'];

export function claudeJobArgs(profileArgs, sessionId, schema, bridge, descriptor) {
  return [...profileArgs, '--print', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--no-session-persistence', '--session-id', sessionId, '--json-schema', JSON.stringify(schema),
    '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true,
      enabledPlugins: { 'agents-md@builtin': false, 'plugin-authoring@builtin': false }, autoMemoryEnabled: false,
      disableBundledSkills: true, disableSkillShellExecution: true, syncClaudeAiSkills: false, syncClaudeAiPlugins: false,
      disableClaudeAiConnectors: true, claudeMdExcludes: ['**'] }),
    '--disable-slash-commands', '--no-chrome', '--tools', '', '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {
      altcli_job: { type: 'stdio', command: process.execPath, args: [bridge, descriptor] },
    } }), '--allowedTools', 'mcp__altcli_job'];
}

/** @param {Record<string, string | undefined>} [source] @returns {Record<string, string>} */
export function jobEnvironment(source = process.env) {
  const env = {};
  // No owner credential, workspace correlation, tmux identity, injected NODE_OPTIONS or inherited CLI permission variables.
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'CLAUDE_CONFIG_DIR'])
    if (source[key] !== undefined) env[key] = source[key];
  env.ENABLE_TOOL_SEARCH = 'false';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Completion requires an exited child AND an empty process group. A valid JSON response alone never settles execution.
 * The caller retains ownership when `settled` is false. stdout/stderr and error objects never leave this boundary. */
export function invokeClaude({ executable, args, directory, prompt, sessionId, deadlineMs = 120000, onStarted = (_pid) => {}, onInit = (_event) => {}, signal = undefined }) {
  return new Promise(resolve => {
    let child, pid = null, bytes = 0, pending = '', result = null, initialized = false, model = null, reason = null, finished = false;
    let deadline, killTimer, abandonTimer;
    const finish = (code, forced = false) => {
      if (!forced && reason && pid !== null && groupAlive(pid)) return;
      if (finished) return; finished = true;
      clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(abandonTimer); signal?.removeEventListener('abort', cancel);
      if (pending.trim()) reason ??= 'invalid-output';
      if (result?.structured_output && Buffer.byteLength(JSON.stringify(result.structured_output)) > 8192) reason ??= 'assessment-size';
      const settled = pid === null || !groupAlive(pid);
      const success = settled && !reason && code === 0 && initialized && result?.type === 'result' && result.subtype === 'success'
        && result.is_error === false && result.session_id === sessionId && result.structured_output && typeof result.structured_output === 'object';
      resolve({ settled, pid, sessionId, model, status: success ? 'succeeded' : reason === 'canceled' ? 'canceled' : 'failed',
        category: !settled ? 'process-unsettled' : reason ?? (success ? 'completed' : 'provider-result'),
        assessment: success ? result.structured_output : null });
    };
    const stop = (why) => {
      if (finished || reason) return; reason = why;
      if (!pid) return;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* close and group inspection establish settlement */ }
      killTimer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* inspected below */ } }, 3000);
      abandonTimer = setTimeout(() => finish(null, true), 6000);
    };
    const cancel = () => stop('canceled');
    try {
      child = spawn(executable, args, { cwd: directory, env: jobEnvironment(), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      pid = child.pid ?? null;
    } catch { reason = 'spawn-failed'; finish(null); return; }
    child.once('spawn', () => { onStarted(pid); if (signal?.aborted) cancel(); });
    child.once('error', () => { reason ??= 'spawn-failed'; });
    child.once('close', code => finish(code));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1048576) { stop('output-limit'); return; }
      pending += chunk;
      let at;
      while ((at = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.subtype === 'init') {
            onInit({ tools: event.tools, mcp: event.mcp_servers?.map(s => ({ name: s.name, status: s.status })), plugins: event.plugins?.map(p => ({ name: p.name })) ?? [] });
            // Fail closed before accepting a reply if this installation has loaded inherited tools, plugins, or MCP servers.
            if (initialized || event.session_id !== sessionId || !Array.isArray(event.tools)
              || event.tools.some(name => name !== 'StructuredOutput' && !/^mcp__altcli_job__[a-z_]+$/.test(name))
              || !Array.isArray(event.mcp_servers) || event.mcp_servers.length !== 1
              || event.mcp_servers[0].name !== 'altcli_job' || event.mcp_servers[0].status !== 'connected'
              || (event.plugins?.length ?? 0) !== 0) { stop('adapter-restrictions'); continue; }
            initialized = true; model = typeof event.model === 'string' ? event.model.slice(0, 200) : null;
          }
          if (event.type === 'system' && event.subtype?.startsWith('hook_')) stop('adapter-hooks');
          if (event.type === 'result') { if (result) stop('duplicate-result'); else result = event; }
        } catch { stop('invalid-output'); }
      }
    });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1048576) stop('output-limit'); });
    deadline = setTimeout(() => stop('deadline'), deadlineMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdin.end(prompt);
  });
}
