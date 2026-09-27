<script setup lang="ts">
/**
 * 图片隐写 / 压缩包伪装 — the merge half of the tool.
 *
 * Every decision (one archive only, magic-byte check, decode probe, byte accounting)
 * already lives in `useMergePanel` and `@/lib`; this component owns presentation only:
 * two input slots, an action row that explains itself, and a result card.
 *
 * `useMergePanel()` is called with no arguments on purpose. The real browser decoder
 * and the real object-URL API are the production path, and the specs drive that same
 * path by stubbing `createImageBitmap` on the global -- so there is no test-only prop
 * on this component and no second code path to keep in sync.
 */
import { computed, onUnmounted, ref } from 'vue'

import ByteOffset from '@/components/ByteOffset.vue'
import DropZone from '@/components/DropZone.vue'
import FieldRow from '@/components/FieldRow.vue'
import PickedFileCard from '@/components/PickedFileCard.vue'
import StatusPill from '@/components/StatusPill.vue'
import { useMergePanel } from '@/composables/useMergePanel'
import { downloadBlob } from '@/lib/download'

const {
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
  busy,
  tone,
  message,
  run,
  reset,
  dispose,
} = useMergePanel()

/**
 * A refusal produced by the drop zone's own `accept` grammar, not by the composable.
 * Panel-local because a dropped `.txt` never reaches the composable's state at all,
 * and a silently ignored file is indistinguishable from a broken panel.
 */
const dropNotice = ref<string | null>(null)

/**
 * One derivation for the inline notice so the two refusal sources cannot disagree: a
 * refusal about the file the user just touched outranks a policy rejection the state
 * is still carrying.
 */
const notice = computed(() => dropNotice.value ?? payloadRejection.value)

/** Nothing chosen and nothing produced: the panel states its purpose instead of going blank. */
const isEmpty = computed(
  () => imageName.value === null && payloadName.value === null && result.value === null,
)

const NOT_CHOSEN = '尚未选择'

/**
 * Each file is offered in turn rather than only the first one, so a multi-select
 * carrying two archives reaches the composable's one-archive policy and is refused
 * out loud instead of the second archive being dropped without a word.
 */
function onImageFiles(files: File[]): void {
  dropNotice.value = null
  for (const file of files) setImage(file)
}

function onPayloadFiles(files: File[]): void {
  dropNotice.value = null
  for (const file of files) setPayload(file)
}

function onRejected(payload: { reason: string }): void {
  dropNotice.value = payload.reason
}

function onRun(): void {
  // `run()` never rejects by construction -- failures arrive as a tone plus a
  // sentence -- so there is nothing to catch here, and swallowing a rejection would
  // only hide a bug in the composable.
  void run()
}

function onDownload(): void {
  const merged = result.value
  if (merged === null) return
  downloadBlob(merged.blob, merged.fileName)
}

// The preview is a live object URL, so unmounting has to hand it back or the blob
// stays resident for the life of the page.
onUnmounted(dispose)
</script>

<template>
  <section class="panel" aria-labelledby="merge-title">
    <h2 id="merge-title" class="lede">
      <span class="eyebrow">图片隐写 / 压缩包伪装</span>
      把 ZIP 压缩包拼在图片字节之后：生成的文件打开是图片，把后缀改成 .zip 就是能正常解压的压缩包。
    </h2>

    <div class="slots">
      <FieldRow label="封面图片" hint="接受 image/*：PNG、JPEG、WebP 等浏览器能显示的图像" for-id="img-input">
        <div class="stack">
          <DropZone
            accept="image/*"
            input-id="img-input"
            label="封面图片"
            hint="拖放图片到此处，或按 Enter / 空格选择"
            :disabled="busy"
            @files="onImageFiles"
            @rejected="onRejected"
          />
          <PickedFileCard
            kind="image"
            :name="imageName"
            :size="imageSize"
            :preview-url="imagePreviewUrl"
            :placeholder="NOT_CHOSEN"
            testid="merge-image-name"
          />
        </div>
      </FieldRow>

      <FieldRow label="压缩包" hint="接受 .zip / application/zip，v1 只处理一个压缩包" for-id="zip-input">
        <div class="stack">
          <DropZone
            accept=".zip,application/zip"
            input-id="zip-input"
            label="压缩包"
            hint="拖放 ZIP 到此处，或按 Enter / 空格选择"
            :disabled="busy"
            @files="onPayloadFiles"
            @rejected="onRejected"
          />
          <!-- No preview URL, ever: a ZIP cannot be rendered, so an <img> pointed at one
               would only produce the browser's broken-image icon. The card shows what it
               can know for certain instead -- the name and the exact byte count. -->
          <PickedFileCard
            kind="archive"
            :name="payloadName"
            :size="payloadSize"
            :preview-url="null"
            :placeholder="NOT_CHOSEN"
            testid="merge-payload-name"
          />
        </div>
      </FieldRow>
    </div>

    <p v-if="isEmpty" class="empty" data-testid="merge-empty">
      还没有选择任何文件：先选一张封面图片，再选一个 ZIP（.zip）压缩包，就能得到一个打开是图片、改后缀就是压缩包的文件。
    </p>

    <p v-if="notice" class="notice" role="alert" data-testid="merge-notice">{{ notice }}</p>

    <div class="actions">
      <button
        id="merge-run"
        class="btn btn--primary"
        type="button"
        :disabled="!canRun"
        :aria-disabled="canRun ? 'false' : 'true'"
        @click="onRun"
      >
        合成伪装文件
      </button>
      <button
        id="merge-download"
        class="btn btn--primary"
        type="button"
        :disabled="result === null"
        :aria-disabled="result === null ? 'true' : 'false'"
        @click="onDownload"
      >
        下载伪装文件
      </button>
      <button class="btn" type="button" data-testid="merge-reset" @click="reset">清空选择</button>
      <span v-if="busy" class="busy" role="status" data-testid="merge-busy">正在合成…</span>
    </div>

    <p v-if="disabledReason" class="reason" data-testid="merge-disabled-reason">{{ disabledReason }}</p>
    <StatusPill :tone="tone" :label="message ?? ''" />

    <article v-if="result" class="card" data-testid="merge-result">
      <div class="thumb-frame">
        <img
          v-if="previewUrl !== null"
          class="thumb"
          :src="previewUrl"
          alt="合成结果预览：打开后仍然是这张封面图片"
          data-testid="merge-preview"
        />
      </div>
      <p class="name mono" data-testid="merge-output-name">{{ result.fileName }}</p>
      <div class="bytes">
        <ByteOffset :value="result.imageBytes" label="图片字节" />
        <ByteOffset :value="result.payloadBytes" label="压缩包字节" />
        <ByteOffset :value="result.totalBytes" label="合计字节" />
      </div>
    </article>
  </section>
</template>

<style scoped>
/* Every value below is a token from src/styles/tokens.css. Properties the shared
   layer already guarantees -- `line-height`, `overflow-wrap`, `text-wrap`, and the
   zeroed `p` margin -- are deliberately NOT restated here: repeating an inherited
   value is how a component ends up quietly fighting base.css. Reduced motion needs
   no local rule either, because base.css forces `transition-duration` to zero
   globally under the same media query. */
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4, 16px);
  padding: var(--sp-5, 24px);
  border: 1px solid var(--line);
  border-radius: var(--r-lg, 14px);
  background: var(--bg-elev);
  box-shadow: var(--shadow-1), inset 0 1px 0 0 var(--edge-light);
}

/* The eyebrow is a block inside the heading rather than a sibling of it: it labels
   that heading, so it belongs to it -- and the section's accessible name then reads
   as one phrase instead of an orphan label followed by a sentence. */
.eyebrow {
  display: block;
  color: var(--text-faint);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--ls-wide);
}

/* One heading step below the page title, so it reads as this panel's subject rather
   than competing with the product name. */
.lede {
  font-size: var(--fs-xl, 21px);
}

/* Two columns that collapse to one when the PANEL narrows, not the viewport: the
   panel is mounted inside a tab body, so its own width is the honest signal. The
   18rem floor is a grid track size rather than a spacing step, so it is not a token. */
.slots {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: var(--sp-4, 16px);
}

/* The drop zone and its card stack in a column of their own rather than sharing
   FieldRow's horizontal control row. A card beside the drop zone would squeeze both, and a
   squeezed name is exactly what broke the `尚未选择` placeholder into an orphan before --
   the name needs the full width of the slot, on a line of its own. */
.stack {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--sp-2, 8px);
  min-width: 0;
}

.empty,
.reason {
  color: var(--text-dim);
  font-size: var(--fs-sm);
}

.notice {
  padding: var(--sp-2, 8px) var(--sp-3, 12px);
  border: 1px solid var(--error-line);
  border-radius: var(--r-sm, 6px);
  background: var(--error-soft);
  color: var(--error);
  font-size: var(--fs-sm);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2, 8px);
}

.btn {
  min-height: 34px;
  padding: 0 var(--sp-4, 16px);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md, 10px);
  color: var(--text);
  font-weight: var(--fw-medium);
  transition: border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
}

/* The two producing actions are tinted ghosts rather than solid fills: a pair of
   saturated buttons in one row would fight each other, and the green border ties
   them to the ok-tone pill the same run produces. The tertiary action stays
   unfilled, which is what gives the row a hierarchy at all. */
.btn--primary {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent);
}

.btn--primary:hover:not(:disabled) {
  border-color: var(--accent-2-line);
  background: var(--accent-2-soft);
  color: var(--accent-2);
}

.btn:disabled {
  border-color: var(--line);
  background: var(--bg-elev-2);
  color: var(--text-faint);
  cursor: not-allowed;
}

.busy {
  color: var(--accent-2);
  font-size: var(--fs-xs);
}

.card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--sp-2, 8px) var(--sp-4, 16px);
  padding: var(--sp-4, 16px);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md, 10px);
  background: var(--bg-elev-2);
}

.thumb-frame {
  grid-row: span 2;
  width: 96px;
  height: 96px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r-sm, 6px);
  background: var(--bg-inset);
}

/* `max-width: 100%` and `object-fit` come from the img rules in base.css; only the
   height is local, and it has to beat base.css's `img { height: auto }`. */
.thumb {
  height: 100%;
  object-fit: cover;
}

.name {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
}

.bytes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2, 8px) var(--space-4, 16px);
}
</style>
