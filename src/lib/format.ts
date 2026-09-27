/**
 * Byte sizes as short, aligned strings.
 *
 * This is the only place in the app that turns a byte count into something a human reads
 * twice, and it exists as its own module because the answer has two rules that the panels
 * must not each re-invent:
 *
 * 1. **Always one decimal place above bytes.** `2.0 MB`, never `2 MB`. The whole interface
 *    is built on `font-variant-numeric: tabular-nums` (`base.css`'s `.mono`), which keeps
 *    *digits* in fixed-width columns -- but the decimal point and the unit label are still
 *    ordinary glyphs, so a formatter that trims a trailing `.0` makes the size column
 *    change width as files are chosen. A byte column that jitters is worse than one with a
 *    redundant zero.
 * 2. **Total.** A negative or non-finite input is not an error to throw and not a string to
 *    render: `NaN B` and `-1 B` in a card read as a bug report. Both collapse to `0 B`,
 *    which is a true statement ("no bytes") rather than a visible defect.
 *
 * The ladder stops at GB on purpose. This tool warns above 256 MB and a browser tab cannot
 * hold a terabyte, so inventing a `TB` unit here would add a label no other part of the
 * interface knows how to speak; anything past the top unit is reported as a large number
 * in that unit instead, which is exact and needs no new vocabulary.
 */

/** One kibibyte. Binary prefixes, deliberately: every other tool in the app counts bytes. */
const KIB = 1024

/** The ladder, largest last. `value` is divided once per step until it fits the unit. */
const UNITS = ['KB', 'MB', 'GB'] as const

/**
 * A byte count as a short human string: `'0 B'`, `'1023 B'`, `'1.5 KB'`, `'2.0 MB'`.
 *
 * Total by construction: every input has an output, and no input can produce `NaN` or a
 * negative rendering.
 */
export function formatBytes(bytes: number): string {
  // `NaN` fails the finite test, and `-Infinity` fails it too, so one guard covers the
  // non-finite pair; `bytes <= 0` then covers negatives and zero with the same rendering.
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < KIB) return `${Math.trunc(bytes)} B`

  let value = bytes
  for (const unit of UNITS) {
    value /= KIB
    // `< KIB` and not `<=`: exactly 1024 KB is one megabyte, and reporting it as
    // "1024.0 KB" is the same jitter defect the decimal rule exists to prevent.
    if (value < KIB) return `${value.toFixed(1)} ${unit}`
  }

  // Past the top of the ladder: `value` has been divided three times, so it is the size in
  // GB. A large number beats a unit nothing else in the app would agree to print.
  return `${value.toFixed(1)} ${UNITS[UNITS.length - 1]}`
}
