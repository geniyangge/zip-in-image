// Specs for the four presentational primitives. Written before the components
// exist, so the first run is expected to fail on unresolved imports.
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ByteOffset from '@/components/ByteOffset.vue'
import DropZone from '@/components/DropZone.vue'
import FieldRow from '@/components/FieldRow.vue'
import StatusPill from '@/components/StatusPill.vue'

/** Minimal stand-in for `DataTransfer`, which jsdom does not implement. */
interface TransferLike {
  readonly files: File[]
}

/** A real, dispatchable `drop` event carrying a stand-in `dataTransfer`. */
class DropEventStub extends Event {
  readonly dataTransfer: TransferLike

  constructor(files: File[]) {
    super('drop', { bubbles: true, cancelable: true })
    this.dataTransfer = { files }
  }
}

function makeFile(name: string, type: string): File {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name, { type })
}

/** Narrows an unknown `rejected` emit payload to its `reason` string. */
function reasonOf(payload: unknown): unknown {
  if (typeof payload === 'object' && payload !== null && 'reason' in payload) {
    return payload.reason
  }
  return payload
}

describe('setup', () => {
  beforeEach(() => {
    globalThis.objectUrlRecord.reset()
  })

  it('the object-URL API is usable inside the jsdom environment', () => {
    // Assert the CONTRACT, not one particular implementation.
    //
    // `test/setup/jsdom.ts` installs a `blob:mock/N` recorder, but only after probing
    // whether the ambient `URL` already implements the API -- deliberately refusing to
    // clobber a working one. Which branch runs depends on the environment: under
    // vitest + jsdom 29 the global `URL` resolves to Node's own implementation (jsdom
    // itself still does not provide `createObjectURL`), so the real one is used and the
    // URLs come back as `blob:nodedata:<uuid>`.
    //
    // An earlier version of this spec asserted the literal `blob:mock/1`, which tested
    // the mock rather than the requirement. Everything the panels actually rely on is
    // asserted below and holds under either implementation: the API exists, each blob
    // gets its own URL, and a URL can be revoked.
    expect(typeof URL.createObjectURL).toBe('function')
    expect(typeof URL.revokeObjectURL).toBe('function')

    const first = URL.createObjectURL(new Blob(['a']))
    const second = URL.createObjectURL(new Blob(['b']))

    expect(typeof first).toBe('string')
    expect(first).not.toBe(second)

    // Must not throw on a URL this environment actually issued.
    expect(() => URL.revokeObjectURL(first)).not.toThrow()
    URL.revokeObjectURL(second)
  })
})

describe('StatusPill', () => {
  it('renders ok, warn and error tones with distinct data-tone', () => {
    const tones = ['ok', 'warn', 'error'] as const
    const pills = tones.map((tone) =>
      mount(StatusPill, { props: { tone, label: `状态-${tone}` } }).get('[data-tone]'),
    )

    expect(pills.map((pill) => pill.attributes('data-tone'))).toEqual(['ok', 'warn', 'error'])
    expect(pills.map((pill) => pill.text())).toEqual(['状态-ok', '状态-warn', '状态-error'])
  })

  it('renders an idle state with no visible pill', () => {
    const pill = mount(StatusPill, { props: { tone: 'idle', label: '待机' } })

    expect(pill.find('[data-tone]').exists()).toBe(false)
    expect(pill.text()).toBe('')
  })
})

describe('ByteOffset', () => {
  it('renders the value in tabular numerals with thousands separators', () => {
    const offset = mount(ByteOffset, {
      props: { value: 1_234_567, label: 'ZIP 起始偏移' },
    })
    const value = offset.get('[data-testid="byte-offset-value"]')

    expect(value.text()).toBe('1,234,567')
    expect(value.classes()).toContain('mono')
    expect(offset.text()).toContain('ZIP 起始偏移')
  })

  it('renders 0 as a real value, not an empty state', () => {
    const offset = mount(ByteOffset, { props: { value: 0 } })
    const value = offset.get('[data-testid="byte-offset-value"]')

    expect(value.text()).toBe('0')
    expect(offset.find('[data-testid="byte-offset-empty"]').exists()).toBe(false)
  })
})

describe('DropZone', () => {
  it('renders an empty state with the accept hint', () => {
    const zone = mount(DropZone, {
      props: { accept: 'image/*', label: '选择封面图', hint: '仅接受 PNG / JPEG 图像' },
    })
    const empty = zone.get('[data-testid="dropzone-empty"]')
    const input = zone.get('input[type="file"]')

    expect(empty.text()).toContain('仅接受 PNG / JPEG 图像')
    expect(empty.text()).toContain('image/*')
    expect(input.attributes('accept')).toBe('image/*')
    expect(input.attributes('hidden')).toBeDefined()
  })

  it('emits files on drop and filters by accept', () => {
    const zone = mount(DropZone, { props: { accept: 'image/*', label: '选择封面图' } })
    const png = makeFile('cover.png', 'image/png')
    const zip = makeFile('payload.zip', 'application/zip')

    zone.get('[data-testid="dropzone"]').element.dispatchEvent(new DropEventStub([png, zip]))

    expect(zone.emitted('files')).toHaveLength(1)
    expect(zone.emitted('files')?.[0]?.[0]).toEqual([png])
    expect(zone.emitted('rejected')).toHaveLength(1)
    expect(reasonOf(zone.emitted('rejected')?.[0]?.[0])).toContain('payload.zip')
  })

  it('ignores a dropped file whose type is not accepted', () => {
    const zone = mount(DropZone, { props: { accept: '.zip', label: '选择压缩包' } })

    zone
      .get('[data-testid="dropzone"]')
      .element.dispatchEvent(new DropEventStub([makeFile('cover.png', 'image/png')]))

    expect(zone.emitted('files')).toBeUndefined()
    expect(zone.emitted('rejected')).toHaveLength(1)
    expect(reasonOf(zone.emitted('rejected')?.[0]?.[0])).toContain('cover.png')
  })

  it('opens the hidden file input on click and on keyboard Enter and Space', () => {
    const zone = mount(DropZone, { props: { accept: 'image/*', label: '选择封面图' } })
    const root = zone.get('[data-testid="dropzone"]')
    const inputElement = zone.get('input[type="file"]').element
    if (!(inputElement instanceof HTMLInputElement)) {
      throw new Error('DropZone must render a real <input type="file">')
    }
    const clickSpy = vi.spyOn(inputElement, 'click')
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })

    root.trigger('click')
    root.trigger('keydown', { key: 'Enter' })
    root.element.dispatchEvent(space)

    expect(clickSpy).toHaveBeenCalledTimes(3)
    // Space must be swallowed, otherwise the page scrolls behind the zone.
    expect(space.defaultPrevented).toBe(true)
  })

  it('applies inputId to the hidden file input so browser automation can target it', () => {
    // Given: a drop zone that names its picker.
    const zone = mount(DropZone, {
      props: { accept: 'image/*', label: '选择封面图', inputId: 'img-input' },
    })

    // When: the zone renders.
    // Then: the id lands on the <input type="file">, not on the decorative wrapper,
    // because that is the element a file has to be set on.
    expect(zone.find('input[type="file"]').attributes('id')).toBe('img-input')
    expect(zone.find('[data-testid="dropzone"]').attributes('id')).toBeUndefined()
  })
})

describe('FieldRow', () => {
  it('renders a label, a default slot and an optional hint', () => {
    const row = mount(FieldRow, {
      props: { label: '输出文件名', hint: '留空则沿用原名', forId: 'out-name' },
      slots: { default: '<input id="out-name" type="text">' },
    })
    const label = row.get('label')

    expect(label.text()).toBe('输出文件名')
    expect(label.attributes('for')).toBe('out-name')
    expect(row.get('#out-name').element.tagName).toBe('INPUT')
    expect(row.get('.hint').text()).toBe('留空则沿用原名')
  })
})
