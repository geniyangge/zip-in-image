// Exact location of a ZIP that was appended to an image payload.
//
// Pure Uint8Array + DataView on purpose: no host imports, no DOM, no Blob/File, so
// the same code runs in a browser, in a worker and under node.
//
// The detection rule that makes this exact: an EOCD is only trusted when its comment
// length runs precisely to the end of the file. That single equation turns the
// central directory's size and offset into a derived archive start offset, and it is
// what a naive `indexOf` of `50 4B 03 04` cannot do -- image payload bytes spell that
// sequence by chance.

const SIG_LFH = 0x04034b50
const SIG_CDH = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50

const EOCD_SIZE = 22
const LFH_SIZE = 30
const EOCD64_SIZE = 56
const EOCD64_LOCATOR_SIZE = 20

/** A record plus the longest legal comment is the furthest back an EOCD can be. */
const EOCD_SEARCH_WINDOW = 0xffff + EOCD_SIZE
const MAX_NAME_LEN = 4096
const MAX_EXTRA_LEN = 0xffff
const U32_SENTINEL = 0xffffffff
const DATA_DESCRIPTOR_FLAG = 0x08

/** A name must be at least this fraction printable text to look like a file name. */
const MIN_PRINTABLE_RATIO = 0.8

export interface EocdInfo {
  sig: number
  diskNum: number
  cdDisk: number
  entriesThisDisk: number
  entriesTotal: number
  cdSize: number
  cdOffset: number
  commentLen: number
}

export interface Zip64Info {
  /** Absolute position of the ZIP64 EOCD record inside the file. */
  recordPos: number
  entriesTotal: number
  cdSize: number
  cdOffset: number
}

export interface LfhInfo {
  flags: number
  method: number
  fnLen: number
  exLen: number
  csize: number
  usize: number
  /** A view into the caller's buffer, not a copy. */
  nameBytes: Uint8Array
  /** Absolute position of the entry's file data. */
  dataStart: number
  hasDataDescriptor: boolean
}

export type ZipStartKind = 'eocd' | 'eocd64' | 'scan' | 'none'

export interface ZipStartDetected {
  kind: 'eocd' | 'eocd64' | 'scan'
  offset: number
  eocdAbsPos: number
  cdOffset: number
  cdSize: number
  entryCount: number
  /** Local header candidates examined before the answer; 0 when nothing was scanned. */
  candidatesTried: number
}

export interface ZipStartAbsent {
  kind: 'none'
  offset: -1
  eocdAbsPos: number
  cdOffset: number
  cdSize: number
  entryCount: number
  candidatesTried: number
}

export type ZipStartDetection = ZipStartDetected | ZipStartAbsent

export type ZipValidationReason = 'no-eocd' | 'cd-out-of-bounds' | 'cd-signature-mismatch'

export interface ZipValidationOk {
  ok: true
  offset: number
  eocdAbsPos: number
  cdAbsPos: number
  cdSize: number
  entryCount: number
}

export interface ZipValidationFail {
  ok: false
  reason: ZipValidationReason
  offset: number
  eocdAbsPos: number
  cdAbsPos: number
  cdSize: number
  entryCount: number
}

export type ZipValidation = ZipValidationOk | ZipValidationFail

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength)
}

/** The readable region: never past the caller's fileLen, never past the buffer. */
function limitOf(b: Uint8Array, fileLen: number): number {
  return Math.min(fileLen, b.byteLength)
}

/** u64 -> number, refusing values that would silently lose precision. */
function readU64(dv: DataView, offset: number): number | null {
  const value = dv.getBigUint64(offset, true)
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value)
}

/** Every EOCD signature position in `[lowerBound, fileLen)`, ascending. */
function eocdCandidates(b: Uint8Array, fileLen: number, lowerBound: number): number[] {
  const end = limitOf(b, fileLen)
  const dv = view(b)
  const found: number[] = []
  for (let pos = end - EOCD_SIZE; pos >= Math.max(lowerBound, end - EOCD_SEARCH_WINDOW); pos -= 1) {
    if (dv.getUint32(pos, true) === SIG_EOCD) found.push(pos)
  }
  return found.reverse()
}

/** The trust gate: the record plus its declared comment must consume everything to EOF. */
function eocdEndsAtEof(b: Uint8Array, pos: number, fileLen: number): boolean {
  return pos + EOCD_SIZE + view(b).getUint16(pos + 20, true) === limitOf(b, fileLen)
}

/** The nearest-EOF EOCD that runs exactly to EOF, else the earliest candidate, else -1. */
export function findEocd(b: Uint8Array, fileLen: number): number {
  const candidates = eocdCandidates(b, fileLen, 0)
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const pos = candidates[i]
    if (pos !== undefined && eocdEndsAtEof(b, pos, fileLen)) return pos
  }
  return candidates[0] ?? -1
}

/** The same trust gate, restricted to a slice: used to validate a candidate offset. */
function findEocdWithin(b: Uint8Array, fileLen: number, from: number): number {
  const candidates = eocdCandidates(b, fileLen, from)
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const pos = candidates[i]
    if (pos !== undefined && eocdEndsAtEof(b, pos, fileLen)) return pos
  }
  return -1
}

export function readEocd(b: Uint8Array, absPos: number): EocdInfo {
  const dv = view(b)
  return {
    sig: dv.getUint32(absPos, true),
    diskNum: dv.getUint16(absPos + 4, true),
    cdDisk: dv.getUint16(absPos + 6, true),
    entriesThisDisk: dv.getUint16(absPos + 8, true),
    entriesTotal: dv.getUint16(absPos + 10, true),
    cdSize: dv.getUint32(absPos + 12, true),
    cdOffset: dv.getUint32(absPos + 16, true),
    commentLen: dv.getUint16(absPos + 20, true),
  }
}

/** Follows EOCD64 locator -> EOCD64 record; null if any signature or bound fails. */
export function readZip64(b: Uint8Array, eocdAbsPos: number): Zip64Info | null {
  const locatorPos = eocdAbsPos - EOCD64_LOCATOR_SIZE
  if (locatorPos < 0 || locatorPos + EOCD64_LOCATOR_SIZE > b.byteLength) return null
  const dv = view(b)
  if (dv.getUint32(locatorPos, true) !== SIG_EOCD64_LOCATOR) return null
  const recordPos = readU64(dv, locatorPos + 8)
  if (recordPos === null || recordPos + EOCD64_SIZE > b.byteLength) return null
  if (dv.getUint32(recordPos, true) !== SIG_EOCD64) return null
  const entriesTotal = readU64(dv, recordPos + 32)
  const cdSize = readU64(dv, recordPos + 40)
  const cdOffset = readU64(dv, recordPos + 48)
  if (entriesTotal === null || cdSize === null || cdOffset === null) return null
  return { recordPos, entriesTotal, cdSize, cdOffset }
}

interface CdDescriptor {
  kind: 'eocd' | 'eocd64'
  cdOffset: number
  cdSize: number
  entryCount: number
  /** Absolute position of the record that ends the central directory. */
  cdEnd: number
}

/**
 * The 32-bit EOCD fields, upgraded to ZIP64 when they are saturated. A saturated EOCD
 * with no readable ZIP64 record leaves the central directory position unknown, so the
 * sentinels are reported and every caller's bound check rejects them.
 */
function readCdDescriptor(b: Uint8Array, eocdAbsPos: number): CdDescriptor {
  const eocd = readEocd(b, eocdAbsPos)
  if (eocd.cdOffset !== U32_SENTINEL && eocd.cdSize !== U32_SENTINEL) {
    return { kind: 'eocd', cdOffset: eocd.cdOffset, cdSize: eocd.cdSize, entryCount: eocd.entriesTotal, cdEnd: eocdAbsPos }
  }
  const zip64 = readZip64(b, eocdAbsPos)
  if (zip64 === null) {
    return { kind: 'eocd64', cdOffset: U32_SENTINEL, cdSize: U32_SENTINEL, entryCount: eocd.entriesTotal, cdEnd: eocdAbsPos }
  }
  return { kind: 'eocd64', cdOffset: zip64.cdOffset, cdSize: zip64.cdSize, entryCount: zip64.entriesTotal, cdEnd: zip64.recordPos }
}

/**
 * A real file name holds no NUL byte and is mostly printable text. High bytes count as
 * printable on purpose: CP437 and UTF-8 names are full of them, and a name we merely
 * failed to decode must never fail the archive.
 */
function isPlausibleName(name: Uint8Array): boolean {
  if (name.length === 0) return false
  let printable = 0
  for (const byte of name) {
    if (byte === 0x00) return false
    if (byte >= 0x20 && byte !== 0x7f) printable += 1
  }
  return printable / name.length >= MIN_PRINTABLE_RATIO
}

/** Decodes an entry name: strict UTF-8 when bit 11 is set, otherwise latin1. */
export function decodeEntryName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      // A broken UTF-8 flag is the archive's lie, not a reason to reject it: CP437
      // archives are legal, so fall through to the byte-preserving latin1 reading.
      return decodeLatin1(raw)
    }
  }
  return decodeLatin1(raw)
}

/** ISO-8859-1, done by hand: the 'latin1' TextDecoder label is windows-1252, which
 * remaps 0x82 and friends and would not round-trip the bytes. */
function decodeLatin1(raw: Uint8Array): string {
  let out = ''
  for (const byte of raw) out += String.fromCharCode(byte)
  return out
}

/** A local file header at `offset`, or null if nothing plausible lives there. */
export function validateLfhAt(b: Uint8Array, offset: number, fileLen: number): LfhInfo | null {
  const end = limitOf(b, fileLen)
  if (offset < 0 || offset + LFH_SIZE > end) return null
  const dv = view(b)
  if (dv.getUint32(offset, true) !== SIG_LFH) return null
  const flags = dv.getUint16(offset + 6, true)
  const method = dv.getUint16(offset + 8, true)
  const csize = dv.getUint32(offset + 18, true)
  const usize = dv.getUint32(offset + 22, true)
  const fnLen = dv.getUint16(offset + 26, true)
  const exLen = dv.getUint16(offset + 28, true)
  if (fnLen === 0 || fnLen > MAX_NAME_LEN || exLen > MAX_EXTRA_LEN) return null
  const headerSize = LFH_SIZE + fnLen + exLen
  const available = end - offset
  if (headerSize > available) return null
  const nameBytes = b.subarray(offset + LFH_SIZE, offset + LFH_SIZE + fnLen)
  if (!isPlausibleName(nameBytes)) return null
  // Bit 3 means the sizes moved into a trailing data descriptor: the LFH then carries
  // zeros and the real bound is proven later from the central directory.
  const hasDataDescriptor = (flags & DATA_DESCRIPTOR_FLAG) !== 0
  if (!hasDataDescriptor && headerSize + csize > available) return null
  return { flags, method, fnLen, exLen, csize, usize, nameBytes, dataStart: offset + headerSize, hasDataDescriptor }
}

/** Every `50 4B 03 04` position, ascending. Cheap: one linear pass. */
export function scanAllLfh(b: Uint8Array, fileLen: number): number[] {
  const end = limitOf(b, fileLen)
  const dv = view(b)
  const found: number[] = []
  for (let pos = 0; pos + 4 <= end; pos += 1) {
    if (dv.getUint32(pos, true) === SIG_LFH) found.push(pos)
  }
  return found
}

/**
 * The naive `indexOf` of `50 4B 03 04` from index 0. Exported so the specs can prove
 * the naive strategy is wrong -- a positive hit here is not evidence of an archive.
 */
export function naiveIndexOfPk(b: Uint8Array): number {
  for (let i = 0; i + 4 <= b.length; i += 1) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x03 && b[i + 3] === 0x04) return i
  }
  return -1
}

function absent(eocdAbsPos: number, candidatesTried: number): ZipStartAbsent {
  return { kind: 'none', offset: -1, eocdAbsPos, cdOffset: 0, cdSize: 0, entryCount: 0, candidatesTried }
}

/**
 * Where the archive starts inside `b[0..fileLen)`.
 *
 * 1. Find the trusted EOCD. Without one there is nothing to anchor a derivation to, so
 *    the answer is 'none' -- a stream with no end-of-central-directory record is not a
 *    zip, and image payloads do throw `PK\x03\x04` by chance.
 * 2. Derive the start from the central directory's size and offset.
 * 3. Accept the derivation only if a valid local header sits there.
 * 4. Otherwise scan every local header and take the earliest valid one.
 */
export function detectZipStart(b: Uint8Array, fileLen: number): ZipStartDetection {
  const end = limitOf(b, fileLen)
  const eocdAbsPos = findEocd(b, end)
  if (eocdAbsPos === -1) return absent(-1, 0)
  const cd = readCdDescriptor(b, eocdAbsPos)
  // The central directory ends where the record describing it begins: the EOCD, or --
  // when the 32-bit fields are saturated -- the ZIP64 EOCD record.
  const derived = cd.cdEnd - cd.cdSize - cd.cdOffset
  if (derived >= 0 && derived < end && validateLfhAt(b, derived, end) !== null) {
    return { kind: cd.kind, offset: derived, eocdAbsPos, cdOffset: cd.cdOffset, cdSize: cd.cdSize, entryCount: cd.entryCount, candidatesTried: 0 }
  }
  const candidates = scanAllLfh(b, end)
  for (let i = 0; i < candidates.length; i += 1) {
    const offset = candidates[i]
    if (offset !== undefined && validateLfhAt(b, offset, end) !== null) {
      return { kind: 'scan', offset, eocdAbsPos, cdOffset: cd.cdOffset, cdSize: cd.cdSize, entryCount: cd.entryCount, candidatesTried: i + 1 }
    }
  }
  return absent(eocdAbsPos, candidates.length)
}

/** Confirms that `[offset, fileLen)` really is a coherent archive. */
export function validateZipSlice(b: Uint8Array, fileLen: number, offset: number): ZipValidation {
  const end = limitOf(b, fileLen)
  const from = Math.max(0, offset)
  const eocdAbsPos = findEocdWithin(b, end, from)
  if (eocdAbsPos === -1) {
    return { ok: false, reason: 'no-eocd', offset: from, eocdAbsPos: -1, cdAbsPos: -1, cdSize: 0, entryCount: 0 }
  }
  const cd = readCdDescriptor(b, eocdAbsPos)
  const cdAbsPos = from + cd.cdOffset
  const fail = (reason: ZipValidationReason): ZipValidationFail => ({
    ok: false,
    reason,
    offset: from,
    eocdAbsPos,
    cdAbsPos,
    cdSize: cd.cdSize,
    entryCount: cd.entryCount,
  })
  if (cdAbsPos < from || cdAbsPos + cd.cdSize > end) return fail('cd-out-of-bounds')
  if (cd.entryCount > 0 && (cdAbsPos + 4 > end || view(b).getUint32(cdAbsPos, true) !== SIG_CDH)) {
    return fail('cd-signature-mismatch')
  }
  return { ok: true, offset: from, eocdAbsPos, cdAbsPos, cdSize: cd.cdSize, entryCount: cd.entryCount }
}
