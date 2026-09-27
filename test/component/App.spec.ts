// The application shell's rendered contract, written before the shell exists.
//
// The two panels and the primitives are finished and independently green, so nothing
// here re-tests their behaviour. This suite owns only the four things the shell itself
// is responsible for: that the tablist tells the truth about which tab is active, that
// switching DESTROYS the other panel rather than hiding it, that the visible copy is
// Chinese, and that the page is authored for a 390px phone.
//
// It lives under test/component/**, which vitest.config.ts maps to jsdom: specs 1-3
// need a real document (`aria-*` attributes, `document.title`, `document.activeElement`).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import App from '@/App.vue'
import ExtractPanel from '@/components/ExtractPanel.vue'
import MergePanel from '@/components/MergePanel.vue'

/** The ids the browser QA script clicks, spelled once so a rename cannot half-land. */
const DISGUISE_TAB = '#tab-disguise'
const EXTRACT_TAB = '#tab-extract'

/**
 * Every `<property>: <n>px` literal in a stylesheet, as numbers.
 *
 * The pixel count is a regex capture group, so it arrives as `string | undefined` under
 * `noUncheckedIndexedAccess`. The explicit guard turns a broken pattern into a loud
 * failure instead of a silent `NaN` -- and `NaN` would compare false against every
 * threshold, which is precisely how a guard like this one stops guarding.
 */
function pxLiterals(source: string, property: string): number[] {
  const found: number[] = []
  for (const match of source.matchAll(new RegExp(`${property}:\\s*(\\d+)px`, 'g'))) {
    const digits = match[1]
    if (digits === undefined) throw new Error(`未能从 ${property} 的匹配中取出像素值：${match[0]}`)
    found.push(Number(digits))
  }
  return found
}

describe('App', () => {
  let titleBefore = ''
  let host: HTMLElement | null = null
  let wrapper: VueWrapper | null = null

  /**
   * The shell, mounted into the LIVE document.
   *
   * `attachTo` is not decoration. `@vue/test-utils@2.4.6` mounts into a detached div by
   * default, and jsdom silently ignores `focus()` on a detached element -- so without
   * this, `document.activeElement` would stay `<body>` and the roving-focus assertion in
   * spec 2 would be measuring the harness instead of the tablist.
   */
  function mountShell(): VueWrapper {
    host = document.createElement('div')
    document.body.appendChild(host)
    wrapper = mount(App, { attachTo: host })
    return wrapper
  }

  beforeEach(() => {
    // The shell writes a global -- `document.title` -- so each test starts from a
    // known value and none of them can leak into a later suite.
    titleBefore = document.title
  })

  afterEach(() => {
    // Unmount before detaching: that is what runs each panel's `onUnmounted(dispose)`,
    // and it is the only path that hands a preview object URL back.
    wrapper?.unmount()
    wrapper = null
    host?.remove()
    host = null
    document.title = titleBefore
  })

  it('renders the 伪装 tab active by default and 还原 inactive', () => {
    // Given: the shell, opened for the first time.
    const app = mountShell()

    // Then: the tablist is a real component rather than hand-rolled markup in the
    // shell, so the keyboard contract below has exactly one implementation to keep
    // correct. Matched by declared name, not by import, so the shell can never quietly
    // inline a second tablist that answers to the same ids. (`findComponent` takes a
    // selector object: a bare string never matches in this version of the library.)
    expect(app.findComponent({ name: 'AppTabs' }).exists()).toBe(true)

    // And it is a real tablist with a name, and 伪装 is the tab in charge.
    expect(app.get('[role="tablist"]').attributes('aria-label')).toBe('选择工具模式')

    const disguise = app.get(DISGUISE_TAB)
    const extract = app.get(EXTRACT_TAB)
    expect(disguise.attributes('role')).toBe('tab')
    expect(disguise.text()).toBe('伪装')
    expect(disguise.attributes('aria-selected')).toBe('true')
    expect(extract.attributes('aria-selected')).toBe('false')

    // Roving tabindex: exactly one stop in the tab order, and it is the active tab.
    // Two stops would make Tab walk the tablist twice, which is the whole defect the
    // pattern exists to prevent.
    expect(disguise.attributes('tabindex')).toBe('0')
    expect(extract.attributes('tabindex')).toBe('-1')

    // And the wiring is closed in both directions, so following a tab with a screen
    // reader actually lands on its panel and the panel names its tab.
    expect(disguise.attributes('aria-controls')).toBe('panel-disguise')
    expect(extract.attributes('aria-controls')).toBe('panel-extract')
    const panel = app.get('#panel-disguise')
    expect(panel.attributes('role')).toBe('tabpanel')
    expect(panel.attributes('aria-labelledby')).toBe('tab-disguise')
  })

  it('switching tabs mounts the other panel and unmounts the first', async () => {
    // Given: the merge panel is on screen and the extract panel was never built.
    const app = mountShell()
    expect(app.findComponent(MergePanel).exists()).toBe(true)
    expect(app.findComponent(ExtractPanel).exists()).toBe(false)

    // When: the user walks the tablist from the keyboard. ArrowRight activates as it
    // moves -- APG automatic activation -- so reaching the second tab costs one key
    // press instead of one press plus an Enter.
    await app.get(DISGUISE_TAB).trigger('keydown', { key: 'ArrowRight' })

    // Then: the other panel is on screen and the first one is GONE. Destroyed, not
    // hidden: a half-finished merge must never ride silently into a later extraction.
    expect(app.findComponent(ExtractPanel).exists()).toBe(true)
    expect(app.findComponent(MergePanel).exists()).toBe(false)
    // Proved at the DOM level too, through the ids the browser QA script drives by id.
    expect(app.find('#zip-download').exists()).toBe(true)
    expect(app.find('#merge-run').exists()).toBe(false)
    expect(app.get(EXTRACT_TAB).attributes('aria-selected')).toBe('true')
    // The focus stayed on the tab it activated, so a keyboard user is never dropped
    // back at the top of the document to find out where they went.
    expect(document.activeElement).toBe(app.get(EXTRACT_TAB).element)

    // And the rest of the APG keyboard contract holds on the same journey: Home/End
    // jump to the ends, and every stop still tears the other panel down.
    await app.get(EXTRACT_TAB).trigger('keydown', { key: 'Home' })
    expect(app.findComponent(MergePanel).exists()).toBe(true)
    expect(app.findComponent(ExtractPanel).exists()).toBe(false)

    await app.get(DISGUISE_TAB).trigger('keydown', { key: 'End' })
    expect(app.findComponent(ExtractPanel).exists()).toBe(true)
    expect(app.findComponent(MergePanel).exists()).toBe(false)
  })

  it('tab labels are in Chinese and the document title is set on mount', () => {
    // Given: the shell, mounted into jsdom's document.
    const app = mountShell()

    // Then: the two tabs are the Chinese words the product actually uses. Exact match,
    // not `toContain`: a stray latin fallback or a template's leftover whitespace is
    // exactly the defect this pins.
    expect(app.get(DISGUISE_TAB).text()).toBe('伪装')
    expect(app.get(EXTRACT_TAB).text()).toBe('还原')

    // And the mechanism is stated in the header, in the one sentence that answers the
    // only question a user brings to a tool like this.
    const mechanism = app.get('[data-testid="shell-mechanism"]').text()
    expect(mechanism).toContain('打开是图片')
    expect(mechanism).toContain('改后缀')

    // "Will this upload my file?" is the second question, and the header answers it
    // rather than leaving it to the README.
    expect(app.get('[data-testid="shell-privacy"]').text()).toContain('本地')

    // And the document title is owned by the shell, so it is correct for any mount --
    // including one that never touched index.html.
    expect(document.title).toContain('图片隐写')
    expect(document.title).toContain('压缩包')
  })

  it('layout has no horizontal overflow at 390px', () => {
    // jsdom has no layout engine: it cannot measure a box, so the real assertion --
    // `document.documentElement.scrollWidth <= 390` -- belongs to the browser QA
    // script (Playwright on `vite preview` at 390x844), and cannot be honestly faked
    // here. What jsdom CAN prove is the two declarations that make that measurement
    // pass, plus the one authoring mistake that would break it.
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8')
    expect(html).toMatch(/<meta\s+name="viewport"[^>]*content="width=device-width,\s*initial-scale=1/)

    const base = readFileSync(join(process.cwd(), 'src', 'styles', 'base.css'), 'utf8')
    expect(base).toContain('@media (max-width: 480px)')

    const shell = readFileSync(join(process.cwd(), 'src', 'App.vue'), 'utf8')
    // The column is bounded from above by `max-width` and never from below by a
    // `min-width` wider than the phone. A min-width is the only way an otherwise
    // fluid layout grows a horizontal scrollbar, so this rejects the class of bug
    // rather than one instance of it.
    expect(pxLiterals(shell, 'min-width').filter((value) => value > 390)).toEqual([])
    expect(shell).toMatch(/max-width:\s*\d/)
  })
})
