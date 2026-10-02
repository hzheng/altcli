import { expect, test } from 'vitest';
import { clearContextCommand, parseClearContext } from './clear-context';

const input = { requestId: '11111111-1111-4111-8111-111111111111', agentId: 'codex', registrationId: '22222222-2222-4222-8222-222222222222', expectedActivityUpdatedAt: null, confirmReady: true };
test('clear context requires an exact target, activity snapshot and explicit confirmation, with no arbitrary command', () => {
  expect(parseClearContext(input)).toEqual(input);
  for (const change of [{ confirmReady: false }, { registrationId: undefined }, { expectedActivityUpdatedAt: undefined }, { expectedActivityUpdatedAt: 'yesterday' }, { text: '/exit' }, { command: '/clear' }]) {
    expect(() => parseClearContext({ ...input, ...change })).toThrow();
  }
  expect(clearContextCommand('claude')).toBe('/clear');
  expect(clearContextCommand('codex')).toBe('/clear');
  expect(clearContextCommand('other')).toBeNull();
});
