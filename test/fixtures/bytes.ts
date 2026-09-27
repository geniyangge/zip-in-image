// Byte-level fixture builders for the zip-in-image specs.
//
// Node-only (node:zlib) and therefore test-only: src/lib/zip.ts must stay a pure
// Uint8Array + DataView reader with no host imports, so nothing here is shareable
// with production code.
//
// The archives are hand-rolled STORED (method 0) writers. They are validated ONLY by
// our own reader and by the unit specs -- never by Expand-Archive / .NET, whose
// tolerance is irrelevant to the code under test.
import { deflateSync } from 'node:zlib'

const LFH_SIG = 0x04034b50
const CDH_SIG = 0x02014b50
const DATA_DESCRIPTOR_SIG = 0x08074b50
const EOCD64_SIG = 0x06064b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const EOCD_SIG = 0x06054b50

const STORED = 0
const VERSION_20 = 20
const VERSION_45 = 45
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

const UTF8_NAME_FLAG = 0x0800
const DATA_DESCRIPTOR_FLAG = 0x0008

const EMPTY = new Uint8Array(0)

/** 10 characters, so the decoy LFH's fnLen field agrees with the bytes on disk. */
const DECOY_NAME = 'decoy1.txt'

/** Grow-on-demand little/big-endian byte writer. Fixture-grade, not perf-oriented. */
class ByteSink {
  private readonly bytes: number[] = []

  get length(): number {
    return this.bytes.length
  }

  u8(value: number): this {
    this.bytes.push(value & 0xff)
    return this
  }

  u16le(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff)
    return this
  }

  u16be(value: number): this {
    this.bytes.push((value >>> 8) & 0xff, value & 0xff)
    return this
  }

  u32le(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
    return this
  }

  u32be(value: number): this {
    this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
    return this
  }

  u64le(value: number): this {
    const big = BigInt(value)
    for (let shift = 0; shift < 8; shift += 1) {
      this.bytes.push(Number((big >> BigInt(shift * 8)) & 0xffn))
    }
    return this
  }

  raw(chunk: ArrayLike<number>): this {
    for (let i = 0; i < chunk.length; i += 1) this.bytes.push(chunk[i] ?? 0)
    return this
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

/** Standard reflected CRC-32 (PNG and ZIP both use it). */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff
  return out
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}

/** Plain concatenation -- the exact shape a "zip appended to an image" payload has. */
export function makePrefixed(prefix: Uint8Array, zip: Uint8Array): Uint8Array {
  return concatBytes([prefix, zip])
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  // The length field covers the payload only -- the 4 type bytes sit outside it.
  const crcInput = concatBytes([latin1Bytes(type), data])
  return new ByteSink().u32be(data.length).raw(crcInput).u32be(crc32(crcInput)).finish()
}

/**
 * A real, decodable 8-bit truecolour PNG with correct CRCs and a deflated IDAT.
 * The pixel pattern is a deterministic gradient so the compressed stream is
 * byte-stable across runs (the specs assert on offsets derived from it).
 */
export function makePng(width = 96, height = 96): Uint8Array {
  if (width < 1 || height < 1) throw new Error('png dimensions must be positive')
  const stride = 1 + width * 3
  const raw = new Uint8Array(height * stride)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = 0 // filter type: None
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3
      raw[pixel] = (x * 5) & 0xff
      raw[pixel + 1] = (y * 7) & 0xff
      raw[pixel + 2] = (x ^ y) & 0xff
    }
  }
  const ihdr = new ByteSink()
    .u32be(width)
    .u32be(height)
    .u8(8) // bit depth
    .u8(2) // colour type: truecolour
    .u8(0) // compression
    .u8(0) // filter
    .u8(0) // interlace
    .finish()
  return concatBytes([
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', EMPTY),
  ])
}

// ---------------------------------------------------------------------------
// JPEG carrying a decoy local file header inside a COM segment
// ---------------------------------------------------------------------------

/** A genuine 1x1 baseline JPEG (JFIF APP0 + DQT + SOF0 + DHT + SOS + EOI). */
export const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

/** Decodes TINY_JPEG_B64 into bytes on a private buffer (offset 0, exact length). */
export function tinyJpegBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(TINY_JPEG_B64, 'base64'))
}

/**
 * `50 4B 03 04` + a structurally valid 30-byte LFH (fnLen 10, exLen 0,
 * csize/usize 99) for a 10-character name + `\r\n\0`: exactly what a naive indexOf
 * scanner would happily accept as the start of an archive.
 */
function decoyLfhBytes(): Uint8Array {
  return new ByteSink()
    .u32le(LFH_SIG)
    .u16le(VERSION_20)
    .u16le(0) // flags
    .u16le(STORED)
    .u16le(0) // mod time
    .u16le(0) // mod date
    .u32le(0) // crc
    .u32le(99) // compressed size
    .u32le(99) // uncompressed size
    .u16le(DECOY_NAME.length)
    .u16le(0) // extra field length
    .raw(latin1Bytes(DECOY_NAME))
    .u8(0x0d)
    .u8(0x0a)
    .u8(0x00)
    .finish()
}

/**
 * A real 1x1 JPEG with one extra legal COM (0xFFFE) segment injected right after
 * SOI. Mainstream decoders skip COM segments, so the file still renders, while a
 * byte scanner finds `PK\x03\x04` inside it.
 */
export function makeJpegWithFakePk(): Uint8Array {
  const jpeg = tinyJpegBytes()
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
    throw new Error('TINY_JPEG_B64 is not a JPEG (expected SOI ... EOI)')
  }
  const payload = decoyLfhBytes()
  if (payload.length + 2 > U16_MAX) throw new Error('COM segment payload must fit a u16 length')
  // JPEG segment lengths are big-endian and count their own two length bytes.
  const com = new ByteSink().u16be(payload.length + 2).raw(payload).finish()
  return concatBytes([jpeg.subarray(0, 2), Uint8Array.from([0xff, 0xfe]), com, jpeg.subarray(2)])
}

// ---------------------------------------------------------------------------
// ZIP / ZIP64
// ---------------------------------------------------------------------------

export interface ZipEntryFixture {
  name: string
  data: Uint8Array
  /** Set the general-purpose bit 11 flag and encode the name as UTF-8. */
  utf8?: boolean
  /** Force the CP437 path: latin1 name bytes, bit 11 clear. Never a UTF-8 name. */
  cp437?: boolean
}

export interface ZipOpts {
  /** Trailing EOCD comment bytes -- may itself contain a decoy PK\x05\x06. */
  eocdComment?: Uint8Array
  /** Write bit 3 (streamed entries): zeroed LFH sizes plus a data descriptor. */
  dataDescriptor?: boolean
  /**
   * ZIP64 only: the byte offset the finished archive will occupy inside its file.
   * The ZIP64 EOCD locator stores a file-absolute record offset, so an archive that
   * will be appended to an image has to be told where it starts.
   */
  baseOffset?: number
}

interface ArchiveLayout {
  body: Uint8Array
  centralDirectory: Uint8Array
  entryCount: number
}

function writeArchive(entries: readonly ZipEntryFixture[], useDataDescriptor: boolean): ArchiveLayout {
  if (entries.length > U16_MAX) throw new Error('fixture archive supports at most 65535 entries')
  const body = new ByteSink()
  const central = new ByteSink()
  for (const entry of entries) {
    const utf8Name = entry.utf8 === true && entry.cp437 !== true
    const name = utf8Name ? new TextEncoder().encode(entry.name) : latin1Bytes(entry.name)
    const flags = (utf8Name ? UTF8_NAME_FLAG : 0) | (useDataDescriptor ? DATA_DESCRIPTOR_FLAG : 0)
    const crc = crc32(entry.data)
    const localOffset = body.length
    body
      .u32le(LFH_SIG)
      .u16le(VERSION_20)
      .u16le(flags)
      .u16le(STORED)
      .u16le(0) // mod time
      .u16le(0) // mod date
      .u32le(useDataDescriptor ? 0 : crc)
      .u32le(useDataDescriptor ? 0 : entry.data.length)
      .u32le(useDataDescriptor ? 0 : entry.data.length)
      .u16le(name.length)
      .u16le(0) // extra field length
      .raw(name)
      .raw(entry.data)
    if (useDataDescriptor) body.u32le(DATA_DESCRIPTOR_SIG).u32le(crc).u32le(entry.data.length).u32le(entry.data.length)

    central
      .u32le(CDH_SIG)
      .u16le(VERSION_20) // version made by
      .u16le(VERSION_20) // version needed
      .u16le(flags)
      .u16le(STORED)
      .u16le(0) // mod time
      .u16le(0) // mod date
      .u32le(crc)
      .u32le(entry.data.length)
      .u32le(entry.data.length)
      .u16le(name.length)
      .u16le(0) // extra field length
      .u16le(0) // file comment length
      .u16le(0) // disk number start
      .u16le(0) // internal attributes
      .u32le(0) // external attributes
      .u32le(localOffset)
      .raw(name)
  }
  return { body: body.finish(), centralDirectory: central.finish(), entryCount: entries.length }
}

function eocdCommentOf(opts: ZipOpts): Uint8Array {
  const comment = opts.eocdComment ?? EMPTY
  if (comment.length > U16_MAX) throw new Error('eocdComment must fit the 16-bit comment length field')
  return comment
}

/** A real STORED archive: local headers, data, central directory, EOCD. */
export function makeZip(entries: readonly ZipEntryFixture[], opts: ZipOpts = {}): Uint8Array {
  const { body, centralDirectory, entryCount } = writeArchive(entries, opts.dataDescriptor === true)
  return new ByteSink()
    .raw(body)
    .raw(centralDirectory)
    .u32le(EOCD_SIG)
    .u16le(0) // this disk
    .u16le(0) // disk with the central directory
    .u16le(entryCount)
    .u16le(entryCount)
    .u32le(centralDirectory.length)
    .u32le(body.length)
    .u16le(eocdCommentOf(opts).length)
    .raw(eocdCommentOf(opts))
    .finish()
}

/**
 * The same archive written ZIP64-style: the EOCD's 16/32-bit count, size and offset
 * fields are saturated, and the real ZIP64 EOCD record plus its locator are appended
 * in front of the EOCD -- so locator -> record -> offset is genuinely exercised.
 *
 * Note the asymmetry that the reader has to respect: the EOCD64 locator holds a
 * file-absolute record offset (hence `baseOffset`), while the record's own central
 * directory offset stays archive-relative, exactly like the 32-bit EOCD.
 */
export function makeZip64(entries: readonly ZipEntryFixture[], opts: ZipOpts = {}): Uint8Array {
  const { body, centralDirectory, entryCount } = writeArchive(entries, opts.dataDescriptor === true)
  const comment = eocdCommentOf(opts)
  const out = new ByteSink().raw(body).raw(centralDirectory)
  const recordOffset = out.length
  out
    .u32le(EOCD64_SIG)
    .u64le(44) // size of this record minus its 12-byte signature + size field
    .u16le(VERSION_45) // version made by
    .u16le(VERSION_45) // version needed
    .u32le(0) // this disk
    .u32le(0) // disk with the central directory
    .u64le(entryCount) // entries on this disk
    .u64le(entryCount) // total entries
    .u64le(centralDirectory.length)
    .u64le(body.length)
  out
    .u32le(EOCD64_LOCATOR_SIG)
    .u32le(0) // disk holding the ZIP64 EOCD record
    .u64le(recordOffset + (opts.baseOffset ?? 0))
    .u32le(1) // total number of disks
  out
    .u32le(EOCD_SIG)
    .u16le(0)
    .u16le(0)
    .u16le(U16_MAX)
    .u16le(U16_MAX)
    .u32le(U32_MAX) // central directory size
    .u32le(U32_MAX) // central directory offset
    .u16le(comment.length)
    .raw(comment)
  return out.finish()
}

// ---------------------------------------------------------------------------
// The naive strategy, kept honest
// ---------------------------------------------------------------------------

/**
 * The naive `indexOf` of `50 4B 03 04`, searching from index 0. It exists ONLY so the
 * specs can prove the naive strategy is wrong: image payloads contain this sequence
 * by chance, so a positive hit here is not evidence of an archive.
 */
export function naiveIndexOfPk(b: Uint8Array): number {
  for (let i = 0; i + 4 <= b.length; i += 1) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x03 && b[i + 3] === 0x04) return i
  }
  return -1
}
