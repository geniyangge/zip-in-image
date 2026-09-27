<script setup lang="ts">
// `forId` is the accessibility contract: pass the id of the control rendered in
// the default slot and the label becomes a real label, not decoration.
defineProps<{
  label: string
  hint?: string
  forId?: string
}>()
</script>

<template>
  <div class="row">
    <label class="label" :for="forId">{{ label }}</label>
    <div class="control">
      <slot />
    </div>
    <p v-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
/* Radii and spacing carry a px fallback: `src/styles/tokens.css` is authored
   separately, and a missing custom property would otherwise drop the rule. */
.row {
  display: grid;
  grid-template-columns: minmax(64px, auto) minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2, 8px) var(--space-3, 12px);
  min-height: 40px;
}

.label {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.4;
}

.control {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  min-width: 0;
}

.hint {
  grid-column: 2;
  margin: 0;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.4;
}
</style>
