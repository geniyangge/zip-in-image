/**
 * Image probing: "is this blob a real image, and how big is it?"
 *
 * The extract panel has to answer that question for the *prefix* of a file, before
 * anything else looks at it. The answer therefore has to be a value, never an
 * exception: a truncated or mislabelled prefix is the normal case, not an error.
 *
 * `ImageDecoder` is an injected parameter rather than a direct global call, because
 * `createImageBitmap` does not exist outside a browser (and jsdom does not
 * implement it either). That single seam is what makes "is the prefix a real
 * image?" testable off-browser.
 */

/** Result of an image probe. `ok` discriminates; both variants are total. */
export type ImageProbe =
  | { ok: true; width: number; height: number; type: string }
  | { ok: false; reason: string }

/** Turns a blob into an `ImageProbe`. Never rejects for an expected input. */
export type ImageDecoder = (blob: Blob) => Promise<ImageProbe>

const UNKNOWN_TYPE = 'image/unknown'
const IMAGE_UNREADABLE = 'the blob could not be decoded as an image'

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const blobType = (blob: Blob): string => (blob.type === '' ? UNKNOWN_TYPE : blob.type)

/** Never lets a decoder rejection escape as a rejection; converts it to a failure probe. */
const toProbe = async (decode: () => Promise<ImageProbe>): Promise<ImageProbe> => {
  try {
    return await decode()
  } catch (error) {
    return { ok: false, reason: describeError(error) }
  }
}

/**
 * Preferred path: one decode call, no DOM, no object URL. The bitmap is closed in a
 * `finally` so a throw while reading its dimensions still releases the memory.
 */
const decodeWithBitmap = async (blob: Blob): Promise<ImageProbe> => {
  const bitmap = await createImageBitmap(blob)
  try {
    return { ok: true, width: bitmap.width, height: bitmap.height, type: blobType(blob) }
  } finally {
    bitmap.close()
  }
}

/**
 * Fallback for engines without `createImageBitmap`. Resolves on both `load` and
 * `error`; the object URL is revoked on both, so a probe never leaks one.
 */
const decodeWithImageElement = (blob: Blob): Promise<ImageProbe> =>
  new Promise<ImageProbe>((resolve) => {
    let objectUrl: string | undefined
    const settle = (probe: ImageProbe): void => {
      if (objectUrl !== undefined) {
        URL.revokeObjectURL(objectUrl)
      }
      resolve(probe)
    }

    try {
      objectUrl = URL.createObjectURL(blob)
      const image = new Image()
      image.onload = (): void => {
        settle({ ok: true, width: image.naturalWidth, height: image.naturalHeight, type: blobType(blob) })
      }
      image.onerror = (): void => {
        settle({ ok: false, reason: IMAGE_UNREADABLE })
      }
      image.src = objectUrl
    } catch (error) {
      settle({ ok: false, reason: describeError(error) })
    }
  })

/**
 * The real decoder. Feature-detects `createImageBitmap` on every call rather than at
 * module load, so the module stays importable where the global is absent and stays
 * correct if a test (or a polyfill) replaces it later. Never throws: every outcome,
 * including a missing `Image` constructor, resolves to an `ImageProbe`.
 */
export const browserImageDecoder: ImageDecoder = (blob) => {
  if (typeof createImageBitmap === 'function') {
    return toProbe(() => decodeWithBitmap(blob))
  }
  return toProbe(() => decodeWithImageElement(blob))
}

/**
 * Reports whether `blob` is a real image and, if so, its dimensions.
 *
 * The decoder is injectable so callers can supply a cheap fake in tests; the default
 * is the browser decoder. The returned promise never rejects, so callers do not need
 * a try/catch to stay alive on a corrupt prefix.
 */
export function probeImage(blob: Blob, decode: ImageDecoder = browserImageDecoder): Promise<ImageProbe> {
  return toProbe(() => decode(blob))
}
