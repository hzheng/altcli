import type { WebSocket } from 'ws';
/** Only this facade crosses the source-host/Next-bundle boundary. It never owns a store. */
export interface TerminalGateway {
  authorize(origin: string | undefined, host: string | undefined): boolean;
  connect(socket: WebSocket): void;
  shutdown(): Promise<void>;
}
interface TerminalHost { gateway?: TerminalGateway; shutdownBackground?: () => Promise<void>;
  consumeBackgroundAction?: (token: string, method: string, path: string, body: unknown) => import('../contracts/background-actions.ts').BackgroundAuthorization;
  active: boolean; closing: boolean; loopbackOrigin?: string }
const root = globalThis as typeof globalThis & { altcliTerminalHost?: TerminalHost };
export function terminalHost(): TerminalHost {
  return root.altcliTerminalHost ??= { active: false, closing: false };
}
