import { AsyncLocalStorage } from 'node:async_hooks';
import type { BackgroundAuthorization } from '../../contracts/background-actions.ts';

// Route bundles share the authority established by the trusted, one-use HTTP grant, never by model input.
type Scope = { value: BackgroundAuthorization; active: boolean };
const root = globalThis as typeof globalThis & { altcliBackgroundAuthority?: AsyncLocalStorage<Scope> };
const context = root.altcliBackgroundAuthority ??= new AsyncLocalStorage<Scope>();
export const backgroundAuthorization = () => { const scope = context.getStore(); return scope?.active ? scope.value : undefined; };
export function withBackgroundAuthorization<T>(value: BackgroundAuthorization, work: () => T): T {
  const scope = { value, active: true };
  return context.run(scope, () => {
    try {
      const result = work();
      if (result instanceof Promise) return result.finally(() => { scope.active = false; }) as T;
      scope.active = false; return result;
    } catch (error) { scope.active = false; throw error; }
  });
}
export const decisionActor = () => backgroundAuthorization()?.decision === 'policy' ? 'Background under the owner’s saved permission' : 'Human';
