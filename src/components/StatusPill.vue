<script setup lang="ts">
// Colour is driven by `--accent` / `--warn` / `--error` / `--text-faint`; the
// `data-tone` attribute is the styling and test hook. `idle` is a deliberate
// no-op: the panel reserves the vertical rhythm with its siblings instead.
defineProps<{
  tone: 'ok' | 'warn' | 'error' | 'idle'
  label: string
}>()
</script>

<template>
  <span v-if="tone !== 'idle'" class="pill" :data-tone="tone">{{ label }}</span>
</template>

<style scoped>
/* Radii and spacing carry a px fallback: `src/styles/tokens.css` is authored
   separately, and a missing custom property would otherwise drop the rule. */
.pill {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  /* The label is a full sentence, not a tag. `nowrap` made a 45-glyph Chinese
     message 599px wide on a 390px viewport, so the page scrolled sideways exactly
     when the user most needed to be told what went wrong. It must wrap. */
  max-width: 100%;
  padding: var(--space-1, 4px) var(--space-2, 8px);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md, 10px);
  background: var(--bg-elev);
  color: var(--text-faint);
  font-size: 12px;
  line-height: var(--lh-snug, 1.5);
  letter-spacing: 0.02em;
  overflow-wrap: anywhere;
}

.pill::before {
  content: '';
  flex: none;
  width: 6px;
  height: 6px;
  margin-right: var(--space-2, 8px);
  border-radius: var(--radius-sm, 6px);
  background: currentColor;
}

.pill[data-tone='ok'] {
  border-color: var(--accent);
  color: var(--accent);
}

.pill[data-tone='warn'] {
  border-color: var(--warn);
  color: var(--warn);
}

.pill[data-tone='error'] {
  border-color: var(--error);
  color: var(--error);
}
</style>
