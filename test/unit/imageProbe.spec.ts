import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserImageDecoder, probeImage } from '@/lib/imageProbe'
import type { ImageDecoder, ImageProbe } from '@/lib/imageProbe'

// Real PNG signature so the fixtures read as what they claim to be. The decoder is
// always faked below, so no byte is ever parsed by a real image implementation.
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const pngBlob = (type: string = ''): Blob => new Blob([PNG_SIGNATURE], { type })

/** Narrows a failure probe to its reason, failing loudly when the probe succeeded. */
const failureReason = (probe: ImageProbe): string => {
  if (probe.ok) {
    throw new Error(`expected a failure probe but received ${JSON.stringify(probe)}`)
  }
  return probe.reason
}

// --- fakes for the browserImageDecoder specs -----------------------------------------
//
// test/unit/** runs under Node 18, where neither `createImageBitmap` nor `Image`
// exists, so every global the decoder feature-detects is stubbed here instead.

type LoadHandler = (() => void) | null
type ImageOutcome = 'load' | 'error'

let nextImageOutcome: ImageOutcome = 'load'
let imageWidth = 0
let imageHeight = 0
let lastImage: FakeImage | null = null
let createdUrls: string[] = []
let revokedUrls: string[] = []

/** Minimal stand-in for HTMLImageElement: only the four members the decoder touches. */
class FakeImage {
  onload: LoadHandler = null
  onerror: LoadHandler = null
  naturalWidth: number
  naturalHeight: number
  assignedSrc: string[] = []

  constructor() {
    this.naturalWidth = imageWidth
    this.naturalHeight = imageHeight
    lastImage = this
  }

  set src(value: string) {
    this.assignedSrc.push(value)
    // A browser fires load/error asynchronously; a microtask is the closest honest
    // approximation and keeps `await browserImageDecoder(...)` meaningful.
    queueMicrotask(() => {
      if (nextImageOutcome === 'load') {
        this.onload?.()
      } else {
        this.onerror?.()
      }
    })
  }
}

/** Stubs the object-URL ledger and records every create/revoke pair. */
const stubObjectUrls = (): void => {
  createdUrls = []
  revokedUrls = []
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (): string => {
      const url = `blob:fake/${createdUrls.length}`
      createdUrls.push(url)
      return url
    },
    revokeObjectURL: (url: string): void => {
      revokedUrls.push(url)
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  lastImage = null
  nextImageOutcome = 'load'
  imageWidth = 0
  imageHeight = 0
})

describe('imageProbe', () => {
  it('probeImage resolves dimensions through the injected decoder', async () => {
    // Given: a decoder that answers with the blob's intrinsic dimensions.
    const decode: ImageDecoder = () =>
      Promise.resolve({ ok: true, width: 640, height: 480, type: 'image/png' })

    // When: probing through the injected decoder.
    const probe = await probeImage(pngBlob('image/png'), decode)

    // Then: the decoder's answer is passed through untouched.
    expect(probe).toEqual({ ok: true, width: 640, height: 480, type: 'image/png' })
  })

  it('reports ok:false with a reason when the decoder rejects', async () => {
    // Given: a decoder that rejects, the way a corrupt blob makes the browser reject.
    const decode: ImageDecoder = () => Promise.reject(new Error('not a decodable image'))

    // When: probing through it.
    const probe = await probeImage(pngBlob('image/png'), decode)

    // Then: the rejection is converted, not propagated.
    expect(probe.ok).toBe(false)
    expect(failureReason(probe)).toContain('not a decodable image')
  })

  it('browserImageDecoder uses createImageBitmap when available', async () => {
    // Given: a global createImageBitmap, plus an Image global that must stay unused.
    const createImageBitmapStub = vi.fn(() =>
      Promise.resolve({ width: 1200, height: 800, close: vi.fn() }),
    )
    const imageGlobal = vi.fn()
    vi.stubGlobal('createImageBitmap', createImageBitmapStub)
    vi.stubGlobal('Image', imageGlobal)

    // When: decoding one typed blob and one blob without a MIME type.
    const typed = await browserImageDecoder(pngBlob('image/png'))
    const untyped = await browserImageDecoder(pngBlob())

    // Then: dimensions and the blob's own type are reported, 'image/unknown' when empty.
    expect(typed).toEqual({ ok: true, width: 1200, height: 800, type: 'image/png' })
    expect(untyped).toEqual({ ok: true, width: 1200, height: 800, type: 'image/unknown' })
    // Then: the bitmap path was the one taken.
    expect(createImageBitmapStub).toHaveBeenCalledTimes(2)
    expect(imageGlobal).not.toHaveBeenCalled()
  })

  it('browserImageDecoder falls back to Image + objectURL when createImageBitmap is missing', async () => {
    // Given: no createImageBitmap global, an object-URL ledger, and a loading Image.
    stubObjectUrls()
    nextImageOutcome = 'load'
    imageWidth = 1200
    imageHeight = 800
    vi.stubGlobal('Image', FakeImage)
    expect(typeof createImageBitmap).toBe('undefined')

    // When: decoding a typed blob.
    const probe = await browserImageDecoder(pngBlob('image/png'))

    // Then: the Image path reports the same shape as the bitmap path.
    expect(probe).toEqual({ ok: true, width: 1200, height: 800, type: 'image/png' })
    // Then: the Image was pointed at the object URL that was created for it.
    expect(createdUrls).toEqual(['blob:fake/0'])
    expect(lastImage?.assignedSrc).toEqual(['blob:fake/0'])
  })

  it('browserImageDecoder closes the ImageBitmap and revokes the object URL on both paths', async () => {
    // --- Path A: createImageBitmap present -> the bitmap is closed. -------------------
    // Given: a global createImageBitmap whose bitmap records close().
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve({ width: 4, height: 5, close })))
    stubObjectUrls()

    // When: decoding through the bitmap path.
    const viaBitmap = await browserImageDecoder(pngBlob('image/png'))

    // Then: the bitmap was released and no Image fallback was involved.
    expect(viaBitmap).toEqual({ ok: true, width: 4, height: 5, type: 'image/png' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(createdUrls).toEqual([])

    // --- Path B: Image fallback -> the object URL is revoked, success and failure. ---
    // Given: no createImageBitmap, an Image that first loads then errors.
    vi.stubGlobal('createImageBitmap', undefined)
    vi.stubGlobal('Image', FakeImage)
    nextImageOutcome = 'load'

    // When: decoding a blob the Image can decode.
    const viaLoad = await browserImageDecoder(pngBlob('image/png'))

    // Then: the object URL created for it is revoked.
    expect(viaLoad.ok).toBe(true)
    expect(revokedUrls).toEqual(['blob:fake/0'])

    // When: decoding a blob the Image rejects.
    nextImageOutcome = 'error'
    const viaError = await browserImageDecoder(pngBlob('image/png'))

    // Then: that object URL is revoked too, and the failure is reported, not thrown.
    expect(viaError.ok).toBe(false)
    expect(failureReason(viaError)).not.toBe('')
    expect(revokedUrls).toEqual(['blob:fake/0', 'blob:fake/1'])
    expect(createdUrls).toEqual(['blob:fake/0', 'blob:fake/1'])
  })
})
