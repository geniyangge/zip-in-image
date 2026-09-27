<script setup lang="ts">
// The extract panel: state comes from `useExtractPanel()` and nothing else. Every hard
// question -- where the archive starts, is the prefix a picture, does the slice verify
// -- is already answered and priced there; what lives in this file is the presentation
// policy: how much weight a detection result carries, and which sentence each verdict
// gets. No `deps` are passed on purpose, so the real decoder runs in the browser and in
// the component specs alike.
import { computed, onUnmounted } from 'vue'

import ByteOffset from '@/components/ByteOffset.vue'
import DropZone from '@/components/DropZone.vue'
import FieldRow from '@/components/FieldRow.vue'
import PickedFileCard from '@/components/PickedFileCard.vue'
import StatusPill from '@/components/StatusPill.vue'
import { useExtractPanel } from '@/composables/useExtractPanel'
import type { StatusTone } from '@/composables/useExtractPanel'
import { downloadBlob } from '@/lib/download'
import type { ZipStartKind, ZipValidationReason } from '@/lib/zip'

/** How much the readout is allowed to trust its own answer. */
type Certainty = 'exact' | 'guessed' | 'absent'
interface Pill { tone: StatusTone; label: string }

/** One short label per failed verification; the composable owns the long explanation. */
const ZIP_FAILURE: Record<ZipValidationReason, string> = {
  'no-eocd': '未找到结尾目录（EOCD）',
  'cd-out-of-bounds': '中央目录越界',
  'cd-signature-mismatch': '中央目录签名不匹配',
}

const {
  applyManualOffset, detection, dispose, hasImagePrefix, imageFileName, imageProbe,
  manualOffset, manualOffsetEnabled, message, offset, prefixBytes, reset, setFile, sourceName,
  sourcePreviewUrl, sourceSize, split, tone, zipFileName, zipValidation,
} = useExtractPanel()

/** Shown in place of a file name while the slot is empty; the merge panel says the same. */
const NOT_CHOSEN = '尚未选择'

/**
 * The picked file's name, or `null` while nothing is chosen -- which is what the card reads
 * as its empty state. Derived from `manualOffsetEnabled` rather than from an empty
 * `sourceName`, because a file whose name really is the empty string is still a chosen file
 * and must not be described as though nothing had been picked.
 */
const sourceLabel = computed(() => (manualOffsetEnabled.value ? sourceName.value : null))

/**
 * Whether the chosen file is a picture or merely a file. It is the preview's own
 * existence that answers this, because that preview is only ever published for bytes that
 * really decoded: a bare ZIP, or a disguised file whose picture did not, stays described
 * rather than drawn.
 */
const sourceKind = computed(() => (sourcePreviewUrl.value === null ? 'unknown' : 'image'))

/**
 * The method label, its strength, and the caveat that goes with it. A scan result is
 * weaker evidence than an EOCD derivation, so the two must not read as the same fact:
 * the strength drives the readout's colour and its `data-certainty` attribute.
 */
function describeMethod(kind: ZipStartKind, tried: number): { label: string; certainty: Certainty; note: string } {
  switch (kind) {
    case 'eocd': return { label: '中央目录记录', certainty: 'exact', note: '由压缩包自己的结尾目录精确推导，偏移量可直接使用。' }
    case 'eocd64': return { label: 'ZIP64', certainty: 'exact', note: '由 ZIP64 结尾记录精确推导，偏移量可直接使用。' }
    case 'scan':
      return { label: '特征扫描', certainty: 'guessed', note: `结尾目录推导不出偏移，扫描了 ${tried} 个候选局部头后取第一个可用的，这是猜测，请以下方完整性结论为准。` }
    case 'none': return { label: '未检测到', certainty: 'absent', note: '文件末尾没有结尾目录记录，此时的 0 只是待填的占位值。' }
    default: {
      const unreachable: never = kind
      throw new Error(`未处理的检测方式：${String(unreachable)}`)
    }
  }
}

const method = computed(() => {
  const found = detection.value
  return describeMethod(found === null ? 'none' : found.kind, found?.candidatesTried ?? 0)
})

/** The slice on screen is the truth about how many entries; a detection is history. */
const entries = computed(() => zipValidation.value?.entryCount ?? detection.value?.entryCount ?? 0)

const zipPill = computed<Pill>(() => {
  const validation = zipValidation.value
  if (validation === null) return { tone: 'idle', label: '' }
  if (validation.ok) return { tone: 'ok', label: `压缩包完整 · ${validation.entryCount} 个条目` }
  return { tone: 'error', label: `压缩包不可用 · ${ZIP_FAILURE[validation.reason]}` }
})

/** A prefix that will not decode is a warning, not an error: the archive is still fine. */
const imagePill = computed<Pill>(() => {
  const probe = imageProbe.value
  if (probe === null) return { tone: 'idle', label: '' }
  if (probe.ok) return { tone: 'ok', label: `图片前缀有效 · ${probe.width}×${probe.height}` }
  return { tone: 'warn', label: '图片前缀无法解码' }
})

/** The archive is downloadable whenever its slice verified, whatever the prefix did. */
const zipReady = computed(() => zipValidation.value !== null && zipValidation.value.ok)

async function onFiles(files: File[]): Promise<void> {
  const first = files[0]
  if (first === undefined) return
  await setFile(first)
}

function onOffsetInput(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  // Deliberately not `v-model`: Vue casts a `type="number"` input to a number, and the
  // composable reads this field as raw text so a half-typed value stays representable.
  manualOffset.value = target.value
}

function applyOffset(): void {
  // Safe to leave unawaited: the offset is clamped rather than thrown, and the probe
  // resolves rather than rejects, so this promise has no rejection path.
  void applyManualOffset()
}

function downloadZip(): void {
  const parts = split()
  if (parts === null) return
  downloadBlob(parts.zip, zipFileName.value)
}

function downloadImage(): void {
  const parts = split()
  if (parts === null) return
  downloadBlob(parts.image, imageFileName.value)
}

onUnmounted(dispose)
</script>

<template>
  <section class="panel" aria-labelledby="extract-title">
    <header class="head">
      <p class="eyebrow">伪装包分离</p>
      <h2 id="extract-title" class="title">
        读取一个「图片后面粘着压缩包」的文件，定位压缩包真正开始的那一个字节，再把图片和压缩包分别还原。
      </h2>
    </header>

    <!-- `accept="*/*"` is the honest filter: whether a file is disguised is a fact about
         its bytes, not its extension, so `DropZone` can never reject one and the panel
         needs no `rejected` handler. -->
    <DropZone
      accept="*/*" input-id="disguised-input" label="选择被伪装的文件"
      hint="扩展名随意：工具会先确认前半段是不是图片，再找出后面粘着的 ZIP 在哪开始。" @files="onFiles"
    />

    <!-- Shown only once a file is actually chosen: this card reports a selection, and an
         empty slot already has the paragraph below explaining itself. The preview is the
         WHOLE file, not the detected prefix -- at offset 0 there is no prefix, and a user
         who picks a plain photograph must still see the photograph. -->
    <PickedFileCard
      v-if="manualOffsetEnabled"
      :kind="sourceKind"
      :name="sourceLabel"
      :size="sourceSize"
      :preview-url="sourcePreviewUrl"
      :placeholder="NOT_CHOSEN"
      testid="extract-source-name"
    />

    <p v-if="!manualOffsetEnabled" class="empty" data-testid="extract-empty">
      还没有选择文件。选好之后，这里会显示压缩包起始偏移、图片长度，以及两半各自的完整性结论。
    </p>

    <div v-else class="readout" data-testid="extract-readout" :data-certainty="method.certainty">
      <ByteOffset label="压缩包起始偏移" :value="offset" />
      <ByteOffset label="图片长度" :value="prefixBytes" />
      <span class="entries" data-testid="extract-entries">压缩包条目 <b class="mono">{{ entries }}</b></span>
      <span data-testid="zip-pill"><StatusPill :tone="zipPill.tone" :label="zipPill.label" /></span>
      <span data-testid="image-pill"><StatusPill :tone="imagePill.tone" :label="imagePill.label" /></span>
      <p class="method">
        <span class="method-label">定位方式</span>
        <span class="method-value">{{ method.label }}</span>
        <span class="method-note">{{ method.note }}</span>
      </p>
    </div>

    <p class="summary" data-testid="extract-summary">
      <StatusPill :tone="tone" :label="message ?? ''" />
    </p>

    <FieldRow
      label="手动指定起始偏移" for-id="offset-input"
      hint="自动检测找不到压缩包时（或者你怀疑它找错了），直接在这里填字节数。"
    >
      <input
        id="offset-input" class="offset-field mono" type="number" inputmode="numeric"
        min="0" step="1" :value="manualOffset" :disabled="!manualOffsetEnabled" @input="onOffsetInput"
      />
      <button id="offset-apply" class="btn" type="button" :disabled="!manualOffsetEnabled" @click="applyOffset">
        应用
      </button>
    </FieldRow>

    <div class="actions">
      <button id="zip-download" class="btn btn--primary" type="button" :disabled="!zipReady" @click="downloadZip">
        下载压缩包
      </button>
      <button id="image-download" class="btn" type="button" :disabled="!hasImagePrefix" @click="downloadImage">
        下载图片
      </button>
      <button v-if="manualOffsetEnabled" id="reset-button" class="btn" type="button" @click="reset">
        清除
      </button>
    </div>

    <p v-if="manualOffsetEnabled && !hasImagePrefix" class="note">
      当前偏移为 0：整个文件都被当作压缩包，前面没有图片可提取，所以图片下载不可用。
    </p>
  </section>
</template>

<style scoped>
/* Radii and spacing carry a px fallback: `src/styles/tokens.css` is authored
   separately, and a missing custom property would otherwise drop the rule. */
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4, 16px);
  padding: var(--space-5, 24px);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg, 14px);
  background: var(--bg-elev);
  box-shadow: var(--shadow-1), inset 0 1px 0 var(--edge-light);
}

.head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
}

.eyebrow {
  color: var(--accent-2);
  font-size: var(--fs-xs);
  letter-spacing: var(--ls-wide);
}

.title {
  /* Sized for CJK, not Latin: `ch` is the advance of "0", so 1ch is roughly half a
     Han glyph. 48ch therefore fits ~48 characters per line, which keeps this sentence
     on one line at desktop width instead of orphaning one or two glyphs on the last. */
  max-width: 48ch;
  color: var(--text);
  font-size: var(--fs-lg);
}

.empty,
.note {
  color: var(--text-faint);
  font-size: var(--fs-sm);
}

.readout {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-3, 12px) var(--space-4, 16px);
  align-items: center;
  padding: var(--space-4, 16px);
  border: 1px solid var(--line);
  border-radius: var(--radius-md, 10px);
  background: var(--bg-inset);
}

.entries,
.method-label,
.method-note {
  color: var(--text-faint);
  font-size: var(--fs-xs);
}

.method {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2, 8px);
  grid-column: 1 / -1;
  margin: 0;
  padding-top: var(--space-2, 8px);
  border-top: 1px solid var(--line);
}

.method-value {
  color: var(--accent);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
}

/* A guessed offset must not look like a derived one: the caveat lives in the colour,
   not only in the sentence. */
.readout[data-certainty='guessed'] .method-value {
  color: var(--warn);
}

.readout[data-certainty='absent'] .method-value {
  color: var(--text-faint);
}

/* Reserves the pill's line, so the panel does not jump when a verdict appears. */
.summary {
  min-height: 24px;
}

.offset-field {
  flex: 0 1 180px;
  min-width: 120px;
}

.btn {
  min-height: 34px;
  padding: var(--space-2, 8px) var(--space-4, 16px);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm, 6px);
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.btn:hover:not(:disabled) {
  border-color: var(--accent-2);
}

.btn--primary {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent);
}

.btn:disabled {
  border-color: var(--line);
  background: var(--bg-inset);
  color: var(--text-faint);
  cursor: not-allowed;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2, 8px);
}
</style>
