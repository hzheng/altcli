/** Host-backed image attachments (ROADMAP M4A/M4B). JSON-only shapes shared by the browser and the server. */
export type ImageMediaType = 'image/png' | 'image/jpeg';
export const IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg'];
/** Fixed AltCLI product bounds, not provider limits. */
export const ATTACHMENT_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  /** Per native tray or Control draft. */
  draftFiles: 4, draftBytes: 20 * 1024 * 1024,
  pixels: 40_000_000,
  concurrentUploads: 2,
  retainedBytes: 512 * 1024 * 1024, retainedFiles: 1000,
  /** An unreferenced upload is a draft; it is reclaimed after this age. Referenced images never expire in this increment. */
  draftMs: 24 * 60 * 60 * 1000,
  /** One upload request must finish streaming within this time. */
  uploadMs: 2 * 60 * 1000,
  /** Bounded JSON in the x-altcli-upload request header. */
  metadataBytes: 2048,
  nameLength: 120,
} as const;
/** Sent as JSON in the `x-altcli-upload` header of `POST /api/v1/attachments`; the body is the raw image. */
export interface AttachmentUploadInput {
  /** Client-generated. Retrying the same ID with identical bytes returns the stored result; different bytes conflict. */
  requestId: string;
  /** Canonical worktree root of the workspace this image is for. */
  workspace: string;
  /** Display label only; never a path, and never typed into a terminal. */
  name?: string;
}
/** An upload's receipt. It is a draft until a native insertion or an accepted Control start pins it. */
export interface AttachmentReceipt {
  id: string;
  requestId: string;
  workspace: string;
  mediaType: ImageMediaType;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  name: string | null;
  createdAt: string;
  /** When an unreferenced upload is reclaimed; null once any possible use is recorded. */
  draftExpiresAt: string | null;
}
/** An immutable image frozen into a run, command manifest or assignment. Agents inspect `path` and may verify `sha256`. */
export interface AttachmentDescriptor {
  id: string;
  path: string;
  mediaType: ImageMediaType;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  name: string | null;
}
/** Written beside a plain Send's assignment when it carries images; the wire prompt names only this file. */
export interface InstructionManifest {
  schema: 1;
  commandId: string;
  instruction: string;
  attachments: AttachmentDescriptor[];
}
