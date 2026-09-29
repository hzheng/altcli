/** What currently holds Control for the selected checkout, and what to watch for when taking it, as read-only notes for the one Control
 * access panel. Presentation only: nothing here grants or confirms anything. Taking control is the user's call; these notes say what
 * it cannot undo or see, and which holds its one confirmation clears. Each of those steps keeps its own request and server checks. */
export type ControlScope = 'server' | 'checkout';
export interface ControlItem {
  id: string; scope: ControlScope;
  /** Needs a human decision (shown with the attention marker). */
  attention: boolean;
  /** The one Take control confirmation clears it; otherwise the note names what to watch for, or the real blocker and its route. */
  takeControl: boolean;
  text: string;
}
export interface ControlInput {
  /** Aggregate server-reported writers, or null when no manual period exists. */
  keyboard: { kind: 'this-browser' | 'this-browser-elsewhere' | 'other-browser' | 'unresolved'; label: string } | null;
  /** Manual-input records: a live period has one or more writers; stopped periods need reconciliation. */
  manual: { live: boolean; runs: number }[];
  /** This checkout's owned run, if any. */
  run: { status: string } | null;
  /** Other worktrees whose runs a server-wide hold affects. */
  otherWorktrees: string[];
  unknownRequest: boolean; transportHold: boolean;
  /** Agent labels by condition. */
  resetAgents: string[]; unknownAgents: string[]; unknownActivity: string[];
  inputBlocks: { label: string; reason: string }[];
  /** The selected agent's own reason (unregistered, no capture), or empty. */
  agentReason: string;
  setupHeld: boolean; stale: boolean; checking: boolean; inputEnabled: boolean;
}
export interface ControlSummary { summary: string; attention: boolean; items: ControlItem[] }

const list = (labels: string[]) => labels.join(', ');

export function controlItems(input: ControlInput): ControlSummary {
  const items: ControlItem[] = [];
  const add = (id: string, scope: ControlScope, attention: boolean, takeControl: boolean, text: string) => items.push({ id, scope, attention, takeControl, text });
  const k = input.keyboard;
  const unresolved = input.manual.filter((m) => !m.live);
  if (k?.kind === 'this-browser') add('keyboard', 'server', false, false, `You type in ${k.label} in this browser. AltCLI dispatch, setup and launch wait until you release it below; a Send that offers the keyboard handoff releases it first.`);
  else if (k && k.kind !== 'unresolved') add('keyboard', 'server', true, false, `Input is active in ${k.label}. Other terminals can also type; automation waits until every writer is stopped and manual input is reconciled.`);
  if (unresolved.length) add('manual', 'server', true, true, `Earlier manual terminal input (${unresolved.length === 1 ? 'one record' : `${unresolved.length} records`}) may have run commands or left background work that AltCLI cannot see. Taking control records that you accept this and lifts the server-wide hold.`);
  if ((k || input.manual.length) && input.otherWorktrees.length) add('scope', 'server', false, false, `This server-wide hold also affects runs in ${list(input.otherWorktrees)}.`);
  const status = input.run?.status;
  if (status === 'running') add('workflow', 'checkout', false, true, 'The controller is driving this checkout. Taking control ends its run without interrupting the agent, which may still be working: check its terminal before typing or sending.');
  else if (status === 'waiting') add('workflow', 'checkout', true, true, 'The controller is waiting for your Next turn. Taking control ends its run instead of continuing it.');
  else if (status === 'paused') add('workflow', 'checkout', true, true, 'The controller is paused and still holds this checkout. Taking control ends its run; the agent was not interrupted and may still be working.');
  if (input.unknownRequest) add('request', 'checkout', true, true, 'A request has an uncertain result and may have reached the terminal. Check the terminal before sending again; nothing is resent.');
  if (input.transportHold) add('delivery', 'checkout', true, true, 'An older delivery may have left partly typed input in a terminal. Check it before typing.');
  if (input.resetAgents.length) add('identity', 'checkout', true, false, `The saved CLI identity is outdated for ${list(input.resetAgents)}. Recheck, or reset the workspace below.`);
  // Common after a backend restart and not a hold by itself; the holds it can block (manual input, checkpoints) raise their own attention.
  if (input.unknownActivity.length) add('activity', 'checkout', false, false, `Activity is unknown for ${list(input.unknownActivity)}: they may still be working. Check their terminals; mark one Ready below once it is at an empty prompt.`);
  if (input.stale) add('stale', 'checkout', false, false, 'The console is not current. Wait for it to reconnect.');
  if (input.checking) add('checking', 'checkout', false, false, 'Recheck is running.');
  if (!input.inputEnabled) add('read-only', 'server', false, false, 'Read-only console: the host has disabled input.');
  if (input.setupHeld) add('setup', 'checkout', false, false, 'A worktree operation is applying or uncertain. Reconcile it in Projects.');
  for (const block of input.inputBlocks) add(`input:${block.label}`, 'checkout', false, false, `${block.label}: ${block.reason}`);
  if (input.unknownAgents.length) add('process', 'checkout', false, false, `The host cannot confirm the CLI process for ${list(input.unknownAgents)}. Recheck.`);
  if (input.agentReason) add('agent', 'checkout', false, false, input.agentReason);
  const affected = unresolved.reduce((n, m) => n + m.runs, 0);
  // Who holds this checkout's workflow is one of two: the system (the controller's run, in any state) or you. A hold worth naming follows it.
  const holder = status === 'running' || status === 'waiting' || status === 'paused' ? 'system' : 'you';
  const detail = unresolved.length ? `manual input unresolved${affected ? ` · ${affected} affected run${affected === 1 ? '' : 's'}` : ''}`
    : k && k.kind !== 'this-browser' ? 'keyboard held elsewhere'
    : k ? `keyboard: ${k.label} (this browser)`
    : status === 'paused' ? 'paused' : status === 'waiting' ? 'waiting for you' : '';
  const summary = detail ? `${holder} · ${detail}` : holder;
  return { summary, attention: items.some((item) => item.attention), items };
}
