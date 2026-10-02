import { basename } from 'node:path';
import type { LaunchProfile } from '../../contracts/launches.ts';
import { GLOBAL_AI_CLAUDE_EFFORTS, GLOBAL_AI_MODEL } from '../../core/policy.ts';
import { GlobalAIError } from './reads.ts';

/** Direct interactive Claude Code with only a model and effort. Helper sets the permission mode and MCP servers itself, so a
 * profile's permission, tool, MCP, settings, directory, prompt and resume arguments are refused rather than silently dropped. */
export function claudeProfileArgs(profile: LaunchProfile): string[] {
  if (profile.adapterHint !== 'claude' || basename(profile.executable) !== 'claude')
    throw new GlobalAIError('PROFILE_UNSUPPORTED', 'Helper supports a direct Claude Code launch profile, not a shell wrapper or another provider.');
  const accepted: string[] = [];
  for (let i = 0; i < profile.args.length; i++) {
    const flag = profile.args[i]!;
    if (flag === '--model') {
      const value = profile.args[++i];
      if (!value || !GLOBAL_AI_MODEL.test(value)) throw new GlobalAIError('PROFILE_ARGUMENT', 'The model argument is missing or unsupported.');
      accepted.push(flag, value); continue;
    }
    if (flag === '--effort') {
      const value = profile.args[++i];
      if (value && (GLOBAL_AI_CLAUDE_EFFORTS as readonly string[]).includes(value)) { accepted.push(flag, value); continue; }
    }
    throw new GlobalAIError('PROFILE_ARGUMENT', 'Use a dedicated Helper Claude Code profile with only --model and --effort. Permission, tool, MCP, settings, directory, prompt and resume arguments are not supported by Helper.');
  }
  return accepted;
}
