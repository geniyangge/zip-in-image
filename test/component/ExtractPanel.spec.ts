// Component specs for the extract panel.
//
// The panel calls `useExtractPanel()` with NO injected dependencies, on purpose: the
// production code stays free of a test-only `deps` prop. That means the real
// `browserImageDecoder` runs here, and it falls back to `new Image()` + an object URL
// whenever `createImageBitmap` is missing -- which jsdom does not implement, so its
// `onload`/`onerror` never fire and the probe promise never settles. Every await in
// this suite would then hang until the timeout. Stubbing the global is therefore not a
// convenience, it is what makes the real code path runnable: `browserImageDecoder`
// feature-detects the global at call time, so the stub exercises the real decoder.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ExtractPanel from '@/components/ExtractPanel.vue'
import DropZone from '@/components/DropZone.vue'
import { downloadBlob } from '@/lib/download'
import { formatBytes } from '@/lib/format'
import { makeJpegWithFakePk, makePng, makePrefixed, makeZip } from '../fixtures/bytes'

// Saving is the one side effect that must not reach the real filesystem/anchor API.
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }))

const ENTRIES = [{ name: 'notes.txt', data: Uint8Array.from([0x6f, 0x6b]) }]
const ZIP = makeZip(ENTRIES)
const PNG = makePng(96, 96)
const DECOY_JPEG = makeJpegWithFakePk()
const DISGUISED = makePrefixed(PNG, ZIP)

/**
 * `bytes` as a real `File`, which is structurally the `PickedFile` the composable
 * accepts, so no cast is needed anywhere. `Uint8Array.from` re-backs the view on a
 * plain `ArrayBuffer`: `BlobPart` accepts only a non-shared buffer view, and the
 * fixture builders declare the wide one.
 *
 * The one addition is `arrayBuffer()`: jsdom 24 ships a `Blob` without it, and it is the
 * single method `useExtractPanel` reads a file through -- the same class of host gap
 * `test/setup/jsdom.ts` patches for `URL.createObjectURL`. It is installed per instance
 * and answers with exactly the bytes the `File` was constructed from, so the file stays
 * byte-accurate; `name`, `type`, `size` and `slice` remain jsdom's real implementation,
 * which is what the panel and the composable actually exercise.
 */
function fileOf(bytes: Uint8Array, name: string, type: string): File {
  const file = new File([Uint8Array.from(bytes)], name, { type })
  return Object.defineProperty(file, 'arrayBuffer', {
    value: async (): Promise<ArrayBuffer> => Uint8Array.from(bytes).buffer,
  })
}

describe('ExtractPanel', () => {
  beforeEach(() => {
    // A 96x96 verdict, as a real `createImageBitmap` would report it. `close()` is
    // part of the real contract: the decoder calls it in a `finally`.
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 96, height: 96, close: vi.fn() })),
    )
  })

  afterEach(() => {
    // Undo the stub, so no later suite inherits a decoder that does not exist in jsdom.
    vi.unstubAllGlobals()
  })

  it('shows an empty state and a disabled manual offset field initially', () => {
    // Given: a freshly mounted panel.
    const panel = mount(ExtractPanel)

    // Then: it says what it wants, and every verdict is unknown.
    expect(panel.get('[data-testid="extract-empty"]').text()).toContain('还没有选择文件')
    // An unknown state is `tone: 'idle'`, and an idle pill renders nothing at all.
    expect(panel.find('[data-tone]').exists()).toBe(false)
    // The escape hatch is present but inert: there is no file to cut yet.
    expect(panel.get('#offset-input').attributes('disabled')).toBeDefined()
    expect(panel.get('#offset-input').attributes('inputmode')).toBe('numeric')
    expect(panel.get('#offset-apply').attributes('disabled')).toBeDefined()
    // And there is nothing to download yet.
    expect(panel.get('#zip-download').attributes('disabled')).toBeDefined()
    expect(panel.get('#image-download').attributes('disabled')).toBeDefined()
  })

  it('reports the detected offset, prefix length and zip integrity after a file is chosen', async () => {
    // Given: a real picture with a real archive concatenated behind it.
    const panel = mount(ExtractPanel)

    // When: it is chosen through the drop zone.
    panel.findComponent(DropZone).vm.$emit('files', [fileOf(DISGUISED, 'holiday.png', 'image/png')])
    await flushPromises()

    // Then: the archive start and the picture length agree, because the archive starts
    // exactly where the picture ends. Read as plain numbers: this suite asserts the
    // values, and `ByteOffset`'s own spec owns the thousands grouping.
    const readouts = panel
      .findAll('[data-testid="byte-offset-value"]')
      .map((node) => Number(node.text().replace(/,/g, '')))
    expect(readouts).toEqual([PNG.length, PNG.length])
    expect(panel.text()).toContain('压缩包起始偏移')
    expect(panel.text()).toContain('图片长度')
    expect(panel.get('[data-testid="extract-entries"]').text()).toContain(`压缩包条目 ${ENTRIES.length}`)
    // And the method is stated with its strength: an EOCD derivation is a fact, so the
    // readout is NOT the weaker "guessed by scan" variant.
    const readout = panel.get('[data-testid="extract-readout"]')
    expect(readout.attributes('data-certainty')).toBe('exact')
    expect(readout.text()).toContain('中央目录记录')
    // And both halves verified, so both the per-half pill and the overall verdict are ok.
    expect(panel.get('[data-testid="zip-pill"] [data-tone]').attributes('data-tone')).toBe('ok')
    expect(panel.get('[data-testid="image-pill"] [data-tone]').attributes('data-tone')).toBe('ok')
    expect(panel.get('[data-testid="extract-summary"] [data-tone]').attributes('data-tone')).toBe('ok')
  })

  it('shows a not-detected error pill plus an enabled manual offset field for a pure image', async () => {
    // Given: a picture with nothing appended to it.
    const panel = mount(ExtractPanel)

    // When: it is chosen.
    panel.findComponent(DropZone).vm.$emit('files', [fileOf(PNG, 'photo.png', 'image/png')])
    await flushPromises()

    // Then: the readout admits there is no evidence at all.
    const readout = panel.get('[data-testid="extract-readout"]')
    expect(readout.attributes('data-certainty')).toBe('absent')
    expect(readout.text()).toContain('未检测到')
    // And the failure is reported as an error pill, not as silence.
    expect(panel.findAll('[data-tone="error"]').length).toBeGreaterThan(0)
    expect(panel.get('[data-testid="extract-summary"]').text()).toContain('手动填写')
    // And the manual override is live: a detector saying "no archive" is a statement
    // about the file, and a hand-typed offset is exactly how that gets rescued.
    expect(panel.get('#offset-input').attributes('disabled')).toBeUndefined()
    expect(panel.get('#offset-apply').attributes('disabled')).toBeUndefined()
  })

  it('applying a manual offset re-runs validation and updates the reported prefix length', async () => {
    // Given: a disguised file whose offset was detected correctly.
    const panel = mount(ExtractPanel)
    panel.findComponent(DropZone).vm.$emit('files', [fileOf(DISGUISED, 'holiday.png', 'image/png')])
    await flushPromises()
    expect(panel.findAll('[data-testid="byte-offset-value"]').map((n) => Number(n.text().replace(/,/g, '')))).toEqual([
      PNG.length,
      PNG.length,
    ])

    // When: an in-range offset one byte into the picture is typed and applied.
    await panel.get('#offset-input').setValue('1')
    await panel.get('#offset-apply').trigger('click')
    await flushPromises()

    // Then: both readouts follow the input, and the slice there is re-verified -- one
    // byte into a PNG is not a central directory, and the panel has to say so.
    expect(panel.findAll('[data-testid="byte-offset-value"]').map((n) => Number(n.text().replace(/,/g, '')))).toEqual([1, 1])
    expect(panel.get('[data-testid="zip-pill"] [data-tone]').attributes('data-tone')).toBe('error')
    expect(panel.get('[data-testid="extract-summary"] [data-tone]').attributes('data-tone')).toBe('error')

    // And: typing the real offset back recovers, so the override is re-applied every
    // time rather than latched.
    await panel.get('#offset-input').setValue(String(PNG.length))
    await panel.get('#offset-apply').trigger('click')
    await flushPromises()
    expect(panel.findAll('[data-testid="byte-offset-value"]').map((n) => Number(n.text().replace(/,/g, '')))).toEqual([
      PNG.length,
      PNG.length,
    ])
    expect(panel.get('[data-testid="zip-pill"] [data-tone]').attributes('data-tone')).toBe('ok')
    expect(panel.get('[data-testid="extract-summary"] [data-tone]').attributes('data-tone')).toBe('ok')
  })

  it('clamping an out-of-range manual offset shows a warn pill, not an exception', async () => {
    // Given: a disguised file and its size, which is the bound the input is clamped to.
    const file = fileOf(DISGUISED, 'holiday.png', 'image/png')
    const panel = mount(ExtractPanel)
    panel.findComponent(DropZone).vm.$emit('files', [file])
    await flushPromises()

    // When: an offset far past the end of the file is applied. Vue swallows a throw
    // from an event handler, so the evidence that nothing threw is the state below.
    await panel.get('#offset-input').setValue('999999999')
    await panel.get('#offset-apply').trigger('click')
    await flushPromises()

    // Then: clamped to the last usable byte -- a cut at the file length would put the
    // whole file in the picture -- and reported as a warning naming that value.
    expect(panel.findAll('[data-testid="byte-offset-value"]').map((n) => Number(n.text().replace(/,/g, '')))).toEqual([
      file.size - 1,
      file.size - 1,
    ])
    expect(panel.get('[data-testid="extract-summary"] [data-tone]').attributes('data-tone')).toBe('warn')
    expect(panel.get('[data-testid="extract-summary"]').text()).toContain('钳制')

    // And non-numeric text is no exception either. A `type="number"` control sanitizes
    // it away, so the field applies 0 -- an in-range offset, therefore no clamp notice
    // and no NaN in the readouts, just an honest "not an archive" verdict.
    await panel.get('#offset-input').setValue('not a number')
    await panel.get('#offset-apply').trigger('click')
    await flushPromises()
    expect(panel.findAll('[data-testid="byte-offset-value"]').map((n) => Number(n.text().replace(/,/g, '')))).toEqual([0, 0])
    expect(panel.get('[data-testid="extract-summary"] [data-tone]').attributes('data-tone')).toBe('error')
  })

  it('marks both parts valid only when the image prefix and the zip slice verify', async () => {
    // Given: a disguised file and a decoder that approves of the prefix.
    const panel = mount(ExtractPanel)
    panel.findComponent(DropZone).vm.$emit('files', [fileOf(DISGUISED, 'holiday.png', 'image/png')])
    await flushPromises()

    // Then: both halves verified, so the overall verdict is green and both downloads live.
    expect(panel.get('[data-testid="zip-pill"] [data-tone]').attributes('data-tone')).toBe('ok')
    expect(panel.get('[data-testid="image-pill"] [data-tone]').attributes('data-tone')).toBe('ok')
    expect(panel.get('[data-testid="extract-summary"] [data-tone]').attributes('data-tone')).toBe('ok')
    expect(panel.get('#zip-download').attributes('disabled')).toBeUndefined()
    expect(panel.get('#image-download').attributes('disabled')).toBeUndefined()

    // When: the very same offset is re-checked against a decoder that now refuses the
    // prefix -- the path the UI takes when the user presses 应用.
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not an image'))))
    await panel.get('#offset-input').setValue(String(PNG.length))
    await panel.get('#offset-apply').trigger('click')
    await flushPromises()

    // Then: the archive half is untouched, but one green half is not a green pair.
    expect(panel.get('[data-testid="zip-pill"] [data-tone]').attributes('data-tone')).toBe('ok')
    expect(panel.get('[data-testid="image-pill"] [data-tone]').attributes('data-tone')).toBe('warn')
    expect(panel.get('[data-testid="extract-summary"] [data-tone]').attributes('data-tone')).toBe('warn')

    // And at offset 0 there is no picture at all, whatever the decoder says: the
    // download is disabled and the panel says why.
    await panel.get('#offset-input').setValue('0')
    await panel.get('#offset-apply').trigger('click')
    await flushPromises()
    expect(panel.get('#image-download').attributes('disabled')).toBeDefined()
    expect(panel.text()).toContain('没有图片')
  })

  it('warns rather than errors when the zip is valid but the prefix is not an image', async () => {
    // Given: a JPEG hiding a decoy local file header with a real archive behind it, and
    // a decoder that refuses the prefix. The decoy is the point: a naive `PK` scan lands
    // inside the picture, so only the EOCD-anchored detection gets this right.
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('前缀无法解码'))))
    const disguised = makePrefixed(DECOY_JPEG, ZIP)
    const panel = mount(ExtractPanel)

    // When: it is chosen.
    panel.findComponent(DropZone).vm.$emit('files', [fileOf(disguised, 'photo.jpg', 'image/jpeg')])
    await flushPromises()

    // Then: the archive is intact and exactly located anyway.
    expect(panel.findAll('[data-testid="byte-offset-value"]').map((n) => Number(n.text().replace(/,/g, '')))).toEqual([
      DECOY_JPEG.length,
      DECOY_JPEG.length,
    ])
    expect(panel.get('[data-testid="zip-pill"] [data-tone]').attributes('data-tone')).toBe('ok')
    // So the verdict is a warning and never an error -- the file is intact, it is just
    // not a picture in front.
    expect(panel.find('[data-testid="extract-summary"] [data-tone="error"]').exists()).toBe(false)
    expect(panel.get('[data-testid="extract-summary"] [data-tone]').attributes('data-tone')).toBe('warn')
    expect(panel.get('[data-testid="extract-summary"]').text()).toContain('ZIP 有效')
    // And the archive the user actually came for is still delivered, byte-exact.
    expect(panel.get('#zip-download').attributes('disabled')).toBeUndefined()
    await panel.get('#zip-download').trigger('click')
    const call = vi.mocked(downloadBlob).mock.calls[0]
    if (call === undefined) throw new Error('下载按钮必须调用 downloadBlob')
    expect(call[1]).toBe('photo.zip')
    expect(call[0].size).toBe(ZIP.length)
  })

  it('shows the selected file, so a plain picture is visible with nothing appended', async () => {
    // Given: a panel with nothing chosen.
    const panel = mount(ExtractPanel)

    // Then: no picked-file card at all -- the empty paragraph below is what speaks here,
    // and a card reporting "nothing chosen" beside it would say the same thing twice.
    expect(panel.find('[data-testid="extract-source-name"]').exists()).toBe(false)

    // When: a plain picture is chosen, with no archive behind it -- the case where the
    // detector's own verdict is an error and the offset stays at 0.
    panel.findComponent(DropZone).vm.$emit('files', [fileOf(PNG, 'photo.png', 'image/png')])
    await flushPromises()

    // Then: the picture is ON SCREEN, with a real alt and its exact size. Before this, a
    // user who picked a photograph saw a filename and a red pill and no photograph.
    const img = panel.get('img')
    expect(img.attributes('alt')).toBe('photo.png')
    expect(img.attributes('src')).toMatch(/^blob:/)
    expect(panel.get('[data-testid="extract-source-name"]').text()).toBe('photo.png')
    expect(panel.get('[data-testid="picked-size"]').text()).toBe(formatBytes(PNG.length))
    // Then: the verdict is untouched. Seeing the file says nothing about whether an
    // archive is hidden behind it, and a preview is not a claim that one is.
    expect(panel.findAll('[data-tone="error"]').length).toBeGreaterThan(0)
    expect(panel.get('[data-testid="extract-readout"]').attributes('data-certainty')).toBe('absent')
  })

  it('describes a chosen file it cannot draw instead of showing a broken image', async () => {
    // Given: a decoder that refuses everything, so the chosen bytes are not a picture.
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('不是图片'))))
    const panel = mount(ExtractPanel)

    // When: a bare archive is chosen.
    panel.findComponent(DropZone).vm.$emit('files', [fileOf(ZIP, 'payload.zip', 'application/zip')])
    await flushPromises()

    // Then: the name and the size are on the card, and there is no <img> anywhere -- an
    // image pointed at ZIP bytes would render the browser's broken-image icon, which in a
    // tool that has not failed looks exactly like a failure.
    expect(panel.find('img').exists()).toBe(false)
    expect(panel.get('[data-testid="extract-source-name"]').text()).toBe('payload.zip')
    expect(panel.get('[data-testid="picked-size"]').text()).toBe(formatBytes(ZIP.length))
    expect(panel.find('svg.glyph').exists()).toBe(true)
  })

  it('exposes stable ids used by the browser QA script', async () => {
    // Given: a mounted panel.
    const panel = mount(ExtractPanel)
    const ids = ['#disguised-input', '#offset-input', '#offset-apply', '#zip-download', '#image-download']

    // Then: every hook the QA script drives resolves in the empty state ...
    for (const id of ids) expect(panel.find(id).exists()).toBe(true)

    // ... and still resolves after a file is loaded, so the script can re-query.
    panel.findComponent(DropZone).vm.$emit('files', [fileOf(DISGUISED, 'holiday.png', 'image/png')])
    await flushPromises()
    for (const id of ids) expect(panel.find(id).exists()).toBe(true)

    // And the picker's id sits on the real <input type="file">: that is the only element
    // a file can be set on, and the decorative wrapper must not shadow it.
    const picker = panel.get('#disguised-input')
    expect(picker.element.tagName).toBe('INPUT')
    expect(picker.attributes('type')).toBe('file')
  })
})
