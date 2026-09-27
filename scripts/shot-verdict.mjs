#!/usr/bin/env node
/**
 * The one screenshot `scripts/browser-qa.mjs` could not take.
 *
 * That gate is correct and complete as a MEASUREMENT harness: it censuses CJK lines and
 * asserts zero horizontal overflow. But it is a measurement, and a measurement is not a
 * picture. Its `extract-mobile.png` is shot on the EMPTY panel, where `StatusPill` renders
 * NOTHING (`v-if="tone !== 'idle'"` in `src/components/StatusPill.vue`), so the one element
 * whose wrap fix is under scrutiny is simply absent from the file. This script supplies
 * that missing picture: the extract panel in its not-detected ERROR state, at 390px and at
 * 1440px, so the wrapped pill is visible to a human and not only provable in a number.
 *
 * Everything structural is deliberately COPIED from `browser-qa.mjs` rather than reinvented,
 * because each piece of it was paid for:
 *
 *   - `vite preview` spawned through `process.execPath` + `node_modules/vite/bin/vite.js`.
 *     The `.cmd` shim adds a `cmd.exe` layer `child.kill()` cannot reliably reach on
 *     Windows, which is how orphan servers on 4173 happen. `--host 127.0.0.1` is explicit
 *     because plain `vite` binds `localhost`, which on this host resolves to `::1` only --
 *     the documented `http://127.0.0.1:4173/` origin then never connects.
 *   - the poll-until-HTTP-200 readiness loop with `AbortSignal.timeout`, and the kill +
 *     independent port re-check in `finally`, so nothing outlives this file.
 *   - `chromium.launch({ channel: 'msedge' })`. Edge 154.0.4258.37 is installed; no browser
 *     is ever downloaded.
 *   - `dist/` is served as-is and NEVER rebuilt. The finished QA run already proved this
 *     build; rebuilding here would be a second, unverified build.
 *
 * The verdict is reached the way a USER reaches it: pick a file that is only an image. With
 * no appended archive the panel reports the not-detected error, and the pill carries the
 * longest Chinese sentence either panel can render -- the exact string that used to be
 * 599.6px wide on a 390px viewport and drag the whole page sideways.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

// --------------------------------------------------------------------------------------
// Paths and constants
// --------------------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const SHOTS_DIR = path.join(ROOT, '.tmp', 'qa', 'shots')
/** A PURE image: no archive appended, which is what makes the panel report not-detected. */
const FIXTURE_IMAGE = path.join(ROOT, '.tmp', 'fixtures', 'photo.png')
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

const ORIGIN = 'http://127.0.0.1:4173'
const PORT = 4173
const STEP_TIMEOUT = 20_000
const SERVER_TIMEOUT = 60_000
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
/** The verdict pill: the summary StatusPill, which is the one the fix is about. */
const VERDICT_PILL = '[data-testid="extract-summary"] .pill[data-tone="error"]'

const results = []
const artifacts = []

function ok(id, message) {
  results.push({ id, pass: true })
  console.log(`[ok]   ${id}  ${message}`)
}

function fail(id, message) {
  results.push({ id, pass: false })
  console.log(`[FAIL] ${id}  ${message}`)
}

function note(line) {
  console.log(`       ${line}`)
}

function banner(text) {
  console.log('')
  console.log(`=== ${text} ${'='.repeat(Math.max(0, 62 - text.length))}`)
}

const rel = (absolute) => path.relative(ROOT, absolute).replace(/\\/g, '/')

/**
 * An unhandled rejection is reported, never allowed to kill the run AFTER the real
 * evidence printed. Exactly ONE signature is noted as a known playwright@1.49.1 + Edge
 * artifact (its own `FrameSession.dispose` rejecting a deferred); this run triggers NO
 * download, so seeing one would itself be worth printing -- it is a tool artifact, not a
 * product verdict. Any other rejection fails the gate.
 */
process.on('unhandledRejection', (reason) => {
  const name = reason instanceof Error ? reason.name : 'unknown'
  const message = reason instanceof Error ? reason.message : String(reason)
  if (name === 'TargetClosedError') {
    artifacts.push(`${name}: ${message}`)
    console.log(`[note] LIFECYCLE.unhandledRejection  KNOWN PLAYWRIGHT ARTIFACT, not a product verdict: ${name}: ${message}`)
    console.log('       note: no download is triggered by this script, so this artifact is unexpected here; it is still not a product verdict')
    return
  }
  fail('LIFECYCLE.unhandledRejection', `an unhandled rejection escaped the driver: ${name}: ${message}`)
})

// --------------------------------------------------------------------------------------
// Filesystem helpers
// --------------------------------------------------------------------------------------

async function byteSize(filePath) {
  return (await stat(filePath)).size
}

async function requireFile(filePath, what) {
  try {
    await stat(filePath)
  } catch {
    throw new Error(`${what} is missing: ${rel(filePath)} (${filePath})`)
  }
}

/**
 * PNG pixel dimensions, read back from the IHDR chunk of the bytes actually on disk.
 *
 * `width` is the 4 bytes at offset 16, `height` the 4 at 20: the 8-byte signature, the
 * 4-byte chunk length, and the 4-byte "IHDR" tag all precede them, and both are
 * big-endian. Asserting a file merely EXISTS would say nothing about whether the shot is
 * 390px wide or 599px -- the width of these PNGs is the measurement, so it is decoded.
 */
async function pngSize(filePath) {
  const buffer = await readFile(filePath)
  const signature = '89504e470d0a1a0a'
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error(`${rel(filePath)} is not a PNG (bad signature)`)
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// --------------------------------------------------------------------------------------
// In-page measurements
// --------------------------------------------------------------------------------------

/**
 * Scroll metrics and the horizontal-overflow census in ONE round trip, so the two cannot
 * be sampled at different moments. An element counts as overflowing when its border box
 * extends past the viewport's usable width; a 0.5px tolerance absorbs sub-pixel layout
 * rounding, which is not a defect. Copied verbatim from `browser-qa.mjs`.
 */
async function measureLayout(page) {
  return page.evaluate(() => {
    const root = document.documentElement
    const clientWidth = root.clientWidth
    const offenders = []
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      if (rect.right > clientWidth + 0.5) {
        const name = typeof el.className === 'string' ? el.className : ''
        offenders.push({
          tag: el.tagName.toLowerCase(),
          id: el.id === '' ? '(none)' : el.id,
          cls: name === '' ? '(none)' : name.slice(0, 40),
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
          right: Math.round(rect.right * 10) / 10,
        })
      }
    }
    return { scrollWidth: root.scrollWidth, clientWidth, count: offenders.length, offenders: offenders.slice(0, 8) }
  })
}

/**
 * The pill's rendered box, its computed line-height, and a PER-CHARACTER line census.
 *
 * A range over the whole text only reports how many line boxes exist; an orphan needs the
 * FILL of the last line. So every character gets a one-character range and the characters
 * are bucketed by `top`, which yields exact per-line glyph counts with no tunable
 * threshold. Line-box tops are sub-pixel, so lines join with a 1.5px epsilon -- without it
 * one wrapped line would be counted as two. Copied from `browser-qa.mjs`.
 */
async function measurePill(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (el === null) return { found: false }
    const node = el.firstChild
    if (node === null || node.nodeType !== Node.TEXT_NODE) return { found: true, measurable: false }

    const style = window.getComputedStyle(el)
    const parsed = Number.parseFloat(style.lineHeight)
    const lineHeight = Number.isNaN(parsed) ? null : parsed
    const box = el.getBoundingClientRect()
    const text = node.textContent ?? ''

    const tops = []
    for (let index = 0; index < text.length; index += 1) {
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      tops.push(Math.round(range.getBoundingClientRect().top * 100) / 100)
    }
    const perLine = []
    for (const top of tops) {
      const joined = perLine.findIndex((known) => Math.abs(known.top - top) <= 1.5)
      if (joined === -1) perLine.push({ top, glyphs: 1 })
      else perLine[joined].glyphs += 1
    }

    return {
      found: true,
      measurable: true,
      tone: el.getAttribute('data-tone'),
      text,
      chars: text.length,
      width: Math.round(box.width * 100) / 100,
      height: Math.round(box.height * 100) / 100,
      lineHeight,
      heightInLineHeights:
        lineHeight === null || lineHeight === 0 ? null : Math.round((box.height / lineHeight) * 100) / 100,
      lines: perLine.length,
      perLine: perLine.map((line) => line.glyphs),
      lastLineGlyphs: perLine.length === 0 ? 0 : perLine[perLine.length - 1].glyphs,
    }
  }, selector)
}

// --------------------------------------------------------------------------------------
// Server lifecycle (copied from browser-qa.mjs -- see the file header for why each part)
// --------------------------------------------------------------------------------------

async function startPreview() {
  await requireFile(VITE_BIN, 'vite binary (run `pnpm install` first)')

  // `--host 127.0.0.1` is explicit, not decoration: vite preview otherwise binds
  // `localhost`, which on this Windows host resolves to `::1` only, so a poll of the
  // documented `http://127.0.0.1:4173/` origin never connects even though the server is up.
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let log = ''
  child.stdout.on('data', (chunk) => {
    log += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log += String(chunk)
  })

  let exited = false
  child.once('exit', (code) => {
    exited = true
    log += `\n[preview exited early, code ${code}]`
  })

  const deadline = Date.now() + SERVER_TIMEOUT
  while (Date.now() < deadline) {
    if (exited) throw new Error(`vite preview exited before it ever served:\n${log}`)
    try {
      const response = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(2000) })
      await response.arrayBuffer()
      note(`vite preview answered HTTP ${response.status} on ${ORIGIN} (serving dist/, pid ${child.pid})`)
      return { child }
    } catch {
      // Not listening yet -- keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`vite preview never answered on ${ORIGIN} within ${SERVER_TIMEOUT}ms:\n${log}`)
}

async function stopPreview(handle) {
  if (handle === null) return
  const { child } = handle
  if (child.exitCode !== null || child.signalCode !== null) {
    note(`vite preview child (pid ${child.pid}) had already exited`)
    return
  }
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  const gone = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ])
  note(gone ? `vite preview child (pid ${child.pid}) terminated in finally` : `vite preview child SURVIVED kill (pid ${child.pid})`)
  if (!gone) throw new Error(`vite preview child ${child.pid} survived kill; port ${PORT} may still be bound`)
}

/** Independent confirmation, from inside this process, that the port was released. */
async function portIsFree() {
  try {
    await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(1500) })
    return false
  } catch {
    return true
  }
}

// --------------------------------------------------------------------------------------
// The capture
// --------------------------------------------------------------------------------------

function wirePage(page, prefix) {
  page.setDefaultTimeout(STEP_TIMEOUT)
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      note(`[${prefix} console.${message.type()}] ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => note(`[${prefix} pageerror] ${error.message}`))
}

/**
 * Drives the panel to its verdict state the way a user does, then measures, then shoots.
 *
 * The gate is `waitForSelector` on the error pill, never a fixed sleep: the shot is taken
 * of a state that is PROVEN to be rendered, because the selector resolving is the proof
 * that `[data-tone="error"]` exists in the DOM right now.
 */
async function captureVerdict(browser, label, viewport, name) {
  banner(`${label}  ${viewport.width}x${viewport.height}  verdict state`)

  const context = await browser.newContext({ acceptDownloads: true, viewport })
  const page = await context.newPage()
  wirePage(page, label.toLowerCase())
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: STEP_TIMEOUT })
  await page.waitForSelector('#tab-disguise', { timeout: STEP_TIMEOUT })

  await page.click('#tab-extract')
  // The tab switch DESTROYS the inactive panel and builds the active one, so the gate is
  // that the new panel's input is ATTACHED -- not visible. The input is `hidden` on
  // purpose (it is a real `<input type="file">` behind a styled label), and
  // `setInputFiles` drives a hidden input fine; only a visibility wait would hang.
  await page.waitForSelector('#disguised-input', { state: 'attached', timeout: STEP_TIMEOUT })
  await page.setInputFiles('#disguised-input', FIXTURE_IMAGE)

  // A PURE image carries no appended archive, so the panel reports not-detected and the
  // pill renders its long Chinese message at `data-tone="error"`.
  await page.waitForSelector(VERDICT_PILL, { state: 'visible', timeout: STEP_TIMEOUT })
  note(`verdict pill present: ${VERDICT_PILL}`)
  const summary = await page.locator('[data-testid="extract-summary"]').innerText()
  note(`extract-summary = ${JSON.stringify(summary.replace(/\s+/g, ' ').trim())}`)

  const pill = await measurePill(page, VERDICT_PILL)
  const layout = await measureLayout(page)

  note('wrap measurements:')
  note(`  documentElement.scrollWidth = ${layout.scrollWidth}`)
  note(`  documentElement.clientWidth = ${layout.clientWidth}`)
  note(`  elements with getBoundingClientRect().right > clientWidth = ${layout.count}`)
  for (const offender of layout.offenders) {
    note(`    overflow: <${offender.tag}> id=${offender.id} class="${offender.cls}" right=${offender.right} text=${JSON.stringify(offender.text)}`)
  }
  note(`  pill data-tone = ${JSON.stringify(pill.tone)}  text = ${JSON.stringify(pill.text)}  chars = ${pill.chars}`)
  note(`  pill rendered width = ${pill.width}px  (before the fix this sentence measured 599.6px on a 390px viewport)`)
  note(`  pill height = ${pill.height}px  computed lineHeight = ${pill.lineHeight}px  height / lineHeight = ${pill.heightInLineHeights}`)
  note(`  wrapped lines = ${pill.lines}  glyphs per line = ${JSON.stringify(pill.perLine)}  last line glyphs = ${pill.lastLineGlyphs}`)

  const file = path.join(SHOTS_DIR, name)
  await page.screenshot({ path: file, fullPage: true })
  const size = await byteSize(file)
  const dims = await pngSize(file)
  note(`screenshot ${rel(file)}: ${size} bytes, ${dims.width}x${dims.height}px, fullPage at viewport ${viewport.width}x${viewport.height}`)

  // The page is closed explicitly, and awaited, BEFORE the context: closing the context
  // directly races Playwright's own frame teardown and surfaces as an unhandled
  // TargetClosedError that aborts Node 18 before the verdict is printed.
  await page.close()
  await context.close()

  size > 0
    ? ok(`shot.${name}`, `${name} is ${size} bytes and ${dims.width}x${dims.height}px`)
    : fail(`shot.${name}`, `${name} is EMPTY (0 bytes)`)

  // A fullPage shot is as wide as the DOCUMENT, not as wide as the viewport -- so a PNG
  // wider than the viewport is the horizontal-overflow defect, visible in the file itself.
  dims.width === viewport.width
    ? ok(`shot.${name}.width`, `the PNG is ${dims.width}px wide, exactly the ${viewport.width}px viewport -- the document is not wider than the screen`)
    : fail(`shot.${name}.width`, `the PNG is ${dims.width}px wide but the viewport is ${viewport.width}px -- the page scrolls sideways`)

  layout.scrollWidth <= layout.clientWidth
    ? ok(`layout.${name}`, `scrollWidth ${layout.scrollWidth} <= clientWidth ${layout.clientWidth}`)
    : fail(`layout.${name}`, `horizontal overflow -- scrollWidth ${layout.scrollWidth} > clientWidth ${layout.clientWidth}`)

  layout.count === 0
    ? ok(`layout.${name}.elements`, `zero elements have getBoundingClientRect().right > clientWidth ${layout.clientWidth}`)
    : fail(`layout.${name}.elements`, `${layout.count} element(s) extend past clientWidth ${layout.clientWidth}: ${JSON.stringify(layout.offenders)}`)

  return { pill, layout, file, size, dims }
}

// --------------------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------------------

async function main() {
  await requireFile(FIXTURE_IMAGE, 'image fixture')
  await requireFile(path.join(ROOT, 'dist', 'index.html'), 'built output (run `pnpm build` first)')
  await mkdir(SHOTS_DIR, { recursive: true })
  note(`node ${process.version}; serving the existing dist/ WITHOUT rebuilding it`)

  let preview = null
  let browser = null
  let mobile = null
  let desktop = null
  try {
    preview = await startPreview()
    // Edge 154.0.4258.37 is installed on this host; nothing is downloaded.
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    note(`browser: chromium channel=msedge ${browser.version()} (no browser was downloaded)`)

    desktop = await captureVerdict(browser, 'DESKTOP', DESKTOP, 'extract-desktop-verdict.png')
    mobile = await captureVerdict(browser, 'MOBILE', MOBILE, 'extract-mobile-verdict.png')
  } finally {
    // Nothing may outlive this process: the browser closes first so no page keeps a socket
    // to the preview server, then the child is killed, then the port is re-checked from
    // inside this process.
    if (browser !== null) await browser.close()
    try {
      await stopPreview(preview)
    } catch (error) {
      fail('LIFECYCLE.kill', error instanceof Error ? error.message : String(error))
    }
    const free = await portIsFree()
    free
      ? ok('LIFECYCLE.port', `port ${PORT} no longer answers after the finally block -- no orphan server survived`)
      : fail('LIFECYCLE.port', `something is STILL answering on ${ORIGIN} after the finally block`)
  }

  banner('WRAP VERDICT')
  if (mobile !== null) {
    const expected = mobile.pill.lines > 1
    expected
      ? ok('wrap.mobile', `the 390px pill WRAPS onto ${mobile.pill.lines} lines -- ${mobile.pill.width}px wide inside a ${mobile.layout.clientWidth}px viewport, height ${mobile.pill.height}px = ${mobile.pill.heightInLineHeights} x lineHeight ${mobile.pill.lineHeight}px, glyphs per line ${JSON.stringify(mobile.pill.perLine)}`)
      : fail('wrap.mobile', `the 390px pill is still ONE line (width ${mobile.pill.width}px in a ${mobile.layout.clientWidth}px viewport) -- the wrap fix is NOT visible`)
  }
  if (desktop !== null) {
    desktop.pill.lines === 1
      ? ok('wrap.desktop', `the 1440px pill fits on ONE line -- width ${desktop.pill.width}px, height ${desktop.pill.height}px = ${desktop.pill.heightInLineHeights} x lineHeight ${desktop.pill.lineHeight}px`)
      : fail('wrap.desktop', `the 1440px pill took ${desktop.pill.lines} lines -- glyphs per line ${JSON.stringify(desktop.pill.perLine)}`)
  }

  banner('SUMMARY')
  for (const shot of [desktop, mobile]) {
    if (shot === null) continue
    console.log(`       ${rel(shot.file)}  ${shot.size} bytes  ${shot.dims.width}x${shot.dims.height}px`)
  }
  const failures = results.filter((result) => !result.pass)
  for (const result of results) if (!result.pass) console.log(`[FAIL] ${result.id}`)
  console.log(`checks: ${results.length} ; passed: ${results.length - failures.length} ; failed: ${failures.length}`)
  console.log(`known Playwright artifacts (reported, not product verdicts): ${artifacts.length}`)
  console.log(failures.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
  process.exitCode = failures.length === 0 ? 0 : 1
}

await main()
