/** Every effect is proposed before it can be authorized. Native model tools stay disabled. */
export type BackgroundOperation =
  | { kind: 'app'; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: Record<string, unknown> }
  | { kind: 'command'; directory: string; executable: string; args: string[]; stdin?: string };
export interface BackgroundPermissions {
  revision: number;
  app: 'ask' | 'allow';
  command: 'ask' | 'allow';
  /** Explicit acceptance of risk decisions ordinarily acknowledged by a person. Never native readiness evidence. */
  risk: 'ask' | 'allow';
}
export interface BackgroundAuthorization {
  actionId: string; decision: 'interactive' | 'policy'; policyRevision: number; at: string;
}
export interface BackgroundAction {
  id: string; requestKey: string; digest: string; attemptId: string; instanceId: string; enablement: number;
  itemId: string; itemRevision: number; sourceVersion: number; policyRevision: number;
  operation: BackgroundOperation; reason: string; risk: boolean;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'denied' | 'stale' | 'uncertain' | 'reconciled';
  createdAt: string; expiresAt: string; updatedAt: string;
  authorization: BackgroundAuthorization | null; pid: number | null;
  result: unknown; message: string;
}
export interface BackgroundLogEntry {
  id: number; at: string; actor: 'background' | 'owner' | 'host'; kind: string;
  actionId: string | null; attemptId: string | null; message: string; detail: unknown;
}
export interface BackgroundActionView {
  permissions: BackgroundPermissions; actions: BackgroundAction[]; entries: BackgroundLogEntry[]; next: number | null;
}
