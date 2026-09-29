import { describe, expect, it } from 'vitest';
import { controlItems, type ControlInput } from './control-items';

const base: ControlInput = { keyboard: null, manual: [], run: null, otherWorktrees: [], unknownRequest: false, transportHold: false,
  resetAgents: [], unknownAgents: [], unknownActivity: [], inputBlocks: [], agentReason: '', setupHeld: false, stale: false, checking: false, inputEnabled: true };

describe('controlItems', () => {
  it('reports you with nothing to decide when nobody else holds the checkout', () => {
    expect(controlItems(base)).toEqual({ summary: 'you', attention: false, items: [] });
  });
  it('names the system as holder in every controller state; only waiting and paused need a decision', () => {
    expect(controlItems({ ...base, run: { status: 'running' } })).toMatchObject({ summary: 'system', attention: false });
    expect(controlItems({ ...base, run: { status: 'waiting' } })).toMatchObject({ summary: 'system · waiting for you', attention: true });
    expect(controlItems({ ...base, run: { status: 'paused' } })).toMatchObject({ summary: 'system · paused', attention: true });
  });
  it('puts server-wide keyboard and manual holds first and names their affected scope', () => {
    const held = controlItems({ ...base, run: { status: 'paused' }, keyboard: { kind: 'other-browser', label: 'another browser' },
      manual: [{ live: true, runs: 1 }, { live: false, runs: 2 }], otherWorktrees: ['/demo/other'] });
    expect(held.summary).toBe('system · manual input unresolved · 2 affected runs');
    expect(held.items.map((item) => [item.id, item.scope])).toEqual([['keyboard', 'server'], ['manual', 'server'], ['scope', 'server'], ['workflow', 'checkout']]);
    expect(held.items.find((item) => item.id === 'scope')!.text).toContain('/demo/other');
    expect(held.items.find((item) => item.id === 'keyboard')).toMatchObject({ takeControl: false, text: expect.stringContaining('Other terminals can also type') });
    // Taking control clears earlier manual input by accepting its possible effects, and says so.
    expect(held.items.find((item) => item.id === 'manual')).toMatchObject({ takeControl: true, text: expect.stringContaining('may have run commands') });
  });
  it('keeps this browser\'s own keyboard informational', () => {
    const mine = controlItems({ ...base, keyboard: { kind: 'this-browser', label: 'Codex' }, manual: [{ live: true, runs: 0 }] });
    expect(mine).toMatchObject({ summary: 'you · keyboard: Codex (this browser)', attention: false });
    expect(controlItems({ ...base, keyboard: { kind: 'unresolved', label: 'an unresolved manual-input record' }, manual: [{ live: false, runs: 0 }] }).summary).toBe('you · manual input unresolved');
  });
  it('lists blockers that no confirmation resolves without offering one', () => {
    const blocked = controlItems({ ...base, stale: true, inputEnabled: false, setupHeld: true, inputBlocks: [{ label: 'Codex', reason: 'Tmux copy mode.' }],
      unknownAgents: ['Claude'], agentReason: 'Recheck Codex before sending.' });
    expect(blocked.attention).toBe(false);
    expect(blocked.items.every((item) => !item.takeControl)).toBe(true);
    expect(blocked.items.map((item) => item.id)).toEqual(['stale', 'read-only', 'setup', 'input:Codex', 'process', 'agent']);
  });
  it('marks recoverable checkout records as needing a decision', () => {
    const records = controlItems({ ...base, unknownRequest: true, transportHold: true, resetAgents: ['Codex'], unknownActivity: ['Claude'] });
    expect(records.attention).toBe(true);
    // Take control clears the uncertain request and delivery holds; identity and activity only need attention or an optional reset.
    expect(records.items.map((item) => [item.id, item.takeControl, item.attention])).toEqual([['request', true, true], ['delivery', true, true], ['identity', false, true], ['activity', false, false]]);
  });
  it('offers an unknown-activity reset without raising attention on its own', () => {
    expect(controlItems({ ...base, unknownActivity: ['Codex'] })).toMatchObject({ summary: 'you', attention: false, items: [{ id: 'activity', takeControl: false }] });
  });
});
