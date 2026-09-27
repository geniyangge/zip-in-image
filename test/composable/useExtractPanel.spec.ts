// The extract panel's reactive contract, written before the composable exists.
//
// Node environment on purpose: this suite lives under `test/composable/**`, which
// `vitest.config.ts` maps to node, so there is no `window`, no `document` and no
// `createImageBitmap`. The file is read once into a Uint8Array, detection comes from
// `@/lib/zip`, and the image decoder and object-URL pair arrive as injected
// dependencies -- which is the only reason any of this is assertable off-browser.
import { describe, expect, it } from 'vitest'
import { useExtractPanel } from '@/composables/useExtractPanel'
import type { ImageDecoder, ImageProbe } from '@/lib/imageProbe'
import { naiveIndexOfPk } from '@/lib/zip'
import { makeJpegWithFakePk, makePng, makePrefixed, makeZip } from '../fixtures/bytes'

const textBytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0))

const ENTRIES = [{ name: 'notes.txt', data: textBytes('extracted payload') }]
const ZIP = makeZip(ENTRIES)
const PNG = makePng(24, 18)
const JPEG_WITH_DECOY = makeJpegWithFakePk()

/**
 * Node 18.16 has no global `File`, so what a file input hands over is emulated by
 * defining the one member the browser's `File` subclass adds. This is the file's ONLY
 * assertion site: the object really is a `Blob` and really does carry a `name`; it is
 * widened to the minimal shape the composable accepts, which is structural, so no
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
  /** Every blob the fake decoder was handed, in call order, so a probe can be attributed. */
  probed: Blob[]
  /** Re-arms the fake decoder for every later call. */
  setProbe: (probe: ImageProbe) => void
}

const OK_PROBE: ImageProbe = { ok: true, width: 24, height: 18, type: 'image/png' }
const BAD_PROBE: ImageProbe = { ok: false, reason: 'the blob could not be decoded as an image' }

/**
 * One macrotask turn. The whole-file probe is launched without being awaited -- `setFile`
 * stays awaitable for the bytes and the detection, and the preview follows -- so a spec
 * that asserts the resulting preview needs a real completion signal. A macrotask boundary
 * drains every microtask the probe chain is built from, which makes this a signal rather
 * than a sleep-and-hope.
 */
const settle = (): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, 0)
  })

/**
 * A decoder whose FIRST call never settles on its own and whose every later call answers
 * immediately.
 *
 * This reproduces the one hazard that matters for a whole-file preview: the browser
 * decoder is async, so loading A and then B can land A's verdict AFTER B's, and a panel
 * that applied whichever answer arrived last would show the discarded file under the
 * chosen name. Gating the first probe makes that ordering a fact of the test rather than a
 * race, and every later probe resolving instantly keeps the spec deterministic.
 */
function gateFirstProbe(probed: Blob[]): {
  decode: ImageDecoder
  settleFirst: (probe: ImageProbe) => void
} {
  let gate: ((probe: ImageProbe) => void) | null = null
  return {
    decode: (blob: Blob) => {
      probed.push(blob)
      if (gate === null) {
        return new Promise<ImageProbe>((resolve) => {
          gate = resolve
        })
      }
      return Promise.resolve(OK_PROBE)
    },
    settleFirst: (probe: ImageProbe) => {
      if (gate === null) throw new Error('no first probe is pending')
      gate(probe)
    },
  }
}

/**
 * A hermetic stand-in for the three injected dependencies. The decoder's verdict is
 * mutable so one panel can be shown both a decodable and an undecodable prefix, and the
 * ledgers make a revocation assertable without Node's own blob-URL registry.
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

describe('useExtractPanel', () => {
  it('reports no zip and enables manual offset for a pure image', async () => {
    // Given: a plain picture with nothing appended to it.
    const panel = useExtractPanel(fakeDeps())

    // When: it is loaded.
    await panel.setFile(namedBlob(PNG, 'holiday.png', 'image/png'))

    // Then: detection is honest -- there is no archive, and it says so.
    const found = panel.detection.value
    if (found === null) throw new Error('setFile must populate detection')
    expect(found.kind).toBe('none')
    expect(panel.tone.value).toBe('error')
    expect(panel.message.value).toContain('手动填写')
    expect(panel.offset.value).toBe(0)
    expect(panel.hasImagePrefix.value).toBe(false)
    expect(panel.bothValid.value).toBe(false)
    // And the manual-offset escape hatch is live: a "no archive" answer from an
    // automatic detector is exactly the case a human offset rescues.
    expect(panel.manualOffsetEnabled.value).toBe(true)
    expect(panel.manualOffset.value).toBe('0')

    panel.dispose()
  })

  it('auto-fills the detected offset and reports the prefix length for a disguised file', async () => {
    // Given: a real PNG with a real archive concatenated behind it.
    const disguised = makePrefixed(PNG, ZIP)
    const panel = useExtractPanel(fakeDeps())

    // When: it is loaded.
    await panel.setFile(namedBlob(disguised, 'holiday.png', 'image/png'))

    // Then: the offset is derived from the archive's own EOCD, not from the picture.
    const found = panel.detection.value
    if (found === null) throw new Error('setFile must populate detection')
    expect(found.kind).toBe('eocd')
    expect(panel.offset.value).toBe(PNG.length)
    expect(panel.prefixBytes.value).toBe(PNG.length)
    expect(panel.manualOffset.value).toBe(String(PNG.length))
    expect(panel.hasImagePrefix.value).toBe(true)
    // And both halves verify, so the panel is green.
    expect(panel.zipValidation.value?.ok).toBe(true)
    expect(panel.bothValid.value).toBe(true)
    expect(panel.tone.value).toBe('ok')
    // And the downloads are named from the source, the image keeping its own name.
    expect(panel.imageFileName.value).toBe('holiday.png')
    expect(panel.zipFileName.value).toBe('holiday.zip')
    // And the split is byte-exact in both directions.
    const split = panel.split()
    if (split === null) throw new Error('split() must return a result once a file is loaded')
    expect(split.offset).toBe(PNG.length)
    expect(split.image.size).toBe(PNG.length)
    expect(Buffer.from(await split.zip.arrayBuffer())).toEqual(Buffer.from(ZIP))
    expect(Buffer.from(await split.image.arrayBuffer())).toEqual(Buffer.from(PNG))

    panel.dispose()
  })

  it('manual offset overrides detection and revalidates the slice', async () => {
    // Given: a disguised file whose offset was detected correctly.
    const disguised = makePrefixed(PNG, ZIP)
    const panel = useExtractPanel(fakeDeps())
    await panel.setFile(namedBlob(disguised, 'holiday.png', 'image/png'))
    expect(panel.offset.value).toBe(PNG.length)

    // When: a wrong in-range offset is typed and applied.
    panel.manualOffset.value = '1'
    await panel.applyManualOffset()

    // Then: the working offset follows the input, and the slice there is re-verified --
    // one byte into the picture is not a central directory, and it must be reported.
    expect(panel.offset.value).toBe(1)
    expect(panel.prefixBytes.value).toBe(1)
    const wrong = panel.zipValidation.value
    if (wrong === null || wrong.ok) throw new Error('offset 1 must not validate as an archive')
    expect(wrong.reason).toBe('cd-signature-mismatch')
    expect(panel.bothValid.value).toBe(false)
    expect(panel.tone.value).toBe('error')

    // When: the right offset is typed back and applied.
    panel.manualOffset.value = String(PNG.length)
    await panel.applyManualOffset()

    // Then: it validates again and the panel recovers to green.
    expect(panel.offset.value).toBe(PNG.length)
    expect(panel.zipValidation.value?.ok).toBe(true)
    expect(panel.bothValid.value).toBe(true)
    expect(panel.tone.value).toBe('ok')

    panel.dispose()
  })

  it('clamps a negative or oversized manual offset instead of throwing', async () => {
    // Given: a disguised file, so the two clamps can be told apart by their result.
    const disguised = makePrefixed(PNG, ZIP)
    const panel = useExtractPanel(fakeDeps())
    await panel.setFile(namedBlob(disguised, 'holiday.png', 'image/png'))

    // When: a negative offset is applied.
    panel.manualOffset.value = '-5'
    await expect(panel.applyManualOffset()).resolves.toBeUndefined()

    // Then: clamped to 0, reported as a warning, and re-verified at 0 -- not thrown.
    expect(panel.offset.value).toBe(0)
    expect(panel.prefixBytes.value).toBe(0)
    expect(panel.hasImagePrefix.value).toBe(false)
    expect(panel.zipValidation.value?.offset).toBe(0)
    expect(panel.tone.value).toBe('warn')

    // When: an offset far past the end is applied.
    panel.manualOffset.value = String(disguised.length + 4096)
    await expect(panel.applyManualOffset()).resolves.toBeUndefined()

    // Then: clamped to the last usable byte -- a cut at the file length would put the
    // whole file in the image part and leave an empty archive.
    expect(panel.offset.value).toBe(disguised.length - 1)
    expect(panel.prefixBytes.value).toBe(disguised.length - 1)
    expect(panel.zipValidation.value?.offset).toBe(disguised.length - 1)
    expect(panel.tone.value).toBe('warn')
    // And the split stays usable at the clamped offset: degenerate, never thrown.
    const split = panel.split()
    if (split === null) throw new Error('split() must return a result once a file is loaded')
    expect(split.offset).toBe(disguised.length - 1)
    expect(split.zip.size).toBe(1)

    panel.dispose()
  })

  it('marks both parts valid only when the image prefix and the zip slice both verify', async () => {
    // Given: a disguised file and a decoder that approves of the prefix.
    const deps = fakeDeps()
    const panel = useExtractPanel(deps)
    await panel.setFile(namedBlob(makePrefixed(PNG, ZIP), 'holiday.png', 'image/png'))
    expect(panel.bothValid.value).toBe(true)

    // When: the prefix stops decoding and the panel re-checks the same offset through
    // the very path the UI uses when the user presses 应用.
    deps.setProbe(BAD_PROBE)
    await panel.applyManualOffset()

    // Then: the archive half is untouched and still good, but the pair is not valid --
    // one green half is not a green pair.
    expect(panel.zipValidation.value?.ok).toBe(true)
    expect(panel.imageProbe.value?.ok).toBe(false)
    expect(panel.hasImagePrefix.value).toBe(true)
    expect(panel.bothValid.value).toBe(false)
    expect(panel.tone.value).toBe('warn')

    // And at offset 0 there is no image to verify at all, whatever the decoder says.
    panel.manualOffset.value = '0'
    await panel.applyManualOffset()
    expect(panel.imageProbe.value).toBeNull()
    expect(panel.bothValid.value).toBe(false)

    panel.dispose()
  })

  it('warns rather than errors when the zip is valid but the prefix is not an image', async () => {
    // Given: a JPEG that hides a decoy local file header, with a real archive after it,
    // and a decoder that refuses it. The decoy is the whole point: a naive `PK` scan
    // lands inside the picture, and only the EOCD-anchored detection gets it right.
    const disguised = makePrefixed(JPEG_WITH_DECOY, ZIP)
    const deps = fakeDeps()
    deps.setProbe(BAD_PROBE)
    const panel = useExtractPanel(deps)

    // When: it is loaded.
    await panel.setFile(namedBlob(disguised, 'photo.jpg', 'image/jpeg'))

    // Then: detection is right anyway, and the slice validates.
    expect(panel.offset.value).toBe(JPEG_WITH_DECOY.length)
    expect(naiveIndexOfPk(disguised)).not.toBe(JPEG_WITH_DECOY.length)
    expect(panel.zipValidation.value?.ok).toBe(true)
    // And an undecodable prefix is a warning, not a failure: the archive is intact and
    // the file is very likely one this tool was never asked about.
    expect(panel.imageProbe.value?.ok).toBe(false)
    expect(panel.tone.value).toBe('warn')
    expect(panel.message.value).toContain('ZIP 有效')
    expect(panel.bothValid.value).toBe(false)
    // The recovered archive is still downloadable, which is the user's actual goal.
    const split = panel.split()
    if (split === null) throw new Error('split() must return a result once a file is loaded')
    expect(Buffer.from(await split.zip.arrayBuffer())).toEqual(Buffer.from(ZIP))

    panel.dispose()
  })

  it('clamps an out-of-range manual offset shows a warn pill, not an exception', async () => {
    // Given: a disguised file and its size, which is the bound the input is clamped to.
    const disguised = makePrefixed(PNG, ZIP)
    const file = namedBlob(disguised, 'holiday.png', 'image/png')
    const panel = useExtractPanel(fakeDeps())
    await panel.setFile(file)

    // When: a wildly out-of-range offset is applied.
    panel.manualOffset.value = '999999999'
    await expect(panel.applyManualOffset()).resolves.toBeUndefined()

    // Then: a warn pill naming the clamped value, and no exception and no NaN state.
    expect(panel.offset.value).toBe(file.size - 1)
    expect(panel.tone.value).toBe('warn')
    expect(panel.message.value).toContain('钳制')
    expect(panel.message.value).toContain(String(file.size - 1))
    // And unparseable input is handled the same way: reported, clamped, never thrown.
    panel.manualOffset.value = 'not a number'
    await expect(panel.applyManualOffset()).resolves.toBeUndefined()
    expect(panel.offset.value).toBe(0)
    expect(panel.tone.value).toBe('warn')
    expect(panel.message.value).toContain('not a number')

    panel.dispose()
  })

  it('shows a plain picture, which detection alone would leave invisible', async () => {
    // Given: a panel with nothing loaded, and a picture with no archive behind it.
    const deps = fakeDeps()
    const panel = useExtractPanel(deps)
    expect(panel.sourceSize.value).toBeNull()
    expect(panel.sourcePreviewUrl.value).toBeNull()

    // When: the picture is loaded.
    await panel.setFile(namedBlob(PNG, 'holiday.png', 'image/png'))
    await settle()

    // Then: the file is VISIBLE and its exact size is known, even though the panel's
    // verdict is still "no archive here" -- a user who picks a picture must SEE the
    // picture, not a filename and a red pill.
    expect(panel.sourceName.value).toBe('holiday.png')
    expect(panel.sourceSize.value).toBe(PNG.length)
    expect(panel.sourcePreviewUrl.value).toBe('blob:fake/1')
    expect(deps.created).toEqual(['blob:fake/1'])
    // Then: the existing prefix preview is untouched by this. At offset 0 there is no
    // prefix to show, which is precisely why the whole-file preview had to be a separate
    // value instead of a wider use of the existing one.
    expect(panel.previewUrl.value).toBeNull()
    expect(panel.tone.value).toBe('error')
  })

  it('previews a disguised file whole and its image prefix separately', async () => {
    // Given: a real picture with a real archive concatenated behind it.
    const disguised = makePrefixed(PNG, ZIP)
    const deps = fakeDeps()
    const panel = useExtractPanel(deps)

    // When: it is loaded.
    await panel.setFile(namedBlob(disguised, 'holiday.png', 'image/png'))
    await settle()

    // Then: two URLs, two different blobs, two different jobs.
    expect(panel.sourceSize.value).toBe(disguised.length)
    expect(panel.sourcePreviewUrl.value).toBe('blob:fake/1')
    expect(panel.previewUrl.value).toBe('blob:fake/2')
    // Then: exactly two probes, and which blob each one got is the whole point. The first
    // is the ENTIRE file -- legitimate and cheap, because a decoder stops at the picture's
    // end marker and simply ignores the archive behind it, so one probe of the whole file
    // answers "is this a picture" as well as it displays it. The second is the validated
    // PREFIX, which answers a different question ("is the part before the archive a real
    // picture") and is what the green pair verdict is computed from. The prefix is not
    // probed a second time for the display's sake: that would be a third decode of bytes
    // already in memory for no new information.
    expect(deps.probed.map((blob) => blob.size)).toEqual([disguised.length, PNG.length])

    panel.dispose()
  })

  it('applies a whole-file probe only while it is still the newest one', async () => {
    // Given: a decoder whose first probe is held open, so the hazard is reproducible.
    const deps = fakeDeps()
    const gated = gateFirstProbe(deps.probed)
    const panel = useExtractPanel({ ...deps, decode: gated.decode })

    // When: one picture is loaded and then immediately replaced by another, so the first
    // load's whole-file probe is still outstanding when the second one runs.
    void panel.setFile(namedBlob(PNG, 'first.png', 'image/png'))
    await panel.setFile(namedBlob(makePng(40, 30), 'second.png', 'image/png'))
    await settle()

    // Then: the newest selection owns the preview.
    expect(panel.sourceName.value).toBe('second.png')
    expect(panel.sourcePreviewUrl.value).toBe('blob:fake/1')

    // When: the discarded load's probe finally lands -- LAST, which is the hazard.
    gated.settleFirst(OK_PROBE)
    await settle()

    // Then: the preview still reflects the file that is actually selected, and the stale
    // verdict never created a URL at all, so it leaks nothing.
    expect(panel.sourceName.value).toBe('second.png')
    expect(panel.sourcePreviewUrl.value).toBe('blob:fake/1')
    expect(deps.created).toEqual(['blob:fake/1'])
    expect(deps.revoked).toEqual([])

    panel.dispose()
  })

  it('shows no source preview when the selected file is not a picture', async () => {
    // Given: a decoder that refuses everything, so the chosen bytes are not a picture.
    const deps = fakeDeps()
    deps.setProbe(BAD_PROBE)
    const panel = useExtractPanel(deps)

    // When: a bare archive is loaded -- the honest case, since a ZIP cannot be rendered.
    await panel.setFile(namedBlob(ZIP, 'payload.zip', 'application/zip'))
    await settle()

    // Then: the size is still known, but no URL was issued -- an <img> pointed at bytes
    // that cannot decode would render a broken-image icon.
    expect(panel.sourceSize.value).toBe(ZIP.length)
    expect(panel.sourcePreviewUrl.value).toBeNull()
    expect(deps.created).toEqual([])

    panel.dispose()
  })

  it('releases the source preview exactly once, on replace, on reset and on dispose', async () => {
    // Given: a loaded picture whose preview is on screen, and a second one.
    const deps = fakeDeps()
    const panel = useExtractPanel(deps)
    await panel.setFile(namedBlob(PNG, 'first.png', 'image/png'))
    await settle()
    expect(panel.sourcePreviewUrl.value).toBe('blob:fake/1')

    // When: it is replaced -- the outgoing file's URL goes back before the new one's is
    // issued, so the page never holds two.
    await panel.setFile(namedBlob(makePng(40, 30), 'second.png', 'image/png'))
    await settle()
    expect(deps.revoked).toEqual(['blob:fake/1'])
    expect(panel.sourcePreviewUrl.value).toBe('blob:fake/2')

    // When: the panel is reset.
    panel.reset()

    // Then: everything is handed back and the size reads as "nothing chosen" again.
    expect(deps.revoked).toEqual(['blob:fake/1', 'blob:fake/2'])
    expect(panel.sourcePreviewUrl.value).toBeNull()
    expect(panel.sourceSize.value).toBeNull()

    // And teardown is idempotent, as a double unmount would be.
    panel.dispose()
    panel.dispose()
    expect(deps.revoked).toEqual(['blob:fake/1', 'blob:fake/2'])
  })
})
