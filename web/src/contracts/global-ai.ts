import type { PaneIdentity } from './api.ts';
import type { LaunchProfile } from './launches.ts';

/** A1 is a user-operated CLI with read-only AltCLI tools, not a background worker. */
export interface GlobalAIInstance {
  schema: 1;
  id: string;
  requestId: string;
  requestDigest: string;
  role: 'global_ai';
  profile: LaunchProfile;
  executable: string;
  args: string[];
  directory: string;
  sessionName: string;
  sessionId: string | null;
  windowId: string | null;
  identity: PaneIdentity | null;
  phase: 'reserved' | 'creating' | 'placeholder' | 'executing' | 'observed';
  status: 'launching' | 'started' | 'uncertain' | 'retired';
  message: string;
  createdAt: string;
  updatedAt: string;
}
export interface GlobalAIPreview {
  id: string;
  digest: string;
  expiresAt: string;
  profile: LaunchProfile;
  executable: string;
  args: string[];
  directory: string;
  sessionName: string;
}
export interface GlobalAIView {
  instance: GlobalAIInstance | null;
  toolsEnabled: boolean;
  toolsExpireAt: string | null;
  observedModel: null;
  nativeState: 'unverified' | 'alive' | 'exited' | 'unavailable';
  nativeMessage: string;
  enabled: boolean;
}
export interface AppTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: false };
}
export interface ToolReply {
  source: string;
  observedAt: string;
  revision: string;
  data: unknown;
}
