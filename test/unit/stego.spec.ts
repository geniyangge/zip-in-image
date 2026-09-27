// The merge and the slice: [image bytes][zip bytes] in, two blobs back out.
//
// Concatenation is the whole disguise. A viewer stops at the image's end marker and
// never reaches the archive; a reader handed the same bytes after a rename to .zip
// starts at the first archive byte, which is exactly the image's length. The offset
// DETECTION is deliberately not here -- it lives in @/lib/zip, and these specs prove
// the two halves compose into a lossless round trip.
import { describe, expect, it } from 'vitest'
import {
  detectZipStart,
  naiveIndexOfPk,
  validateZipSlice,
  type ZipStartDetection,
  type ZipStartDetected,
} from '@/lib/zip'
import { mergeConcat, sanitizeFileName, sliceBlob, splitAtOffset } from '@/lib/stego'
import { makeJpegWithFakePk, makePng, makeZip, type ZipEntryFixture } from '../fixtures/bytes'

const textBytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0))

const ENTRIES: ZipEntryFixture[] = [
  { name: 'hello.txt', data: textBytes('hello zip') },
  { name: 'dir/notes.md', data: textBytes('# notes') },
]

/**
 * Node 18.16 has no global `File`, so a named blob is built by defining the single
 * member the browser's `File` subclass would inherit. This is the file's only
 * assertion site: the object really is a `Blob` and really does carry a `name` -- it
 * is just widened to the minimal shape the specs hand to `mergeConcat`, which is
 * typed on `Blob` and must stay that way.
 */
interface NamedBlob extends Blob {
  name: string
}

/**
 * `bytes` as a Blob. `Uint8Array.from` re-backs the view on a plain `ArrayBuffer`:
 * the fixture builders declare the wide `Uint8Array`, and `BlobPart` accepts only a
 * non-shared buffer view. The copy is free here -- the Blob copies the bytes into its
 * own store on construction anyway.
 */
const blobOf = (bytes: Uint8Array, type = ''): Blob => new Blob([Uint8Array.from(bytes)], { type })

const namedBlob = (bytes: Uint8Array, name: string, type: string): NamedBlob =>
  Object.defineProperty(blobOf(bytes, type), 'name', { value: name }) as NamedBlob

const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer())

/** Narrowing helper: a failed expect() must not leave the rest of the spec unchecked. */
function detected(detection: ZipStartDetection): ZipStartDetected {
  if (detection.kind === 'none') throw new Error(`expected a detection, got kind=none (offset ${detection.offset})`)
  return detection
}

describe('stego', () => {
  it('mergeConcat lays out image bytes then payload bytes with no gap', async () => {
    // Given: a real PNG and a real archive, in that order.
    const png = makePng()
    const zip = makeZip(ENTRIES)
    const image = namedBlob(png, 'photo.png', 'image/png')

    // When: concatenating image-then-payload.
    const result = await mergeConcat(image, [blobOf(zip)])
    const merged = await bytesOf(result.blob)

    // Then: the archive begins at exactly the image length -- byte for byte, no gap.
    expect(merged.length).toBe(png.length + zip.length)
    expect(result.imageBytes).toBe(png.length)
    expect(Buffer.from(merged.subarray(0, result.imageBytes))).toEqual(Buffer.from(png))
    expect(Buffer.from(merged.subarray(result.imageBytes))).toEqual(Buffer.from(zip))
    // Then: the MIME type survives, so a viewer still treats the file as an image.
    expect(result.blob.type).toBe('image/png')

    // Given: a source image that carries no MIME type at all (a hand-built Blob).
    const typeless = blobOf(png)

    // When: concatenating it.
    const untypeable = await mergeConcat(typeless, [blobOf(zip)])

    // Then: the merged blob still gets a concrete type instead of the empty string.
    expect(untypeable.blob.type).toBe('application/octet-stream')
  })

  it('mergeConcat output name keeps the image original extension', async () => {
    // Given: an image whose name carries CJK, a space, digits and an extension.
    const name = '照片 01.png'
    const image = namedBlob(makePng(), name, 'image/png')

    // When: concatenating it with a payload.
    const result = await mergeConcat(image, [blobOf(makeZip(ENTRIES))])

    // Then: the name is the image's own, extension intact, no '.zip' appended to it.
    expect(result.fileName).toBe(name)
    expect(result.fileName.endsWith('.png')).toBe(true)
  })

  it('mergeConcat output size equals imageBytes plus payloadBytes', async () => {
    // Given: one image and two payloads, so the total is a sum and not a single term.
    const png = makePng(64, 48)
    const first = makeZip(ENTRIES)
    const second = makeZip([{ name: 'second.bin', data: textBytes('second payload') }])

    // When: concatenating all three parts.
    const result = await mergeConcat(namedBlob(png, 'photo.png', 'image/png'), [
      blobOf(first),
      blobOf(second),
    ])

    // Then: the accounting is exact and agrees with the blob's real size.
    expect(result.imageBytes).toBe(png.length)
    expect(result.payloadBytes).toBe(first.length + second.length)
    expect(result.totalBytes).toBe(result.imageBytes + result.payloadBytes)
    expect(result.blob.size).toBe(result.totalBytes)
  })

  it('sliceBlob returns exactly the requested byte range', async () => {
    // Given: a disguised file, and a window that straddles the image/archive seam.
    const png = makePng()
    const zip = makeZip(ENTRIES)
    const merged = await mergeConcat(namedBlob(png, 'photo.png', 'image/png'), [blobOf(zip)])

    // When: slicing four bytes either side of the seam.
    const window = sliceBlob(merged.blob, png.length - 4, png.length + 4)

    // Then: those eight bytes are the tail of the image followed by the head of the zip.
    const expected = Buffer.concat([
      Buffer.from(png.subarray(png.length - 4)),
      Buffer.from(zip.subarray(0, 4)),
    ])
    expect(window.size).toBe(8)
    expect(Buffer.from(await window.arrayBuffer())).toEqual(expected)
  })

  it('splitAtOffset round-trips a merged file back to the original zip bytes', async () => {
    // Given: a disguised file whose image hides a decoy local file header, so a naive
    // PK scan lands inside the picture and only real detection finds the archive.
    const jpeg = makeJpegWithFakePk()
    const zip = makeZip(ENTRIES)
    const merged = await mergeConcat(namedBlob(jpeg, 'photo.jpg', 'image/jpeg'), [blobOf(zip)])
    const mergedBytes = await bytesOf(merged.blob)

    // When: asking the existing detector where the archive starts, then splitting there.
    const detection = detected(detectZipStart(mergedBytes, mergedBytes.length))
    const split = splitAtOffset(merged.blob, detection.offset)

    // Then: the detector landed exactly on the boundary the merger reported.
    expect(detection.offset).toBe(merged.imageBytes)
    // Then: the naive scan would NOT have found it -- the round trip is not luck.
    expect(naiveIndexOfPk(mergedBytes)).not.toBe(merged.imageBytes)
    // Then: the prefix is the image again, byte for byte.
    expect(Buffer.from(await bytesOf(split.image))).toEqual(Buffer.from(jpeg))
    // Then: the suffix is the original archive, byte for byte, and it validates alone.
    const extracted = await bytesOf(split.zip)
    expect(Buffer.from(extracted)).toEqual(Buffer.from(zip))
    expect(validateZipSlice(extracted, extracted.length, 0).ok).toBe(true)
  })

  it('splitAtOffset with offset 0 yields an empty image prefix', async () => {
    // Given: a disguised file and an offset at its very first byte.
    const png = makePng()
    const zip = makeZip(ENTRIES)
    const merged = await mergeConcat(namedBlob(png, 'photo.png', 'image/png'), [blobOf(zip)])

    // When: splitting at 0.
    const split = splitAtOffset(merged.blob, 0)

    // Then: degenerate, reported, never thrown -- an empty prefix, the whole file as zip.
    expect(split.offset).toBe(0)
    expect(split.image.size).toBe(0)
    expect(split.zip.size).toBe(merged.totalBytes)
  })

  it('splitAtOffset with offset equal to fileLen yields an empty zip (degenerate, reported not thrown)', async () => {
    // Given: a disguised file and an offset one byte past its end.
    const png = makePng()
    const zip = makeZip(ENTRIES)
    const merged = await mergeConcat(namedBlob(png, 'photo.png', 'image/png'), [blobOf(zip)])

    // When: splitting at exactly the file length.
    const atEnd = splitAtOffset(merged.blob, merged.totalBytes)

    // Then: the whole file is the image and the zip side is empty.
    expect(atEnd.offset).toBe(merged.totalBytes)
    expect(atEnd.image.size).toBe(merged.totalBytes)
    expect(atEnd.zip.size).toBe(0)

    // When: splitting far past the end, and far before the start.
    const past = splitAtOffset(merged.blob, merged.totalBytes + 4096)
    const before = splitAtOffset(merged.blob, -1)

    // Then: the offset is clamped into range and reported, never thrown.
    expect(past.offset).toBe(merged.totalBytes)
    expect(past.zip.size).toBe(0)
    expect(before.offset).toBe(0)
    expect(before.image.size).toBe(0)
  })

  it('sanitizeFileName strips path separators and control characters', () => {
    // Given: a traversal attempt wearing a Windows drive colon, a NUL and two control
    // bytes: '  ../..\a/b  :c.png  '.
    const hostile = '  ../..\\a/b\u0000\u001f\u007f:c.png  '

    // When: sanitizing it.
    const safe = sanitizeFileName(hostile)

    // Then: every separator, drive colon and control byte is gone; the extension is not.
    expect(safe).toBe('abc.png')

    // When: there is nothing left to name the file with at all.
    // Then: the one result that must never be empty is the documented fallback.
    expect(sanitizeFileName('')).toBe('disguised.bin')
    expect(sanitizeFileName('..')).toBe('disguised.bin')
  })

  it('sanitizeFileName preserves CJK characters', () => {
    // Given: a Chinese name with a space, digits, an underscore, a hyphen and a
    // extension -- nothing a normal picture is named after.
    const name = '照片 01-夏日_v2.png'

    // When: sanitizing a name that needs no stripping.
    const verbatim = sanitizeFileName(name)

    // Then: it comes back byte-for-byte.
    expect(verbatim).toBe(name)

    // When: the same name padded with a traversal prefix and a trailing dot.
    const padded = sanitizeFileName(`..${name}.`)

    // Then: only the leading dots and the trailing dot go; the CJK and extension stay.
    expect(padded).toBe(name)
  })
})
