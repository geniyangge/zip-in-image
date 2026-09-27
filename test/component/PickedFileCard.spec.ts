// The picked-file card: the one place a chosen file becomes visible.
//
// Three slots in the app show a picked file (merge cover, merge archive, extract source),
// and this component is what all three render. Keeping it single-purpose is the point: a
// card that behaves differently per call site is three cards with a shared filename.
//
// This suite runs under jsdom, and jsdom applies no CSS at all (vitest stubs style blocks
// out), so nothing here can assert a width, a line count or a colour. What it DOES pin is
// everything the DOM can answer, and one of those is load-bearing beyond this repo:
// `scripts/browser-qa.mjs` measures `[data-testid="merge-image-name"]` by taking
// `element.firstChild` and requiring it to be a single TEXT_NODE -- it then censuses that
// text character by character to catch a CJK orphan such as the `尚未选 / 择` this app
// already had once. A name element with any other child shape makes the QA script report
// "no single text node" and fail, so that contract is asserted here rather than discovered
// by a browser run.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PickedFileCard from '@/components/PickedFileCard.vue'

/** The props every spec needs, overridable per case. */
const BASE = {
  name: 'photo.png',
  size: 25662,
  previewUrl: null,
  kind: 'image',
  placeholder: '尚未选择',
} as const

describe('PickedFileCard', () => {
  it('shows the placeholder as a single unbroken text node when nothing is chosen', () => {
    // Given: an empty slot.
    const card = mount(PickedFileCard, {
      props: { ...BASE, name: null, size: null, kind: 'archive', testid: 'merge-payload-name' },
    })

    // Then: the placeholder stands in for the name -- the slot is never blank, because a
    // drop zone with nothing under it reads as a broken control.
    const name = card.get('[data-testid="merge-payload-name"]')
    expect(name.text()).toBe('尚未选择')
    // Then: it is ONE text node and nothing else. This is the shape the browser QA script
    // measures; a nested element, a leading space or a sibling would make its census
    // unmeasurable rather than merely different.
    expect(name.element.childNodes).toHaveLength(1)
    expect(name.element.firstChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(name.element.firstChild?.textContent).toBe('尚未选择')
    // Then: no size is claimed, because none is known. An em dash or a `0 B` here would
    // both be statements the panel cannot support.
    expect(card.find('[data-testid="picked-size"]').exists()).toBe(false)

    card.unmount()
  })

  it('renders the picked name and its formatted size without a testid attribute', () => {
    // Given: a picked file, and no `testid` passed.
    const card = mount(PickedFileCard, { props: { ...BASE } })

    // Then: the real name, and a size formatted by `@/lib/format` -- one decimal above a
    // kilobyte so the size column keeps its width as files are chosen.
    const name = card.get('.name')
    expect(name.text()).toBe('photo.png')
    expect(name.element.firstChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(name.attributes('data-testid')).toBeUndefined()
    expect(card.get('[data-testid="picked-size"]').text()).toBe('25.1 KB')

    card.unmount()
  })

  it('shows the picture itself when there is a preview URL', () => {
    // Given: a cover that decoded.
    const card = mount(PickedFileCard, { props: { ...BASE, previewUrl: 'blob:fake/1' } })

    // Then: a real <img> carrying that URL, with a real alt -- the file name, which is the
    // only honest description available for a picture whose content was never inspected.
    // An empty alt would hide the one thing this card exists to show from a screen reader.
    const img = card.get('img.thumb')
    expect(img.attributes('src')).toBe('blob:fake/1')
    expect(img.attributes('alt')).toBe('photo.png')
    // Then: the name and the size are still on the card, not replaced by the picture.
    expect(card.get('.name').text()).toBe('photo.png')
    expect(card.get('[data-testid="picked-size"]').text()).toBe('25.1 KB')
    // Then: no glyph alongside it -- a placeholder box next to a loaded picture is noise.
    expect(card.find('svg.glyph').exists()).toBe(false)

    card.unmount()
  })

  it('falls back to a glyph when there is nothing renderable, never a broken image', () => {
    // Given: an archive, which cannot be drawn, so it is described instead of displayed.
    const card = mount(PickedFileCard, {
      props: { ...BASE, name: 'payload.zip', size: 377, kind: 'archive' },
    })

    // Then: no <img> at all. An <img> pointed at ZIP bytes would render the browser's
    // broken-image icon, which looks like a failure in a tool that has not failed.
    expect(card.find('img').exists()).toBe(false)
    // Then: a decorative glyph standing in for the file, plus the facts the card can
    // actually know: the name and the exact size.
    const glyph = card.get('svg.glyph')
    // Decorative means decorative: it is hidden from assistive technology, because the
    // name beside it already says what the file is.
    expect(glyph.attributes('aria-hidden')).toBe('true')
    expect(card.get('.name').text()).toBe('payload.zip')
    expect(card.get('[data-testid="picked-size"]').text()).toBe('377 B')

    card.unmount()
  })

  it('exposes the kind so the slot can be told apart without reading the copy', () => {
    // Given: the same file described three ways.
    for (const kind of ['image', 'archive', 'unknown'] as const) {
      const card = mount(PickedFileCard, { props: { ...BASE, kind } })

      // Then: the kind is on the card itself, which is what lets styling and specs
      // distinguish an archive from a picture without parsing a Chinese noun.
      expect(card.attributes('data-kind')).toBe(kind)
      // Then: with no preview, every kind gets exactly one glyph and no image.
      expect(card.findAll('svg.glyph')).toHaveLength(1)
      expect(card.find('img').exists()).toBe(false)

      card.unmount()
    }
  })

  it('omits the size when a name is known but no byte count is', () => {
    // Given: a name with `size: null` -- a real state, since a host that cannot report a
    // length must not have a size invented for it.
    const card = mount(PickedFileCard, { props: { ...BASE, size: null } })

    // Then: the name is shown and the size line is simply absent.
    expect(card.get('.name').text()).toBe('photo.png')
    expect(card.find('[data-testid="picked-size"]').exists()).toBe(false)

    card.unmount()
  })

  it('keeps a megabyte size on one decimal place', () => {
    // Given: a file big enough to be measured in megabytes.
    const card = mount(PickedFileCard, { props: { ...BASE, size: 2 * 1024 * 1024, previewUrl: 'blob:fake/1' } })

    // Then: exactly one decimal. A trimmed `2 MB` next to a `1.5 KB` above it is the
    // width change the whole interface's tabular numerals exist to prevent.
    expect(card.get('[data-testid="picked-size"]').text()).toBe('2.0 MB')

    card.unmount()
  })
})
