import { ATTACHMENT_LIMITS, type AttachmentUploadInput } from '../contracts/attachments.ts';
import { AppError } from './errors.ts';
import { object, requestId } from './validation.ts';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
/** Ordered, distinct attachment IDs for one draft; absent or empty means a text-only request. */
export function attachmentIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > ATTACHMENT_LIMITS.draftFiles) throw new AppError('INVALID_ATTACHMENTS', `Attach one to ${ATTACHMENT_LIMITS.draftFiles} images.`);
  const ids = value.map((id) => { try { return requestId(id); } catch { throw new AppError('INVALID_ATTACHMENTS', 'Attachment IDs must be UUIDs.'); } });
  if (new Set(ids).size !== ids.length) throw new AppError('INVALID_ATTACHMENTS', 'Each image can be attached once.');
  return ids;
}
/** The `x-altcli-upload` header: bounded JSON naming the request, its workspace and an optional display label. */
export function parseUploadInput(header: string | null): AttachmentUploadInput {
  if (!header || new TextEncoder().encode(header).length > ATTACHMENT_LIMITS.metadataBytes) throw new AppError('INVALID_UPLOAD', 'Upload metadata is missing or too large.');
  let raw: unknown;
  try { raw = JSON.parse(header); } catch { throw new AppError('INVALID_UPLOAD', 'Upload metadata must be JSON.'); }
  const body = object(raw);
  if (Object.keys(body).some((key) => !['requestId', 'workspace', 'name'].includes(key))) throw new AppError('INVALID_UPLOAD', 'Unknown upload field.');
  if (typeof body.workspace !== 'string' || !body.workspace.startsWith('/') || body.workspace.length > 4096 || CONTROL.test(body.workspace)) throw new AppError('INVALID_UPLOAD', 'Choose the workspace this image is for.');
  let name: string | undefined;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || CONTROL.test(body.name)) throw new AppError('INVALID_UPLOAD', 'The image name must be plain text.');
    name = body.name.trim().slice(0, ATTACHMENT_LIMITS.nameLength) || undefined;
  }
  return { requestId: requestId(body.requestId), workspace: body.workspace, ...(name ? { name } : {}) };
}
