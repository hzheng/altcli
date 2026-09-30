import { ATTACHMENT_LIMITS as L, IMAGE_TYPES, type AttachmentReceipt, type ImageMediaType } from '../contracts/attachments';
import type { ApiError } from '../contracts/api';
import { api, HttpError } from './api';

/** One image in a native tray or Control draft. Page memory only; Lock forgets it and revokes its preview. */
export interface ImageItem {
  key: string;
  requestId: string;
  file: File;
  name: string;
  url: string;
  status: 'checking' | 'uploading' | 'ready' | 'inserting' | 'inserted' | 'uncertain' | 'failed';
  receipt?: AttachmentReceipt;
  error?: string;
}
const MiB = 1024 * 1024;
const previews = new Set<string>();
export function previewUrl(file: File): string { const url = URL.createObjectURL(file); previews.add(url); return url; }
export function revokePreview(url: string): void { if (previews.delete(url)) URL.revokeObjectURL(url); }
/** Lock: every preview in this page is released. */
export function revokePreviews(): void { for (const url of previews) URL.revokeObjectURL(url); previews.clear(); }

/** The image files of a paste, plus whether it also carries plain text. HTML and URLs are never read or fetched. */
export function clipboardImages(data: DataTransfer | null): { images: File[]; text: string } {
  if (!data) return { images: [], text: '' };
  const images = Array.from(data.files).filter((file) => file.type.startsWith('image/'));
  return { images, text: data.getData('text/plain') };
}
/** Applies the fixed format, size and count bounds; nothing is silently dropped: each excess or unsupported file is reported. */
export function admitImages(files: File[], existing: readonly ImageItem[]): { accepted: File[]; problems: string[] } {
  const accepted: File[] = [], problems: string[] = [];
  let count = existing.length, bytes = existing.reduce((sum, item) => sum + item.file.size, 0);
  for (const file of files) {
    const name = file.name || 'image';
    if (!IMAGE_TYPES.includes(file.type as ImageMediaType)) { problems.push(`${name}: only PNG and JPEG images can be attached (this is ${file.type || 'an unknown type'}).`); continue; }
    if (file.size > L.fileBytes) { problems.push(`${name}: images are limited to ${L.fileBytes / MiB} MiB.`); continue; }
    if (count + 1 > L.draftFiles) { problems.push(`${name}: at most ${L.draftFiles} images can be attached here.`); continue; }
    if (bytes + file.size > L.draftBytes) { problems.push(`${name}: attached images are limited to ${L.draftBytes / MiB} MiB in total.`); continue; }
    accepted.push(file); count++; bytes += file.size;
  }
  return { accepted, problems };
}
/** The browser must be able to decode an image before it is uploaded or sent. */
export async function decodes(file: File): Promise<boolean> {
  try { const bitmap = await createImageBitmap(file); bitmap.close(); return true; } catch { return false; }
}
/** Header values must be Latin-1: escape everything else in the metadata JSON (a file name such as 截屏.png), which the server decodes. */
const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** One raw upload. Retrying the same request ID with the same file returns the stored result; nothing retries automatically. */
export async function uploadImage(token: string, item: Pick<ImageItem, 'requestId' | 'file' | 'name'>, workspace: string, signal?: AbortSignal): Promise<AttachmentReceipt> {
  const response = await fetch('/api/v1/attachments', { method: 'POST', body: item.file, cache: 'no-store', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': item.file.type, 'x-altcli-upload': asciiJson({ requestId: item.requestId, workspace, ...(item.name ? { name: item.name.slice(0, L.nameLength) } : {}) }) } });
  const data: unknown = await response.json();
  if (!response.ok) throw new HttpError((data as ApiError).error?.message ?? 'Upload failed.', response.status, (data as ApiError).error?.code);
  return data as AttachmentReceipt;
}
export function removeImage(token: string, id: string): Promise<{ ok: true; removed: boolean }> {
  return api(token, `attachments/${id}`, { method: 'DELETE' });
}
/** The order-sensitive identity of a draft's images, for readiness and action-intent keys. */
export const imagesKey = (items: readonly ImageItem[]) => items.map((item) => [item.key, item.status, item.receipt?.id ?? null, item.receipt?.sha256 ?? null]);
/** Why a draft's images block an action, or empty. */
export function imagesBlocker(items: readonly ImageItem[]): string {
  if (items.some((item) => item.status === 'checking' || item.status === 'uploading')) return 'Wait for the images to finish uploading.';
  if (items.some((item) => item.status === 'failed')) return 'Remove or retry the image that could not be uploaded.';
  return '';
}
