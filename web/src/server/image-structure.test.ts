import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inspectImage } from './image-structure';

const chunk = (type: string, data: Buffer = Buffer.alloc(0), crc?: number) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const check = Buffer.alloc(4); check.writeUInt32BE(crc ?? crc32(body));
  return Buffer.concat([length, body, check]);
};
const header = (width: number, height: number, depth = 8, color = 2) => {
  const data = Buffer.alloc(13); data.writeUInt32BE(width, 0); data.writeUInt32BE(height, 4); data[8] = depth; data[9] = color;
  return chunk('IHDR', data);
};
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pixels = (width: number, height: number) => deflateSync(Buffer.alloc((width * 3 + 1) * height, 7));
export function png(width = 4, height = 3, extra: Buffer[] = []): Buffer {
  return Buffer.concat([SIGNATURE, header(width, height), ...extra, chunk('IDAT', pixels(width, height)), chunk('IEND')]);
}
const segment = (marker: number, body: Buffer) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(body.length + 2, 2); return Buffer.concat([head, body]); };
const frame = (width: number, height: number) => { const body = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]); body.writeUInt16BE(height, 1); body.writeUInt16BE(width, 3); return segment(0xc0, body); };
const scan = () => Buffer.concat([segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])]);
export function jpeg(width = 4, height = 3, parts?: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...(parts ?? [segment(0xe0, Buffer.from('JFIF\0')), frame(width, height), scan()]), Buffer.from([0xff, 0xd9])]);
}

describe('PNG structure', () => {
  it('accepts a complete PNG and reports its dimensions', () => {
    expect(inspectImage(png(4, 3), 'image/png')).toEqual({ mediaType: 'image/png', width: 4, height: 3 });
    expect(inspectImage(png(2, 2, [chunk('tEXt', Buffer.from('k\0v'))]), 'image/png').width).toBe(2);
  });
  it('refuses signature-only, truncated, corrupted and trailing data', () => {
    expect(() => inspectImage(SIGNATURE, 'image/png')).toThrow(/truncated/);
    const whole = png();
    expect(() => inspectImage(whole.subarray(0, whole.length - 3), 'image/png')).toThrow(/truncated/);
    const corrupt = Buffer.from(whole); corrupt[SIGNATURE.length + 10] = corrupt[SIGNATURE.length + 10]! ^ 1;
    expect(() => inspectImage(corrupt, 'image/png')).toThrow(/checksum/);
    expect(() => inspectImage(Buffer.concat([whole, Buffer.from([0])]), 'image/png')).toThrow(/after its end/);
    expect(() => inspectImage(Buffer.concat([SIGNATURE, header(2, 2), chunk('IEND')]), 'image/png')).toThrow(/no image data/);
  });
  it('refuses animation, unknown critical chunks, invalid headers and missing palettes', () => {
    expect(() => inspectImage(png(2, 2, [chunk('acTL', Buffer.alloc(8))]), 'image/png')).toThrow(/Animated/);
    expect(() => inspectImage(png(2, 2, [chunk('ABCD', Buffer.alloc(1))]), 'image/png')).toThrow(/critical chunk/);
    expect(() => inspectImage(Buffer.concat([SIGNATURE, header(2, 2, 4, 2), chunk('IDAT', pixels(2, 2)), chunk('IEND')]), 'image/png')).toThrow(/header is invalid/);
    expect(() => inspectImage(Buffer.concat([SIGNATURE, header(2, 2, 8, 3), chunk('IDAT', pixels(2, 2)), chunk('IEND')]), 'image/png')).toThrow(/no palette/);
    expect(() => inspectImage(Buffer.concat([SIGNATURE, chunk('IDAT', pixels(2, 2)), chunk('IEND')]), 'image/png')).toThrow(/header chunk/);
  });
  it('bounds dimensions before any image data is read', () => {
    expect(() => inspectImage(Buffer.concat([SIGNATURE, header(10000, 5000)]), 'image/png')).toThrow(/million pixels/);
    expect(() => inspectImage(Buffer.concat([SIGNATURE, header(0, 5)]), 'image/png')).toThrow(/no dimensions/);
  });
});
describe('JPEG structure', () => {
  it('accepts a complete baseline structure, including stuffed bytes and restart markers', () => {
    expect(inspectImage(jpeg(640, 480), 'image/jpeg')).toEqual({ mediaType: 'image/jpeg', width: 640, height: 480 });
    // Bytes after the first end-of-image marker (such as appended MPF images) are stored but not inspected.
    expect(inspectImage(Buffer.concat([jpeg(), Buffer.from('trailer')]), 'image/jpeg').height).toBe(3);
  });
  it('refuses truncation, a scan before the frame, several frames and missing dimensions', () => {
    const whole = jpeg();
    expect(() => inspectImage(whole.subarray(0, whole.length - 2), 'image/jpeg')).toThrow(/truncated/);
    expect(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toThrow(/ends before/);
    expect(() => inspectImage(jpeg(4, 3, [scan(), frame(4, 3)]), 'image/jpeg')).toThrow(/scan before/);
    expect(() => inspectImage(jpeg(4, 3, [frame(4, 3), frame(4, 3), scan()]), 'image/jpeg')).toThrow(/more than one frame/);
    expect(() => inspectImage(jpeg(0, 3), 'image/jpeg')).toThrow(/no dimensions/);
    expect(() => inspectImage(jpeg(8000, 8000), 'image/jpeg')).toThrow(/million pixels/);
    expect(() => inspectImage(jpeg(4, 3, [segment(0xe0, Buffer.alloc(40)).subarray(0, 20)]), 'image/jpeg')).toThrow(/truncated/);
  });
});
describe('format detection', () => {
  it('requires PNG or JPEG bytes matching the declared type', () => {
    expect(() => inspectImage(png(), 'image/jpeg')).toThrow(/PNG image but was sent as image\/jpeg/);
    expect(() => inspectImage(jpeg(), 'image/png')).toThrow(/JPEG image but was sent as image\/png/);
    expect(() => inspectImage(Buffer.from('GIF89a......'), 'image/png')).toThrow(/Only PNG and JPEG/);
    expect(() => inspectImage(Buffer.alloc(0), 'image/png')).toThrow(/Only PNG and JPEG/);
  });
});
