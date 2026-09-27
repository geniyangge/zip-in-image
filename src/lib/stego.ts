/**
 * The merge and the slice: `[image bytes][zip bytes]`, in that order.
 *
 * Concatenation is the whole disguise. A viewer stops at the image's end marker and
 * never reaches the archive, while a reader handed the same bytes after a rename to
 * `.zip` starts at the first archive byte -- which is exactly the image's length.
 * Where that offset actually IS, is not this module's business: `@/lib/zip` derives
 * it, and the split side only has to be the exact inverse of the merge side.
 *
 * Two decisions here are load-bearing and not obvious from the code:
 *
 * 1. The output is assembled by handing the parts to `new Blob([...])` rather than by
 *    copying the bytes into one buffer. Copying would double peak memory on a large
 *    payload -- the image and the archive are already resident, and a second combined
 *    copy buys nothing the host does not already do while storing the blob.
 * 2. The output name is the image's own name, extension included. Rewriting it to
 *    `.zip` would advertise what the file is; the disguise is that nothing observable
 *    about the file changed but its length.
 */

/** The name given to a file whose own name is empty or strips down to nothing. */
const FALLBACK_FILE_NAME = 'disguised.bin'

/**
 * Path separators, plus ':' -- a drive letter (`C:evil`) and a Windows alternate data
 * stream (`name:stream`) both name something other than the file. Then the ASCII
 * control bytes, which no real name carries and which several filesystems reject.
 */
const UNSAFE_NAME_CHARS = /[/\\:\u0000-\u001f\u007f]/g

/**
 * Leading and trailing whitespace and dots. Leading dots are a traversal attempt
 * (`..`), and Windows silently drops trailing dots and spaces, so a name ending in
 * either is a lie the download would not keep.
 */
const NAME_EDGE_NOISE = /^[\s.]+|[\s.]+$/g

export interface MergeResult {
  /** `[image bytes][payload bytes]`, with the image's MIME type. */
  blob: Blob
  /** The image's own name, sanitized -- extension untouched. */
  fileName: string
  imageBytes: number
  payloadBytes: number
  totalBytes: number
}

export interface SplitResult {
  image: Blob
  zip: Blob
  /** The clamped offset actually used, not necessarily the one requested. */
  offset: number
}

/**
 * The source's file name, or `''` when there is none.
 *
 * Typed on `Blob` on purpose: the browser's `File` global does not exist under the
 * node test environment, and `name` is the only member this module needs from it. A
 * bare `Blob` genuinely has no name, so the member is narrowed here rather than
 * forcing every caller to cast -- and a nameless source degrades to the fallback
 * name instead of failing the merge.
 */
function nameOf(source: Blob): string {
  if ('name' in source && typeof source.name === 'string') return source.name
  return ''
}

/**
 * `[image][...payloads]` as one blob, plus the exact byte accounting.
 *
 * Async only so callers can await a uniform API alongside the read side; the body is
 * synchronous and allocates no combined buffer of its own.
 *
 * An empty `type` is replaced with `application/octet-stream` because a blob with an
 * empty type is not offered as a download by some browsers, and the merged file
 * still has to reach the disk.
 */
export async function mergeConcat(image: Blob, payloads: Blob[]): Promise<MergeResult> {
  const imageBytes = image.size
  let payloadBytes = 0
  for (const payload of payloads) payloadBytes += payload.size
  return {
    blob: new Blob([image, ...payloads], {
      type: image.type === '' ? 'application/octet-stream' : image.type,
    }),
    fileName: sanitizeFileName(nameOf(image)),
    imageBytes,
    payloadBytes,
    totalBytes: imageBytes + payloadBytes,
  }
}

/**
 * `[start, end)` of `b`, with the range clamped instead of validated.
 *
 * Clamping rather than throwing is the contract: every caller here is acting on an
 * offset that was detected, and a degenerate range is inspectable (an empty blob, or
 * the whole file) where an exception would abort the recovery the user is waiting
 * for. `Blob.prototype.slice` already tolerates a negative start and an end past the
 * end, so all that is left to normalise is `start > end` collapsing to empty.
 */
export function sliceBlob(b: Blob, start: number, end: number): Blob {
  const from = Math.min(Math.max(start, 0), b.size)
  const to = Math.min(Math.max(end, 0), b.size)
  return b.slice(from, Math.max(from, to))
}

/**
 * The two halves of a disguised file, split where the archive starts.
 *
 * The offset is clamped into `[0, b.size]`, so a bad detection yields a degenerate
 * split -- everything as image, or nothing -- which the caller can report, rather
 * than an exception thrown from the middle of a recovery.
 */
export function splitAtOffset(b: Blob, offset: number): SplitResult {
  const at = Math.min(Math.max(offset, 0), b.size)
  return { image: sliceBlob(b, 0, at), zip: sliceBlob(b, at, b.size), offset: at }
}

/**
 * A name that is safe to hand to a download and still looks like the picture.
 *
 * Strips the bytes that would make a name mean a path (separators, a drive colon)
 * and the bytes no name legitimately carries (ASCII control), then drops leading and
 * trailing whitespace and dots. Everything else survives untouched -- CJK, inner
 * spaces, digits, `-`, `_`, `.` and the extension -- because the promise of the tool
 * is that the disguised file still looks like the image it is.
 */
export function sanitizeFileName(name: string): string {
  const safe = name.replace(UNSAFE_NAME_CHARS, '').replace(NAME_EDGE_NOISE, '')
  return safe === '' ? FALLBACK_FILE_NAME : safe
}
