<script setup lang="ts">
/**
 * The tab switcher.
 *
 * Nothing in this file knows what a panel is. The shell owns the panels; this owns the
 * accessibility contract: a `tablist` of `tab`s, exactly one roving-tabindex stop, arrow
 * / Home / End traversal that activates as it moves, and `aria-controls` wired to the
 * panel ids the shell renders.
 *
 * The id convention IS the API:
 *
 *   tab button   `tab-<id>`
 *   tabpanel     `panel-<id>`
 *
 * The shell has to render its panels under exactly those panel ids or the wiring is
 * decoration; `App.spec.ts` pins both halves of the pair so the two cannot drift.
 */
defineOptions({ name: 'AppTabs' })

const props = defineProps<{
  tabs: readonly { readonly id: string; readonly label: string }[]
  /** The active tab's id, not its index: the shell stores ids, and so does this. */
  modelValue: string
}>()

const emit = defineEmits<{ 'update:modelValue': [id: string] }>()

/** The panel a tab controls. Mirrors the ids `App.vue` puts on its tabpanel elements. */
function panelId(tabId: string): string {
  return `panel-${tabId}`
}

function isActive(tabId: string): boolean {
  return tabId === props.modelValue
}

function onSelect(tabId: string): void {
  // Re-selecting the active tab emits nothing: a redundant update would still tear the
  // panel down and rebuild it, which is exactly the state loss this switcher avoids.
  if (isActive(tabId)) return
  emit('update:modelValue', tabId)
}

/**
 * Keyboard support for the roving tabindex, with APG automatic activation: moving
 * between tabs also selects them, so reaching the second tab costs one key press
 * instead of one press plus an Enter.
 *
 * The rendered buttons and the `tabs` prop share a single order, so the DOM is used as
 * the index source -- that removes any way for the two to disagree after a later edit.
 * The focused tab is the selected one by construction (that is what a roving tabindex
 * means), so the position is read off the element the event came from rather than off
 * component state, which is already changing underneath this handler.
 */
function onKeydown(event: KeyboardEvent): void {
  const host = event.currentTarget
  if (!(host instanceof HTMLButtonElement)) return
  const list = host.parentElement
  if (list === null) return

  const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  const from = buttons.indexOf(host)
  if (from === -1) return
  const last = buttons.length - 1

  let to: number
  switch (event.key) {
    case 'ArrowRight':
      // Wraps, so holding Right cycles the strip instead of dead-ending on the last tab.
      to = from === last ? 0 : from + 1
      break
    case 'ArrowLeft':
      to = from === 0 ? last : from - 1
      break
    case 'Home':
      to = 0
      break
    case 'End':
      to = last
      break
    default:
      // Every other key belongs to the page, not to the tablist.
      return
  }

  const next = buttons[to]
  if (next === undefined) return
  // Read back off the button instead of slicing `tab-<id>`: the element stays the single
  // source of truth for which tab it is, and no string surgery can drift from the id.
  const nextId = next.dataset.tabId
  if (nextId === undefined || nextId === '') return

  // Without this, ArrowLeft / ArrowRight also scroll the page horizontally.
  event.preventDefault()
  onSelect(nextId)
  // Focus follows activation, so a keyboard user is never dropped back at the top of the
  // document and left guessing which tab they landed on.
  next.focus()
}
</script>

<template>
  <div class="tablist" role="tablist" aria-label="选择工具模式">
    <button
      v-for="tab in tabs"
      :id="`tab-${tab.id}`"
      :key="tab.id"
      class="tab"
      type="button"
      role="tab"
      :data-tab-id="tab.id"
      :aria-selected="isActive(tab.id) ? 'true' : 'false'"
      :aria-controls="panelId(tab.id)"
      :tabindex="isActive(tab.id) ? 0 : -1"
      @click="onSelect(tab.id)"
      @keydown="onKeydown"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
/* One hairline under the whole strip rather than a box around each tab: the active tab
   is located by the accent underline, so per-tab outlines would be redundant ink. */
.tablist {
  display: flex;
  gap: var(--sp-1);
  border-bottom: 1px solid var(--line);
}

.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  /* min-height, never height: CJK glyphs are full-width and a fixed height on a box
     holding 伪装 or 还原 clips the tails. 40px also lands the touch target. */
  min-height: 40px;
  padding: 0 var(--sp-4);
  border-radius: var(--r-sm) var(--r-sm) 0 0;
  color: var(--text-faint);
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  transition: color var(--dur-fast) var(--ease-out);
}

/* The active mark. Only `transform` and `opacity` are transitioned, never `width` or
   `left`: the underline is in the layout either way, so revealing it by `scaleX` keeps
   the whole animation off layout and off paint, and stays correct no matter how wide
   the label renders. */
.tab::after {
  content: '';
  position: absolute;
  inset-inline: var(--sp-2);
  /* -1px sits the underline ON the strip's hairline instead of beside it, so the two
     read as one line rather than two. */
  bottom: -1px;
  height: 2px;
  border-radius: var(--r-pill);
  background: var(--accent);
  transform: scaleX(0);
  transform-origin: left center;
  opacity: 0;
  transition:
    transform var(--dur) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}

/* Colour is never the only signal: the selected tab is also the only one with
   `aria-selected="true"` and the only one in the tab order, so the state survives a
   greyscale render and a screen reader alike. */
.tab[aria-selected='true'] {
  color: var(--text);
}

.tab[aria-selected='true']::after {
  transform: scaleX(1);
  opacity: 1;
}

/* Hover says "this is live" -- which is information, not decoration. */
.tab:hover:not([aria-selected='true']) {
  color: var(--text-dim);
}

@media (prefers-reduced-motion: reduce) {
  /* base.css already forces every transition to ~0ms under this same query. Stating it
     here keeps the tablist's own affordance intact if that global rule is ever relaxed
     -- a tab switch that teleports reads as a jump-cut, which is worse than a fade. */
  .tab,
  .tab::after {
    transition: none;
  }
}
</style>
