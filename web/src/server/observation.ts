import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { AppError } from '../core/errors.ts';

const observing = new AsyncLocalStorage<boolean>();
/** Only display reads and periodic terminal checks enter this context. Action/lifecycle evidence stays fresh. */
export const observe = <T>(read: () => Promise<T>): Promise<T> => observing.run(true, read);

/** One completed read per interval, shared by every browser/tool client. Failures also cool down; never serve an older success. */
export class ObservedRead<T> {
  private pending?: Promise<T>;
  private expires = 0;
  private version: unknown;
  private readonly interval: number;
  constructor(interval: number) { this.interval = interval; }
  read(load: () => Promise<T>, revision: () => unknown = () => null): Promise<T> {
    const version = revision();
    // A write during inspection invalidates reuse, but must not fork a second scan alongside it.
    if (this.pending && version !== this.version && this.expires === Infinity) {
      return this.pending.catch(() => {}).then(() => this.read(load, revision));
    }
    if (!this.pending || version !== this.version || performance.now() >= this.expires) {
      this.version = version;
      this.expires = Infinity;
      this.pending = observe(async () => load()).finally(() => { this.expires = performance.now() + this.interval; });
    }
    // Readers must not mutate the shared snapshot (including its proposed registrations).
    return this.pending.then(value => structuredClone(value));
  }
}

// Pace launches, not just concurrent children: fast Git/tmux commands can otherwise fork thousands per second.
export const OBSERVATION_PROCESSES = { spacingMs: 25, concurrent: 4, queued: 256 } as const;
const queue: (() => void)[] = [];
let active = 0, nextStart = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function drain(): void {
  if (timer || !queue.length || active >= OBSERVATION_PROCESSES.concurrent) return;
  const delay = nextStart - performance.now();
  if (delay > 0) { timer = setTimeout(() => { timer = undefined; drain(); }, Math.ceil(delay)); return; }
  nextStart = performance.now() + OBSERVATION_PROCESSES.spacingMs;
  queue.shift()!();
  drain();
}
/** Saturation means display evidence is missing, not that a target changed: callers must never turn it into an effect. */
export const observationBusy = (error: unknown): boolean => error instanceof AppError && error.code === 'OBSERVATION_BUSY';
/** Admission immediately before spawning. No result caching, retries, or throttling of execution-critical checks. */
export function observationProcess<T>(spawn: () => Promise<T>): Promise<T> {
  if (!observing.getStore()) return spawn();
  if (queue.length >= OBSERVATION_PROCESSES.queued) return Promise.reject(new AppError('OBSERVATION_BUSY', 'Host observation is busy. Wait for the next refresh.', 503));
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      active++;
      void Promise.resolve().then(spawn).then(resolve, reject).finally(() => { active--; drain(); });
    });
    drain();
  });
}
