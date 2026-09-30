import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

/** Small synthetic image fixtures and raw upload requests for Node tests; no private screenshots. */
export const TOKEN = 'a'.repeat(64);
export const chunk = (type: string, data: Buffer = Buffer.alloc(0)) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
export function png(width = 3, height = 2, fill = 7): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height, fill))), chunk('IEND')]);
}
const segment = (marker: number, body: Buffer) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(body.length + 2, 2); return Buffer.concat([head, body]); };
export const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xc0, Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0])), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([1, 2, 0xff, 0xd9])]);
export function upload(workspace: string, body: Buffer | ReadableStream<Uint8Array>, more: { requestId?: string; name?: string; type?: string; headers?: Record<string, string> } = {}): Request {
  const meta = { requestId: more.requestId ?? randomUUID(), workspace, ...(more.name ? { name: more.name } : {}) };
  return new Request('http://127.0.0.1:8787/api/v1/attachments', { method: 'POST', body, duplex: 'half',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': more.type ?? 'image/png', 'x-altcli-upload': JSON.stringify(meta), ...more.headers } } as RequestInit);
}
