// Correctness crux: where does the appended ZIP start inside an image file?
//
// The product promise is "opens as an image, rename to .zip and it is a valid
// archive", so detection must be EXACT. A naive `indexOf` of `50 4B 03 04`
// false-positives on image payload bytes; only an EOCD whose comment length runs
// exactly to EOF gives a derivation we can trust.
import { describe, expect, it } from 'vitest'
import {
  decodeEntryName,
  detectZipStart,
  findEocd,
  naiveIndexOfPk,
  readEocd,
  readZip64,
  scanAllLfh,
  validateLfhAt,
  validateZipSlice,
  type EocdInfo,
  type ZipStartDetection,
  type ZipStartDetected,
  type ZipValidation,
  type ZipValidationFail,
} from '@/lib/zip'
import {
  makeJpegWithFakePk,
  makePng,
  makePrefixed,
  makeZip,
  makeZip64,
  naiveIndexOfPk as naiveIndexOfPkFixture,
  type ZipEntryFixture,
} from '../fixtures/bytes'

const SIG_LFH = 0x04034b50
const SIG_CDH = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const U32_MAX = 0xffffffff

const EOCD_SIZE = 22
const LFH_SIZE = 30

const textBytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0))

const ENTRIES: ZipEntryFixture[] = [
  { name: 'hello.txt', data: textBytes('hello zip') },
  { name: 'dir/notes.md', data: textBytes('# notes') },
]

const u32At = (b: Uint8Array, pos: number): number =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(pos, true)

/** Narrowing helpers: a failed expect() must not leave the rest of the spec unchecked. */
function detected(detection: ZipStartDetection): ZipStartDetected {
  if (detection.kind === 'none') throw new Error(`expected a detection, got kind=none (offset ${detection.offset})`)
  return detection
}

function failureOf(validation: ZipValidation): ZipValidationFail {
  if (validation.ok) throw new Error('expected validation to fail, got ok')
  return validation
}

/** Overwrites the EOCD's central directory offset, simulating a non-derivable archive. */
function withEocdCdOffset(archive: Uint8Array, cdOffset: number): Uint8Array {
  const copy = archive.slice()
  const eocdPos = findEocd(copy, copy.length)
  if (eocdPos === -1) throw new Error('fixture archive has no EOCD')
  new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint32(eocdPos + 16, cdOffset, true)
  return copy
}

/**
 * A structurally valid archive whose EOCD overstates cdOffset by 1000, so the
 * derivation lands inside the image prefix instead of on the archive boundary.
 */
function withUnderivableEocd(archive: Uint8Array): Uint8Array {
  const eocdPos = findEocd(archive, archive.length)
  if (eocdPos === -1) throw new Error('fixture archive has no EOCD')
  return withEocdCdOffset(archive, readEocd(archive, eocdPos).cdOffset + 1000)
}

/** Overwrites a 16-bit field of the local header sitting at `lfhAt`. */
function withLfhField(archive: Uint8Array, lfhAt: number, fieldAt: number, value: number): Uint8Array {
  const copy = archive.slice()
  new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint16(lfhAt + fieldAt, value, true)
  return copy
}

function firstLfhOffset(b: Uint8Array): number {
  const first = scanAllLfh(b, b.length)[0]
  if (first === undefined) throw new Error('fixture archive has no local file header')
  return first
}

describe('zip', () => {
  it('findEocd returns -1 when no EOCD signature exists', () => {
    const png = makePng()
    expect(findEocd(png, png.length)).toBe(-1)
    // shorter than the 22-byte record: nothing to scan
    expect(findEocd(new Uint8Array(10), 10)).toBe(-1)
    expect(findEocd(new Uint8Array(0), 0)).toBe(-1)
  })

  it('findEocd accepts an EOCD whose comment length runs exactly to EOF', () => {
    const comment = textBytes('appended by zip-in-image')
    const zip = makeZip(ENTRIES, { eocdComment: comment })
    const expected = zip.length - EOCD_SIZE - comment.length
    const found = findEocd(zip, zip.length)
    expect(found).toBe(expected)
    expect(found + EOCD_SIZE + readEocd(zip, found).commentLen).toBe(zip.length)
    expect(Array.from(zip.subarray(found + EOCD_SIZE))).toEqual(Array.from(comment))
  })

  it('findEocd skips a PK\x05\x06 that appears inside the archive comment', () => {
    // A decoy EOCD signature in the tail of the comment: it sits after the real record,
    // so the backwards scan meets it FIRST and must reject it. Its own comment length
    // is 0, so it cannot consume the remaining bytes up to EOF.
    const comment = new Uint8Array(24)
    comment.set([0x50, 0x4b, 0x05, 0x06], 0)
    const zip = makeZip(ENTRIES, { eocdComment: comment })
    const decoyPos = zip.length - comment.length
    expect(Array.from(zip.subarray(decoyPos, decoyPos + 4))).toEqual([0x50, 0x4b, 0x05, 0x06])
    expect(decoyPos + EOCD_SIZE).toBeLessThan(zip.length)

    const found = findEocd(zip, zip.length)
    expect(found).toBe(zip.length - EOCD_SIZE - comment.length)
    expect(found).toBeLessThan(decoyPos)
    expect(detected(detectZipStart(zip, zip.length)).offset).toBe(0)
  })

  it('readEocd decodes entriesTotal, cdSize, cdOffset and commentLen', () => {
    const zip = makeZip(ENTRIES, { eocdComment: textBytes('tail') })
    const eocdPos = findEocd(zip, zip.length)
    const eocd: EocdInfo = readEocd(zip, eocdPos)

    expect(eocd.sig).toBe(SIG_EOCD)
    expect(eocd.diskNum).toBe(0)
    expect(eocd.cdDisk).toBe(0)
    expect(eocd.entriesThisDisk).toBe(ENTRIES.length)
    expect(eocd.entriesTotal).toBe(ENTRIES.length)
    expect(eocd.commentLen).toBe(4)
    expect(eocd.cdSize).toBeGreaterThan(0)
    expect(eocd.cdOffset).toBeGreaterThan(0)
    // the decoded fields must describe the archive that is actually there
    expect(u32At(zip, eocd.cdOffset)).toBe(SIG_CDH)
    expect(eocd.cdOffset + eocd.cdSize).toBe(eocdPos)
  })

  it('detectZipStart derives the exact offset for an appended zip', () => {
    const png = makePng()
    const file = makePrefixed(png, makeZip(ENTRIES))
    const result = detectZipStart(file, file.length)

    expect(result.kind).toBe('eocd')
    const found = detected(result)
    expect(found.offset).toBe(png.length)
    expect(found.eocdAbsPos).toBe(file.length - EOCD_SIZE)
    expect(found.entryCount).toBe(ENTRIES.length)
    expect(found.cdOffset).toBeGreaterThan(0)
    expect(found.candidatesTried).toBe(0)
    expect(validateLfhAt(file, found.offset, file.length)).not.toBeNull()
  })

  it('reports offset 0 for an unprefixed archive', () => {
    const zip = makeZip(ENTRIES)
    const result = detectZipStart(zip, zip.length)
    expect(result.kind).toBe('eocd')
    expect(result.offset).toBe(0)
    expect(detected(result).eocdAbsPos).toBe(zip.length - EOCD_SIZE)
    expect(validateZipSlice(zip, zip.length, 0).ok).toBe(true)
  })

  it('uses the ZIP64 locator when cdOffset and cdSize are 0xFFFFFFFF', () => {
    const png = makePng(16, 16)
    // the locator stores a file-absolute record offset, so a prefixed archive must
    // be told where it starts
    const file = makePrefixed(png, makeZip64(ENTRIES, { baseOffset: png.length }))
    const eocdPos = findEocd(file, file.length)
    const eocd = readEocd(file, eocdPos)
    // the 32-bit fields are saturated, so the ZIP64 chain is the only way through
    expect(eocd.cdOffset).toBe(U32_MAX)
    expect(eocd.cdSize).toBe(U32_MAX)
    expect(eocd.entriesTotal).toBe(0xffff)
    expect(u32At(file, eocdPos - 20)).toBe(SIG_EOCD64_LOCATOR)

    const z64 = readZip64(file, eocdPos)
    if (z64 === null) throw new Error('ZIP64 locator -> record chain is broken')
    expect(u32At(file, z64.recordPos)).toBe(SIG_EOCD64)
    expect(z64.entriesTotal).toBe(ENTRIES.length)
    expect(z64.recordPos - z64.cdSize - z64.cdOffset).toBe(png.length)

    const result = detectZipStart(file, file.length)
    expect(result.kind).toBe('eocd64')
    expect(detected(result).offset).toBe(png.length)
    expect(detected(result).entryCount).toBe(ENTRIES.length)
  })

  it('falls back to the LFH scan when the EOCD-derived offset is invalid', () => {
    const png = makePng()
    const lying = withUnderivableEocd(makeZip(ENTRIES))
    const eocdPos = lying.length - EOCD_SIZE
    const eocd = readEocd(lying, eocdPos)
    const file = makePrefixed(png, lying)
    // inflating cdOffset drags the derivation 1000 bytes back into the PNG's IDAT stream
    const derived = png.length + eocdPos - eocd.cdSize - eocd.cdOffset
    expect(derived).toBe(png.length - 1000)
    expect(derived).toBeGreaterThanOrEqual(0)
    expect(validateLfhAt(file, derived, file.length)).toBeNull()

    const result = detectZipStart(file, file.length)
    expect(result.kind).toBe('scan')
    expect(detected(result).offset).toBe(png.length)
    expect(detected(result).candidatesTried).toBe(1)
  })

  it('picks the earliest valid LFH candidate in scan mode', () => {
    // a structurally plausible LFH that can never pass validation: fnLen 0
    const decoy = new Uint8Array(LFH_SIZE)
    new DataView(decoy.buffer, decoy.byteOffset, decoy.byteLength).setUint32(0, SIG_LFH, true)
    const png = makePng()
    const archiveStart = decoy.length + png.length
    const file = makePrefixed(decoy, makePrefixed(png, withUnderivableEocd(makeZip(ENTRIES))))

    // the decoy plus both real local headers are on the table
    const candidates = scanAllLfh(file, file.length)
    expect(candidates[0]).toBe(0)
    expect(candidates.length).toBeGreaterThan(2)
    expect(candidates).toContain(archiveStart)

    const result = detectZipStart(file, file.length)
    expect(result.kind).toBe('scan')
    // the decoy at 0 is tried and rejected; the earliest VALID candidate wins over
    // the second entry's header that sits after it
    expect(detected(result).offset).toBe(archiveStart)
    expect(detected(result).candidatesTried).toBe(2)
  })

  it('validateLfhAt rejects fnlen or extralen that run past EOF', () => {
    const zip = makeZip(ENTRIES)
    expect(validateLfhAt(zip, firstLfhOffset(zip), zip.length)).not.toBeNull()

    // the 30-byte header is the only thing visible
    expect(validateLfhAt(zip, 0, LFH_SIZE)).toBeNull()
    // exLen claims 60000 extra bytes that are not there
    expect(validateLfhAt(withLfhField(zip, 0, 28, 60000), 0, zip.length)).toBeNull()
    // fnLen must name at least one byte
    expect(validateLfhAt(withLfhField(zip, 0, 26, 0), 0, zip.length)).toBeNull()
    // ... and stay within the 4096-byte ceiling real writers respect
    expect(validateLfhAt(withLfhField(zip, 0, 26, 5000), 0, zip.length)).toBeNull()
    // an offset outside the buffer is not a header
    expect(validateLfhAt(zip, zip.length, zip.length)).toBeNull()
    expect(validateLfhAt(zip, -1, zip.length)).toBeNull()
  })

  it('validateLfhAt accepts a streamed entry whose LFH sizes are zero (data descriptor bit 3)', () => {
    const name = 'stream.bin'
    const zip = makeZip([{ name, data: textBytes('0123456789') }], { dataDescriptor: true })
    const lfh = validateLfhAt(zip, 0, zip.length)
    if (lfh === null) throw new Error('streamed local header was rejected')

    expect(lfh.hasDataDescriptor).toBe(true)
    expect(lfh.csize).toBe(0)
    expect(lfh.usize).toBe(0)
    expect(lfh.fnLen).toBe(name.length)
    expect(lfh.exLen).toBe(0)
    expect(lfh.dataStart).toBe(LFH_SIZE + name.length)
    // the size bound is skipped for streamed entries, and the archive still validates
    expect(lfh.dataStart).toBeLessThan(zip.length)
    expect(validateZipSlice(zip, zip.length, 0).ok).toBe(true)
    expect(detected(detectZipStart(zip, zip.length)).offset).toBe(0)
  })

  it('validateZipSlice confirms central directory consistency', () => {
    const png = makePng(8, 8)
    const file = makePrefixed(png, makeZip(ENTRIES))
    const result = validateZipSlice(file, file.length, png.length)
    if (!result.ok) throw new Error(`slice rejected: ${result.reason}`)

    expect(result.offset).toBe(png.length)
    expect(result.entryCount).toBe(ENTRIES.length)
    expect(result.cdSize).toBeGreaterThan(0)
    expect(result.eocdAbsPos).toBe(file.length - EOCD_SIZE)
    expect(result.cdAbsPos).toBe(png.length + readEocd(file, result.eocdAbsPos).cdOffset)
    // the central directory really starts where we claim
    expect(u32At(file, result.cdAbsPos)).toBe(SIG_CDH)
  })

  it('validateZipSlice rejects a slice whose cdOffset points outside the file', () => {
    const broken = withEocdCdOffset(makeZip(ENTRIES), 0x7fffff00)
    const result = failureOf(validateZipSlice(broken, broken.length, 0))
    expect(result.reason).toBe('cd-out-of-bounds')
    expect(result.offset).toBe(0)

    // an offset inside the file but with no EOCD after it is also rejected
    const png = makePng(8, 8)
    const file = makePrefixed(png, makeZip(ENTRIES))
    expect(failureOf(validateZipSlice(file, file.length, file.length - 4)).reason).toBe('no-eocd')
  })

  it('detectZipStart returns kind none for a pure image', () => {
    const png = makePng()
    const result = detectZipStart(png, png.length)
    expect(result.kind).toBe('none')
    expect(result.offset).toBe(-1)
    expect(findEocd(png, png.length)).toBe(-1)
  })

  it('does not false-positive on PK\x03\x04 inside a JPEG COM segment while naiveIndexOfPk does', () => {
    const jpeg = makeJpegWithFakePk()

    // the naive strategy hits: image payload bytes that happen to spell PK\x03\x04
    const naive = naiveIndexOfPk(jpeg)
    expect(naive).toBeGreaterThan(0)
    expect(naiveIndexOfPkFixture(jpeg)).toBe(naive)
    // ... and that hit is a structurally VALID local header, so only the EOCD rule
    // (an archive must have an end-of-central-directory record) saves us here
    expect(validateLfhAt(jpeg, naive, jpeg.length)).not.toBeNull()

    const result = detectZipStart(jpeg, jpeg.length)
    expect(result.kind).toBe('none')
    expect(result.offset).toBe(-1)
    expect(findEocd(jpeg, jpeg.length)).toBe(-1)
  })

  it('decodes non-UTF8 (CP437) entry names as latin1 without failing validation', () => {
    const cp437Name = '\u0082\u008a.txt'
    const zip = makeZip([{ name: cp437Name, data: textBytes('cp437'), cp437: true }])
    const lfh = validateLfhAt(zip, 0, zip.length)
    if (lfh === null) throw new Error('CP437 name was rejected as binary noise')

    expect(lfh.nameBytes).toEqual(Uint8Array.from([0x82, 0x8a, 0x2e, 0x74, 0x78, 0x74]))
    expect(lfh.flags & 0x0800).toBe(0)
    expect(decodeEntryName(lfh.nameBytes, false)).toBe(cp437Name)
    expect(decodeEntryName(lfh.nameBytes, (lfh.flags & 0x0800) !== 0)).toBe(cp437Name)
    // bytes that are not valid UTF-8 must not throw even when the UTF-8 flag is set
    expect(decodeEntryName(Uint8Array.from([0xff, 0xfe, 0x2e]), true)).toBe('\u00ff\u00fe.')
    expect(detected(detectZipStart(zip, zip.length)).offset).toBe(0)
  })
})
