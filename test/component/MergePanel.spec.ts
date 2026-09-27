// MergePanel's rendered contract, written before the component exists.
//
// This suite lives under test/component/**, which vitest.config.ts maps to jsdom --
// that mapping is the point. The panel deliberately wires the REAL browser image
// decoder (no `deps` prop, no injected fake), so the render path has to survive a DOM
// that implements neither `createImageBitmap` nor image loading. The global is stubbed
// per test instead, which keeps production code free of any test-only API and still
// exercises the real decoder, the real merge and the real object-URL plumbing.
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import DropZone from '@/components/DropZone.vue'
import MergePanel from '@/components/MergePanel.vue'
import PickedFileCard from '@/components/PickedFileCard.vue'
import { downloadBlob } from '@/lib/download'
import { formatBytes } from '@/lib/format'
import { makePng, makeZip } from '../fixtures/bytes'

// The panel's only outbound side effect that is not DOM rendering, so it is faked
// at the module boundary rather than by watching the anchor a real download builds.
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }))

const textBytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0))

// Large enough that thousands grouping is actually visible in the rendered readouts
// (a 96x96 cover compresses below 1000 bytes, which would make a separator assertion
// pass vacuously). Both sizes are byte-stable across runs, so the exact numbers below
// are fixed facts about the fixture, not guesses.
const PNG_BYTES = makePng(256, 256)
const ZIP_BYTES = makeZip([{ name: 'a.txt', data: textBytes('伪装文件里的第一个条目') }])

const COVER_NAME = 'photo.png'
const PAYLOAD_NAME = 'payload.zip'

/**
 * `bytes` as a `File`. `Uint8Array.from` re-backs the view on a plain `ArrayBuffer`:
 * the fixture builders declare the wide `Uint8Array<ArrayBufferLike>`, while `BlobPart`
 * accepts only a non-shared buffer view. The copy is free -- `File` copies the bytes
 * into its own store on construction anyway. Same reasoning as the node-side fixture
 * helper in test/composable/useMergePanel.spec.ts.
 */
const fileOf = (bytes: Uint8Array, name: string, type: string): File =>
  new File([Uint8Array.from(bytes)], name, { type })

const pngFile = (): File => fileOf(PNG_BYTES, COVER_NAME, 'image/png')
const zipFile = (name = PAYLOAD_NAME): File => fileOf(ZIP_BYTES, name, 'application/zip')

/** The reason the fake decoder reports, so the pill's text can be pinned to it. */
const UNREADABLE = '封面图的字节流不是可识别的图像'

/**
 * jsdom 24 ships `Blob`/`File` with NO byte-reading members: `arrayBuffer()`,
 * `text()` and `stream()` are all absent on the prototype (verified against the
 * installed version). Node 18's native Blob has all three, which is exactly why
 * `test/unit/**` and `test/composable/**` -- the suites that actually merge -- never
 * notice. `useMergePanel` reads the archive's first four bytes with
 * `slice().arrayBuffer()`, so this suite installs the one member it needs.
 *
 * Guarded in both directions: a host that already implements `arrayBuffer` keeps its
 * own, and the patch is removed again in `afterEach` so no later suite can inherit it.
 * This is an environment shim, not a test seam in the panel -- the component still
 * runs the real composable against the real jsdom Blob.
 */
const needsArrayBufferShim = typeof Blob.prototype.arrayBuffer !== 'function'

function installArrayBufferShim(): void {
  if (!needsArrayBufferShim) return
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    // `FileReader` is jsdom's own byte reader, so the shim stays inside the DOM
    // implementation instead of reaching for a Node-only buffer API.
    value: function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = (): void => {
          const { result } = reader
          if (!(result instanceof ArrayBuffer)) {
            reject(new Error('FileReader did not produce an ArrayBuffer for the blob'))
            return
          }
          resolve(result)
        }
        reader.onerror = (): void => {
          reject(reader.error ?? new Error('FileReader failed to read the blob'))
        }
        reader.readAsArrayBuffer(this)
      })
    },
  })
}

const mounted: VueWrapper[] = []

function render(): VueWrapper {
  const wrapper = mount(MergePanel)
  mounted.push(wrapper)
  return wrapper
}

/**
 * The panel's own slot order IS the contract -- cover image first, archive second --
 * so specs address the two drop zones by position and a reordered panel fails them.
 */
function dropZoneAt(wrapper: VueWrapper, index: number): VueWrapper {
  const zone = wrapper.findAllComponents(DropZone)[index]
  if (zone === undefined) throw new Error(`MergePanel must render a drop zone at index ${index}`)
  return zone
}

async function chooseBoth(wrapper: VueWrapper): Promise<void> {
  dropZoneAt(wrapper, 0).vm.$emit('files', [pngFile()])
  dropZoneAt(wrapper, 1).vm.$emit('files', [zipFile()])
  await nextTick()
}

/**
 * Clicks the primary action, then waits for the panel to leave its busy state.
 *
 * `run()` finishes across two different clocks: the merge itself is a microtask
 * chain, but reading the archive's first four bytes goes through `FileReader`, which
 * is task-based. A single `flushPromises()` is therefore provably too early here, and
 * a fixed sleep would be a guess. Waiting on the panel's own rendered busy flag is
 * the observable completion signal, so this is deterministic and still has a bound.
 */
async function clickRun(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('#merge-run').trigger('click')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!wrapper.find('[data-testid="merge-busy"]').exists()) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  }
  throw new Error('the merge never left its busy state')
}

describe('MergePanel', () => {
  beforeEach(() => {
    installArrayBufferShim()
    // The real `browserImageDecoder` feature-detects this global on every call, so
    // stubbing it here drives the real decode path. jsdom implements neither this
    // nor `new Image()` loading, so without a stub `run()` never settles.
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 256, height: 256, close: vi.fn() })),
    )
    globalThis.objectUrlRecord.reset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (needsArrayBufferShim) {
      Reflect.deleteProperty(Blob.prototype, 'arrayBuffer')
    }
    // Unmounting is what revokes the preview object URL (onUnmounted -> dispose), so
    // a spec that ran a merge must not leave a live blob URL behind for the next one.
    mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  })

  it('shows an empty state before any file is chosen', () => {
    // Given: a panel that has just mounted.
    const wrapper = render()

    // When: nothing has happened.
    // Then: the empty state says what the product is and names both inputs, so the
    // panel is never a blank void with two mystery boxes in it.
    const empty = wrapper.get('[data-testid="merge-empty"]')
    expect(empty.text()).toContain('打开是图片')
    expect(empty.text()).toContain('.zip')
    expect(empty.text()).toContain('封面图片')
    expect(empty.text()).toContain('压缩包')

    // Then: both input slots are on screen, the primary action is off, and there is
    // no result card or preview image to look at yet.
    expect(wrapper.findAllComponents(DropZone)).toHaveLength(2)
    expect(wrapper.get('#merge-run').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#merge-download').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="merge-result"]').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('disables run until one image and one zip are chosen', async () => {
    // Given: a panel with nothing chosen.
    const wrapper = render()
    const runButton = wrapper.get('#merge-run')

    // Then: the button is off in both senses, and a Chinese sentence explains it --
    // never a dead control with no reason.
    expect(runButton.attributes('disabled')).toBeDefined()
    expect(runButton.attributes('aria-disabled')).toBe('true')
    expect(wrapper.get('[data-testid="merge-disabled-reason"]').text()).toBe('请先选择一张封面图。')

    // When: only the cover image is chosen.
    dropZoneAt(wrapper, 0).vm.$emit('files', [pngFile()])
    await nextTick()

    // Then: still off, and the reason now names the half that is missing.
    expect(runButton.attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="merge-disabled-reason"]').text()).toBe('请再选择一个 ZIP 压缩包。')

    // When: the archive is chosen as well.
    dropZoneAt(wrapper, 1).vm.$emit('files', [zipFile()])
    await nextTick()

    // Then: live in both senses, and there is nothing left to explain.
    expect(runButton.attributes('disabled')).toBeUndefined()
    expect(runButton.attributes('aria-disabled')).toBe('false')
    expect(wrapper.find('[data-testid="merge-disabled-reason"]').exists()).toBe(false)
  })

  it('renders the output filename with the image original extension', async () => {
    // Given: a cover and an archive.
    const wrapper = render()
    await chooseBoth(wrapper)

    // When: the merge runs.
    await clickRun(wrapper)

    // Then: the output keeps the cover's own name, extension included, because
    // rewriting it to .zip would advertise exactly what the file is.
    const fileName = wrapper.get('[data-testid="merge-output-name"]').text()
    expect(fileName).toBe('photo.png')
    expect(fileName.endsWith('.png')).toBe(true)
    expect(fileName.endsWith('.zip')).toBe(false)
  })

  it('renders byte sizes in tabular numerals', async () => {
    // Given: a cover and an archive, merged.
    const wrapper = render()
    await chooseBoth(wrapper)
    await clickRun(wrapper)

    // Then: exactly three readouts, in the order the card lists them -- which is why
    // their Chinese labels are asserted here: the positional byte check below is
    // only meaningful if each value is known to belong to the labelled row.
    expect(wrapper.get('[data-testid="merge-result"]').text()).toContain('图片字节')
    expect(wrapper.get('[data-testid="merge-result"]').text()).toContain('压缩包字节')
    expect(wrapper.get('[data-testid="merge-result"]').text()).toContain('合计字节')

    const values = wrapper.findAll('[data-testid="byte-offset-value"]')
    expect(values).toHaveLength(3)
    const [imageText, payloadText, totalText] = values.map((value) => value.text())
    if (imageText === undefined || payloadText === undefined || totalText === undefined) {
      throw new Error('the result card must render exactly three byte readouts')
    }

    // Then: every readout is a grouped, digits-only number...
    for (const text of [imageText, payloadText, totalText]) {
      expect(text).toMatch(/^\d{1,3}(,\d{3})*$/)
    }
    // ...carrying the tabular-numerals hook the utility layer defines...
    for (const value of values) {
      expect(value.classes()).toContain('mono')
    }
    // ...with a separator that is actually visible, not a pattern that never fires:
    // the cover alone is over 999 bytes, so the grouping is observable.
    expect(PNG_BYTES.length).toBeGreaterThan(999)
    expect(imageText).toContain(',')
    // ...and the digits under the separators are the real byte counts, totalling
    // the two inputs rather than restating either one.
    const ungrouped = (text: string): number => Number(text.replace(/,/g, ''))
    expect(ungrouped(imageText)).toBe(PNG_BYTES.length)
    expect(ungrouped(payloadText)).toBe(ZIP_BYTES.length)
    expect(ungrouped(totalText)).toBe(PNG_BYTES.length + ZIP_BYTES.length)
  })

  it('renders a warn StatusPill when the image cannot be decoded', async () => {
    // Given: a cover the real decoder cannot decode -- the fake global rejects, and
    // `toProbe` in @/lib/imageProbe turns that rejection into a failed probe.
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error(UNREADABLE))))
    const wrapper = render()
    await chooseBoth(wrapper)

    // When: the merge runs anyway -- concatenation never needed the cover to be a
    // picture, so this is a warning and not a failure.
    await clickRun(wrapper)

    // Then: the pill warns and names the reason, rather than reporting a success the
    // user cannot trust or an error that did not happen.
    const pill = wrapper.get('[data-tone="warn"]')
    expect(pill.text()).toContain(UNREADABLE)
    expect(wrapper.find('[data-tone="error"]').exists()).toBe(false)

    // Then: the output still exists -- only the picture inside it is unrecognisable.
    expect(wrapper.find('[data-testid="merge-result"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="merge-output-name"]').text()).toBe('photo.png')
  })

  it('clicking download emits a downloadBlob call with the merged blob and the image filename', async () => {
    // Given: a panel that has produced nothing yet.
    const wrapper = render()
    const downloadButton = wrapper.get('#merge-download')
    expect(downloadButton.attributes('disabled')).toBeDefined()

    // When: a cover and an archive are chosen and merged.
    await chooseBoth(wrapper)
    await clickRun(wrapper)

    // Then: the action is a real <button>, so Enter and Space reach it natively --
    // no synthetic key handling to keep in sync.
    expect(downloadButton.element.tagName).toBe('BUTTON')
    expect(downloadButton.attributes('disabled')).toBeUndefined()
    await downloadButton.trigger('click')

    // Then: exactly one download, carrying the image's own filename.
    const calls = vi.mocked(downloadBlob).mock.calls
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error('clicking download must call downloadBlob')
    const [blob, fileName] = call
    expect(fileName).toBe('photo.png')

    // Then: the blob is the MERGED file rather than either input -- cover bytes
    // first, then the archive, for a total that is neither file on its own.
    expect(blob.size).toBe(PNG_BYTES.length + ZIP_BYTES.length)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(Buffer.from(bytes.subarray(0, PNG_BYTES.length))).toEqual(Buffer.from(PNG_BYTES))
    expect(Buffer.from(bytes.subarray(PNG_BYTES.length))).toEqual(Buffer.from(ZIP_BYTES))
  })

  it('rejects a second zip selection with an inline message', async () => {
    // Given: a panel holding a cover and already holding one archive.
    const wrapper = render()
    const archiveZone = dropZoneAt(wrapper, 1)
    dropZoneAt(wrapper, 0).vm.$emit('files', [pngFile()])
    archiveZone.vm.$emit('files', [zipFile()])
    await nextTick()
    expect(wrapper.get('#merge-run').attributes('disabled')).toBeUndefined()

    // When: a second archive is offered.
    archiveZone.vm.$emit('files', [zipFile('other.zip')])
    await nextTick()

    // Then: refused inline, in one sentence that explains why -- concatenating two
    // archives would leave two end-of-central-directory records and orphan the first.
    const notice = wrapper.get('[data-testid="merge-notice"]')
    expect(notice.text()).toContain('只接受一个压缩包')

    // Then: the pill agrees with the inline notice -- a tone and its sentence are
    // derived together, so they can never contradict each other.
    expect(wrapper.get('[data-tone="error"]').text()).toBe(notice.text())

    // Then: the first archive is still the one held, and the run action is still
    // live, so the user is not stranded by the refusal.
    expect(wrapper.get('[data-testid="merge-payload-name"]').text()).toBe('payload.zip')
    expect(wrapper.get('#merge-run').attributes('disabled')).toBeUndefined()
  })

  it('shows the picked cover and archive the moment they are chosen', async () => {
    // Given: a panel with nothing chosen. The card order is part of the contract, exactly
    // as the drop zones' order is: cover first, archive second.
    const wrapper = render()
    const cardAt = (index: number): VueWrapper => {
      const card = wrapper.findAllComponents(PickedFileCard)[index]
      if (card === undefined) throw new Error(`MergePanel must render a picked-file card at index ${index}`)
      return card
    }

    // Then: both slots say that nothing is chosen, and there is no image anywhere -- an
    // empty state with a broken-image icon in it reads as a failure that did not happen.
    expect(cardAt(0).get('[data-testid="merge-image-name"]').text()).toBe('尚未选择')
    expect(cardAt(1).get('[data-testid="merge-payload-name"]').text()).toBe('尚未选择')
    expect(wrapper.find('img').exists()).toBe(false)

    // When: the cover is chosen. Nothing is merged, and no button has been pressed.
    dropZoneAt(wrapper, 0).vm.$emit('files', [pngFile()])
    await flushPromises()

    // Then: THE PICTURE IS VISIBLE -- the whole point of the feature. The `<img>` carries a
    // real alt, because a filename is the only honest description of a picture nothing
    // here has looked inside.
    const cover = cardAt(0)
    const thumb = cover.get('img')
    const coverSrc = thumb.attributes('src')
    expect(thumb.attributes('alt')).toBe(COVER_NAME)
    expect(coverSrc).toMatch(/^blob:/)
    // Then: its exact size, formatted by `@/lib/format` (whose own rules this suite does not
    // re-test -- asserting the wiring is the point here, and the digits are that unit's).
    // And this card carries the COVER's testid, not the archive's, so the two slots cannot
    // be silently swapped without a spec failing.
    expect(cover.get('[data-testid="merge-image-name"]').text()).toBe(COVER_NAME)
    expect(cover.find('[data-testid="merge-payload-name"]').exists()).toBe(false)
    expect(cover.get('[data-testid="picked-size"]').text()).toBe(formatBytes(PNG_BYTES.length))
    // Then: the archive slot is untouched, and the cover's thumbnail is the only image on
    // screen.
    expect(cardAt(1).get('[data-testid="merge-payload-name"]').text()).toBe('尚未选择')
    expect(wrapper.findAll('img')).toHaveLength(1)

    // When: the archive is chosen as well.
    dropZoneAt(wrapper, 1).vm.$emit('files', [zipFile()])
    await flushPromises()

    // Then: the cover picture is STILL the one on screen, with the same URL. Swapping the
    // archive is not a reason to blank the picture the user already picked.
    expect(cardAt(0).get('img').attributes('src')).toBe(coverSrc)
    // Then: the archive is described rather than drawn -- a ZIP cannot be rendered, so it
    // gets a glyph and its facts instead of a broken image.
    const archive = cardAt(1)
    expect(archive.get('[data-testid="merge-payload-name"]').text()).toBe(PAYLOAD_NAME)
    expect(archive.get('[data-testid="picked-size"]').text()).toBe(formatBytes(ZIP_BYTES.length))
    expect(archive.find('img').exists()).toBe(false)
    expect(archive.find('svg.glyph').exists()).toBe(true)
    expect(archive.attributes('data-kind')).toBe('archive')
  })

  it('exposes stable ids used by the browser QA script', () => {
    // Given: a freshly mounted panel -- the state the browser QA script opens on.
    const wrapper = render()

    // Then: all four automation targets resolve, each as the element kind a script
    // can actually drive.
    for (const id of ['img-input', 'zip-input', 'merge-run', 'merge-download']) {
      if (!wrapper.find(`#${id}`).exists()) throw new Error(`MergePanel must expose #${id}`)
    }
    // Then: the two picker ids land on real <input type="file"> elements, because a
    // file has to be set on the input itself -- the drop zone cannot take one.
    expect(wrapper.get('#img-input').element.tagName).toBe('INPUT')
    expect(wrapper.get('#img-input').attributes('type')).toBe('file')
    expect(wrapper.get('#zip-input').element.tagName).toBe('INPUT')
    expect(wrapper.get('#zip-input').attributes('type')).toBe('file')
    // Then: the two actions are buttons, reachable by Tab and activated by Enter.
    expect(wrapper.get('#merge-run').element.tagName).toBe('BUTTON')
    expect(wrapper.get('#merge-run').attributes('type')).toBe('button')
    expect(wrapper.get('#merge-download').element.tagName).toBe('BUTTON')
    expect(wrapper.get('#merge-download').attributes('type')).toBe('button')
  })
})
