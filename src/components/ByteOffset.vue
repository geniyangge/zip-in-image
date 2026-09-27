<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    value: number
    label?: string
    unit?: string
  }>(),
  { unit: 'B' },
)

// Grouping is done by hand: `toLocaleString` would depend on the host's ICU
// data, and a dev machine with small-icu would disagree with CI.
const GROUP_EVERY_THREE = /\B(?=(\d{3})+(?!\d))/g

// 0 is a real offset (a bare zip starts at byte 0), so there is no empty state.
const formatted = computed(() => String(Math.trunc(props.value)).replace(GROUP_EVERY_THREE, ','))
</script>

<template>
  <span class="offset">
    <span v-if="label" class="label">{{ label }}</span>
    <span class="value mono" data-testid="byte-offset-value">{{ formatted }}</span>
    <span v-if="unit" class="unit" data-testid="byte-offset-unit">{{ unit }}</span>
  </span>
</template>

<style scoped>
/* Radii and spacing carry a px fallback: `src/styles/tokens.css` is authored
   separately, and a missing custom property would otherwise drop the rule. */
.offset {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2, 8px);
  min-height: 24px;
  font-size: 13px;
  line-height: 1.4;
}

.label {
  color: var(--text-faint);
  font-size: 12px;
}

.value {
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  /* `mono` carries the tabular numerals; restated so the primitive stands
     alone if the utility layer is not loaded. */
  font-variant-numeric: tabular-nums;
}

.unit {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 12px;
}
</style>
