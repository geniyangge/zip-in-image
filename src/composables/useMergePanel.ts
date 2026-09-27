/**
 * The merge panel: pick a cover image, pick exactly one archive, concatenate.
 *
 * All the real work already exists in `@/lib` -- this module only owns the *state* a
 * panel needs to render and the two decisions that are genuinely UI policy:
 *
 * 1. One archive, never two. Concatenating two archives leaves two end-of-central-
 *    directory records, and every reader honours the last one, so the first archive is
 *    silently orphaned. The rejection is therefore a state value with a machine-readable
 *    reason, not an exception: the drop zone can explain itself next to the field.
 * 2. Nothing throws out of `run()`. It is wired straight to a click handler, where a
 *    rejected promise shows up as an unhandled rejection and a frozen panel. Every
 *    failure becomes a tone plus a Chinese sentence instead.
 *
 * The environment shapes the seams. `test/composable/**` runs under node, where
 * `createImageBitmap` does not exist and neither does a global `File`, so the image
 * decoder and the object-URL pair are injected dependencies (defaulting to the real
 * browser ones) exactly as `probeImage(blob, decode = browserImageDecoder)` already
 * established. Nothing here touches `document` or `window`: the panel is a state
 * machine, and the template decides what a preview URL is for.
 */
import { computed, ref } from 'vue'
import { browserImageDecoder, probeImage } from '@/lib/imageProbe'
import type { ImageDecoder, ImageProbe } from '@/lib/imageProbe'
import { mergeConcat } from '@/lib/stego'
import type { MergeResult } from '@/lib/stego'

/** The four states the status pill understands; mirrors the pill's own vocabulary. */
export type StatusTone = 'ok' | 'warn' | 'error' | 'idle'

/**
 * A picked file, narrowed to the only two members this panel reads: the bytes and the
 * name. A browser `File` satisfies this structurally, so `<input type="file">` hands
 * straight in; the node specs cannot build a `File` (no such global there) and pass a
 * `Blob` carrying a `name` member instead. Narrowing here is what keeps every `@/lib`
 * signature on `Blob` -- no library call below ever has to know a name exists.
 */
export interface PickedFile extends Blob {
  readonly name: string
}

export interface MergeDeps {
  /** Decides whether the chosen cover is a real picture. Injected: see the header. */
  decode: ImageDecoder
  createObjectUrl: (blob: Blob) => string
  revokeObjectUrl: (url: string) => void
}

/**
 * The real implementations, wrapped in arrow functions rather than referenced
 * directly: the bodies only touch `URL` when called, so importing this module in a
 * host without the object-URL API stays safe.
 */
const defaultDeps: MergeDeps = {
  decode: browserImageDecoder,
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
}

/** `50 4B 03 04`: a local file header, i.e. the first four bytes of every zip. */
const ZIP_MAGIC = Uint8Array.from([0x50, 0x4b, 0x03, 0x04])

/**
 * Above this the merge is still legal, but the whole thing is held in memory twice
 * (both inputs, then the output), so the pill says so out loud rather than letting a
 * browser tab die without explanation.
 */
const MEMORY_CEILING_BYTES = 256 * 1024 * 1024

const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

export function useMergePanel(deps: Partial<MergeDeps> = {}) {
  const decode = deps.decode ?? defaultDeps.decode
  const createObjectUrl = deps.createObjectUrl ?? defaultDeps.createObjectUrl
  const revokeObjectUrl = deps.revokeObjectUrl ?? defaultDeps.revokeObjectUrl

  const image = ref<PickedFile | null>(null)
  const payload = ref<PickedFile | null>(null)
  const result = ref<MergeResult | null>(null)
  const previewUrl = ref<string | null>(null)
  const imageProbe = ref<ImageProbe | null>(null)
  const busy = ref(false)
  const payloadRejection = ref<string | null>(null)
  /** A failure that is not the payload's fault, so the pill can name the right culprit. */
  const failure = ref<string | null>(null)
  /**
   * Generation counter for cover probes, per panel instance: two panels on one page each
   * have their own in-flight probes, and neither may invalidate the other. See
   * `beginCoverProbe` for what the counter is actually guarding.
   */
  let coverProbeToken = 0
  /**
   * An object URL for the SELECTED cover, published the moment the cover is known to be a
   * real picture. This is a second, independent lifetime from `previewUrl` above: that one
   * belongs to the merged result and only exists after a run, while this one belongs to the
   * input and exists from the moment the user can see what they picked.
   */
  const imagePreviewUrl = ref<string | null>(null)

  const imageName = computed(() => image.value?.name ?? null)
  const payloadName = computed(() => payload.value?.name ?? null)
  /** Byte counts for the two cards. `null` means "nothing chosen", never zero. */
  const imageSize = computed(() => image.value?.size ?? null)
  const payloadSize = computed(() => payload.value?.size ?? null)

  const canRun = computed(() => image.value !== null && payload.value !== null)

  /**
   * Why the button is dead, in a sentence the panel can show in its place. A greyed-out
   * button with no explanation is the single most common complaint about a two-input
   * form, and the fix is one Chinese short sentence per missing half.
   */
  const disabledReason = computed(() => {
    if (image.value === null) return '请先选择一张封面图。'
    if (payload.value === null) return '请再选择一个 ZIP 压缩包。'
    return null
  })

  /** Revoking is idempotent by construction: no outstanding URL means nothing to do. */
  function revokePreview(): void {
    const url = previewUrl.value
    if (url === null) return
    revokeObjectUrl(url)
    previewUrl.value = null
  }

  /**
   * The same contract for the cover's own preview, kept as a separate function so the two
   * lifetimes can never be confused: every caller below states which of the two it means.
   */
  function revokeImagePreview(): void {
    const url = imagePreviewUrl.value
    if (url === null) return
    revokeObjectUrl(url)
    imagePreviewUrl.value = null
  }

  /**
   * Starts a new cover-probe generation and returns it.
   *
   * The injected decoder is async, so choosing A and then B can settle A's probe AFTER
   * B's -- a large first image and a small second one is enough. A panel that applied
   * whichever verdict arrived last would show the discarded cover under the chosen name.
   * The token is the guard: a result is only allowed to touch state while it is still the
   * newest generation, and bumping it here is what makes an in-flight probe stale.
   */
  function beginCoverProbe(): number {
    coverProbeToken += 1
    return coverProbeToken
  }

  /**
   * Publishes the cover's preview once the bytes are known to be a real picture.
   *
   * Safe to leave un-awaited: `probeImage` never rejects (it converts a decoder rejection
   * into a failed probe), so this floating promise has no rejection path, and a panel that
   * has been torn down mid-flight simply finds its token superseded.
   */
  async function publishCoverPreview(file: PickedFile, token: number): Promise<void> {
    const probe = await probeImage(file, decode)
    if (token !== coverProbeToken) return
    // A cover that will not decode gets NO object URL. Pointing an <img> at bytes that
    // cannot decode renders a broken-image icon, so the card shows the name and size on
    // their own instead of a picture that is not there.
    if (!probe.ok) return
    imagePreviewUrl.value = createObjectUrl(file)
  }

  /**
   * Swapping the cover or the archive invalidates a previous run's numbers.
   *
   * It deliberately does NOT touch `imagePreviewUrl`. The cover thumbnail describes the
   * INPUT, and this function is also called when only the archive changed: blanking the
   * picture the user already picked because they swapped a ZIP would be a lie about what
   * they chose. Only the merged result's own preview belongs to a run.
   */
  function clearOutput(): void {
    revokePreview()
    result.value = null
    imageProbe.value = null
    failure.value = null
  }

  function setImage(file: PickedFile | null): void {
    // This selection's own probe generation. It is read from the bump's return value
    // rather than from the counter later on, so no future `await` or reordering can let it
    // drift onto a newer cover's generation. Bumping first makes a probe already in flight
    // for the outgoing cover stale before anything else happens.
    const probeToken = beginCoverProbe()
    revokeImagePreview()
    image.value = file
    clearOutput()
    if (file === null) return
    // Synchronous on purpose: the panel and its specs call this without awaiting, so the
    // name and size are readable the moment the user picks a file. The preview follows as
    // soon as the injected decoder has an opinion.
    void publishCoverPreview(file, probeToken)
  }

  function setPayload(file: PickedFile | null): void {
    if (file !== null && payload.value !== null) {
      payloadRejection.value =
        'v1 只接受一个压缩包：两个压缩包拼在一起会留下两个结尾目录记录，先出现的那个会被无声丢弃。请先清空当前压缩包再重新选择。'
      return
    }
    payloadRejection.value = null
    payload.value = file
    clearOutput()
  }

  async function run(): Promise<void> {
    const cover = image.value
    const archive = payload.value
    if (cover === null || archive === null) return

    busy.value = true
    payloadRejection.value = null
    failure.value = null
    try {
      // The magic check reads four bytes and nothing else: a 4 GB "zip" must be
      // rejectable without ever being pulled into memory.
      const head = new Uint8Array(await archive.slice(0, ZIP_MAGIC.length).arrayBuffer())
      if (!ZIP_MAGIC.every((byte, index) => byte === head[index])) {
        payloadRejection.value = `所选文件不是 ZIP 压缩包：开头 4 字节不是 50 4B 03 04。`
        return
      }
      const merged = await mergeConcat(cover, [archive])
      revokePreview()
      // The result card now owns the picture: the merged blob decodes to the very same
      // cover, so holding a second live object URL for it would keep a second reference to
      // those bytes resident for nothing. The cover's own preview is released here, which
      // is the only place a run and the cover's lifetime meet.
      revokeImagePreview()
      previewUrl.value = createObjectUrl(merged.blob)
      result.value = merged
      imageProbe.value = await probeImage(cover, decode)
    } catch (error) {
      failure.value = `合成失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      busy.value = false
    }
  }

  /**
   * One derivation for both halves of the pill, so a tone and its sentence can never
   * disagree. Priority is worst-news-first: a rejection outranks everything, then a
   * memory warning, then an undecodable cover, then success.
   */
  const pill = computed<{ tone: StatusTone; message: string | null }>(() => {
    const rejection = payloadRejection.value ?? failure.value
    if (rejection !== null) return { tone: 'error', message: rejection }

    const merged = result.value
    if (merged === null) return { tone: 'idle', message: null }

    if (merged.totalBytes > MEMORY_CEILING_BYTES) {
      return {
        tone: 'warn',
        message: `已合成，总大小约 ${megabytes(merged.totalBytes)} MB，超过 256 MB：整个文件会一次性读入内存，请谨慎处理。`,
      }
    }

    const probe = imageProbe.value
    if (probe !== null && !probe.ok) {
      return { tone: 'warn', message: `已合成，但封面图不是可识别的图像（${probe.reason}）；拼接仍可正常还原。` }
    }

    return {
      tone: 'ok',
      message: `已合成伪装文件：图片 ${merged.imageBytes} 字节 + 压缩包 ${merged.payloadBytes} 字节。`,
    }
  })

  const tone = computed(() => pill.value.tone)
  const message = computed(() => pill.value.message)

  function reset(): void {
    // Same order as `setImage`: invalidate any in-flight probe, hand back the cover's own
    // URL, then let `clearOutput` hand back the merged result's.
    beginCoverProbe()
    revokeImagePreview()
    image.value = null
    payload.value = null
    payloadRejection.value = null
    clearOutput()
  }

  /** Keeps the selection -- a remount should not force the user to pick files again. */
  function dispose(): void {
    // Both lifetimes are released here, and both are idempotent: a double unmount revokes
    // nothing twice, and a probe still in flight finds its token superseded.
    beginCoverProbe()
    revokeImagePreview()
    revokePreview()
  }

  return {
    setImage,
    setPayload,
    canRun,
    disabledReason,
    imageName,
    payloadName,
    imageSize,
    payloadSize,
    payloadRejection,
    result,
    previewUrl,
    imagePreviewUrl,
    imageProbe,
    busy,
    tone,
    message,
    run,
    reset,
    dispose,
  }
}
