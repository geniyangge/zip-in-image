import { afterEach, describe, expect, it, vi } from 'vitest'

import { downloadBlob } from '@/lib/download'

// test/unit/** runs under Node 18, which has no `document` at all. Rather than
// switching the suite to jsdom, the spec hands downloadBlob a hand-rolled
// Document-shaped fake and asserts on the calls it records.

const PAYLOAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

const payloadBlob = (): Blob => new Blob([PAYLOAD], { type: 'image/png' })

type ClickSnapshot = { href: string; download: string; attached: boolean }

interface FakeAnchor {
  href: string
  download: string
  parentNode: FakeBody | null
  setAttribute: (name: string, value: string) => void
  click: () => void
}

interface FakeBody {
  children: FakeAnchor[]
  appendChild: (node: FakeAnchor) => FakeBody
  removeChild: (node: FakeAnchor) => FakeBody
}

interface FakeDocument {
  body: FakeBody
  createElement: (tagName: 'a') => FakeAnchor
}

interface FakeDom {
  doc: FakeDocument
  /** Ordered call log: 'create:<tag>' | 'append' | 'click' | 'remove' */
  log: string[]
  clicks: ClickSnapshot[]
  /** Every setAttribute call, so "property, not attribute" is observable. */
  attributes: Record<string, string>
}

const createFakeDom = (): FakeDom => {
  const log: string[] = []
  const clicks: ClickSnapshot[] = []
  const attributes: Record<string, string> = {}

  const body: FakeBody = {
    children: [],
    appendChild(node) {
      this.children.push(node)
      node.parentNode = body
      log.push('append')
      return body
    },
    removeChild(node) {
      const at = this.children.indexOf(node)
      if (at >= 0) {
        this.children.splice(at, 1)
      }
      node.parentNode = null
      log.push('remove')
      return body
    },
  }

  const doc: FakeDocument = {
    body,
    createElement(tagName) {
      log.push(`create:${tagName}`)
      const anchor: FakeAnchor = {
        href: '',
        download: '',
        parentNode: null,
        setAttribute(name, value) {
          attributes[name] = value
        },
        click() {
          log.push('click')
          clicks.push({ href: this.href, download: this.download, attached: this.parentNode !== null })
        },
      }
      return anchor
    },
  }

  return { doc, log, clicks, attributes }
}

/**
 * The single assertion site in this file. The fake is structurally a Document for
 * the four members downloadBlob touches, but it cannot satisfy the ~100-member DOM
 * `Document` interface, so it is widened through `unknown` at this one point.
 */
const asDocument = (fake: FakeDocument): Document => fake as unknown as Document

let createdUrls: string[] = []
let revokedUrls: string[] = []

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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('download', () => {
  it('sets the download name, clicks a DOM-attached anchor, then revokes', () => {
    // Given: an object-URL ledger and a fake document.
    vi.useFakeTimers()
    stubObjectUrls()
    const dom = createFakeDom()

    // When: downloading through the fake document.
    downloadBlob(payloadBlob(), 'report.png', asDocument(dom.doc))

    // Then: an anchor was created, attached, clicked while attached, and removed.
    expect(dom.log).toEqual(['create:a', 'append', 'click', 'remove'])
    expect(dom.clicks).toEqual([{ href: 'blob:fake/0', download: 'report.png', attached: true }])
    // Then: the name was set as the property, never as an attribute.
    expect(dom.attributes).toEqual({})
    expect(dom.doc.body.children).toEqual([])
    // Then: the object URL is released once the macrotask runs.
    vi.advanceTimersByTime(0)
    expect(revokedUrls).toEqual(['blob:fake/0'])
  })

  it('preserves a non-ASCII filename verbatim', () => {
    // Given: a filename with Chinese characters and a space.
    vi.useFakeTimers()
    stubObjectUrls()
    const dom = createFakeDom()
    const fileName = '照片 01.png'

    // When: downloading with it.
    downloadBlob(payloadBlob(), fileName, asDocument(dom.doc))

    // Then: the anchor received it byte-for-byte, with no re-encoding or stripping.
    expect(dom.clicks).toEqual([{ href: 'blob:fake/0', download: fileName, attached: true }])
    expect(dom.clicks[0]?.download).toBe('照片 01.png')
  })

  it('revokes on a macrotask rather than synchronously', () => {
    // Given: an object-URL ledger that records revocation order in time.
    vi.useFakeTimers()
    stubObjectUrls()
    const dom = createFakeDom()

    // When: downloading.
    downloadBlob(payloadBlob(), 'report.png', asDocument(dom.doc))

    // Then: downloadBlob has returned but the object URL is still alive.
    expect(createdUrls).toEqual(['blob:fake/0'])
    expect(revokedUrls).toEqual([])

    // Then: the revoke happens on the next macrotask tick.
    vi.advanceTimersByTime(0)
    expect(revokedUrls).toEqual(['blob:fake/0'])
  })
})
