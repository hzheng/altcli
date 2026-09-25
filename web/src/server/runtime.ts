// One process owns the store and scheduler. Restart dev after server edits; never replace a live dispatcher on HMR.
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Controller } from './controller.ts';
import { ControlPlane } from './control-plane.ts';
import { MockAdapter, mockSessions } from './adapters/mock.ts';
import { TmuxAdapter, createRunner } from './adapters/tmux.ts';
import { terminalHost } from './terminal-gateway.ts';
import { assertExternalDataDir } from './paths.ts';
const runtime = globalThis as typeof globalThis & { altcliControlPlane?: ControlPlane };
export function controller(): ControlPlane {
  if (runtime.altcliControlPlane) return runtime.altcliControlPlane;
  const config = loadConfig();
  assertExternalDataDir(config.dataDir, resolve(process.cwd(), '..'));
  const store = new Store(config.dataDir);
  if (config.mode === 'mock' && !store.sessions().length) for (const session of mockSessions()) store.saveSession(session);
  const adapter = config.mode === 'mock' ? new MockAdapter() : new TmuxAdapter(createRunner(config.tmuxBin, config.tmuxSocket));
  const plane = new ControlPlane(new Controller(config, store, adapter));
  runtime.altcliControlPlane = plane;
  terminalHost().gateway = plane.terminals;
  return plane;
}
