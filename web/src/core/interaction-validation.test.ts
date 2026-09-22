import { describe, expect, it } from 'vitest';
import { parseInteraction, parseCheckpoint } from './interaction-validation';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = { requestId: id, runId: id, commandId: id, agentId: 'codex', registrationId: id, sessionId: 'session', sourceTurnId: 'turn', expectedRevision: 0, confirmPresent: true, purpose: 'answer', text: '1' };
describe('literal terminal input contract', () => {
  it('preserves numeric answers and multiline text without inventing an action', () => {
    expect(parseInteraction(input).text).toBe('1');
    expect(parseInteraction({ ...input, text: 'line one\nline two' }).text).toBe('line one\nline two');
  });
  it('bounds bytes and refuses control sequences, blank input and correlation markers', () => {
    for (const text of ['', ' ', '\u001b[A', '中'.repeat(667), '[codercrew-command:fake]']) expect(() => parseInteraction({ ...input, text })).toThrow();
    expect(parseInteraction({ ...input, text: 'a'.repeat(2000) }).text).toHaveLength(2000);
  });
  it('requires fresh identity, explicit presence and a closed schema', () => {
    for (const change of [{ agentId: '' }, { expectedRevision: -1 }, { confirmPresent: false }, { handoff: true }, { sessionId: '' }]) expect(() => parseInteraction({ ...input, ...change })).toThrow();
  });
  it('allows only Enter and separately confirmed Escape with no text payload', () => {
    const key = { ...input, text: undefined, purpose: 'key', key: 'Enter' };
    expect(parseInteraction(key).key).toBe('Enter');
    for (const change of [{ key: 'C-c' }, { key: 'Escape' }, { text: '1' }, { confirmInterrupt: 'yes' }]) expect(() => parseInteraction({ ...key, ...change })).toThrow();
    expect(parseInteraction({ ...key, key: 'Escape', confirmInterrupt: true }).key).toBe('Escape');
  });
  it('makes checkpoint recovery an explicit version-bound action', () => {
    const cp = { requestId: id, runId: id, commandId: id, expectedRevision: 1, action: 'restore', confirmReady: true };
    expect(parseCheckpoint(cp).action).toBe('restore');
    for (const change of [{ confirmReady: false }, { expectedRevision: 1.5 }, { action: 'resume' }, { text: 'x' }]) expect(() => parseCheckpoint({ ...cp, ...change })).toThrow();
  });
});
