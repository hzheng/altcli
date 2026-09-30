import { describe, expect, it } from 'vitest';
import { attachmentIds, parseUploadInput } from './attachment-validation';
import { parseImplementation, parseStandalone } from './implementation-validation';
import { parsePlan } from './planning-validation';

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const request = '11111111-1111-4111-8111-111111111111';
describe('attachment IDs', () => {
  it('keeps order and refuses duplicates, non-UUIDs, empty and oversized selections', () => {
    expect(attachmentIds([id(3), id(2)])).toEqual([id(3), id(2)]);
    expect(() => attachmentIds([id(2), id(2)])).toThrow(/once/);
    expect(() => attachmentIds(['../x'])).toThrow(/UUID/);
    expect(() => attachmentIds([])).toThrow(/one to 4/);
    expect(() => attachmentIds([id(1), id(2), id(3), id(4), id(5)])).toThrow(/one to 4/);
    expect(() => attachmentIds('x')).toThrow(/one to 4/);
  });
});
describe('upload metadata', () => {
  it('accepts a request, an absolute workspace and a trimmed display name', () => {
    expect(parseUploadInput(JSON.stringify({ requestId: request, workspace: '/w', name: '  shot.png ' }))).toEqual({ requestId: request, workspace: '/w', name: 'shot.png' });
    expect(parseUploadInput(JSON.stringify({ requestId: request, workspace: '/w', name: 'x'.repeat(500) })).name).toHaveLength(120);
    expect(parseUploadInput(JSON.stringify({ requestId: request, workspace: '/w', name: '   ' }))).toEqual({ requestId: request, workspace: '/w' });
  });
  it('refuses missing, oversized, malformed and unexpected metadata', () => {
    expect(() => parseUploadInput(null)).toThrow(/missing/);
    expect(() => parseUploadInput('{')).toThrow(/JSON/);
    expect(() => parseUploadInput(JSON.stringify({ requestId: request, workspace: '/w', path: '/etc/passwd' }))).toThrow(/Unknown/);
    expect(() => parseUploadInput(JSON.stringify({ requestId: request, workspace: 'relative' }))).toThrow(/workspace/);
    expect(() => parseUploadInput(JSON.stringify({ requestId: request, workspace: '/w', name: 'a\u001b[31m' }))).toThrow(/plain text/);
    expect(() => parseUploadInput(JSON.stringify({ requestId: request, workspace: `/${'w'.repeat(3000)}` }))).toThrow(/too large/);
  });
});
describe('start validators', () => {
  const group = { requestId: request, groupId: 'g', groupRevision: 1, registrations: { codex: request }, agentId: 'codex', policy: 'solo', confirmReady: true };
  it('accept images only for plain Send, new work and a Plan brief', () => {
    expect(parseStandalone({ ...group, text: 'Look', attachments: [id(2)] }).attachments).toEqual([id(2)]);
    const work = { ...group, kind: 'work', text: 'Fix', handoff: false, autoContinue: false, turnLimit: 5, branch: { branch: 'task', head: 'a'.repeat(40) } };
    expect(parseImplementation({ ...work, attachments: [id(2)] }).attachments).toEqual([id(2)]);
    expect(() => parseImplementation({ ...work, kind: 'commit', text: undefined, attachments: [id(2)] })).toThrow(/new work/);
    expect(() => parseImplementation({ ...work, kind: 'review', reviewBase: 'b'.repeat(40), attachments: [id(2)] })).toThrow(/new work/);
    const plan = { requestId: request, groupId: 'g', groupRevision: 1, registrations: { codex: request }, text: 'Plan it', baseline: { branch: 'task', head: 'a'.repeat(40) },
      autoContinue: false, requireApproval: true, turnLimit: 5, implementation: { groupId: 'g', groupRevision: 1, registrations: { codex: request }, agentId: 'codex', handoff: false, policy: 'solo', branch: null }, confirmReady: true };
    expect(parsePlan({ ...plan, attachments: [id(2)] }).attachments).toEqual([id(2)]);
    expect(parsePlan(plan)).not.toHaveProperty('attachments');
    expect(() => parsePlan({ ...plan, implementation: { ...plan.implementation, attachments: [id(2)] } })).toThrow(/Unknown post-plan/);
  });
});
