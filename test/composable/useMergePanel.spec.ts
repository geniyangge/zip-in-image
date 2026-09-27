// The merge panel's reactive contract, written before the composable exists.
//
// Node environment on purpose: this suite lives under `test/composable/**`, which
// `vitest.config.ts` maps to node. So there is no `window`, no `document` and no
// `createImageBitmap` here -- the composable has to survive all three absences, which
// is exactly why the image decoder and the object-URL pair are injected instead of
// reached for as globals. Nothing below may touch a DOM global either.
import { describe, expect, it, vi } from 'vitest'
import { useMergePanel } from '@/composables/useMergePanel'
import type { ImageDecoder, ImageProbe } from '@/lib/imageProbe'
import { makePng, makeZip } from '../fixtures/bytes'

const textBytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0))

const ENTRIES = [{ name: 'notes.txt', data: textBytes('one payload') }]
const ZIP_BYTES = makeZip(ENTRIES)
const OTHER_ZIP = makeZip([{ name: 'other.txt', data: textBytes('a second payload') }])

/**
 * Node 18.16 has no global `File`, so what a file input hands over is emulated by
 * defining the one member the browser's `File` subclass adds. This is the file's ONLY
 * assertion site: the object really is a `Blob` and really does carry a `name`; it is
 * widened to the minimal shape the composables accept, which is structural, so no
 * `File` cast and no `as any` is needed anywhere in this suite.
 */
interface NamedBlob extends Blob {
  name: string
}

/**
 * `bytes` as a Blob. `Uint8Array.from` re-backs the view on a plain `ArrayBuffer`:
 * the fixture builders declare the wide `Uint8Array`, and `BlobPart` accepts only a
 * non-shared buffer view. The copy is free -- the Blob copies the bytes into its own
 * store on construction anyway.
 */
const blobOf = (bytes: Uint8Array, type = ''): Blob => new Blob([Uint8Array.from(bytes)], { type })

const namedBlob = (bytes: Uint8Array, name: string, type: string): NamedBlob =>
  Object.defineProperty(blobOf(bytes, type), 'name', { value: name }) as NamedBlob

interface FakeDeps {
  decode: ImageDecoder
  createObjectUrl: (blob: Blob) => string
  revokeObjectUrl: (url: string) => void
  /** URLs handed out by the fake object-URL factory, in creation order. */
  created: string[]
  /** URLs passed to the fake revoke, in revocation order. */
  revoked: string[]
  /** Every blob the fake decoder was handed, in call order. */
  probed: Blob[]
  /** Re-arms the fake decoder for every later call. */
  setProbe: (probe: ImageProbe) => void
}

const OK_PROBE: ImageProbe = { ok: true, width: 96, height: 96, type: 'image/png' }
const BAD_PROBE: ImageProbe = { ok: false, reason: 'the blob could not be decoded as an image' }

/**
 * One macrotask turn. The cover probe is a floating promise by design -- `setImage` stays
 * synchronous so the panel and its existing specs can drive it synchronously -- so a spec
 * that asserts the resulting preview needs a real signal to wait on. A macrotask boundary
 * drains every microtask the probe chain is built from, which makes this a completion
 * signal rather than a sleep-and-hope.
 */
const settle = (): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, 0)
  })

/**
 * A decoder that never settles on its own, so a spec can land two probes out of order.
 * This is the only way to reproduce the real hazard: the browser decoder is async, so
 * choosing A then B quickly can settle A's probe AFTER B's, and a panel that applies
 * whichever answer arrives last would show the wrong picture.
 */
function gatedDecoder(): { decode: ImageDecoder; settleAt: (index: number, probe: ImageProbe) => void } {
  const waiting: Array<(probe: ImageProbe) => void> = []
  return {
    decode: () =>
      new Promise<ImageProbe>((resolve) => {
        waiting.push(resolve)
      }),
    settleAt: (index, probe) => {
      const resolve = waiting[index]
      if (resolve === undefined) throw new Error(`no probe is pending at index ${index}`)
      resolve(probe)
    },
  }
}

/**
 * A hermetic stand-in for the three injected dependencies. The verdict is mutable so
 * one panel can be shown both a decodable and an undecodable cover, and the ledgers
 * make a revocation assertable without depending on Node's own blob-URL registry.
 */
function fakeDeps(): FakeDeps {
  const created: string[] = []
  const revoked: string[] = []
  const probed: Blob[] = []
  let verdict: ImageProbe = OK_PROBE
  let issued = 0
  return {
    created,
    revoked,
    probed,
    setProbe: (probe: ImageProbe): void => {
      verdict = probe
    },
    decode: async (blob: Blob): Promise<ImageProbe> => {
      probed.push(blob)
      return verdict
    },
    createObjectUrl: (): string => {
      issued += 1
      const url = `blob:fake/${issued}`
      created.push(url)
      return url
    },
    revokeObjectUrl: (url: string): void => {
      revoked.push(url)
    },
  }
}

describe('useMergePanel', () => {
  it('starts empty with the run action disabled', () => {
    // Given: a freshly constructed panel, nothing chosen yet.
    const panel = useMergePanel(fakeDeps())

    // When: nothing has happened.
    // Then: the run action is off, and a Chinese sentence stands in for the dead button.
    expect(panel.canRun.value).toBe(false)
    expect(panel.disabledReason.value).toBe('请先选择一张封面图。')
    expect(panel.imageName.value).toBeNull()
    expect(panel.payloadName.value).toBeNull()
    expect(panel.result.value).toBeNull()
    expect(panel.previewUrl.value).toBeNull()
    expect(panel.imageProbe.value).toBeNull()
    expect(panel.payloadRejection.value).toBeNull()
    expect(panel.busy.value).toBe(false)
    // Then: idle means "nothing to say", not a disabled-looking warning pill.
    expect(panel.tone.value).toBe('idle')
    expect(panel.message.value).toBeNull()

    panel.dispose()
  })

  it('requires exactly one image and one zip before run is enabled', () => {
    // Given: a panel with a cover image only.
    const panel = useMergePanel(fakeDeps())
    panel.setImage(namedBlob(makePng(32, 24), 'photo.png', 'image/png'))

    // Then: still disabled, and the reason now names the missing half.
    expect(panel.canRun.value).toBe(false)
    expect(panel.disabledReason.value).toBe('请再选择一个 ZIP 压缩包。')

    // When: a zip is chosen as well.
    panel.setPayload(namedBlob(ZIP_BYTES, 'payload.zip', 'application/zip'))

    // Then: live, with no reason to show.
    expect(panel.canRun.value).toBe(true)
    expect(panel.disabledReason.value).toBeNull()
    expect(panel.imageName.value).toBe('photo.png')
    expect(panel.payloadName.value).toBe('payload.zip')

    // When: a SECOND zip is offered -- concatenating two archives would leave two
    // end-of-central-directory records and silently orphan the first one.
    panel.setPayload(namedBlob(OTHER_ZIP, 'other.zip', 'application/zip'))

    // Then: refused with a machine-readable reason, and the first zip is still the one held.
    expect(panel.payloadRejection.value).toContain('只接受一个压缩包')
    expect(panel.payloadName.value).toBe('payload.zip')
    expect(panel.canRun.value).toBe(true)
    expect(panel.tone.value).toBe('error')

    // When: the zip slot is cleared, which is the documented way out.
    panel.setPayload(null)

    // Then: the rejection is forgotten and the panel is disabled again.
    expect(panel.payloadRejection.value).toBeNull()
    expect(panel.canRun.value).toBe(false)
    expect(panel.tone.value).toBe('idle')

    panel.dispose()
  })

  it('merge produces a blob whose byte layout is image-then-zip', async () => {
    // Given: a 32x24 cover and one archive.
    const png = makePng(32, 24)
    const deps = fakeDeps()
    const panel = useMergePanel(deps)
    panel.setImage(namedBlob(png, 'photo.png', 'image/png'))
    panel.setPayload(namedBlob(ZIP_BYTES, 'payload.zip', 'application/zip'))

    // When: the merge runs.
    await panel.run()

    // Then: the output is the image's bytes followed by the archive's, byte for byte.
    const merged = panel.result.value
    if (merged === null) throw new Error('run() must expose a MergeResult on success')
    const bytes = new Uint8Array(await merged.blob.arrayBuffer())
    expect(bytes.length).toBe(png.length + ZIP_BYTES.length)
    expect(Buffer.from(bytes.subarray(0, png.length))).toEqual(Buffer.from(png))
    expect(Buffer.from(bytes.subarray(png.length))).toEqual(Buffer.from(ZIP_BYTES))
    // Then: the output keeps the cover's own name, extension included.
    expect(merged.fileName).toBe('photo.png')
    // Then: every probe the decoder was handed was the CHOSEN cover, never the merged
    // blob -- the pill reports whether the picture is real, and the merged blob would
    // always "decode", so handing it over would make the warning unreachable. There are
    // two probes of that one cover: one when the cover was chosen (so the panel can show
    // a thumbnail before any merge) and one when the merge ran.
    expect(deps.probed).toHaveLength(2)
    for (const probed of deps.probed) expect(probed.size).toBe(png.length)
    expect(panel.busy.value).toBe(false)

    panel.dispose()
  })

  it('exposes output size and a preview object URL', async () => {
    // Given: a cover and a payload, and a panel with a fake object-URL factory.
    const png = makePng(32, 24)
    const deps = fakeDeps()
    const panel = useMergePanel(deps)
    panel.setImage(namedBlob(png, 'photo.png', 'image/png'))
    panel.setPayload(namedBlob(ZIP_BYTES, 'payload.zip', 'application/zip'))

    // When: the merge runs.
    await panel.run()

    // Then: exact byte accounting, and a preview URL that came from the INJECTED factory.
    const merged = panel.result.value
    if (merged === null) throw new Error('run() must expose a MergeResult on success')
    expect(merged.imageBytes).toBe(png.length)
    expect(merged.payloadBytes).toBe(ZIP_BYTES.length)
    expect(merged.totalBytes).toBe(merged.blob.size)
    // Then: two URLs were issued in all -- the cover's own preview when it was chosen, and
    // the merged result when the run finished -- and the run handed the cover's straight
    // back, because the result card now shows that same picture.
    expect(deps.created).toEqual(['blob:fake/1', 'blob:fake/2'])
    expect(panel.previewUrl.value).toBe('blob:fake/2')
    expect(deps.revoked).toEqual(['blob:fake/1'])
    expect(panel.imagePreviewUrl.value).toBeNull()
    expect(panel.imageProbe.value).toEqual(OK_PROBE)
    expect(panel.tone.value).toBe('ok')
    expect(panel.message.value).toContain('已合成')

    // When: the panel is torn down twice, as a double unmount would.
    panel.dispose()
    panel.dispose()

    // Then: the outstanding preview is revoked exactly once -- never twice.
    expect(deps.revoked).toEqual(['blob:fake/1', 'blob:fake/2'])
    expect(panel.previewUrl.value).toBeNull()

    panel.dispose()
  })

  it('surfaces a warn pill when the chosen image fails to decode', async () => {
    // Given: a cover the injected decoder refuses to decode.
    const deps = fakeDeps()
    deps.setProbe({ ok: false, reason: 'the blob could not be decoded as an image' })
    const panel = useMergePanel(deps)
    panel.setImage(namedBlob(makePng(16, 16), 'photo.png', 'image/png'))
    panel.setPayload(namedBlob(ZIP_BYTES, 'payload.zip', 'application/zip'))

    // When: the merge runs anyway -- concatenation does not care whether it is a picture.
    await panel.run()

    // Then: the merge still produced a result; only the pill is a warning.
    expect(panel.result.value).not.toBeNull()
    expect(panel.imageProbe.value).toEqual({ ok: false, reason: 'the blob could not be decoded as an image' })
    expect(panel.tone.value).toBe('warn')
    expect(panel.message.value).toContain('the blob could not be decoded as an image')
    expect(panel.payloadRejection.value).toBeNull()

    panel.dispose()
  })

  it('rejects a payload that lacks the zip magic bytes', async () => {
    // Given: a payload that is not an archive, with its reads watched.
    const cover = makePng(16, 16)
    const notZip = namedBlob(textBytes('this is plain text, not an archive at all'), 'notes.txt', 'text/plain')
    const sliceSpy = vi.spyOn(notZip, 'slice')
    const deps = fakeDeps()
    const panel = useMergePanel(deps)
    panel.setImage(namedBlob(cover, 'photo.png', 'image/png'))
    panel.setPayload(notZip)

    // When: the merge runs.
    await panel.run()

    // Then: refused before any merging, with the reason exposed as state.
    expect(panel.payloadRejection.value).toContain('50 4B 03 04')
    expect(panel.result.value).toBeNull()
    expect(panel.previewUrl.value).toBeNull()
    expect(panel.tone.value).toBe('error')
    // Then: it never reached the payload either -- the rejection is genuinely early. The
    // single probe on record is the COVER's own, taken when the cover was chosen so the
    // panel could show it; naming the blob is what proves the payload was left alone,
    // rather than merely that a count stayed small.
    expect(deps.probed).toHaveLength(1)
    expect(deps.probed[0]?.size).toBe(cover.length)
    expect(deps.probed[0]?.size).not.toBe(notZip.size)
    // And only the first 4 bytes were read to reach that verdict: a multi-gigabyte
    // payload must not be pulled into memory in order to be rejected.
    expect(sliceSpy).toHaveBeenCalled()
    for (const call of sliceSpy.mock.calls) {
      expect(call[1] ?? 0).toBeLessThanOrEqual(4)
    }

    panel.dispose()
  })

  it('shows the chosen cover and its size before the merge has ever run', async () => {
    // Given: a panel with a cover chosen and nothing else done.
    const png = makePng(32, 24)
    const deps = fakeDeps()
    const panel = useMergePanel(deps)

    // When: the cover is picked. `setImage` is synchronous on purpose -- the panel and
    // its specs drive it synchronously -- so the size is readable immediately.
    panel.setImage(namedBlob(png, 'photo.png', 'image/png'))

    // Then: the size is exact, and nothing has been produced or probed twice over.
    expect(panel.imageSize.value).toBe(png.length)
    expect(panel.payloadSize.value).toBeNull()
    expect(panel.result.value).toBeNull()
    expect(panel.previewUrl.value).toBeNull()

    // When: the cover's decode settles.
    await settle()

    // Then: the cover is VISIBLE, before any merge exists -- a preview URL from the
    // INJECTED factory, never a global one. This is the whole point of the feature:
    // picking a picture shows the picture.
    expect(panel.imagePreviewUrl.value).toBe('blob:fake/1')
    expect(deps.created).toEqual(['blob:fake/1'])
    // Then: the archive is still the one half with no object URL, because a ZIP cannot be
    // rendered -- the panel shows its name and size instead.
    panel.setPayload(namedBlob(ZIP_BYTES, 'payload.zip', 'application/zip'))
    expect(panel.payloadSize.value).toBe(ZIP_BYTES.length)
    expect(deps.created).toEqual(['blob:fake/1'])

    panel.dispose()
  })

  it('keeps the cover preview when the archive changes and revokes it when the cover does', async () => {
    // Given: a cover whose preview is on screen.
    const deps = fakeDeps()
    const panel = useMergePanel(deps)
    panel.setImage(namedBlob(makePng(32, 24), 'first.png', 'image/png'))
    await settle()
    expect(panel.imagePreviewUrl.value).toBe('blob:fake/1')

    // When: the archive is chosen and then replaced -- neither touches the cover.
    panel.setPayload(namedBlob(ZIP_BYTES, 'payload.zip', 'application/zip'))
    panel.setPayload(null)
    panel.setPayload(namedBlob(OTHER_ZIP, 'other.zip', 'application/zip'))

    // Then: the cover thumbnail is untouched and no URL was handed back. The two
    // lifetimes are separate objects, and swapping the archive is not a reason to blank
    // the picture the user already picked.
    expect(panel.imagePreviewUrl.value).toBe('blob:fake/1')
    expect(deps.revoked).toEqual([])

    // When: the COVER is replaced -- which does invalidate its own preview.
    panel.setImage(namedBlob(makePng(16, 16), 'second.png', 'image/png'))

    // Then: the old cover's URL is released synchronously, and the new one is issued
    // only once its own decode says the bytes really are a picture.
    expect(deps.revoked).toEqual(['blob:fake/1'])
    expect(panel.imagePreviewUrl.value).toBeNull()
    await settle()
    expect(panel.imagePreviewUrl.value).toBe('blob:fake/2')

    panel.dispose()
  })

  it('applies a cover probe only while it is still the newest one', async () => {
    // Given: a decoder that will settle on the spec's command, so the probes can be
    // landed out of order exactly as a slow first decode would land them.
    const gated = gatedDecoder()
    const deps: FakeDeps = { ...fakeDeps(), decode: gated.decode }
    const panel = useMergePanel(deps)

    // When: cover A is chosen and then immediately replaced by cover B, so two probes are
    // in flight at once and the FIRST one is still outstanding.
    panel.setImage(namedBlob(makePng(32, 24), 'cover-a.png', 'image/png'))
    panel.setImage(namedBlob(makePng(16, 16), 'cover-b.png', 'image/png'))

    // Then: B's probe settles first.
    gated.settleAt(1, OK_PROBE)
    await settle()
    expect(panel.imagePreviewUrl.value).toBe('blob:fake/1')

    // When: A's probe finally settles -- LAST, which is the hazard: a panel that applied
    // whichever answer arrived last would now be showing the discarded cover.
    gated.settleAt(0, OK_PROBE)
    await settle()

    // Then: the preview still reflects the cover that is actually selected, and A's URL
    // was never created at all, so the stale verdict leaks nothing.
    expect(panel.imageName.value).toBe('cover-b.png')
    expect(panel.imagePreviewUrl.value).toBe('blob:fake/1')
    expect(deps.created).toEqual(['blob:fake/1'])
    expect(deps.revoked).toEqual([])

    panel.dispose()
  })

  it('shows no cover preview when the cover does not decode', async () => {
    // Given: a cover the injected decoder refuses, so there is no picture to show.
    const deps = fakeDeps()
    deps.setProbe(BAD_PROBE)
    const panel = useMergePanel(deps)

    // When: it is chosen.
    panel.setImage(namedBlob(makePng(16, 16), 'broken.png', 'image/png'))
    await settle()

    // Then: the size is still known, but no URL was issued -- pointing an <img> at bytes
    // that cannot decode would render a broken-image icon, so the card falls back to
    // showing the name and size on its own.
    expect(panel.imagePreviewUrl.value).toBeNull()
    expect(panel.imageSize.value).toBeGreaterThan(0)
    expect(deps.created).toEqual([])

    panel.dispose()
  })

  it('releases every object URL it holds, exactly once, on run and on reset', async () => {
    // Given: a cover and an archive, merged.
    const deps = fakeDeps()
    const panel = useMergePanel(deps)
    panel.setImage(namedBlob(makePng(32, 24), 'photo.png', 'image/png'))
    await settle()
    panel.setPayload(namedBlob(ZIP_BYTES, 'payload.zip', 'application/zip'))
    await panel.run()

    // When: the merge produced its result. The result card now owns the picture, so the
    // cover's own object URL is handed back rather than holding a second live reference
    // to the same bytes for the life of the panel.
    expect(deps.created).toEqual(['blob:fake/1', 'blob:fake/2'])
    expect(deps.revoked).toEqual(['blob:fake/1'])
    expect(panel.previewUrl.value).toBe('blob:fake/2')
    expect(panel.imagePreviewUrl.value).toBeNull()

    // When: the panel is reset, and then torn down twice, as a double unmount would.
    panel.reset()
    panel.dispose()
    panel.dispose()

    // Then: the full, exact set of URLs handed back -- the cover and the merged result,
    // and nothing revoked twice.
    expect(deps.revoked).toEqual(['blob:fake/1', 'blob:fake/2'])
    expect(panel.previewUrl.value).toBeNull()
    expect(panel.imagePreviewUrl.value).toBeNull()
    expect(panel.imageSize.value).toBeNull()
    expect(panel.payloadSize.value).toBeNull()
  })

  it('releases a cover preview that has no merge behind it', async () => {
    // Given: a cover chosen and never merged -- the case `run()` above cannot cover,
    // because there is no result to release the cover for.
    const deps = fakeDeps()
    const panel = useMergePanel(deps)
    panel.setImage(namedBlob(makePng(32, 24), 'photo.png', 'image/png'))
    await settle()
    expect(deps.revoked).toEqual([])

    // When: the panel is disposed without ever running.
    panel.dispose()

    // Then: the cover's URL goes back, and going back is idempotent.
    expect(deps.revoked).toEqual(['blob:fake/1'])
    expect(panel.imagePreviewUrl.value).toBeNull()
    panel.dispose()
    expect(deps.revoked).toEqual(['blob:fake/1'])
  })
})
