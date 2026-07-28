import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from(
  "89504e470d0a1a0a",
  "hex",
);
const MAX_PNG_BYTES = 50 * 1_024 * 1_024;
const MAX_RGBA_BYTES = 50 * 1_024 * 1_024;
const CRC32_TABLE = buildCrc32Table();

export interface VerificationPngMetadata {
  readonly width: number;
  readonly height: number;
  readonly bit_depth: number;
  readonly color_type: number;
  readonly compression: number;
  readonly filter: number;
  readonly interlace: number;
}

export interface VerificationDecodedRgba8Png {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

interface ParsedPng {
  readonly metadata: VerificationPngMetadata;
  readonly idat: readonly Buffer[];
}

export function inspectVerificationPng(
  input: Uint8Array,
): VerificationPngMetadata {
  return parsePng(input).metadata;
}

export function decodeVerificationRgba8Png(
  input: Uint8Array,
): VerificationDecodedRgba8Png {
  const parsed = parsePng(input);
  const { metadata } = parsed;
  if (
    metadata.bit_depth !== 8 ||
    ![2, 6].includes(metadata.color_type) ||
    metadata.interlace !== 0
  ) {
    throw new Error(
      "comparison PNG must be non-interlaced RGB8 or RGBA8",
    );
  }
  const channels = metadata.color_type === 2 ? 3 : 4;
  const sourceRowBytes = checkedProduct(
    metadata.width,
    channels,
    "PNG source row",
  );
  const rgbaRowBytes = checkedProduct(metadata.width, 4, "PNG RGBA row");
  const rgbaByteLength = checkedProduct(
    metadata.height,
    rgbaRowBytes,
    "PNG RGBA pixels",
  );
  if (rgbaByteLength > MAX_RGBA_BYTES) {
    throw new Error("PNG decoded bytes exceed the fixed RGBA8 limit");
  }
  const expectedInflatedBytes = checkedProduct(
    metadata.height,
    sourceRowBytes + 1,
    "PNG scanlines",
  );

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(parsed.idat), {
      maxOutputLength: expectedInflatedBytes,
    });
  } catch (error) {
    throw new Error("PNG image data is not a bounded deflate stream", {
      cause: error,
    });
  }
  if (inflated.byteLength !== expectedInflatedBytes) {
    throw new Error("PNG decoded scanline length is invalid");
  }

  const decoded = new Uint8Array(
    checkedProduct(metadata.height, sourceRowBytes, "PNG source pixels"),
  );
  let sourceOffset = 0;
  for (let y = 0; y < metadata.height; y += 1) {
    const filterType = inflated[sourceOffset] ?? 255;
    sourceOffset += 1;
    const rowOffset = y * sourceRowBytes;
    for (let x = 0; x < sourceRowBytes; x += 1) {
      const raw = inflated[sourceOffset + x] ?? 0;
      const left =
        x >= channels ? decoded[rowOffset + x - channels] ?? 0 : 0;
      const above =
        y > 0 ? decoded[rowOffset - sourceRowBytes + x] ?? 0 : 0;
      const upperLeft =
        y > 0 && x >= channels
          ? decoded[
              rowOffset - sourceRowBytes + x - channels
            ] ?? 0
          : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + above;
          break;
        case 3:
          value = raw + Math.floor((left + above) / 2);
          break;
        case 4:
          value = raw + paeth(left, above, upperLeft);
          break;
        default:
          throw new Error("PNG uses an unsupported scanline filter");
      }
      decoded[rowOffset + x] = value & 0xff;
    }
    sourceOffset += sourceRowBytes;
  }

  if (channels === 4) {
    return {
      width: metadata.width,
      height: metadata.height,
      rgba: decoded,
    };
  }
  const rgba = new Uint8Array(rgbaByteLength);
  for (
    let sourceIndex = 0, targetIndex = 0;
    sourceIndex < decoded.byteLength;
    sourceIndex += 3, targetIndex += 4
  ) {
    rgba[targetIndex] = decoded[sourceIndex]!;
    rgba[targetIndex + 1] = decoded[sourceIndex + 1]!;
    rgba[targetIndex + 2] = decoded[sourceIndex + 2]!;
    rgba[targetIndex + 3] = 255;
  }
  return {
    width: metadata.width,
    height: metadata.height,
    rgba,
  };
}

export function encodeVerificationRgba8Png(input: {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}): Uint8Array {
  assertDimension(input.width, "PNG width");
  assertDimension(input.height, "PNG height");
  const rowBytes = checkedProduct(input.width, 4, "PNG row");
  const rgbaBytes = checkedProduct(input.height, rowBytes, "PNG pixels");
  if (rgbaBytes > MAX_RGBA_BYTES || input.rgba.byteLength !== rgbaBytes) {
    throw new Error("RGBA8 input length is invalid or exceeds its fixed limit");
  }

  const scanlines = Buffer.alloc(
    checkedProduct(input.height, rowBytes + 1, "PNG scanlines"),
  );
  for (let y = 0; y < input.height; y += 1) {
    const scanlineOffset = y * (rowBytes + 1);
    scanlines[scanlineOffset] = 0;
    Buffer.from(
      input.rgba.buffer,
      input.rgba.byteOffset + y * rowBytes,
      rowBytes,
    ).copy(scanlines, scanlineOffset + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(input.width, 0);
  ihdr.writeUInt32BE(input.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function parsePng(input: Uint8Array): ParsedPng {
  const bytes = Buffer.from(
    input.buffer,
    input.byteOffset,
    input.byteLength,
  );
  if (
    bytes.byteLength < 57 ||
    bytes.byteLength > MAX_PNG_BYTES ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    throw new Error("PNG is empty, oversized, or missing its signature");
  }

  let offset = PNG_SIGNATURE.byteLength;
  let metadata: VerificationPngMetadata | null = null;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  const idat: Buffer[] = [];
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new Error("PNG chunk header is truncated");
    }
    const length = bytes.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + length;
    const nextOffset = crcOffset + 4;
    if (
      crcOffset < dataOffset ||
      nextOffset < crcOffset ||
      nextOffset > bytes.byteLength
    ) {
      throw new Error("PNG chunk exceeds the byte stream");
    }
    const typeBytes = bytes.subarray(typeOffset, dataOffset);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new Error("PNG chunk type is invalid");
    }
    if (
      crc32(bytes.subarray(typeOffset, crcOffset)) !==
      bytes.readUInt32BE(crcOffset)
    ) {
      throw new Error("PNG chunk CRC is invalid");
    }
    if (offset === PNG_SIGNATURE.byteLength && type !== "IHDR") {
      throw new Error("PNG IHDR must be the first chunk");
    }
    if (
      !["IHDR", "PLTE", "IDAT", "IEND"].includes(type) &&
      (typeBytes[0]! & 0x20) === 0
    ) {
      throw new Error("PNG contains an unsupported critical chunk");
    }

    if (type === "IHDR") {
      if (metadata !== null || length !== 13) {
        throw new Error("PNG has an invalid or duplicate IHDR");
      }
      const width = bytes.readUInt32BE(dataOffset);
      const height = bytes.readUInt32BE(dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8] ?? 0;
      const colorType = bytes[dataOffset + 9] ?? 255;
      const compression = bytes[dataOffset + 10] ?? 255;
      const filter = bytes[dataOffset + 11] ?? 255;
      const interlace = bytes[dataOffset + 12] ?? 255;
      const validDepths = new Map<number, readonly number[]>([
        [0, [1, 2, 4, 8, 16]],
        [2, [8, 16]],
        [3, [1, 2, 4, 8]],
        [4, [8, 16]],
        [6, [8, 16]],
      ]);
      assertDimension(width, "PNG width");
      assertDimension(height, "PNG height");
      if (
        !validDepths.get(colorType)?.includes(bitDepth) ||
        compression !== 0 ||
        filter !== 0 ||
        ![0, 1].includes(interlace)
      ) {
        throw new Error("PNG IHDR metadata is invalid");
      }
      metadata = {
        width,
        height,
        bit_depth: bitDepth,
        color_type: colorType,
        compression,
        filter,
        interlace,
      };
    } else if (type === "PLTE") {
      if (
        metadata === null ||
        sawPalette ||
        sawImageData ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0
      ) {
        throw new Error("PNG palette position or length is invalid");
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (
        metadata === null ||
        imageDataEnded ||
        (metadata.color_type === 3 && !sawPalette)
      ) {
        throw new Error("PNG image data position is invalid");
      }
      sawImageData = true;
      idat.push(bytes.subarray(dataOffset, crcOffset));
    } else if (type === "IEND") {
      if (
        metadata === null ||
        !sawImageData ||
        length !== 0 ||
        nextOffset !== bytes.byteLength
      ) {
        throw new Error("PNG IEND or image-data boundary is invalid");
      }
      return { metadata, idat };
    } else if (sawImageData) {
      imageDataEnded = true;
    }
    offset = nextOffset;
  }
  throw new Error("PNG is missing its terminal IEND chunk");
}

function assertDimension(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid`);
  }
}

function checkedProduct(left: number, right: number, name: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} byte length is invalid`);
  }
  return result;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const chunk = Buffer.alloc(12 + body.byteLength);
  chunk.writeUInt32BE(body.byteLength, 0);
  typeBytes.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, body])),
    8 + body.byteLength,
  );
  return chunk;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value =
      (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff]!;
  }
  return (value ^ 0xffffffff) >>> 0;
}
