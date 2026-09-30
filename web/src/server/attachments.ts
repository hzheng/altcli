import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readdir, readFile, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ATTACHMENT_LIMITS as L, IMAGE_TYPES, type AttachmentDescriptor, type AttachmentReceipt, type ImageMediaType } from '../contracts/attachments.ts';
import type { AgentType } from '../contracts/api.ts';
import { parseUploadInput } from '../core/attachment-validation.ts';
import { AppError } from '../core/errors.ts';
import { requestId } from '../core/validation.ts';
import type { Config } from './config.ts';
import { inspectImage } from './image-structure.ts';
import { isWithin } from './paths.ts';
import type { Store } from './store.ts';

/** One upload row. `reservedBytes` counts toward the quota from reservation; a ready row reserves its actual size. */
interface AttachmentRow {
  id: string; requestId: string; workspace: string; status: 'uploading' | 'ready';
  mediaType: ImageMediaType; bytes: number; width: number; height: number; sha256: string; name: string | null;
  createdAt: string; reservedBytes: number; leaseExpiresAt: string | null;
}
const MiB = 1024 * 1024;
const FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(part|png|jpg)$/;
const extension = (type: ImageMediaType) => type === 'image/png' ? 'png' : 'jpg';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Characters a single-quoted CLI reference cannot carry safely, and that must never reach a terminal. */
const UNQUOTABLE = /['\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
/** CLIs whose running session was observed turning this reference into an image and reading it (see docs/TERMINAL-PROTOCOL.md). */
export const IMAGE_AGENTS: readonly AgentType[] = ['claude', 'codex'];
export const imageAgent = (type: AgentType | undefined) => !!type && IMAGE_AGENTS.includes(type);
/** The verified native reference: the absolute path in single quotes, sent as one bracketed paste and never followed by Enter.
 * tmux forwards the paste markers only to a program that enabled bracketed paste. */
export function nativeReference(path: string): Buffer {
  if (!path.startsWith('/') || UNQUOTABLE.test(path)) throw new AppError('IMAGE_REFERENCE', 'This image path cannot be referenced safely. Nothing was inserted.', 409);
  return Buffer.from(`\x1b[200~'${path}'\x1b[201~`, 'utf8');
}
function rowOf(db: Database.Database, id: string): AttachmentRow | undefined {
  const row = db.prepare('SELECT value FROM attachments WHERE id=?').get(id) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as AttachmentRow : undefined;
}
function referenced(db: Database.Database, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM attachment_refs WHERE attachment_id=? LIMIT 1').get(id);
}
/** Records possible use before the first write or dispatch; call inside the owning transaction. Pinned images never expire here. */
export function pinAttachments(db: Database.Database, descriptors: readonly AttachmentDescriptor[], kind: 'run' | 'native', refId: string): void {
  const at = new Date().toISOString();
  for (const descriptor of descriptors) {
    const row = rowOf(db, descriptor.id);
    if (!row || row.status !== 'ready' || row.sha256 !== descriptor.sha256) throw new AppError('ATTACHMENT_CHANGED', 'An attached image was removed or changed before it could be used. Nothing was sent; attach it again.', 409);
    db.prepare('INSERT OR IGNORE INTO attachment_refs(attachment_id,kind,ref_id,created_at) VALUES (?,?,?,?)').run(descriptor.id, kind, refId, at);
  }
}
/** Reads a request body into memory within the byte and time bounds; a declared length must match exactly. */
async function readBody(request: Request, declared: number | null): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('INVALID_UPLOAD', 'Send the image bytes as the request body.');
  const chunks: Uint8Array[] = []; let total = 0; let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, L.uploadMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (expired) throw new AppError('UPLOAD_TIMEOUT', 'The upload took too long. Attach the image again.', 408);
      if (done) break;
      total += value.byteLength;
      if (total > L.fileBytes || (declared !== null && total > declared)) { await reader.cancel().catch(() => {}); throw new AppError('IMAGE_TOO_LARGE', `Images are limited to ${L.fileBytes / MiB} MiB.`, 413); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(expired ? 'UPLOAD_TIMEOUT' : 'UPLOAD_INCOMPLETE', expired ? 'The upload took too long. Attach the image again.' : 'The upload was interrupted. Attach the image again.', expired ? 408 : 400);
  } finally { clearTimeout(timer); reader.releaseLock(); }
  if (!total || (declared !== null && total !== declared)) throw new AppError('UPLOAD_INCOMPLETE', 'The upload was empty or incomplete. Attach the image again.');
  return Buffer.concat(chunks);
}

/** Private, bounded image storage under <data directory>/attachments, outside every workspace it serves. Files are immutable once
 * published; SQLite records metadata and possible use. Upload success is never an insertion, a send or evidence that a model read it. */
export class AttachmentService {
  private readonly config: Config;
  private readonly store: Store;
  /** Canonical worktree roots of the workspaces an upload may name. */
  private readonly workspaces: () => Promise<string[]>;
  private readonly uploading = new Set<string>();
  private active = 0;
  constructor(config: Config, store: Store, workspaces: () => Promise<string[]>) {
    this.config = config; this.store = store; this.workspaces = workspaces;
  }
  private get db() { return this.store.db; }
  private get directory() { return join(this.config.dataDir, 'attachments'); }
  /** Creates or verifies the private directory and returns its canonical path. */
  async prepare(): Promise<string> {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(this.directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new AppError('ATTACHMENT_STORAGE', `${this.directory} must be an ordinary directory owned by this user. Nothing was stored.`, 409);
    if (info.mode & 0o077) await chmod(this.directory, 0o700);
    const real = await realpath(this.directory);
    if (real !== join(await realpath(this.config.dataDir), 'attachments')) throw new AppError('ATTACHMENT_STORAGE', 'The attachment directory resolves outside AltCLI\'s data directory. Nothing was stored.', 409);
    if (UNQUOTABLE.test(real)) throw new AppError('ATTACHMENT_STORAGE', "AltCLI's data directory path contains a quote, backslash or control character, so image paths cannot be referenced safely. Choose another ALTCLI_DATA_DIR.", 409);
    return real;
  }
  /** The workspace must be a current one, and the attachment directory must not be inside it. */
  async assertWorkspace(workspace: string, directory?: string): Promise<void> {
    if (!(await this.workspaces()).includes(workspace)) throw new AppError('WORKSPACE_UNKNOWN', 'This image is not for a current workspace. Recheck and attach it again.', 409);
    if (this.config.mode === 'mock') return; // Simulated workspaces have no filesystem.
    const root = await realpath(workspace).catch(() => { throw new AppError('WORKSPACE_UNKNOWN', 'The workspace directory is unavailable. Recheck it.', 409); });
    if (isWithin(root, directory ?? await this.prepare())) throw new AppError('ATTACHMENT_STORAGE', 'AltCLI\'s data directory is inside this workspace, so images cannot be stored outside it. Choose another ALTCLI_DATA_DIR.', 409);
  }
  private receipt(row: AttachmentRow): AttachmentReceipt {
    const draft = !referenced(this.db, row.id);
    return { id: row.id, requestId: row.requestId, workspace: row.workspace, mediaType: row.mediaType, bytes: row.bytes, width: row.width, height: row.height,
      sha256: row.sha256, name: row.name, createdAt: row.createdAt, draftExpiresAt: draft ? new Date(Date.parse(row.createdAt) + L.draftMs).toISOString() : null };
  }
  private usage(): { bytes: number; files: number } {
    const row = this.db.prepare("SELECT COALESCE(SUM(json_extract(value,'$.reservedBytes')),0) AS bytes, COUNT(*) AS files FROM attachments").get() as { bytes: number; files: number };
    return row;
  }
  /** `POST /api/v1/attachments`, after authentication. One raw PNG or JPEG body; metadata in the x-altcli-upload header. */
  async upload(request: Request): Promise<AttachmentReceipt> {
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host; no image was stored.', 403);
    const input = parseUploadInput(request.headers.get('x-altcli-upload'));
    const declaredType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() as ImageMediaType | undefined;
    if (!declaredType || !IMAGE_TYPES.includes(declaredType)) throw new AppError('UNSUPPORTED_IMAGE', 'Only PNG and JPEG images can be attached.', 415);
    const length = request.headers.get('content-length');
    const declared = length === null ? null : Number(length);
    if (declared !== null && (!Number.isSafeInteger(declared) || declared < 1)) throw new AppError('INVALID_UPLOAD', 'Invalid upload length.');
    if (declared !== null && declared > L.fileBytes) throw new AppError('IMAGE_TOO_LARGE', `Images are limited to ${L.fileBytes / MiB} MiB.`, 413);
    const directory = await this.prepare();
    await this.assertWorkspace(input.workspace, directory);
    if (this.active >= L.concurrentUploads) throw new AppError('UPLOAD_BUSY', `At most ${L.concurrentUploads} images upload at once. Wait, then attach again.`, 429);
    this.active++;
    try {
      const existing = this.db.prepare('SELECT value FROM attachments WHERE request_id=?').get(input.requestId) as { value: string } | undefined;
      if (existing) {
        const row = JSON.parse(existing.value) as AttachmentRow;
        if (row.status !== 'ready') throw new AppError('UPLOAD_IN_PROGRESS', 'This upload is still in progress. Wait for it, then retry.', 409);
        const bytes = await readBody(request, declared);
        if (row.workspace !== input.workspace || row.mediaType !== declaredType || row.sha256 !== sha256(bytes)) throw new AppError('ID_CONFLICT', 'This upload request ID is bound to another image.', 409);
        return this.receipt(row);
      }
      await this.reclaim();
      const id = randomUUID(), reserved = declared ?? L.fileBytes, createdAt = new Date().toISOString();
      this.db.transaction(() => {
        const usage = this.usage();
        if (usage.bytes + reserved > L.retainedBytes || usage.files + 1 > L.retainedFiles) {
          throw new AppError('ATTACHMENTS_FULL', `Image storage is full: ${Math.ceil(usage.bytes / MiB)} MiB in ${usage.files} files of ${L.retainedBytes / MiB} MiB and ${L.retainedFiles} files. Images that may have been used are retained, and this version has no in-app way to release them; unused uploads are reclaimed after ${L.draftMs / 3600000} hours. Deleting files by hand breaks recorded references.`, 507);
        }
        const row: AttachmentRow = { id, requestId: input.requestId, workspace: input.workspace, status: 'uploading', mediaType: declaredType, bytes: 0, width: 0, height: 0, sha256: '',
          name: input.name ?? null, createdAt, reservedBytes: reserved, leaseExpiresAt: new Date(Date.now() + L.uploadMs * 2).toISOString() };
        this.db.prepare('INSERT INTO attachments(id,request_id,status,value) VALUES (?,?,?,?)').run(id, input.requestId, 'uploading', JSON.stringify(row));
      }).immediate();
      this.uploading.add(id);
      try {
        const bytes = await readBody(request, declared);
        const structure = inspectImage(bytes, declaredType);
        const part = join(directory, `${id}.part`), final = join(directory, `${id}.${extension(structure.mediaType)}`);
        // Exclusive creation refuses an existing file or symbolic link; the no-clobber link publishes only a complete, validated file.
        const handle = await open(part, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await link(part, final); await unlink(part);
        const info = await lstat(final);
        if (!info.isFile() || info.nlink !== 1 || info.size !== bytes.length) throw new AppError('ATTACHMENT_STORAGE', 'The stored image could not be verified. Nothing was published.', 409);
        const ready: AttachmentRow = { id, requestId: input.requestId, workspace: input.workspace, status: 'ready', mediaType: structure.mediaType, bytes: bytes.length,
          width: structure.width, height: structure.height, sha256: sha256(bytes), name: input.name ?? null, createdAt, reservedBytes: bytes.length, leaseExpiresAt: null };
        this.db.prepare('UPDATE attachments SET status=?, value=? WHERE id=?').run('ready', JSON.stringify(ready), id);
        return this.receipt(ready);
      } catch (error) {
        await this.discard(id, directory);
        throw error;
      } finally { this.uploading.delete(id); }
    } finally { this.active--; }
  }
  /** Removes an unfinished upload's row and exactly its files. */
  private async discard(id: string, directory: string): Promise<void> {
    for (const suffix of ['part', 'png', 'jpg']) await unlink(join(directory, `${id}.${suffix}`)).catch(() => {});
    this.db.prepare("DELETE FROM attachments WHERE id=? AND status='uploading'").run(id);
  }
  /** Reclaims unreferenced drafts older than the draft age and abandoned uploads whose lease expired, rechecking use in one transaction. */
  async reclaim(now = Date.now()): Promise<number> {
    const directory = await this.prepare();
    const candidates = (this.db.prepare('SELECT value FROM attachments WHERE id NOT IN (SELECT attachment_id FROM attachment_refs)').all() as { value: string }[])
      .map((row) => JSON.parse(row.value) as AttachmentRow)
      .filter((row) => row.status === 'ready' ? Date.parse(row.createdAt) + L.draftMs <= now : !this.uploading.has(row.id) && Date.parse(row.leaseExpiresAt ?? row.createdAt) <= now);
    let removed = 0;
    for (const candidate of candidates) {
      const deleted = this.db.transaction(() => {
        if (referenced(this.db, candidate.id) || this.uploading.has(candidate.id)) return false;
        return this.db.prepare('DELETE FROM attachments WHERE id=?').run(candidate.id).changes === 1;
      }).immediate();
      if (!deleted) continue;
      removed++;
      for (const suffix of ['part', 'png', 'jpg']) await unlink(join(directory, `${candidate.id}.${suffix}`)).catch(() => {});
    }
    return removed;
  }
  /** At startup no upload is in flight: interrupted uploads are never published or referenced, so their rows and files are
   * reclaimed, as are this service's own files that have no row. Nothing referenced is touched. */
  async recover(): Promise<void> {
    const directory = await this.prepare();
    const interrupted = (this.db.prepare("SELECT id FROM attachments WHERE status='uploading'").all() as { id: string }[]).map((row) => row.id).filter((id) => !this.uploading.has(id));
    for (const id of interrupted) await this.discard(id, directory);
    for (const name of await readdir(directory)) {
      const match = FILE.exec(name);
      if (!match || this.uploading.has(match[1]!)) continue;
      const row = rowOf(this.db, match[1]!);
      if (!row || (match[2] === 'part' && row.status === 'ready')) await unlink(join(directory, name)).catch(() => {});
    }
  }
  /** `DELETE /api/v1/attachments/{id}`: removes an unreferenced draft upload. Possible use is recorded server-side; it refuses. */
  async remove(value: string): Promise<{ ok: true; removed: boolean }> {
    const id = requestId(value);
    const row = this.db.transaction(() => {
      const row = rowOf(this.db, id);
      if (!row) return null;
      if (row.status !== 'ready') throw new AppError('UPLOAD_IN_PROGRESS', 'This upload is still in progress.', 409);
      if (referenced(this.db, id)) throw new AppError('ATTACHMENT_IN_USE', 'This image may already have been used, so AltCLI keeps it. Removing the preview does not retract it.', 409);
      this.db.prepare('DELETE FROM attachments WHERE id=?').run(id);
      return row;
    }).immediate();
    if (!row) return { ok: true, removed: false };
    await unlink(join(await this.prepare(), `${id}.${extension(row.mediaType)}`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    return { ok: true, removed: true };
  }
  private async verified(directory: string, row: AttachmentRow): Promise<AttachmentDescriptor> {
    const path = join(directory, `${row.id}.${extension(row.mediaType)}`);
    const changed = () => new AppError('ATTACHMENT_CHANGED', `An attached image is missing or changed on the host (${row.name ?? row.id}). Nothing was sent; attach it again.`, 409);
    const info = await lstat(path).catch(() => { throw changed(); });
    if (!info.isFile() || info.nlink !== 1 || info.size !== row.bytes || sha256(await readFile(path)) !== row.sha256) throw changed();
    return { id: row.id, path, mediaType: row.mediaType, bytes: row.bytes, width: row.width, height: row.height, sha256: row.sha256, name: row.name };
  }
  /** Ordered, verified descriptors for an admission. Every image must be ready, belong to this workspace and fit the draft bounds. */
  async describe(ids: readonly string[], workspace: string): Promise<AttachmentDescriptor[]> {
    const directory = await this.prepare();
    await this.assertWorkspace(workspace, directory);
    const rows = ids.map((id) => rowOf(this.db, id));
    if (rows.some((row) => !row || row.status !== 'ready' || row.workspace !== workspace)) throw new AppError('ATTACHMENT_UNAVAILABLE', 'An attached image is missing, still uploading, or belongs to another workspace. Remove it and attach it again.', 409);
    if (rows.reduce((sum, row) => sum + row!.bytes, 0) > L.draftBytes) throw new AppError('ATTACHMENTS_TOO_LARGE', `Attached images are limited to ${L.draftBytes / MiB} MiB in total.`, 413);
    return Promise.all(rows.map((row) => this.verified(directory, row!)));
  }
  /** Before a later dispatch: frozen bytes must be unchanged. A missing or changed file refuses; nothing is regenerated. */
  async verify(descriptors: readonly AttachmentDescriptor[]): Promise<void> {
    const directory = await this.prepare();
    for (const descriptor of descriptors) {
      const row = rowOf(this.db, descriptor.id);
      if (!row || row.status !== 'ready' || row.sha256 !== descriptor.sha256) throw new AppError('ATTACHMENT_CHANGED', 'An attached image is missing or changed on the host. Nothing was sent; inspect it and take over.', 409);
      const current = await this.verified(directory, row);
      if (current.path !== descriptor.path) throw new AppError('ATTACHMENT_CHANGED', 'An attached image moved on the host. Nothing was sent; inspect it and take over.', 409);
    }
  }
  /** Native insertion: the verified reference for one image in the target's workspace. Pinning happens separately, just before the write. */
  async reference(id: string, workspace: string): Promise<{ descriptor: AttachmentDescriptor; bytes: Buffer }> {
    const [descriptor] = await this.describe([requestId(id)], workspace);
    return { descriptor: descriptor!, bytes: nativeReference(descriptor!.path) };
  }
  pin(descriptors: readonly AttachmentDescriptor[], kind: 'run' | 'native', refId: string): void {
    this.db.transaction(() => pinAttachments(this.db, descriptors, kind, refId)).immediate();
  }
}
