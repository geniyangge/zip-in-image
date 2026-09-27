import { describe, expect, it } from 'vitest'

describe('smoke', () => {
  it('provides the Blob surface the library is typed on', async () => {
    // Every lib signature is typed on `Blob`, never `File`, so the one environment
    // fact that actually matters is that `Blob` is constructible and readable. This
    // holds on every Node version we support.
    expect(typeof Blob).toBe('function')
    expect(typeof Blob.prototype.arrayBuffer).toBe('function')

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    expect(blob.size).toBe(3)
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('lacks createImageBitmap, which is why ImageDecoder is injected', () => {
    // This is the load-bearing guard, and it is still true on Node 25. `File`, by
    // contrast, became a global in Node 20 — an earlier version of this file asserted
    // it was absent, which was incidental: the code never depended on `File` being
    // missing, only on `Blob` being present and on image decoding being injectable.
    //
    // jsdom 24 also does not implement it, so the same seam is what makes the
    // component specs runnable at all.
    expect(typeof createImageBitmap).toBe('undefined')
    expect(typeof URL.createObjectURL).toBe('function')
    expect(typeof URL.revokeObjectURL).toBe('function')
  })

  it('accepts whatever a file input yields as a Blob', () => {
    // The panels receive a `File` from `<input type="file">` in the browser. Whether
    // `File` is a global or not is a platform detail; that it satisfies the `Blob`
    // contract the lib is typed on is the actual requirement. Asserting it this way
    // keeps the guard meaningful on Node 18 (no `File` global) and Node 20+ (`File`
    // global) alike.
    //
    // Node >= 20 requires both `fileBits` and `fileName`; jsdom and browsers accept
    // them too, so pass them rather than relying on a zero-arg construction.
    const fileCtor = (globalThis as { File?: new (bits: BlobPart[], name: string) => Blob }).File
    if (fileCtor === undefined) {
      expect(typeof Blob).toBe('function')
      return
    }
    const asBlob: Blob = new fileCtor([new Uint8Array([7])], 'placeholder.png')
    expect(asBlob).toBeInstanceOf(Blob)
    expect(asBlob.size).toBe(1)
  })
})
