// The PROOF layer: real files, real bytes, real files on disk.
//
// The unit specs in test/unit prove the algorithm against bytes we built ourselves.
// That is necessary and not sufficient: a self-graded format proves only that we and
// ourselves agree. This spec closes the gap by writing the disguised file to
// <cwd>/.tmp/evidence/disguised.jpg and reading it back off the filesystem, so the
// assertions below are about bytes that actually reached a disk.
//
// scripts/real-surface-check.ps1 then hands that very file to genuine third-party
// archive tooling (libarchive via bsdtar, and Info-ZIP), which is the only kind of
// evidence that does not grade our own homework.
//
// ---------------------------------------------------------------------------
// WHY there are two payload archives, and which one is which
//
// The happy-path payload is `.tmp/fixtures/payload.zip`, written by the PowerShell
// step through .NET's `ZipFile.CreateFromDirectory`. It is real by construction: an
// independent zip writer produced it, so when a third-party tool lists and extracts
// the disguised file, the credit belongs to the ZIP format and to our concatenation
// -- not to us agreeing with ourselves.
//
// `makeZip` / `makeZip64` from ../fixtures/bytes are the OTHER thing, and must never
// be confused with the above. They are hand-rolled STORED writers that exist to
// drive edge cases (EOCD comments, ZIP64 sentinels, data descriptors, zero-entry
// archives) and are validated ONLY by our own reader in src/lib/zip. They are the
// fallback below purely so `npm test` works with no PowerShell step. They are never
// handed to bsdtar / unzip / Expand-Archive, and no pass/fail claim about real
// archive tooling is ever derived from them.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { detectZipStart, validateZipSlice } from '@/lib/zip'
import type { ZipStartDetection, ZipStartDetected } from '@/lib/zip'
import { mergeConcat, splitAtOffset } from '@/lib/stego'
import { TINY_JPEG_B64, makePng, makeZip } from '../fixtures/bytes'
import type { ZipEntryFixture } from '../fixtures/bytes'

// Node 18.16 has no `import.meta.dirname`, so every path is resolved from the cwd --
// which is how vitest was launched, and therefore the project root.
const PROJECT_ROOT = process.cwd()
const TMP_ROOT = resolve(PROJECT_ROOT, '.tmp')
const FIXTURE_DIR = resolve(TMP_ROOT, 'fixtures')
const EVIDENCE_DIR = resolve(TMP_ROOT, 'evidence')

/** The names this spec writes. Spec 3 asserts none of them exist at the repo root. */
const ARTIFACT_NAMES = ['photo.png', 'photo.jpg', 'payload.zip', 'disguised.jpg', 'extracted.zip'] as const

/**
 * Windows path comparison is case-insensitive, so the containment check is too.
 * Without this, a sibling directory that differs only in case would pass the guard.
 */
const comparable = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * The one and only door to the filesystem, and it opens onto `.tmp` alone.
 *
 * This is a real containment check, not a convention: `path.resolve` returns an
 * absolute argument unchanged, so a `..` traversal and a fully-qualified path both
 * resolve to something outside `.tmp` and are rejected here. Nothing in this spec
 * calls `writeFileSync` without going through it.
 */
function resolveInsideTmp(relativePath: string): string {
  const target = resolve(TMP_ROOT, relativePath)
  const root = comparable(TMP_ROOT)
  if (comparable(target) !== root && !comparable(target).startsWith(root + sep)) {
    throw new Error(`refusing to write outside .tmp: "${relativePath}" resolves to ${target}`)
  }
  return target
}

/** `resolveInsideTmp` plus the parent directory, as the one way bytes reach a disk. */
function writeArtifact(relativePath: string, bytes: Uint8Array): string {
  const target = resolveInsideTmp(relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return target
}

/**
 * Node 18.16 has no global `File`, so the named blob a browser would hand us is built
 * by defining the single member `File` would inherit. `mergeConcat` is typed on
 * `Blob` precisely so this shim is the caller's problem and not the library's.
 */
interface NamedBlob extends Blob {
  name: string
}

/**
 * `Uint8Array.from` re-backs the view on a plain `ArrayBuffer`, which is what `BlobPart`
 * demands -- the builders declare the wide `Uint8Array`, and a view over a
 * `SharedArrayBuffer` is not a `BlobPart`. The copy is free: the Blob copies the bytes
 * into its own store on construction anyway.
 *
 * Deliberately unannotated: naming the return type `Uint8Array` widens it back to
 * `Uint8Array<ArrayBufferLike>` and reintroduces exactly the error this avoids.
 */
const blobPart = (bytes: Uint8Array) => Uint8Array.from(bytes)

const namedBlob = (bytes: Uint8Array, name: string, type: string): NamedBlob =>
  Object.defineProperty(new Blob([blobPart(bytes)], { type }), 'name', { value: name }) as NamedBlob

const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer())

const textBytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0))

/** Mirrors what the PowerShell step drops into payload-src, so the fallback merges the same shape. */
const FALLBACK_ENTRIES: ZipEntryFixture[] = [
  { name: 'a.txt', data: textBytes('alpha') },
  { name: 'nested/b.txt', data: textBytes('beta') },
  { name: 'c.bin', data: Uint8Array.from({ length: 64 }, (_, i) => i + 1) },
]

interface Payload {
  bytes: Uint8Array
  /** Logged, because which archive was used changes what the run is allowed to claim. */
  source: string
}

function loadPayload(): Payload {
  const real = resolveInsideTmp('fixtures/payload.zip')
  if (existsSync(real)) {
    const bytes = new Uint8Array(readFileSync(real))
    return { bytes, source: `real .NET archive at .tmp/fixtures/payload.zip (${bytes.length} bytes)` }
  }
  // Deliberately NOT written to .tmp/fixtures/payload.zip: a synthetic archive left
  // there would be picked up as "real" by the next run and quietly upgrade a fake
  // green into a permanent one.
  const bytes = makeZip(FALLBACK_ENTRIES)
  return { bytes, source: `SYNTHETIC makeZip fallback (${bytes.length} bytes) -- no .tmp/fixtures/payload.zip present` }
}

const PAYLOAD = loadPayload()

interface Evidence {
  image: Uint8Array
  payload: Uint8Array
  fileName: string
  /** Where the archive starts, detected on the bytes read back off the disk. */
  offset: number
  pngPath: string
  jpgPath: string
  disguisedPath: string
  extractedPath: string
}

let evidence: Evidence | null = null

/** beforeAll is the only writer; this is the reader every assertion goes through. */
function built(): Evidence {
  if (evidence === null) throw new Error('beforeAll did not run: no artifacts were built')
  return evidence
}

/** Narrowing helper: a failed expect() must not leave the rest of the spec unchecked. */
function detected(detection: ZipStartDetection): ZipStartDetected {
  if (detection.kind === 'none') throw new Error(`expected a detection, got kind=none (offset ${detection.offset})`)
  return detection
}

describe('evidence', () => {
  beforeAll(async () => {
    console.log(`[evidence] payload source: ${PAYLOAD.source}`)
    mkdirSync(FIXTURE_DIR, { recursive: true })
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    // Given: a real PNG and a real 1x1 JPEG on disk, both under .tmp.
    const pngPath = writeArtifact('fixtures/photo.png', makePng(96, 96))
    const image = new Uint8Array(Buffer.from(TINY_JPEG_B64, 'base64'))
    const jpgPath = writeArtifact('fixtures/photo.jpg', image)

    // When: the disguise itself -- image bytes, then archive bytes, onto the disk.
    const merged = await mergeConcat(namedBlob(image, 'photo.jpg', 'image/jpeg'), [new Blob([blobPart(PAYLOAD.bytes)])])
    const disguisedPath = writeArtifact('evidence/disguised.jpg', await bytesOf(merged.blob))

    // And the offset is detected on what the FILESYSTEM gave back, not on the blob
    // still in memory -- otherwise this would only re-prove the in-memory unit spec.
    const onDisk = new Uint8Array(readFileSync(disguisedPath))
    const detection = detected(detectZipStart(onDisk, onDisk.length))
    if (detection.offset !== merged.imageBytes) {
      throw new Error(`detection seam ${detection.offset} != image length ${merged.imageBytes}`)
    }

    // And the exact inverse, written back out.
    const extractedPath = writeArtifact('evidence/extracted.zip', await bytesOf(splitAtOffset(merged.blob, detection.offset).zip))

    evidence = {
      image,
      payload: PAYLOAD.bytes,
      fileName: merged.fileName,
      offset: detection.offset,
      pngPath,
      jpgPath,
      disguisedPath,
      extractedPath,
    }
  })

  it('writes a disguised file whose prefix and suffix are byte-exact on disk', () => {
    // Given: the disguised file the run above just wrote.
    const state = built()

    // When: it is read back with node:fs -- the on-disk bytes, not the blob.
    const onDisk = new Uint8Array(readFileSync(state.disguisedPath))
    const { offset } = state

    // Then: the seam is at exactly the image length, so the split costs nothing.
    expect(offset).toBe(state.image.length)
    // Then: the file is the image followed by the archive, byte for byte, on disk.
    expect(onDisk.length).toBe(state.image.length + state.payload.length)
    expect(Buffer.from(onDisk.subarray(0, offset))).toEqual(Buffer.from(state.image))
    expect(Buffer.from(onDisk.subarray(offset))).toEqual(Buffer.from(state.payload))
    // Then: the name is untouched -- the disguise changes the file's length, not its name.
    expect(state.fileName).toBe('photo.jpg')
  })

  it('writes an extracted zip byte-identical to the original payload', () => {
    // Given: the split result, already on disk at .tmp/evidence/extracted.zip.
    const state = built()

    // When: it is read back with node:fs.
    const onDisk = new Uint8Array(readFileSync(state.extractedPath))

    // Then: byte-identical to the archive that went in -- the round trip is lossless.
    expect(Buffer.from(onDisk)).toEqual(Buffer.from(state.payload))
    // Then: and a coherent archive standing alone, per the same reader that found the seam.
    expect(validateZipSlice(onDisk, onDisk.length, 0).ok).toBe(true)
  })

  it('writes fixtures into .tmp so nothing leaks into the repo', () => {
    // Given: every path this run resolved.
    const state = built()

    // Then: all of them sit under <cwd>/.tmp.
    for (const path of [state.pngPath, state.jpgPath, state.disguisedPath, state.extractedPath]) {
      expect(path.startsWith(TMP_ROOT + sep)).toBe(true)
    }
    // Then: and those directories really exist, holding the artifacts.
    expect(existsSync(FIXTURE_DIR)).toBe(true)
    expect(existsSync(EVIDENCE_DIR)).toBe(true)
    // Then: no artifact of this run is sitting at the repo root.
    for (const name of ARTIFACT_NAMES) {
      expect(existsSync(resolve(PROJECT_ROOT, name))).toBe(false)
    }
    // Then: and .tmp is ignored, so the artifacts cannot be committed by accident.
    const ignored = readFileSync(resolve(PROJECT_ROOT, '.gitignore'), 'utf8')
    expect(ignored.split(/\r?\n/).some((line) => line.trim() === '.tmp/')).toBe(true)
  })

  it('refuses to write outside .tmp', () => {
    // Given: an absolute path that is outside the project entirely.
    const absoluteOutside = resolve(PROJECT_ROOT, '..', 'escape-absolute.txt')
    expect(isAbsolute(absoluteOutside)).toBe(true)

    // Then: a relative traversal is refused by the guard...
    expect(() => resolveInsideTmp('../escape.txt')).toThrow(/outside \.tmp/)
    // ...and the absolute path is refused too, because resolve() hands an absolute
    // argument straight back and the containment check then fails on it.
    expect(() => resolveInsideTmp(absoluteOutside)).toThrow(/outside \.tmp/)

    // Then: the writer honours the guard, so the resolver is not decorative.
    expect(() => writeArtifact('../escape.txt', Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toThrow(/outside \.tmp/)
    expect(() => writeArtifact(absoluteOutside, Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toThrow(/outside \.tmp/)

    // Then: the refused writes left nothing behind, at the repo root or above it.
    expect(existsSync(resolve(PROJECT_ROOT, 'escape.txt'))).toBe(false)
    expect(existsSync(absoluteOutside)).toBe(false)

    // Then: a legitimate path inside .tmp still resolves, so the guard is not a blanket denial.
    expect(resolveInsideTmp('evidence/ok.txt').startsWith(TMP_ROOT + sep)).toBe(true)
  })
})
