import { crc32 } from 'node:zlib';
import { ATTACHMENT_LIMITS, type ImageMediaType } from '../contracts/attachments.ts';
import { AppError } from '../core/errors.ts';

export interface ImageStructure { mediaType: ImageMediaType; width: number; height: number }
const fail = (message: string): never => { throw new AppError('INVALID_IMAGE', message, 415); };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function dimensions(width: number, height: number): void {
  if (!width || !height) fail('The image has no dimensions.');
  if (width * height > ATTACHMENT_LIMITS.pixels) fail(`The image exceeds ${ATTACHMENT_LIMITS.pixels / 1e6} million pixels.`);
}

/** Structure only; pixels are never decoded. Checks the signature, that the first chunk is a valid IHDR (dimensions, bit depth and
 * color type, compression, filter, interlace), every chunk's length and CRC, known critical chunks only, no animation chunks
 * (acTL/fcTL/fdAT), a palette for indexed color, at least one contiguous run of IDAT, and IEND as the last bytes of the file. */
function png(bytes: Buffer): ImageStructure {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail('This is not a PNG image.');
  let offset = 8, width = 0, height = 0, colorType = -1, palette = false, data = false, dataEnded = false;
  for (let index = 0; ; index++) {
    if (offset + 12 > bytes.length) fail('The PNG image is truncated.');
    const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8);
    if (length > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type)) fail('The PNG image has a malformed chunk.');
    const end = offset + 12 + length;
    if (end > bytes.length) fail('The PNG image is truncated.');
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail('A PNG chunk checksum does not match.');
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (index === 0) {
      if (type !== 'IHDR' || length !== 13) fail('The PNG image does not start with a header chunk.');
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9]!;
      if (width > 0x7fffffff || height > 0x7fffffff || !PNG_DEPTHS[colorType]?.includes(body[8]!) || body[10] !== 0 || body[11] !== 0 || body[12]! > 1) fail('The PNG header is invalid.');
      dimensions(width, height);
    } else if (type === 'IHDR') fail('The PNG image has more than one header.');
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') fail('Animated PNG images are not supported.');
    if (type[0] === type[0]!.toUpperCase() && !PNG_CRITICAL.has(type)) fail('The PNG image uses an unsupported critical chunk.');
    if (type === 'PLTE') palette = true;
    if (type === 'IDAT') { if (dataEnded) fail('The PNG image data is not contiguous.'); data = true; }
    else if (data) dataEnded = true;
    offset = end;
    if (type === 'IEND') {
      if (length !== 0) fail('The PNG end chunk is invalid.');
      if (offset !== bytes.length) fail('The PNG image has data after its end.');
      break;
    }
  }
  if (!data) fail('The PNG image has no image data.');
  if (colorType === 3 && !palette) fail('The indexed PNG image has no palette.');
  return { mediaType: 'image/png', width, height };
}

/** Structure only; the entropy-coded data is never decoded. Checks the start marker, that every marker segment's length stays inside
 * the file, exactly one frame header with nonzero dimensions and a component table matching its length, a scan only after that frame,
 * and an end-of-image marker after at least one scan. Bytes after the first end-of-image marker, such as appended MPF images, are
 * stored but not inspected. */
function jpeg(bytes: Buffer): ImageStructure {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('This is not a JPEG image.');
  let offset = 2, width = 0, height = 0, frame = false, scan = false;
  while (true) {
    if (offset >= bytes.length || bytes[offset] !== 0xff) fail('The JPEG image has a malformed marker.');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) fail('The JPEG image is truncated.');
    const marker = bytes[offset++]!;
    if (marker === 0xd9) {
      if (!frame || !scan) fail('The JPEG image ends before its image data.');
      return { mediaType: 'image/jpeg', width, height };
    }
    if (marker === 0x01) continue;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) fail('The JPEG image has a misplaced marker.');
    if (offset + 2 > bytes.length) fail('The JPEG image is truncated.');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) fail('The JPEG image is truncated.');
    const body = bytes.subarray(offset + 2, offset + length);
    if (JPEG_FRAMES.has(marker)) {
      if (frame) fail('JPEG images with more than one frame are not supported.');
      if (body.length < 6 || body.length !== 6 + 3 * body[5]! || !body[5]) fail('The JPEG frame header is invalid.');
      height = body.readUInt16BE(1); width = body.readUInt16BE(3); frame = true;
      dimensions(width, height);
    }
    offset += length;
    if (marker === 0xda) {
      if (!frame) fail('The JPEG image has a scan before its frame header.');
      scan = true;
      // Entropy-coded data: stuffed 0xFF00 bytes, restart markers and fill bytes belong to the scan; any other marker ends it.
      while (true) {
        if (offset + 1 >= bytes.length) fail('The JPEG image is truncated.');
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const next = bytes[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) offset += 2;
        else if (next === 0xff) offset++;
        else break;
      }
    }
  }
}

/** Detects the format from the bytes; the declared type must match. Throws INVALID_IMAGE (415) with a user-facing reason. */
export function inspectImage(bytes: Buffer, declared: ImageMediaType): ImageStructure {
  const actual: ImageMediaType | null = bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : null;
  if (!actual) fail('Only PNG and JPEG images can be attached.');
  if (actual !== declared) fail(`The file is ${actual === 'image/png' ? 'a PNG' : 'a JPEG'} image but was sent as ${declared}.`);
  return actual === 'image/png' ? png(bytes) : jpeg(bytes);
}
