#!/usr/bin/env node
/**
 * Browser QA gate for 图片隐写 · 压缩包伪装.
 *
 * This is NOT a unit-test rerun. The product logic is already proven by the unit suite and
 * by `scripts/real-surface-check.ps1`; what this file exists to prove is that a REAL
 * browser, driving the REAL built bundle over HTTP, produces a REAL downloadable file
 * whose bytes satisfy a REAL archive tool. Every scenario below has a binary observable
 * that only a live page can produce:
 *
 *   - the download's `suggestedFilename()` (what the browser actually saved it as),
 *   - the bytes on disk after `download.saveAs()` (a real Blob written to a real file),
 *   - `unzip -t` on a renamed copy (an independent ZIP reader, not the product's own),
 *   - `createImageBitmap` in the page (the real decoder, run on the MERGED bytes),
 *   - `getBoundingClientRect()` in the page (real layout at a real viewport).
 *
 * Two environment facts shape the code and are NOT assumptions:
 *
 *   1. `vite preview` is spawned as a CHILD PROCESS of this script and killed in
 *      `finally`, then the port is re-checked from inside the same process. Nothing may
 *      outlive this file; `scripts/teardown.ps1` re-checks it from outside as well. The
 *      run targets `dist/` -- the build the user actually receives -- rather than the dev
 *      server, so the build gate is exercised on the same surface the checks measure.
 *   2. `.NET` `System.IO.Compression` cannot read an archive that has a prefix: it
 *      silently reports 0 entries. That is a documented .NET limitation already asserted
 *      in `real-surface-check.ps1`, so every archive cross-check here goes through
 *      Info-ZIP `unzip`. No .NET reader is used anywhere in this file, and no 0-entry
 *      result from one is ever presented as a product verdict.
 *
 * Every check prints exactly one `[ok]` or `[FAIL]` line, and any `[FAIL]` makes the
 * process exit non-zero. Evidence (byte counts, `unzip` listings, measurements, PNG
 * sizes) is printed inline with each verdict: a run that prints no failure but also no
 * evidence has not run.
 */
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

// --------------------------------------------------------------------------------------
// Paths and constants
// --------------------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const QA_DIR = path.join(ROOT, '.tmp', 'qa')
const SHOTS_DIR = path.join(QA_DIR, 'shots')
const DOWNLOADS_DIR = path.join(QA_DIR, 'downloads')
/** Fixtures belong to the evidence harness; this gate only ever reads them. */
const FIXTURES = {
  image: path.join(ROOT, '.tmp', 'fixtures', 'photo.png'),
  payload: path.join(ROOT, '.tmp', 'fixtures', 'payload.zip'),
}
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

const ORIGIN = 'http://127.0.0.1:4173'
const PORT = 4173
const STEP_TIMEOUT = 20_000
const SERVER_TIMEOUT = 60_000
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const EXPECTED_ENTRIES = ['a.txt', 'c.bin', 'nested/b.txt']

/** `unzip` is Info-ZIP on PATH; a non-zero exit is an observation, not an exception. */
const UNZIP = 'unzip'

// --------------------------------------------------------------------------------------
// Result log. The exit code is derived from it, so every check records exactly one entry.
// --------------------------------------------------------------------------------------

const results = []

/** Set by `clickAndDownload`, so the classifier below can demand proof, not assume. */
let tookDownloadPath = false

/**
 * An unhandled rejection is turned into a verdict, never into a silent pass: Node 18
 * aborts the process on one, which would kill the run AFTER the real checks printed, so
 * no verdict and no evidence would ever appear.
 *
 * Exactly ONE signature is classified rather than failed, and only when this run actually
 * exercised the download path. It was isolated with a three-pass probe: a context opened
 * and closed without a download produced 0 rejections; performing one real download
 * produced 1; a further context with no download added none. The rejection comes from
 * Playwright's own `FrameSession.dispose` (`crPage.js:497`) rejecting an initialization
 * deferred that the download path already short-circuited (`crPage.js:769`, "Starting new
 * page download"), so it is a playwright@1.49.1 + Edge artifact of DOWNLOADING, not a
 * product behaviour and not a harness teardown bug. It is printed on every run and
 * counted, so it can never be mistaken for silence -- but it is not a product verdict, and
 * any OTHER unhandled rejection still fails the gate.
 */
process.on('unhandledRejection', (reason) => {
  const name = reason instanceof Error ? reason.name : 'unknown'
  const message = reason instanceof Error ? reason.message : String(reason)
  if (tookDownloadPath && name === 'TargetClosedError' && message.includes('has been closed')) {
    artifacts.push(message)
    console.log(`[note] LIFECYCLE.unhandledRejection  KNOWN PLAYWRIGHT ARTIFACT, not a product verdict: ${name}: ${message}`)
    console.log('       provenance: isolated by probe -- 0 rejections without a download, 1 with; playwright@1.49.1 FrameSession.dispose rejects the deferred that the download path already rejected')
    return
  }
  fail('LIFECYCLE.unhandledRejection', `an unhandled rejection escaped the driver: ${name}: ${message}`)
})

/** Counted and reported in the summary so the artifact is always accounted for. */
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

// --------------------------------------------------------------------------------------
// Filesystem / archive helpers
// --------------------------------------------------------------------------------------

async function byteSize(filePath) {
  return (await stat(filePath)).size
}

/** Asserts a file is present, naming it in the error so a missing input is diagnosable. */
async function requireFile(filePath, what) {
  try {
    await stat(filePath)
  } catch {
    throw new Error(`${what} is missing: ${rel(filePath)} (${filePath})`)
  }
}

function unzipTest(archivePath) {
  try {
    const stdout = execFileSync(UNZIP, ['-t', archivePath], { encoding: 'utf8', windowsHide: true })
    return { status: 0, output: stdout }
  } catch (error) {
    // A non-zero exit is a legitimate outcome here -- a broken archive is exactly what
    // this gate is hunting for -- so it is captured rather than thrown.
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    return { status: typeof error.status === 'number' ? error.status : -1, output: `${stdout}${stderr}` }
  }
}

/**
 * `unzip -t` output, parsed into facts rather than pattern-matched as prose.
 *
 * Two Info-ZIP behaviours matter and are easy to get wrong:
 *
 *   - A PREFIXED archive makes `unzip -t` exit 1 and print
 *     `warning: N extra bytes at beginning or within zipfile (attempting to process
 *     anyway)`. That is Info-ZIP's documented tolerance for exactly this format, and the
 *     listing that follows is still authoritative -- so the prefix warning is REPORTED and
 *     asserted as expected, never counted as corruption.
 *   - The success sentence is `No errors detected in compressed data of <path>.`, which
 *     contains the word "errors". Matching /error/i against the whole output would flag
 *     that success line as a failure, so the per-entry `testing:` lines and that one
 *     sentence are the only things parsed.
 *
 * Entry names come from the `testing: <name> ... OK|FAILED` lines, with the .NET-built
 * backslashes normalised to `/`.
 */
function unzipReport(archivePath) {
  const { status, output } = unzipTest(archivePath)
  const entries = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*testing:\s+(\S+)\s+(OK|FAILED)\s*$/.exec(line)
    if (match !== null) entries.push({ name: match[1].replace(/\\/g, '/'), result: match[2] })
  }
  const prefixWarning = /warning .*?(\d+) extra bytes at beginning or within zipfile/.exec(output)
  return {
    status,
    output,
    entries,
    names: entries.map((entry) => entry.name),
    allEntriesOk: entries.length > 0 && entries.every((entry) => entry.result === 'OK'),
    dataIntact: /No errors detected in compressed data/.test(output),
    prefixBytes: prefixWarning === null ? null : Number(prefixWarning[1]),
  }
}

function printUnzip(label, report) {
  note(`${UNZIP} -t ${label}  (exit ${report.status}):`)
  for (const line of report.output.trimEnd().split(/\r?\n/)) note(`  | ${line}`)
  note(`  parsed: ${JSON.stringify({ entries: report.entries, dataIntact: report.dataIntact, prefixBytes: report.prefixBytes })}`)
}

/**
 * The archive cross-check, stated once so S2 and the round trip cannot drift apart.
 *
 * `prefixed` is the difference between the two call sites, and it is a fact about the
 * bytes, not a tolerance knob: the merged file IS `[image][zip]`, so Info-ZIP is expected
 * to warn about the prefix and exit 1, and the recovered file IS a bare zip, so it is
 * expected to exit 0 with no warning. In both cases every entry must test OK and the
 * data must be reported intact.
 */
function assertArchive(label, report, expectedEntries, prefixed) {
  const lines = [`[FAIL] ${label}`]
  const problems = []

  if (!report.allEntriesOk) problems.push(`not every entry tested OK (${JSON.stringify(report.entries)})`)
  if (report.entries.length !== expectedEntries.length) {
    problems.push(`expected ${expectedEntries.length} entries, unzip tested ${report.entries.length}`)
  }
  for (const want of expectedEntries) {
    if (!report.names.includes(want)) problems.push(`missing entry ${want}`)
  }
  if (!report.dataIntact) problems.push('unzip did not report "No errors detected in compressed data"')
  if (prefixed) {
    if (report.prefixBytes === null) problems.push('expected the "extra bytes at beginning" prefix warning, and it is absent')
    if (report.status === 0) problems.push('expected a non-zero exit for a prefixed archive (Info-ZIP signals the prefix that way)')
  } else {
    if (report.prefixBytes !== null) problems.push(`unexpected prefix warning for a bare archive (${report.prefixBytes} extra bytes)`)
    if (report.status !== 0) problems.push(`expected exit 0 for a bare archive, got ${report.status}`)
  }

  if (problems.length > 0) {
    fail(label, problems.join('; '))
    return false
  }
  ok(
    label,
    prefixed
      ? `every entry tests OK and unzip reports the data intact: entries ${JSON.stringify(report.names)}; Info-ZIP flagged the ${report.prefixBytes}-byte image prefix and exited ${report.status} (its documented behaviour for a prefixed archive)`
      : `every entry tests OK and unzip reports the data intact: entries ${JSON.stringify(report.names)}; exit ${report.status}, no prefix warning`,
  )
  return true
}

// --------------------------------------------------------------------------------------
// Step wrapper: timeout + diagnosable failure
// --------------------------------------------------------------------------------------

function withTimeout(promise, ms, label) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/**
 * Playwright reports a hung selector as `waiting for locator('#merge-run')` in its call
 * log. Recovering that string is what turns "Timeout 20000ms exceeded" into a sentence
 * naming the element that actually hung.
 */
function extractLocator(error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  return /waiting for (?:locator|selector)\(([^)]*)\)/.exec(message)?.[1] ?? null
}

async function visibleText(page) {
  if (page === null || page === undefined || page.isClosed()) return '(page unavailable)'
  try {
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())
    return text === '' ? '(empty)' : text.length > 400 ? `${text.slice(0, 400)}...` : text
  } catch (error) {
    return `(unreadable: ${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * Runs one named step under the 20s per-step budget. A failure prints the locator that
 * hung plus the page's visible text and records a `[FAIL]`; it never hands back a value
 * the caller could mistake for a pass.
 */
async function step(id, page, description, body) {
  try {
    return { id, value: await withTimeout(body(), STEP_TIMEOUT, `${id} ${description}`), failed: false }
  } catch (error) {
    fail(id, `${description} -- ${error instanceof Error ? error.message : String(error)}`)
    note(`locator that failed: ${extractLocator(error) ?? '(not a locator timeout)'}`)
    note(`page visible text: ${await visibleText(page)}`)
    return { id, value: null, failed: true }
  }
}

// --------------------------------------------------------------------------------------
// Page interaction helpers
// --------------------------------------------------------------------------------------

/** Three separate gates: attached, visible, and not `disabled`. */
async function waitEnabled(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible', timeout: STEP_TIMEOUT })
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel)
      return el instanceof HTMLElement && !el.disabled
    },
    selector,
    { timeout: STEP_TIMEOUT },
  )
}

/** Clicks and captures the download the click schedules; the wait must be armed first. */
async function clickAndDownload(page, selector, saveAsPath) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: STEP_TIMEOUT }),
    page.click(selector),
  ])
  tookDownloadPath = true
  await download.saveAs(saveAsPath)
  // `delete()` is not cleanup for its own sake: it waits for Chromium to finish streaming
  // the download and then releases it. Without it an in-flight download is still live
  // when the context closes, and Playwright raises an unhandled TargetClosedError from
  // its own frame teardown -- which kills the run after every real check already passed.
  await download.delete()
  return download
}

async function isDisabled(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el === null ? null : el.disabled === true
  }, selector)
}

async function textOf(page, selector) {
  const locator = page.locator(selector)
  if ((await locator.count()) === 0) return null
  return (await locator.first().innerText()).trim()
}

/** The `index`-th match's text; needed where one readout holds several byte counters. */
async function textOfNth(page, selector, index) {
  const locator = page.locator(selector)
  if ((await locator.count()) <= index) return null
  return (await locator.nth(index).innerText()).trim()
}

/**
 * A byte counter's text as a number. `ByteOffset` groups thousands with commas on purpose
 * (25,662), so the rendered text is compared after the separators are stripped -- reading
 * the formatted string as a raw integer would be a bug in the CHECK, not in the panel.
 */
function asByteCount(text) {
  return text === null ? null : Number(text.replace(/[,\s]/g, ''))
}

async function waitForText(page, selector, needle) {
  await page.waitForFunction(
    ([sel, wanted]) => (document.querySelector(sel)?.textContent ?? '').includes(wanted),
    [selector, needle],
    { timeout: STEP_TIMEOUT },
  )
}

// --------------------------------------------------------------------------------------
// In-page measurements
// --------------------------------------------------------------------------------------

/**
 * Scroll metrics and the horizontal-overflow census in ONE round trip, so the two cannot
 * be sampled at different moments. An element counts as overflowing when its border box
 * extends past the viewport's usable width; a 0.5px tolerance absorbs sub-pixel layout
 * rounding, which is not a defect.
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
 * Line geometry of one text block, measured PER CHARACTER.
 *
 * A range over the whole text only reports how many line boxes exist. An orphan needs the
 * FILL of the last line: a two-line render whose second line holds one glyph is the
 * defect, while a three-line render with an even split is correct. So every character gets
 * its own one-character range and the characters are bucketed by `top`, which yields exact
 * per-line glyph counts with no tunable threshold and nothing left to weaken.
 */
async function measureLines(page, selector) {
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
    // Browsers return sub-pixel line-box tops, so lines are joined with a 1.5px epsilon;
    // without it a single wrapped line would be counted as two.
    const perLine = []
    for (const top of tops) {
      const joined = perLine.findIndex((known) => Math.abs(known.top - top) <= 1.5)
      if (joined === -1) perLine.push({ top, glyphs: 1 })
      else perLine[joined].glyphs += 1
    }

    return {
      found: true,
      measurable: true,
      text,
      chars: text.length,
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
// Server lifecycle
// --------------------------------------------------------------------------------------

/**
 * Spawns `vite preview` as a DIRECT node child. The `.cmd` shim in `node_modules/.bin`
 * would add a `cmd.exe` layer that `child.kill()` cannot reliably reach on Windows, which
 * is exactly how an orphan server on 4173 happens; calling the vite entry point through
 * `process.execPath` keeps the kill exact.
 */
async function startPreview() {
  await requireFile(VITE_BIN, 'vite binary (run `pnpm install` first)')

  // `--host 127.0.0.1` is explicit, not decoration: vite preview otherwise binds
  // `localhost`, which on this Windows host resolves to `::1` only, so a poll of the
  // documented `http://127.0.0.1:4173/` origin never connects even though the server is
  // up. Pinning the host makes the origin the run reports the one the run really used.
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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
// Scenarios
// --------------------------------------------------------------------------------------

/** S2 + S15 + S17: the merge, its download, its bytes, and its decodability. */
async function scenarioMerge(page, lengths) {
  banner('S2 / S15 / S17  merge via the real page, real download, real archive tool, real decoder')

  const inputs = await step('S2.setInputs', page, 'set #img-input and #zip-input from the fixtures', () =>
    page.setInputFiles('#img-input', FIXTURES.image).then(() => page.setInputFiles('#zip-input', FIXTURES.payload)),
  )
  if (inputs.failed) return { mergedPath: null }

  const runEnabled = await step('S2.runEnabled', page, '#merge-run becomes enabled', () => waitEnabled(page, '#merge-run'))
  if (runEnabled.failed) return { mergedPath: null }

  const ran = await step('S2.run', page, 'click #merge-run, then wait for #merge-download to enable', async () => {
    await page.click('#merge-run')
    await waitEnabled(page, '#merge-download')
  })
  if (ran.failed) return { mergedPath: null }

  const mergedPath = path.join(DOWNLOADS_DIR, 'merged-from-ui.png')
  const captured = await step('S2.download', page, 'click #merge-download and capture the download', () =>
    clickAndDownload(page, '#merge-download', mergedPath),
  )
  if (captured.failed) return { mergedPath: null }

  const suggested = captured.value.suggestedFilename()
  const actual = await byteSize(mergedPath)

  note(`download.suggestedFilename() = ${JSON.stringify(suggested)}`)
  note(`saved file = ${rel(mergedPath)}`)
  note(`byte lengths: photo.png=${lengths.image} + payload.zip=${lengths.payload} = ${lengths.expected} expected ; saved=${actual}`)

  // (a) The output keeps the IMAGE's own extension. Renaming it to `.zip` is the USER's
  //     move -- doing it in the download would advertise what the file is.
  suggested === 'photo.png'
    ? ok('S15', `the download keeps the cover image's own extension: suggestedFilename() === "photo.png", not ".zip"`)
    : fail('S15', `expected suggestedFilename() "photo.png", got ${JSON.stringify(suggested)}`)

  // (b) The merge is pure concatenation: image bytes then archive bytes, nothing inserted.
  actual === lengths.expected
    ? ok('S2.bytes', `the saved file is exactly photo.png (${lengths.image}) + payload.zip (${lengths.payload}) = ${actual} bytes`)
    : fail('S2.bytes', `expected ${lengths.expected} bytes, the saved file is ${actual} bytes`)

  // (c) An independent ZIP reader agrees, after the extension rename that IS the tool.
  const renamed = path.join(DOWNLOADS_DIR, 'merged-renamed.zip')
  await copyFile(mergedPath, renamed)
  printUnzip(rel(renamed), unzipReport(renamed))
  assertArchive('S2.archive', unzipReport(renamed), EXPECTED_ENTRIES, true)

  // S17: the browser's own decode of the MERGED bytes. A trailing archive must not break
  // image decoding. If createImageBitmap rejects here the product promise is broken, so a
  // rejection is reported as a failure and never swallowed.
  const mergedBytes = [...new Uint8Array(await readFile(mergedPath))]
  const decoded = await step('S17.decode', page, 'createImageBitmap on the merged bytes via an object URL', () =>
    page.evaluate(async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      try {
        const bitmap = await createImageBitmap(blob)
        const size = { resolved: true, width: bitmap.width, height: bitmap.height }
        bitmap.close()
        return size
      } catch (error) {
        return { resolved: false, reason: error instanceof Error ? error.message : String(error) }
      } finally {
        URL.revokeObjectURL(url)
      }
    }, mergedBytes),
  )

  if (!decoded.failed) {
    const result = decoded.value
    result.resolved
      ? ok('S17', `createImageBitmap RESOLVED on the ${actual}-byte merged file: ${result.width} x ${result.height} -- the trailing archive does not break decoding`)
      : fail('S17', `createImageBitmap REJECTED on the merged bytes: ${result.reason}`)
  }

  // A second, independent real-browser observable of the same claim: the page's own <img>
  // preview of the merged blob must have decoded to a non-zero intrinsic size.
  const preview = await page.evaluate(() => {
    const img = document.querySelector('[data-testid="merge-preview"]')
    if (img === null) return null
    return { complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }
  })
  note(`merge panel <img data-testid="merge-preview"> = ${JSON.stringify(preview)}`)
  preview !== null && preview.complete === true && preview.naturalWidth > 0 && preview.naturalHeight > 0
    ? ok('S17.preview', `the page's own preview of the merged blob rendered: naturalWidth=${preview.naturalWidth} naturalHeight=${preview.naturalHeight}`)
    : fail('S17.preview', `the merged-blob preview did not decode: ${JSON.stringify(preview)}`)

  return { mergedPath }
}

/** S6: a pure image carries no archive, and the manual escape hatch survives that. */
async function scenarioPureImage(page) {
  banner('S6  a pure image has no appended archive')

  const set = await step('S6.setInput', page, 'set #disguised-input to photo.png', () =>
    page.setInputFiles('#disguised-input', FIXTURES.image),
  )
  if (set.failed) return

  const settled = await step('S6.settled', page, 'wait for the not-detected verdict', () =>
    waitForText(page, '[data-testid="extract-summary"]', '未在此文件中找到 ZIP'),
  )
  if (settled.failed) return

  const summary = await textOf(page, '[data-testid="extract-summary"]')
  const method = await textOf(page, '.method-value')
  const offsetDisabled = await isDisabled(page, '#offset-input')
  const applyDisabled = await isDisabled(page, '#offset-apply')

  note(`extract-summary       = ${JSON.stringify(summary)}`)
  note(`detection method label = ${JSON.stringify(method)}`)
  note(`#offset-input disabled = ${offsetDisabled}`)
  note(`#offset-apply disabled = ${applyDisabled}`)

  summary !== null && summary.includes('未在此文件中找到 ZIP')
    ? ok('S6', 'a pure image reports the not-detected error state')
    : fail('S6', `expected a not-detected error state, got ${JSON.stringify(summary)}`)

  offsetDisabled === false && applyDisabled === false
    ? ok('S6.manualOffset', '#offset-input (and #offset-apply) stay ENABLED -- a detection miss does not take away the manual escape hatch')
    : fail('S6.manualOffset', `#offset-input disabled=${offsetDisabled} #offset-apply disabled=${applyDisabled}; the escape hatch must survive a detection miss`)
}

/** S8: a bare archive starts at byte 0 and there is no picture to hand back. */
async function scenarioBareArchive(page) {
  banner('S8  a bare archive has offset 0 and no image to hand back')

  const set = await step('S8.setInput', page, 'set #disguised-input to payload.zip', () =>
    page.setInputFiles('#disguised-input', FIXTURES.payload),
  )
  if (set.failed) return

  const settled = await step('S8.settled', page, 'wait for the offset-0 warning', () =>
    waitForText(page, '[data-testid="extract-summary"]', '偏移为 0'),
  )
  if (settled.failed) return

  const offset = await asByteCount(await textOfNth(page, '[data-testid="extract-readout"] .offset .value', 0))
  const summary = await textOf(page, '[data-testid="extract-summary"]')
  const panelNote = await textOf(page, '#panel-extract .note')
  const entries = await textOf(page, '[data-testid="extract-entries"]')
  const imageDisabled = await isDisabled(page, '#image-download')
  const zipDisabled = await isDisabled(page, '#zip-download')

  note(`reported 压缩包起始偏移 = ${offset}`)
  note(`extract-summary          = ${JSON.stringify(summary)}`)
  note(`panel .note              = ${JSON.stringify(panelNote)}`)
  note(`entries line             = ${JSON.stringify(entries)}`)
  note(`#image-download disabled = ${imageDisabled}`)
  note(`#zip-download   disabled = ${zipDisabled}`)

  offset === 0
    ? ok('S8', 'a bare archive reports offset 0 -- the archive really does start at byte 0')
    : fail('S8', `expected the reported offset to be 0, got ${offset}`)

  summary !== null && summary.includes('偏移为 0') && summary.includes('没有图片前缀')
    ? ok('S8.warning', 'the panel shows the no-image-prefix warning')
    : fail('S8.warning', `expected a no-image-prefix warning, got ${JSON.stringify(summary)}`)

  imageDisabled === true
    ? ok('S8.noImageDownload', '#image-download is disabled -- at offset 0 there is no picture to hand back')
    : fail('S8.noImageDownload', `#image-download disabled=${imageDisabled}; it must be disabled at offset 0`)

  zipDisabled === false
    ? ok('S8.zipStillAvailable', '#zip-download is still enabled -- a bare archive is itself recoverable')
    : fail('S8.zipStillAvailable', `#zip-download disabled=${zipDisabled}; a bare archive must stay downloadable`)
}

/** The full loop: the merged file goes back in and the archive comes back out. */
async function scenarioRoundTrip(page, mergedPath, lengths) {
  banner('ROUND-TRIP  the file merged in S2 goes back into 还原 and the archive comes out')
  if (mergedPath === null) {
    fail('RT.setup', 'no merged file to round-trip because S2 failed')
    return
  }

  const set = await step('RT.setInput', page, 'set #disguised-input to the file downloaded in S2', () =>
    page.setInputFiles('#disguised-input', mergedPath),
  )
  if (set.failed) return

  const settled = await step('RT.settled', page, 'wait for the readout to appear', () =>
    page.waitForSelector('[data-testid="extract-readout"]', { timeout: STEP_TIMEOUT }),
  )
  if (settled.failed) return

  const offset = await asByteCount(await textOfNth(page, '[data-testid="extract-readout"] .offset .value', 0))
  const prefix = await asByteCount(await textOfNth(page, '[data-testid="extract-readout"] .offset .value', 1))
  const zipPill = await textOf(page, '[data-testid="zip-pill"]')
  const imagePill = await textOf(page, '[data-testid="image-pill"]')
  const summary = await textOf(page, '[data-testid="extract-summary"]')
  const zipDisabled = await isDisabled(page, '#zip-download')
  const imageDisabled = await isDisabled(page, '#image-download')

  note(`reported 压缩包起始偏移 = ${offset} (the panel groups thousands; expected exactly ${lengths.image})`)
  note(`reported 图片长度       = ${prefix}`)
  note(`zip pill                = ${JSON.stringify(zipPill)}`)
  note(`image pill              = ${JSON.stringify(imagePill)}`)
  note(`extract-summary         = ${JSON.stringify(summary)}`)
  note(`#zip-download disabled=${zipDisabled}  #image-download disabled=${imageDisabled}`)

  offset === lengths.image
    ? ok('RT.offset', `the reported offset equals the cover image's length exactly: ${offset} === ${lengths.image}`)
    : fail('RT.offset', `expected offset ${lengths.image}, got ${offset}`)

  zipPill !== null && zipPill.includes('压缩包完整') && imagePill !== null && imagePill.includes('图片前缀有效')
    ? ok('RT.bothHalves', `both halves verified in the UI: zip "${zipPill}" / image "${imagePill}"`)
    : fail('RT.bothHalves', `expected both halves verified, got zip=${JSON.stringify(zipPill)} image=${JSON.stringify(imagePill)}`)

  const recovered = path.join(DOWNLOADS_DIR, 'recovered.zip')
  const captured = await step('RT.download', page, 'click #zip-download and capture the archive', () =>
    clickAndDownload(page, '#zip-download', recovered),
  )
  if (captured.failed) return

  const size = await byteSize(recovered)
  note(`recovered download: suggestedFilename()=${JSON.stringify(captured.value.suggestedFilename())} size=${size} (the original payload.zip is ${lengths.payload})`)

  const report = unzipReport(recovered)
  printUnzip(rel(recovered), report)
  assertArchive('RT.archive', report, EXPECTED_ENTRIES, false)
  size === lengths.payload
    ? ok('RT.size', `the recovered archive is exactly as long as the original payload.zip (${size} bytes)`)
    : fail('RT.size', `expected ${lengths.payload} bytes, the recovered archive is ${size} bytes`)
}

/** S16: no horizontal overflow at a given width, on the given tab, in the given state. */
async function scenarioResponsive(page, label, tabId, state) {
  const id = `S16.${label}.${tabId.replace('#tab-', '')}.${state}`
  if (state === 'switched') {
    const switched = await step(id, page, `activate ${tabId}`, async () => {
      await page.click(tabId)
      // The tab switch DESTROYS the inactive panel and builds the active one; a short
      // settle keeps the measurement off a half-mounted DOM.
      await page.waitForTimeout(150)
    })
    if (switched.failed) return
  }

  const metrics = await measureLayout(page)
  note(`${label} / ${tabId} / ${state}: documentElement.scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth} elementsPastClientWidth=${metrics.count}`)
  for (const offender of metrics.offenders) {
    note(`  overflow: <${offender.tag}> id=${offender.id} class="${offender.cls}" right=${offender.right} text=${JSON.stringify(offender.text)}`)
  }

  metrics.scrollWidth <= metrics.clientWidth
    ? ok(id, `${label}/${tabId} (${state}): scrollWidth ${metrics.scrollWidth} <= viewport ${metrics.clientWidth}`)
    : fail(id, `${label}/${tabId} (${state}): horizontal overflow -- scrollWidth ${metrics.scrollWidth} > viewport ${metrics.clientWidth}`)

  metrics.count === 0
    ? ok(`${id}.elements`, `${label}/${tabId} (${state}): zero elements have getBoundingClientRect().right > clientWidth ${metrics.clientWidth}`)
    : fail(`${id}.elements`, `${label}/${tabId} (${state}): ${metrics.count} element(s) extend past clientWidth ${metrics.clientWidth}: ${JSON.stringify(metrics.offenders)}`)
}

/**
 * The CJK regression gate.
 *
 * The two defects that were just fixed were ORPHANS, not line counts. The merge panel's
 * `尚未选择` placeholder used to break as `尚未选 / 择`, and the extract panel's `.title`
 * used to strand one or two glyphs on a final line. So the two blocks are held to
 * different -- and individually correct -- bars:
 *
 *   - The placeholder is a fixed four-glyph string behind `white-space: nowrap`, so it
 *     must measure exactly ONE line-height at every width. Two lines is a FAIL,
 *     unconditionally, at 390 and at 1440 alike.
 *   - The `.title` is a 50-glyph sentence, so at 390px it is SUPPOSED to occupy several
 *     lines; demanding one line there would be demanding worse typography. What must
 *     never happen is a last line holding a single glyph. The per-character census above
 *     measures exactly that, so this bar is strictly stronger than a line count: it fails
 *     a two-line orphan AND a four-line render that strands one character.
 */
async function scenarioCjk(page, label, selector, description, mode) {
  const id = `CJK.${label}.${selector}`
  const measurement = await measureLines(page, selector)

  if (measurement.found !== true) {
    fail(id, `${label}: ${description} -- selector ${selector} is not present on the active tab`)
    return
  }
  if (measurement.measurable !== true) {
    fail(id, `${label}: ${description} -- the element has no single text node, so its lines cannot be censused`)
    return
  }

  note(`${label} ${selector} (${description}):`)
  note(`  text=${JSON.stringify(measurement.text)} chars=${measurement.chars}`)
  note(`  height=${measurement.height}px computedLineHeight=${measurement.lineHeight}px heightInLineHeights=${measurement.heightInLineHeights}`)
  note(`  lines=${measurement.lines} glyphsPerLine=${JSON.stringify(measurement.perLine)} lastLineGlyphs=${measurement.lastLineGlyphs}`)

  if (mode === 'single-line') {
    const allOnOneLine = measurement.lines === 1 && measurement.lastLineGlyphs === measurement.chars
    const oneLineHeight = measurement.heightInLineHeights !== null && measurement.heightInLineHeights <= 1.15
    allOnOneLine && oneLineHeight
      ? ok(id, `${label}: ${description} renders on ONE line -- height ${measurement.height}px = ${measurement.heightInLineHeights} x lineHeight ${measurement.lineHeight}px, all ${measurement.chars} glyphs on it`)
      : fail(id, `${label}: ${description} ORPHANED -- ${measurement.lines} line(s), glyphs per line ${JSON.stringify(measurement.perLine)}, height ${measurement.height}px vs lineHeight ${measurement.lineHeight}px`)
  } else {
    measurement.lastLineGlyphs >= 2
      ? ok(id, `${label}: ${description} has no orphan -- ${measurement.lines} line(s), glyphs per line ${JSON.stringify(measurement.perLine)}, the last line holds ${measurement.lastLineGlyphs}`)
      : fail(id, `${label}: ${description} ORPHANED -- ${measurement.lines} line(s), glyphs per line ${JSON.stringify(measurement.perLine)}, the last line holds only ${measurement.lastLineGlyphs} glyph(s)`)
  }
}

/** Screenshots are evidence, not assertions -- so each one is byte-checked as well. */
async function shoot(page, name) {
  const file = path.join(SHOTS_DIR, name)
  await page.screenshot({ path: file, fullPage: true })
  const size = await byteSize(file)
  note(`screenshot ${rel(file)} (${size} bytes)`)
  size > 0 ? ok(`shot.${name}`, `${name} is ${size} bytes`) : fail(`shot.${name}`, `${name} is EMPTY (0 bytes)`)
}

// --------------------------------------------------------------------------------------
// Passes
// --------------------------------------------------------------------------------------

/** Wires a page's console and uncaught errors into this log: a page-side error must be visible. */
function wirePage(page, prefix) {
  page.setDefaultTimeout(STEP_TIMEOUT)
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      note(`[${prefix} console.${message.type()}] ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => note(`[${prefix} pageerror] ${error.message}`))
}

async function openPage(context, prefix) {
  const page = await context.newPage()
  wirePage(page, prefix)
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: STEP_TIMEOUT })
  await page.waitForSelector('#tab-disguise', { timeout: STEP_TIMEOUT })
  return page
}

async function desktopPass(browser, lengths) {
  banner('DESKTOP PASS  1440x900')
  const context = await browser.newContext({ acceptDownloads: true, viewport: DESKTOP })
  const page = await openPage(context, 'desktop')

  await scenarioResponsive(page, 'desktop', '#tab-disguise', 'initial')
  await scenarioCjk(page, 'desktop', '[data-testid="merge-image-name"]', 'merge 尚未选择 placeholder (image)', 'single-line')
  await scenarioCjk(page, 'desktop', '[data-testid="merge-payload-name"]', 'merge 尚未选择 placeholder (payload)', 'single-line')
  await shoot(page, 'merge-desktop.png')

  const { mergedPath } = await scenarioMerge(page, lengths)
  await shoot(page, 'merge-result-desktop.png')

  await scenarioResponsive(page, 'desktop', '#tab-extract', 'switched')
  await scenarioCjk(page, 'desktop', '#panel-extract .title', 'extract .title heading', 'no-orphan')
  await shoot(page, 'extract-desktop.png')

  await scenarioPureImage(page)
  await scenarioBareArchive(page)
  await scenarioRoundTrip(page, mergedPath, lengths)

  // The page is closed explicitly, and awaited, BEFORE the context. Closing the context
  // directly races Playwright's own frame teardown: the browser detaches the target while
  // a frame session is still live, and that surfaces as an unhandled TargetClosedError
  // which in Node 18 aborts the process before the verdict is ever printed.
  await page.close()
  await context.close()
}

async function mobilePass(browser) {
  banner('MOBILE PASS  390x844')
  const context = await browser.newContext({ acceptDownloads: true, viewport: MOBILE })
  const page = await openPage(context, 'mobile')

  await scenarioResponsive(page, 'mobile', '#tab-disguise', 'initial')
  await scenarioCjk(page, 'mobile', '[data-testid="merge-image-name"]', 'merge 尚未选择 placeholder (image)', 'single-line')
  await scenarioCjk(page, 'mobile', '[data-testid="merge-payload-name"]', 'merge 尚未选择 placeholder (payload)', 'single-line')
  await shoot(page, 'merge-mobile.png')

  await scenarioResponsive(page, 'mobile', '#tab-extract', 'switched')
  await scenarioCjk(page, 'mobile', '#panel-extract .title', 'extract .title heading', 'no-orphan')
  await shoot(page, 'extract-mobile.png')

  // The empty panels render NO status pill, so the empty-state measurements above cannot
  // see a verdict at all -- and a verdict is the LONGEST string in either panel. Repeating
  // the census with a verdict actually rendered is the difference between measuring the
  // easy case and measuring the case a user is in when something needs telling them.
  const loaded = await step('S16.mobile.verdict.setInput', page, 'load a file so the extract verdict renders', () =>
    page.setInputFiles('#disguised-input', FIXTURES.image),
  )
  if (!loaded.failed) {
    await waitForText(page, '[data-testid="extract-summary"]', '未在此文件中找到 ZIP').catch((error) =>
      note(`extract verdict text never appeared: ${error instanceof Error ? error.message : String(error)}`),
    )
    await scenarioResponsive(page, 'mobile', '#tab-extract', 'verdict-shown')
  }

  // Same census for the merge panel's own success verdict, so the defect report below is
  // complete rather than limited to whichever panel happened to be measured.
  await scenarioResponsive(page, 'mobile', '#tab-disguise', 'switched')
  const merged = await step('S16.mobile.merge.run', page, 'merge on mobile so the success verdict renders', async () => {
    await page.setInputFiles('#img-input', FIXTURES.image)
    await page.setInputFiles('#zip-input', FIXTURES.payload)
    await waitEnabled(page, '#merge-run')
    await page.click('#merge-run')
    await waitEnabled(page, '#merge-download')
  })
  if (!merged.failed) {
    await scenarioResponsive(page, 'mobile', '#tab-disguise', 'verdict-shown')
  }

  await page.close()
  await context.close()
}

// --------------------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------------------

async function main() {
  await requireFile(FIXTURES.image, 'image fixture')
  await requireFile(FIXTURES.payload, 'archive fixture')
  await requireFile(path.join(ROOT, 'dist', 'index.html'), 'built output (run `pnpm build` first)')

  await mkdir(SHOTS_DIR, { recursive: true })
  await mkdir(DOWNLOADS_DIR, { recursive: true })
  // A stale artifact must never be mistaken for this run's evidence.
  for (const stale of ['merged-from-ui.png', 'merged-renamed.zip', 'recovered.zip']) {
    await rm(path.join(DOWNLOADS_DIR, stale), { force: true })
  }

  const lengths = { image: await byteSize(FIXTURES.image), payload: await byteSize(FIXTURES.payload) }
  lengths.expected = lengths.image + lengths.payload
  note(`fixtures: photo.png=${lengths.image}B  payload.zip=${lengths.payload}B  expected merged=${lengths.expected}B`)
  note(`archive cross-check tool: ${UNZIP} (Info-ZIP). .NET is NOT used anywhere: it cannot read a prefixed archive.`)

  let preview = null
  let browser = null
  try {
    preview = await startPreview()
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    note(`browser: chromium channel=msedge ${browser.version()} (no browser was downloaded)`)

    await desktopPass(browser, lengths)
    await mobilePass(browser)
  } finally {
    // Nothing may outlive this process: the browser closes first so no page keeps a
    // socket to the preview server, then the child is killed, then the port is re-checked
    // from inside this process. `scripts/teardown.ps1` checks the same things from outside.
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

  banner('VERDICT')
  const failures = results.filter((result) => !result.pass)
  for (const result of results) if (!result.pass) console.log(`[FAIL] ${result.id}`)
  console.log(`checks: ${results.length} ; passed: ${results.length - failures.length} ; failed: ${failures.length}`)
  console.log(`known Playwright artifacts (reported, not product verdicts): ${artifacts.length}`)
  console.log(`screenshots: ${rel(SHOTS_DIR)}`)
  console.log(`downloads:   ${rel(DOWNLOADS_DIR)}`)
  console.log(failures.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
  process.exitCode = failures.length === 0 ? 0 : 1
}

await main()
