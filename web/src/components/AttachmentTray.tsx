'use client';
import { useRef, type ClipboardEvent, type MouseEvent } from 'react';
import { IconButton } from './Hint';
import { ATTACHMENT_LIMITS } from '../contracts/attachments';
import { useMemoryCell } from '../client/memory';
import { admitImages, clipboardImages, decodes, previewUrl, removeImage, revokePreview, uploadImage, type ImageItem } from '../client/attachments';
import { HttpError } from '../client/api';

const EMPTY: ImageItem[] = [];
const MIXED = 'The clipboard holds an image and text. Attach the image? Cancel pastes the text instead.';
const DECODE = 'This browser could not decode the image.';
/** Uploads in flight, by image key: they belong to the page draft, not to the component that started them. */
const inFlight = new Map<string, AbortController>();
/** Lock: uploads still in flight are cancelled; their drafts are already forgotten. */
export function abortUploads(): void { for (const abort of inFlight.values()) abort.abort(); inFlight.clear(); }
/** One draft's images, remembered in page memory under `memoryKey`. Uploading never sends, inserts or grants anything. A completion
 * updates its own draft even after the composer that started it unmounted, and reaches the composer showing that draft now; an image
 * removed meanwhile (or forgotten by Lock) is never recreated. */
export function useImageTray(token: string, workspace: string, memoryKey: string) {
  const [items, cell] = useMemoryCell<ImageItem[]>(memoryKey, EMPTY);
  const setItems = cell.update;
  const patch = (key: string, change: (item: ImageItem) => ImageItem) => setItems((current) => current.map((item) => item.key === key ? change(item) : item));
  async function upload(item: ImageItem) {
    const abort = new AbortController(); inFlight.set(item.key, abort);
    try {
      if (!await decodes(item.file)) { patch(item.key, (i) => ({ ...i, status: 'failed', error: DECODE })); return; }
      patch(item.key, (i) => ({ ...i, status: 'uploading', error: undefined }));
      const receipt = await uploadImage(token, item, workspace, abort.signal);
      patch(item.key, (i) => i.status === 'uploading' ? { ...i, status: 'ready', receipt } : i);
    } catch (error) {
      if (!abort.signal.aborted) patch(item.key, (i) => ({ ...i, status: 'failed', error: error instanceof Error ? error.message : 'Upload failed.' }));
    } finally { if (inFlight.get(item.key) === abort) inFlight.delete(item.key); }
  }
  /** Adds files within the fixed bounds and starts their uploads; returns a description of every file not attached. */
  function add(files: File[]): string[] {
    const { accepted, problems } = admitImages(files, cell.get());
    const created: ImageItem[] = accepted.map((file) => ({ key: crypto.randomUUID(), requestId: crypto.randomUUID(), file, name: file.name || 'pasted image', url: previewUrl(file), status: 'checking' }));
    if (created.length) setItems((current) => [...current, ...created]);
    for (const item of created) void upload(item);
    return problems;
  }
  /** An explicit retry resends the same request ID and file; the server returns the stored image or a conflict. */
  function retry(key: string) {
    const item = cell.get().find((i) => i.key === key);
    if (item?.status === 'failed' && item.error !== DECODE) { patch(key, (i) => ({ ...i, status: 'checking' })); void upload(item); }
  }
  /** Removes a preview. An unreferenced upload is also deleted from the host; a possibly used one stays there. */
  async function remove(key: string): Promise<string> {
    const item = cell.get().find((i) => i.key === key);
    if (!item) return '';
    inFlight.get(key)?.abort(); inFlight.delete(key);
    let message = item.status === 'inserted' || item.status === 'uncertain' ? 'Removing the preview does not retract the reference already sent to the terminal.' : '';
    if (item.receipt && (item.status === 'ready' || item.status === 'failed')) {
      try { await removeImage(token, item.receipt.id); }
      catch (error) { message = error instanceof HttpError && error.code === 'ATTACHMENT_IN_USE' ? error.message : `The preview was removed; the host copy could not be deleted (${error instanceof Error ? error.message : 'unknown error'}). Unused uploads are reclaimed after 24 hours.`; }
    }
    revokePreview(item.url);
    setItems((current) => current.filter((i) => i.key !== key));
    return message;
  }
  function setStatus(key: string, status: ImageItem['status'], error?: string) { patch(key, (i) => ({ ...i, status, error })); }
  /** After an accepted start: clears only the exact selection that was sent, so a newer draft survives. */
  function clearExact(keys: readonly string[]) {
    setItems((current) => {
      if (current.length !== keys.length || current.some((item, index) => item.key !== keys[index])) return current;
      for (const item of current) revokePreview(item.url);
      return [];
    });
  }
  return { items, add, retry, remove, setStatus, clearExact };
}
export type ImageTray = ReturnType<typeof useImageTray>;

/** A paste carrying image files attaches them (after asking when it also carries text). Returns false to let the text paste proceed. */
export function pasteImages(event: ClipboardEvent, attach: (files: File[]) => void): boolean {
  const { images, text } = clipboardImages(event.clipboardData);
  if (!images.length || (text.trim() && !window.confirm(MIXED))) return false;
  event.preventDefault(); event.stopPropagation(); attach(images);
  return true;
}

/** A labelled image-file picker, the accessible and mobile path when the clipboard has no image data. */
export function AttachImageButton({ label, disabled, onOpen, onFiles, className, icon, help }: { label: string; disabled?: boolean; className?: string;
  /** An icon-only tool button with help, as in a terminal's tool row. */
  icon?: string; help?: string;
  /** Runs at the click, before the system dialog opens; returning false opens nothing. */
  onOpen?: () => boolean; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const open = (event: MouseEvent<HTMLButtonElement>) => { if (!event.isTrusted || (onOpen && !onOpen())) return; input.current?.click(); };
  return <>
    {icon ? <IconButton icon={icon} label={label} help={help ?? label} className={className} disabled={disabled} onClick={open} />
      : <button type="button" className={className} disabled={disabled} onClick={open}>{label}</button>}
    <input ref={input} type="file" hidden accept="image/png,image/jpeg" multiple
      onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) onFiles(files); }} />
  </>;
}

const STATE: Record<ImageItem['status'], string> = {
  checking: 'Checking…', uploading: 'Uploading…', ready: 'Uploaded', inserting: 'Inserting…',
  inserted: 'Reference inserted. Submit in the terminal when ready; this does not show that the model read it.',
  uncertain: 'Insertion uncertain. Inspect the terminal; it is never resent.', failed: 'Not attached',
};
/** Thumbnails with truthful states. Not a text field: the instruction stays in its own composer or the native CLI prompt. */
export function AttachmentTray({ label, tray, onMessage, insert }: { label: string; tray: ImageTray; onMessage: (message: string) => void;
  insert?: { onInsert: (item: ImageItem) => void; blocked: string } }) {
  if (!tray.items.length) return null;
  return <ul className="attachment-tray" aria-label={label}>
    {tray.items.map((item) => <li key={item.key} className="attachment-item" data-status={item.status}>
      <img src={item.url} alt={`Preview of ${item.name}`} width={48} height={48} onError={() => { if (item.status !== 'failed') tray.setStatus(item.key, 'failed', DECODE); }} />
      <span className="attachment-text"><span className="attachment-name">{item.name}</span>
        <span className="fine" role="status">{item.status === 'ready' && insert ? 'Ready to insert' : STATE[item.status]}{item.error ? `: ${item.error}` : ''}</span></span>
      <span className="attachment-actions">
        {insert && item.status === 'ready' && <button type="button" disabled={!!insert.blocked} title={insert.blocked || 'Insert this image’s host reference into the CLI prompt, without Enter.'}
          aria-label={`Insert image reference ${item.name}`} onClick={(event) => { if (event.isTrusted) insert.onInsert(item); }}>Insert</button>}
        {item.status === 'failed' && item.error !== DECODE && <button type="button" aria-label={`Retry upload ${item.name}`} onClick={() => tray.retry(item.key)}>Retry</button>}
        {item.status !== 'inserting' && <button type="button" className="quiet" aria-label={`Remove ${item.name}`} onClick={() => void tray.remove(item.key).then((message) => { if (message) onMessage(message); })}>Remove</button>}
      </span>
    </li>)}
  </ul>;
}
export const IMAGE_LIMIT_NOTE = `PNG or JPEG, up to ${ATTACHMENT_LIMITS.draftFiles} images and ${ATTACHMENT_LIMITS.fileBytes / (1024 * 1024)} MiB each.`;
