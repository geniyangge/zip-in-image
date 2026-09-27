/**
 * The extract panel: take one file that might be a picture with an archive hidden
 * behind it, find where the archive starts, and cut there.
 *
 * Every hard question is answered in `@/lib` and only *asked* here: `@/lib/zip` owns
 * the byte-level truth, `@/lib/stego` owns the cut, `probeImage` owns "is the prefix a
 * picture", `sanitizeFileName` owns naming. What is left is state and three decisions
 * that are genuinely panel policy:
 *
 * 1. The manual offset stays live once a file is loaded. A detector answering "no
 *    archive here" is a statement about the *file*, not a verdict on the user's file,
 *    so the escape hatch must survive it.
 * 2. An out-of-range offset is CLAMPED and reported, never thrown: the number field is
 *    a free-text input whose half-typed states are normal, and the clamp is the more
 *    actionable fact, so it outranks the validation verdict in the pill.
 * 3. A valid archive behind an undecodable prefix is a WARNING, not an error -- the
 *    archive is intact and downloadable, which is what the user came for.
 *
 * The environment shapes the seams exactly as in `useMergePanel`: node has neither
 * `createImageBitmap` nor a global `File`, so the decoder and the object-URL pair are
 * injected. Nothing here touches `document` or `window`, and the file is read once.
 */
import { computed, ref, shallowRef } from 'vue'
import { browserImageDecoder, probeImage } from '@/lib/imageProbe'
import type { ImageDecoder, ImageProbe } from '@/lib/imageProbe'
import { sanitizeFileName, sliceBlob, splitAtOffset } from '@/lib/stego'
import type { SplitResult } from '@/lib/stego'
import { detectZipStart, validateZipSlice } from '@/lib/zip'
import type { ZipStartDetection, ZipValidation, ZipValidationReason } from '@/lib/zip'

/** The four states the status pill understands; declared here so the panels stay independent. */
export type StatusTone = 'ok' | 'warn' | 'error' | 'idle'

/**
 * A picked file, narrowed to the only two members this panel reads. A browser `File`
 * satisfies this structurally, so `<input type="file">` hands straight in; the node
 * specs pass a `Blob` carrying a `name` member instead. Narrowing here is what keeps
 * every `@/lib` signature on `Blob`.
 */
export interface PickedFile extends Blob {
  readonly name: string
}

export interface ExtractDeps {
  /** Decides whether the recovered prefix is a real picture. Injected: see the header. */
  decode: ImageDecoder
  createObjectUrl: (blob: Blob) => string
  revokeObjectUrl: (url: string) => void
}

/**
 * The real implementations, wrapped in arrows: the bodies only touch `URL` when called,
 * so importing this module where the object-URL API is absent stays safe.
 */
const defaultDeps: ExtractDeps = {
  decode: browserImageDecoder,
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
}

/** One sentence per way the archive can fail to verify, keyed by the lib's own union. */
const SLICE_FAILURE: Record<ZipValidationReason, string> = {
  'no-eocd': '该位置之后没有找到 ZIP 结尾目录记录（EOCD），请调整偏移量。',
  'cd-out-of-bounds': '中央目录越界：这个偏移量把中央目录切到了文件之外。',
  'cd-signature-mismatch': '中央目录签名不匹配：这个偏移量切在了压缩包中间。',
}

/** The name up to its last dot; a name with no dot is its own base. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function useExtractPanel(deps: Partial<ExtractDeps> = {}) {
  const decode = deps.decode ?? defaultDeps.decode
  const createObjectUrl = deps.createObjectUrl ?? defaultDeps.createObjectUrl
  const revokeObjectUrl = deps.revokeObjectUrl ?? defaultDeps.revokeObjectUrl

  const source = ref<PickedFile | null>(null)
  // The single read of the file, and why it is a `shallowRef`: proxying a
  // multi-megabyte buffer would be both useless and ruinous.
  const bytes = shallowRef<Uint8Array | null>(null)
  const detection = ref<ZipStartDetection | null>(null)
  const zipValidation = ref<ZipValidation | null>(null)
  const imageProbe = ref<ImageProbe | null>(null)
  const prefixBytes = ref(0)
  const offset = ref(0)
  /** The raw text of the number input, so a half-typed value is representable. */
  const manualOffset = ref('')
  const previewUrl = ref<string | null>(null)
  /**
   * An object URL for the WHOLE selected file, published once those bytes are known to be
   * a real picture. This is a second, independent lifetime from `previewUrl` above, and it
   * is not a wider use of it: `previewUrl` is the *validated prefix* and is empty whenever
   * the offset is 0, which for a plain picture is the normal case. Without this value a
   * user who picks a photograph sees no photograph at all -- only a filename and a
   * "no archive here" verdict.
   */
  const sourcePreviewUrl = ref<string | null>(null)
  /**
   * Generation counter for whole-file probes, per panel instance: two panels on one page
   * each have their own in-flight probes, and neither may invalidate the other.
   */
  let sourceProbeToken = 0
  /** Set when a typed offset had to be clamped; it outranks the validation verdict. */
  const clampNotice = ref<string | null>(null)
  /** Reading the file can genuinely fail (a file being rewritten, an allocation). */
  const readFailure = ref<string | null>(null)

  const manualOffsetEnabled = computed(() => source.value !== null)
  const hasImagePrefix = computed(() => offset.value > 0)
  const sourceName = computed(() => source.value?.name ?? '')
  /** Byte count of the selected file; `null` means "nothing chosen", never zero. */
  const sourceSize = computed(() => source.value?.size ?? null)
  /** The recovered picture keeps the source's own name: the disguise changed nothing. */
  const imageFileName = computed(() => sanitizeFileName(sourceName.value))
  const zipFileName = computed(() => sanitizeFileName(`${stripExtension(sourceName.value)}.zip`))

  /**
   * A pair is only as good as its weaker half. `hasImagePrefix` is part of it: at offset
   * 0 there is no picture, and a decoder that approves of an empty blob must not talk
   * the panel into green.
   */
  const bothValid = computed(() => {
    const probe = imageProbe.value
    const validation = zipValidation.value
    return hasImagePrefix.value && probe !== null && probe.ok && validation !== null && validation.ok
  })

  /** The last usable start: a cut at `size` would leave an empty archive. */
  function maxOffset(): number {
    return source.value === null ? 0 : Math.max(0, source.value.size - 1)
  }

  /** Revoking is idempotent by construction: no outstanding URL means nothing to do. */
  function revokePreview(): void {
    const url = previewUrl.value
    if (url === null) return
    revokeObjectUrl(url)
    previewUrl.value = null
  }

  function setPreview(blob: Blob): void {
    revokePreview()
    previewUrl.value = createObjectUrl(blob)
  }

  /** The same contract for the whole-file preview; see `revokePreview` above. */
  function revokeSourcePreview(): void {
    const url = sourcePreviewUrl.value
    if (url === null) return
    revokeObjectUrl(url)
    sourcePreviewUrl.value = null
  }

  /**
   * Starts a new whole-file probe generation and returns it.
   *
   * The decoder is async, so loading A and then B can settle A's probe AFTER B's, and a
   * panel that applied whichever verdict arrived last would display the discarded file
   * under the chosen name. The token is the guard: a result may only touch state while it
   * is still the newest generation, and bumping it here is what makes an in-flight probe
   * stale.
   */
  function beginSourceProbe(): number {
    sourceProbeToken += 1
    return sourceProbeToken
  }

  /**
   * Publishes the selected file's preview once its bytes are known to be a real picture.
   *
   * Probing the ENTIRE file is legitimate here and costs one decode: a decoder stops at
   * the picture's own end marker, so the archive appended behind it is ignored exactly as
   * it is in a real image viewer, and the same probe both answers "is this a picture" and
   * justifies the thumbnail. The validated PREFIX is probed separately by `revalidate`,
   * because that probe answers a different question -- is the part *before* the archive a
   * real picture -- and the green pair verdict is computed from it. Neither is repeated for
   * the other's purpose: the prefix is not decoded twice to produce a second copy of an
   * image whose bytes are already in memory.
   *
   * Safe to leave un-awaited: `probeImage` never rejects, so this has no rejection path,
   * and a panel torn down mid-flight simply finds its token superseded.
   */
  async function publishSourcePreview(file: PickedFile, token: number): Promise<void> {
    const probe = await probeImage(file, decode)
    if (token !== sourceProbeToken) return
    // No object URL for bytes that will not decode: an <img> pointed at them would render
    // a broken-image icon, so the card falls back to name and size on their own.
    if (!probe.ok) return
    sourcePreviewUrl.value = createObjectUrl(file)
  }

  /**
   * Re-answers both questions for the working offset. Every path that moves the offset
   * comes through here, so the two verifications can never describe different offsets.
   */
  async function revalidate(): Promise<void> {
    const file = source.value
    const data = bytes.value
    if (file === null || data === null) return

    const at = Math.min(Math.max(Math.trunc(offset.value), 0), maxOffset())
    offset.value = at
    prefixBytes.value = at
    zipValidation.value = validateZipSlice(data, data.length, at)

    const prefix = sliceBlob(file, 0, at)
    // Nothing to decode at offset 0, so no probe is claimed -- reporting a verdict on
    // an empty blob would be a claim about nothing.
    if (at === 0) {
      imageProbe.value = null
      revokePreview()
      return
    }
    const probe = await probeImage(prefix, decode)
    imageProbe.value = probe
    if (probe.ok) setPreview(prefix)
    else revokePreview()
  }

  function clearState(): void {
    revokeSourcePreview()
    revokePreview()
    source.value = null
    bytes.value = null
    detection.value = null
    zipValidation.value = null
    imageProbe.value = null
    prefixBytes.value = 0
    offset.value = 0
    manualOffset.value = ''
    clampNotice.value = null
    readFailure.value = null
  }

  async function setFile(file: PickedFile | null): Promise<void> {
    if (file === null) {
      reset()
      return
    }
    // This selection's own probe generation, taken before anything is awaited. It must be
    // read HERE and not re-read after `await file.arrayBuffer()`: a second `setFile` can
    // land while this one is suspended and bump the counter, so a probe that read it late
    // would carry the newer file's token and be wrongly allowed to publish the discarded
    // file. Both callers of `clearState` bump the generation for the same reason -- to make
    // a probe still in flight for the outgoing file stale before its URL can be published.
    const probeToken = beginSourceProbe()
    clearState()
    source.value = file

    let data: Uint8Array
    try {
      data = new Uint8Array(await file.arrayBuffer())
    } catch (error) {
      readFailure.value = `读取文件失败：${error instanceof Error ? error.message : String(error)}`
      return
    }
    bytes.value = data

    // Launched, not awaited: the panel's own verdict does not depend on whether the file
    // turns out to be displayable, so the preview is published whenever it is ready rather
    // than delaying every read by one more decode.
    void publishSourcePreview(file, probeToken)

    detection.value = detectZipStart(data, data.length)
    const found = detection.value
    // No archive means no offset to fill in; the field starts at 0 and waits for the
    // user, which is the escape hatch this panel exists to keep usable.
    offset.value = found.kind === 'none' ? 0 : found.offset
    manualOffset.value = String(offset.value)
    await revalidate()
  }

  async function applyManualOffset(): Promise<void> {
    if (source.value === null) return
    const limit = maxOffset()
    const raw = manualOffset.value.trim()
    const parsed = raw === '' ? 0 : Number(raw)

    if (!Number.isFinite(parsed)) {
      clampNotice.value = `无法把「${manualOffset.value}」读作偏移量，已按 0 处理。`
      offset.value = 0
      await revalidate()
      return
    }

    const wanted = Math.trunc(parsed)
    const at = Math.min(Math.max(wanted, 0), limit)
    clampNotice.value = wanted === at ? null : `偏移量 ${wanted} 超出文件范围（0 - ${limit}），已钳制为 ${at}。`
    offset.value = at
    await revalidate()
  }

  function split(): SplitResult | null {
    return source.value === null ? null : splitAtOffset(source.value, offset.value)
  }

  /**
   * One derivation for both halves of the pill, so a tone and its sentence can never
   * disagree. Worst news first, with the clamp outranking the validation verdict.
   */
  const pill = computed<{ tone: StatusTone; message: string | null }>(() => {
    const unreadable = readFailure.value
    if (unreadable !== null) return { tone: 'error', message: unreadable }

    const clamped = clampNotice.value
    if (clamped !== null) return { tone: 'warn', message: clamped }

    if (source.value === null) return { tone: 'idle', message: null }

    const found = detection.value
    if (found !== null && found.kind === 'none') {
      return { tone: 'error', message: '未在此文件中找到 ZIP 压缩包：请确认文件是被伪装过的图片，或手动填写 ZIP 起始偏移后重试。' }
    }

    const validation = zipValidation.value
    if (validation !== null && !validation.ok) {
      return { tone: 'error', message: SLICE_FAILURE[validation.reason] }
    }

    if (!hasImagePrefix.value) {
      return { tone: 'warn', message: '偏移为 0：整个文件被当作压缩包，没有图片前缀可提取。' }
    }

    const probe = imageProbe.value
    if (probe !== null && !probe.ok) {
      return { tone: 'warn', message: 'ZIP 有效，但前半段不是可识别的图片（可能是一份从未被伪装的原始文件）。' }
    }

    return { tone: 'ok', message: '已确认：图片前缀与 ZIP 压缩包均可还原。' }
  })

  const tone = computed(() => pill.value.tone)
  const message = computed(() => pill.value.message)

  function reset(): void {
    // Bumped before the state is dropped, so a whole-file probe still in flight cannot
    // publish a preview for a file the user has just cleared.
    beginSourceProbe()
    clearState()
  }

  /** Nothing outlives the panel: the same teardown, named for the unmount hook. */
  const dispose = reset

  return {
    setFile,
    applyManualOffset,
    split,
    detection,
    zipValidation,
    imageProbe,
    prefixBytes,
    offset,
    manualOffset,
    manualOffsetEnabled,
    hasImagePrefix,
    bothValid,
    sourceName,
    sourceSize,
    imageFileName,
    zipFileName,
    previewUrl,
    sourcePreviewUrl,
    tone,
    message,
    reset,
    dispose,
  }
}
