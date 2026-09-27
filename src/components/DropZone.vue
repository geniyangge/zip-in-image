<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(
  defineProps<{
    accept: string
    label: string
    hint?: string
    disabled?: boolean
    /**
     * Id for the hidden `<input type="file">`. Automation has to set a file on that
     * element specifically -- a drop zone cannot receive a synthetic drop with real
     * file contents -- so the id belongs on the input, not on the decorative wrapper.
     */
    inputId?: string
  }>(),
  { hint: '', disabled: false, inputId: undefined },
)

const emit = defineEmits<{
  files: [files: File[]]
  rejected: [payload: { reason: string }]
}>()

const inputRef = ref<HTMLInputElement | null>(null)
const dragActive = ref(false)

/** Mirrors the DOM `accept` grammar: `*`, `.ext`, `type/*`, `type/subtype`. */
function accepts(file: File, accept: string): boolean {
  return accept.split(',').some((rawToken) => {
    const token = rawToken.trim().toLowerCase()
    if (token === '') return false
    if (token === '*' || token === '*/*') return true
    if (token.startsWith('.')) return file.name.toLowerCase().endsWith(token)
    if (token.endsWith('/*')) return file.type.toLowerCase().startsWith(token.slice(0, -1))
    return file.type.toLowerCase() === token
  })
}

/** Single funnel for both drop and picker input: accept, then report the rest. */
function submit(picked: FileList | File[] | null): void {
  if (props.disabled) return
  const candidates = picked === null ? [] : Array.from(picked)
  const accepted = candidates.filter((file) => accepts(file, props.accept))
  const refused = candidates.filter((file) => !accepts(file, props.accept))

  for (const file of refused) {
    emit('rejected', { reason: `不支持的文件：${file.name}，仅接受 ${props.accept}` })
  }
  if (accepted.length > 0) emit('files', accepted)
}

function openPicker(): void {
  if (props.disabled) return
  inputRef.value?.click()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
  // Enter/Space must activate a role="button"; without preventDefault Space
  // would also scroll the page.
  event.preventDefault()
  openPicker()
}

function onDragOver(event: DragEvent): void {
  if (props.disabled) return
  // Required, or the browser refuses the drop and navigates to the file.
  event.preventDefault()
  dragActive.value = true
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragActive.value = false
  submit(event.dataTransfer?.files ?? null)
}

function onChange(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  submit(target.files)
  // Clear the control so re-picking the same file still fires a change event.
  target.value = ''
}
</script>

<template>
  <div
    class="zone"
    :class="{ 'zone--active': dragActive, 'zone--disabled': disabled }"
    data-testid="dropzone"
    role="button"
    tabindex="0"
    :aria-disabled="disabled ? 'true' : undefined"
    @click="openPicker"
    @keydown="onKeydown"
    @dragover="onDragOver"
    @dragleave="dragActive = false"
    @drop="onDrop"
  >
    <div class="empty" data-testid="dropzone-empty">
      <span class="label">{{ label }}</span>
      <span class="accept">{{ accept }}</span>
      <!-- A caller-supplied `hint` REPLACES the generic prompt rather than joining it.
           Both used to render at once, so every zone printed two near-identical
           instructions ("拖放文件到此处…" and "拖放图片到此处…"), which is noise, and the
           doubled text is what pushed the last word onto a line of its own. -->
      <span v-if="hint" class="hint">{{ hint }}</span>
      <span v-else class="prompt">拖放文件到此处，或按 Enter / 空格选择</span>
    </div>

    <input
      :id="inputId"
      ref="inputRef"
      class="picker"
      type="file"
      hidden
      multiple
      :accept="accept"
      :disabled="disabled"
      @click.stop
      @change="onChange"
    />
  </div>
</template>

<style scoped>
/* Radii and spacing carry a px fallback: `src/styles/tokens.css` is authored
   separately, and a missing custom property would otherwise drop the rule. */
.zone {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 112px;
  padding: var(--space-4, 16px);
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-lg, 14px);
  background: var(--bg-elev);
  color: var(--text-dim);
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
}

.zone:hover {
  border-color: var(--accent);
  color: var(--text);
}

.zone:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.zone--active {
  border-style: solid;
  border-color: var(--accent);
  background: var(--bg-elev-2);
  color: var(--text);
}

.zone--disabled {
  border-color: var(--line);
  color: var(--text-faint);
  cursor: not-allowed;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1, 4px);
  text-align: center;
}

.label {
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
}

.accept {
  padding: 0 var(--space-2, 8px);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-elev-2);
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 12px;
}

.prompt {
  font-size: 12px;
}

.hint {
  color: var(--text-faint);
  font-size: 12px;
}

/* CJK breaks between any two characters, so a line that is one glyph too long drops a
   single character onto a line of its own (孤字) -- measured at 390px as
   "拖放图片到此处，或按 Enter / 空格选" + "择". Balancing the lines evens them out
   instead, and fixes the whole class of case rather than shortening this one string.
   The same property already guards the headings in src/styles/base.css. */
.prompt,
.hint {
  max-width: 30ch;
  text-wrap: balance;
}

@media (prefers-reduced-motion: reduce) {
  .zone {
    transition: none;
  }
}
</style>
