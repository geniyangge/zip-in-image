// Focused follow-up to scripts/preview-proof.mjs: measure the two things a screenshot
// suggested might be wrong, instead of assuming a fix was enough.
//
//   1. The drop-zone instruction text, per-line glyph census at 390px. A single glyph
//      alone on the last line is a CJK orphan (孤字) -- the same defect class as the
//      earlier `尚未选 / 择` bug.
//   2. A deliberately long file name next to the thumbnail, which is the layout's real
//      squeeze risk: does the card stay inside the viewport, and does the name wrap to a
//      sane number of lines rather than one orphan glyph?
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const ORIGIN = 'http://127.0.0.1:4173'
const PORT = 4173
const SHOTS = path.join(ROOT, '.tmp', 'qa', 'preview-shots')
const IMAGE = path.join(ROOT, '.tmp', 'fixtures', 'photo.png')
const LONG = path.join(ROOT, '.tmp', 'qa', 'long-name-check')

let failed = 0
const ok = (id, d) => console.log(`[ok]   ${id}${d ? `  ${d}` : ''}`)
const bad = (id, d) => {
  failed += 1
  console.log(`[FAIL] ${id}${d ? `  ${d}` : ''}`)
}
const check = (id, c, d) => (c ? ok(id, d) : bad(id, d))
const note = (t) => console.log(`       ${t}`)

/**
 * Per-line glyph census for every element matching `selector`, using one Range per
 * character: the number of distinct rect `top` values is the line count, and the glyphs
 * sharing the lowest `top`... sharing the HIGHEST top form the last line.
 */
const CENSUS = `(selector) => {
  const out = []
  for (const el of document.querySelectorAll(selector)) {
    const text = el.textContent ?? ''
    if (text.trim() === '') continue
    const node = el.firstChild
    if (node === null || node.nodeType !== 3) continue
    const perGlyph = []
    for (let i = 0; i < text.length; i++) {
      const r = document.createRange()
      r.setStart(node, i)
      r.setEnd(node, i + 1)
      const rect = r.getBoundingClientRect()
      if (rect.height === 0 && rect.width === 0) continue
      perGlyph.push(Math.round(rect.top))
    }
    if (perGlyph.length === 0) continue
    const lines = []
    for (const top of perGlyph) {
      const found = lines.find((l) => Math.abs(l.top - top) <= 2)
      if (found) found.count += 1
      else lines.push({ top, count: 1 })
    }
    lines.sort((a, b) => a.top - b.top)
    out.push({
      text: text.trim().slice(0, 40),
      lines: lines.length,
      glyphsPerLine: lines.map((l) => l.count),
      lastLine: lines[lines.length - 1].count,
    })
  }
  return out
}`

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ORIGIN, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

if (!existsSync(IMAGE)) {
  console.error(`missing image fixture: ${IMAGE} (run \`pnpm fixtures\`)`)
  process.exit(1)
}
mkdirSync(LONG, { recursive: true })
// A name long enough to be forced onto several lines beside a 72px thumbnail.
const longName = '很长的图片文件名称-2026-09-27-最终版-不要删-真的非常长-used-for-squeeze-check.png'
const longPath = path.join(LONG, longName)
copyFileSync(IMAGE, longPath)

const child = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', windowsHide: true },
)

let browser
try {
  if (!(await waitForServer())) throw new Error('preview never answered')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })

  // --- 1. drop-zone instruction text: one line per zone, no orphan -----------------
  const zoneText = await page.evaluate(
    ([sel, body]) => {
      // eslint-disable-next-line no-new-func
      return new Function(`return ${body}`)()(sel)
    },
    ['.zone .hint, .zone .prompt', CENSUS],
  )
  for (const t of zoneText) {
    note(`zone text ${JSON.stringify(t.text)} -> ${t.lines} line(s), glyphs/line [${t.glyphsPerLine.join(',')}]`)
  }
  check(
    'zone-text.single-instruction',
    zoneText.length === 2,
    `exactly ${zoneText.length} instruction line(s) across the two zones (was 4: generic prompt AND hint both rendered)`,
  )
  const orphans = zoneText.filter((t) => t.lastLine <= 1)
  check(
    'zone-text.no-one-glyph-orphan',
    orphans.length === 0,
    orphans.length === 0
      ? 'no instruction line ends with a single glyph'
      : `orphan in: ${orphans.map((o) => o.text).join(' | ')}`,
  )

  // --- 2. long file name beside the thumbnail ---------------------------------------
  await page.setInputFiles('#img-input', longPath)
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="merge-image-name"]')
      const img = el?.closest('.card')?.querySelector('img.thumb')
      return Boolean(img && img.complete && img.naturalWidth > 0)
    },
    undefined,
    { timeout: 15000 },
  )
  const nameCensus = await page.evaluate(
    ([sel, body]) => {
      // eslint-disable-next-line no-new-func
      return new Function(`return ${body}`)()(sel)
    },
    ['[data-testid="merge-image-name"]', CENSUS],
  )
  for (const t of nameCensus) {
    note(`long name -> ${t.lines} line(s), glyphs/line [${t.glyphsPerLine.join(',')}]`)
  }
  const nameOrphans = nameCensus.filter((t) => t.lastLine <= 1)
  check(
    'long-name.no-one-glyph-orphan',
    nameOrphans.length === 0,
    nameOrphans.length === 0
      ? 'the squeezed name wraps without leaving one glyph alone'
      : `orphan: last line of ${JSON.stringify(nameCensus[0]?.text)} holds ${nameCensus[0]?.lastLine} glyph(s)`,
  )

  const overflow = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth
    const past = [...document.querySelectorAll('body *')].filter(
      (el) => el.getBoundingClientRect().right > limit,
    )
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: limit, count: past.length }
  })
  check(
    'long-name.no-horizontal-overflow',
    overflow.scrollWidth <= 390 && overflow.count === 0,
    `a 60-character name beside a 72px thumbnail: scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} past=${overflow.count}`,
  )

  await page.screenshot({ path: path.join(SHOTS, 'merge-mobile-long-name.png'), fullPage: true })
  const size = statSync(path.join(SHOTS, 'merge-mobile-long-name.png')).size
  check('long-name.screenshot', size > 5000, `merge-mobile-long-name.png is ${size} bytes`)

  await context.close()
} catch (error) {
  failed += 1
  console.error(`[FAIL] harness threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  if (child.exitCode === null && child.signalCode === null) child.kill()
  await new Promise((r) => setTimeout(r, 800))
  let up = false
  try {
    up = (await fetch(ORIGIN, { signal: AbortSignal.timeout(1200) })).ok
  } catch {
    up = false
  }
  if (up) {
    failed += 1
    console.log(`[FAIL] LIFECYCLE.port  port ${PORT} still answers`)
  } else ok('LIFECYCLE.port', `port ${PORT} free`)
}

console.log(`\n=== CJK / SQUEEZE CHECK =====================================`)
console.log(`failed: ${failed}`)
console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'}`)
process.exitCode = failed === 0 ? 0 : 1
