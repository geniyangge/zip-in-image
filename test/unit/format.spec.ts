// `formatBytes`, written before the module exists.
//
// The one rule this file exists to protect is ALIGNMENT. The whole interface is built on
// `font-variant-numeric: tabular-nums` (`base.css`'s `.mono`), and a size column that
// jitters between `1.5 KB` and `2 KB` destroys the only reason a monospace column is
// worth having. So every unit above bytes carries EXACTLY one decimal place -- `2.0 MB`,
// never `2 MB` -- and a spec pins that here rather than leaving it to taste.
//
// The second rule is totality. This function formats a `number` that came from a
// `Blob.size` in one path and from arithmetic in another, so a negative or a `NaN` can
// reach it. Neither `NaN B` nor `-1 B` may ever be rendered into a card; both collapse to
// `0 B`, which is a true statement about "no bytes" rather than a visible defect.
import { describe, expect, it } from 'vitest'
import { formatBytes } from '@/lib/format'

describe('formatBytes', () => {
  it('renders zero and sub-kilobyte sizes as whole bytes', () => {
    // Given: sizes below one kibibyte, plus the empty file.
    // When: each is formatted.
    // Then: plain bytes, and the empty file says so in the same vocabulary.
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(512)).toBe('512 B')
    // Then: 1023 is the LAST byte-sized value -- one byte more crosses into KB, and
    // this boundary is exactly where an off-by-one would be invisible in the UI.
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
  })

  it('keeps exactly one decimal place so a column of sizes stays aligned', () => {
    // Given: values that would each be "one significant digit" if the formatter trimmed.
    // When: they are formatted.
    // Then: the decimal is always present, which is what makes the glyph count constant
    // and the tabular-numeral column stop wobbling as files are chosen.
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    // 2 MB exactly is the case a trimming formatter gets wrong: it renders "2 MB" and
    // the row above it rendered "1.5 KB", so the size column is one glyph narrower.
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('rounds to one decimal rather than truncating', () => {
    // Given: 1.05 MB and 1.04 MB, which straddle a rounding boundary.
    // When: they are formatted.
    // Then: the first rounds up and the second does not -- a formatter that truncated
    // would print "1.0 MB" for both and understate a file by more than 50 kB.
    expect(formatBytes(Math.round(1.05 * 1024 * 1024))).toBe('1.1 MB')
    expect(formatBytes(Math.round(1.04 * 1024 * 1024))).toBe('1.0 MB')
  })

  it('never renders NaN or a negative size', () => {
    // Given: the inputs a `Blob.size` cannot produce but arithmetic can.
    // When: they are formatted.
    // Then: every one of them collapses to the empty-file rendering, so no card can ever
    // display "NaN B" or "-1 B" -- the two failure modes that look like a bug report.
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
    expect(formatBytes(Number.NEGATIVE_INFINITY)).toBe('0 B')
  })

  it('keeps the unit ladder capped at the largest unit it names', () => {
    // Given: a size past the top of the KB/MB/GB ladder.
    // When: it is formatted.
    // Then: it is reported in the largest unit the formatter names, as a large number,
    // rather than silently inventing a "TB" the rest of the interface never mentions.
    expect(formatBytes(1024 ** 4)).toBe('1024.0 GB')
    expect(formatBytes(2 * 1024 ** 4)).toBe('2048.0 GB')
  })
})
