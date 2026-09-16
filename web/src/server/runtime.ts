// Imported only by Node route handlers. Do not import from client components.
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { Controller } from "./controller.ts";
import { MockAdapter, mockSessions } from "./adapters/mock.ts";
import { TmuxAdapter, createRunner } from "./adapters/tmux.ts";
import { assertExternalDataDir } from "./paths.ts";
// One controller per process. In development this module is re-evaluated on every server-side edit; a fresh
// evaluation token retires the previous instance (closing its SQLite handle) so hot reloads never run stale code.
const evaluation = Symbol("codercrew-runtime");
const globalRuntime = globalThis as typeof globalThis & { codercrewRuntime?: { token: symbol; controller: Controller } };
export function controller(): Controller {
  const cached = globalRuntime.codercrewRuntime;
  if (cached?.token === evaluation) return cached.controller;
  if (cached) { try { cached.controller.store.close(); } catch { /* already closed */ } }
  const config = loadConfig();
  // Scripts run Next from web/. Keep runtime metadata outside the whole source tree.
  assertExternalDataDir(config.dataDir, resolve(process.cwd(), ".."));
  const store = new Store(config.dataDir);
  if (config.mode === "mock" && store.sessions().length === 0) for (const session of mockSessions()) store.saveSession(session);
  const adapter = config.mode === "mock" ? new MockAdapter() : new TmuxAdapter(createRunner(config.tmuxBin, config.tmuxSocket));
  const instance = new Controller(config, store, adapter);
  globalRuntime.codercrewRuntime = { token: evaluation, controller: instance };
  return instance;
}
