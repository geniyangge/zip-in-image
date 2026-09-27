// Visual proof for the file-preview feature.
//
// The existing browser QA gate (scripts/browser-qa.mjs) exercises the EMPTY state and the
// merged result. It never selects a cover image and looks at what appears, and it never
// feeds a plain picture to the extract panel -- which is precisely the case that used to
// render nothing at all. This script covers those two gaps and captures screenshots.
//
// Reuses the working patterns from browser-qa.mjs: vite preview bound to 127.0.0.1 (vite
// binds IPv6 localhost otherwise), a readiness poll, and a `finally` that kills the child
// and re-checks the port.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const ORIGIN = 'http://127.0.0.1:4173'
const PORT = 4173
const SHOTS = path.join(ROOT, '.tmp', 'qa', 'preview-shots')
const IMAGE = path.join(ROOT, '.tmp', 'fixtures', 'photo.png')
const ZIP = path.join(ROOT, '.tmp', 'fixtures', 'payload.zip')

const results = []
let failed = 0

const ok = (id, detail) => {
  results.push({ id, pass: true, detail })
  console.log(`[ok]   ${id}${detail ? `  ${detail}` : ''}`)
}
const bad = (id, detail) => {
  failed += 1
  results.push({ id, pass: false, detail })
  console.log(`[FAIL] ${id}${detail ? `  ${detail}` : ''}`)
}
const check = (id, condition, detail) => (condition ? ok(id, detail) : bad(id, detail))
const note = (text) => console.log(`       ${text}`)

function requireFile(p, what) {
  if (!existsSync(p)) {
    console.error(`missing ${what}: ${p}`)
    process.exit(1)
  }
  return p
}

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ORIGIN, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** Wait until the card's thumbnail has actually decoded, not merely been inserted. */
async function thumbState(page, testid) {
  return page.evaluate((tid) => {
    const card = document.querySelector(`[data-testid="${tid}"]`)?.closest('.card')
    if (!card) return { found: false }
    const img = card.querySelector('img.thumb')
    if (!img) return { found: true, img: false }
    return {
      found: true,
      img: true,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: Math.round(img.getBoundingClientRect().width),
      isBlob: img.src.startsWith('blob:'),
    }
  }, testid)
}

async function cardFacts(page, testid) {
  return page.evaluate((tid) => {
    const nameEl = document.querySelector(`[data-testid="${tid}"]`)
    const card = nameEl?.closest('.card')
    return {
      name: nameEl?.textContent ?? null,
      size: card?.querySelector('[data-testid="picked-size"]')?.textContent ?? null,
      kind: card?.getAttribute('data-kind') ?? null,
      hasGlyph: Boolean(card?.querySelector('svg.glyph')),
      // The name must be the first child text node: browser-qa.mjs's census depends on it.
      firstChildIsText: nameEl?.firstChild?.nodeType === 3,
    }
  }, testid)
}

const child = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', windowsHide: true },
)

let browser
try {
  requireFile(path.join(ROOT, 'dist', 'index.html'), 'built output (run `pnpm build` first)')
  requireFile(IMAGE, 'image fixture (run `pnpm fixtures` first)')
  requireFile(ZIP, 'zip fixture (run `pnpm fixtures` first)')
  mkdirSync(SHOTS, { recursive: true })

  if (!(await waitForServer())) throw new Error(`preview never answered on ${ORIGIN}`)
  note(`vite preview answered HTTP 200 (pid ${child.pid})`)

  browser = await chromium.launch({ channel: 'msedge', headless: true })
  note(`browser: chromium channel=msedge ${browser.version()} (no browser was downloaded)`)

  for (const [label, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    console.log(`\n=== ${label.toUpperCase()} ${viewport.width}x${viewport.height} ===`)
    const context = await browser.newContext({ acceptDownloads: true, viewport })
    const page = await context.newPage()
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })

    // --- merge panel: selecting a cover must show a THUMBNAIL, before any merge -----
    await page.setInputFiles('#img-input', IMAGE)
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="merge-image-name"]')
        const img = el?.closest('.card')?.querySelector('img.thumb')
        return Boolean(img && img.complete && img.naturalWidth > 0)
      },
      undefined,
      { timeout: 15000 },
    )
    const cover = await thumbState(page, 'merge-image-name')
    const coverFacts = await cardFacts(page, 'merge-image-name')
    note(`cover card: name=${JSON.stringify(coverFacts.name)} size=${coverFacts.size} kind=${coverFacts.kind}`)
    check(
      `${label}.cover.thumbnail-decodes`,
      cover.img === true && cover.complete === true && cover.naturalWidth === 96 && cover.naturalHeight === 96,
      `naturalWidth x naturalHeight = ${cover.naturalWidth} x ${cover.naturalHeight}, complete=${cover.complete}`,
    )
    check(
      `${label}.cover.name-and-size`,
      coverFacts.name === 'photo.png' && typeof coverFacts.size === 'string' && coverFacts.size.length > 0,
      `name=${JSON.stringify(coverFacts.name)} size=${JSON.stringify(coverFacts.size)}`,
    )
    check(`${label}.cover.name-first-child-is-text`, coverFacts.firstChildIsText === true)

    // --- merge panel: the archive gets a card, never a broken <img> -----------------
    await page.setInputFiles('#zip-input', ZIP)
    await page.waitForFunction(
      () => document.querySelector('[data-testid="merge-payload-name"]')?.textContent === 'payload.zip',
      undefined,
      { timeout: 15000 },
    )
    const zipFacts = await cardFacts(page, 'merge-payload-name')
    const zipImg = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="merge-payload-name"]')?.closest('.card')?.querySelector('img.thumb')),
    )
    note(`archive card: name=${JSON.stringify(zipFacts.name)} size=${JSON.stringify(zipFacts.size)} kind=${JSON.stringify(zipFacts.kind)}`)
    check(
      `${label}.archive.card-not-broken-image`,
      zipFacts.name === 'payload.zip' && zipFacts.kind === 'archive' && zipFacts.hasGlyph === true && zipImg === false,
      `glyph present=${zipFacts.hasGlyph}, img present=${zipImg} (a zip must never be handed to <img>)`,
    )

    await page.screenshot({ path: path.join(SHOTS, `merge-${label}.png`), fullPage: true })
    const mergeShot = statSync(path.join(SHOTS, `merge-${label}.png`)).size
    check(`${label}.screenshot.merge`, mergeShot > 5000, `merge-${label}.png is ${mergeShot} bytes`)

    // --- extract panel: a PLAIN PICTURE must now be visible ------------------------
    // This is the case that used to render nothing: detection finds no archive, the
    // offset is 0, and the old code revoked the preview instead of showing the picture.
    await page.click('#tab-extract')
    await page.waitForSelector('#disguised-input', { state: 'attached' })
    await page.setInputFiles('#disguised-input', IMAGE)
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="extract-source-name"]')
        const img = el?.closest('.card')?.querySelector('img.thumb')
        return Boolean(img && img.complete && img.naturalWidth > 0)
      },
      undefined,
      { timeout: 15000 },
    )
    const plain = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="extract-source-name"]')
      const card = el?.closest('.card')
      const img = card?.querySelector('img.thumb')
      return {
        name: el?.textContent ?? null,
        size: card?.querySelector('[data-testid="picked-size"]')?.textContent ?? null,
        naturalWidth: img?.naturalWidth ?? 0,
        naturalHeight: img?.naturalHeight ?? 0,
        renderedWidth: img ? Math.round(img.getBoundingClientRect().width) : 0,
        firstChildIsText: el?.firstChild?.nodeType === 3,
      }
    })
    note(`plain picture card: name=${JSON.stringify(plain.name)} size=${JSON.stringify(plain.size)} natural=${plain.naturalWidth}x${plain.naturalHeight}`)
    check(
      `${label}.extract.plain-image-is-visible`,
      plain.naturalWidth === 96 && plain.naturalHeight === 96 && plain.renderedWidth > 0,
      `a picture with no appended archive still renders: natural ${plain.naturalWidth}x${plain.naturalHeight}, laid out ${plain.renderedWidth}px wide`,
    )
    check(`${label}.extract.name-first-child-is-text`, plain.firstChildIsText === true)

    // Photograph the plain picture HERE, while it is loaded. The disguised-file case
    // below replaces it, and its image prefix is a 1x1 JPEG -- a single black pixel
    // scaled to the thumbnail, which is correct behaviour but useless as visual evidence
    // that "the picture is visible".
    await page.screenshot({ path: path.join(SHOTS, `extract-plain-${label}.png`), fullPage: true })
    const plainShot = statSync(path.join(SHOTS, `extract-plain-${label}.png`)).size
    check(`${label}.screenshot.extract-plain`, plainShot > 5000, `extract-plain-${label}.png is ${plainShot} bytes`)

    // --- the same file WITH an archive appended: still one picture, no duplication ---
    const disguised = path.join(ROOT, '.tmp', 'evidence', 'disguised.jpg')
    if (existsSync(disguised)) {
      await page.setInputFiles('#disguised-input', disguised)
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="extract-source-name"]')
          const img = el?.closest('.card')?.querySelector('img.thumb')
          return el?.textContent === 'disguised.jpg' && Boolean(img && img.complete && img.naturalWidth > 0)
        },
        undefined,
        { timeout: 15000 },
      )
      const both = await page.evaluate(
        () => document.querySelectorAll('[data-testid="extract-source-name"]').length,
      )
      check(
        `${label}.extract.disguised-file-still-one-card`,
        both === 1,
        `a disguised file yields exactly ${both} card, and its picture still decodes`,
      )
    } else {
      note('skipped the disguised-file case: run `pnpm qa:evidence` first')
    }

    await page.screenshot({ path: path.join(SHOTS, `extract-${label}.png`), fullPage: true })
    const extractShot = statSync(path.join(SHOTS, `extract-${label}.png`)).size
    check(`${label}.screenshot.extract`, extractShot > 5000, `extract-${label}.png is ${extractShot} bytes`)

    // --- no horizontal overflow introduced by the new cards ------------------------
    const overflow = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth
      const past = [...document.querySelectorAll('body *')].filter(
        (el) => el.getBoundingClientRect().right > limit,
      )
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: limit, count: past.length }
    })
    check(
      `${label}.no-horizontal-overflow`,
      overflow.scrollWidth <= viewport.width && overflow.count === 0,
      `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} elements past clientWidth=${overflow.count}`,
    )

    await context.close()
  }
} catch (error) {
  failed += 1
  console.error(`[FAIL] harness threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  if (child.exitCode === null && child.signalCode === null) child.kill()
  await new Promise((r) => setTimeout(r, 800))
  let stillUp = false
  try {
    const res = await fetch(ORIGIN, { signal: AbortSignal.timeout(1200) })
    stillUp = res.ok
  } catch {
    stillUp = false
  }
  if (stillUp) {
    failed += 1
    console.log(`[FAIL] LIFECYCLE.port  port ${PORT} still answers after teardown`)
  } else {
    ok('LIFECYCLE.port', `port ${PORT} no longer answers -- no orphan server survived`)
  }
}

const passed = results.filter((r) => r.pass).length
console.log(`\n=== PREVIEW PROOF ==========================================`)
console.log(`checks: ${results.length} ; passed: ${passed} ; failed: ${failed}`)
console.log(`screenshots: ${SHOTS}`)
console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'}`)
process.exitCode = failed === 0 ? 0 : 1
