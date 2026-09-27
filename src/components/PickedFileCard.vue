<script setup lang="ts">
/**
 * The card under a drop zone: what the user actually picked.
 *
 * All three slots in this app have the same job -- name a chosen file, show its size, and
 * show the picture if it is one -- so they share one component rather than three. Two
 * decisions are baked in here, and both exist because of defects this project already had:
 *
 * 1. **The name gets its own full-width line, below the thumbnail.** Laid out as a row, the
 *    name is a shrinkable flex item, and a fixed four-glyph CJK placeholder in a squeezed
 *    flex item breaks as `尚未选 / 择` -- an orphan that reads as two words. The browser QA
 *    script censuses that element character by character and fails on two lines, so the
 *    constraint is structural here: a column, with the name last and never sharing a line.
 * 2. **A file that cannot be drawn gets a glyph, not an `<img>`.** Pointing an image at ZIP
 *    bytes produces the browser's broken-image icon, which in a tool that has not failed
 *    looks exactly like a failure. The same holds for a cover whose bytes would not decode.
 *
 * Purely presentational: it owns no state beyond what it is handed, and it never touches
 * the object URL it is given -- the composable that created it owns that lifetime.
 */
import { computed } from 'vue'

import { formatBytes } from '@/lib/format'

const props = defineProps<{
  /** The chosen file's name, or `null` for an empty slot. */
  name: string | null
  /** Byte count, or `null` when unknown. Absent is not the same as zero. */
  size: number | null
  /** An object URL for the file, or `null` when it is not displayable. */
  previewUrl: string | null
  kind: 'image' | 'archive' | 'unknown'
  /** What to show as the name while the slot is empty. */
  placeholder: string
  /** Placed on the name element, which is what the specs and the QA script address. */
  testid?: string
}>()

/** One string for the name line, so the element can never hold two text nodes. */
const label = computed(() => props.name ?? props.placeholder)

/** The empty state is styled apart from a real name: it must never wrap. */
const isPlaceholder = computed(() => props.name === null)

/** `null` rather than a dash or a `0 B`: an unknown size is not a size of zero. */
const sizeText = computed(() => (props.size === null ? null : formatBytes(props.size)))

/**
 * The best available description of the picture. The file's own name is the honest one:
 * nothing here has looked at the image's content, and inventing "a photo" would be a claim
 * the panel cannot support. The placeholder doubles as the alt in the transient state
 * between an empty slot and a decoded preview.
 */
const previewAlt = computed(() => props.name ?? props.placeholder)
</script>

<template>
  <div class="card" :data-kind="kind">
    <img v-if="previewUrl !== null" class="thumb" :src="previewUrl" :alt="previewAlt" />
    <svg v-else class="glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <template v-if="kind === 'archive'">
        <!-- An archive is a box with a lid and a latch: the one shape that says "container"
             without needing a label under it. -->
        <rect x="3.5" y="5.5" width="17" height="14" rx="2" />
        <path d="M3.5 10.5h17" />
        <path d="M10 8h4" />
      </template>
      <template v-else>
        <!-- A generic document: the fallback for a file that is not displayable, whether
             that is an undecodable cover or a disguised file whose picture did not decode. -->
        <path d="M6.5 3.5h7l4.5 4.5v12.5h-11.5z" />
        <path d="M13.5 3.5V8H18" />
      </template>
    </svg>

    <!-- One interpolation, one text node, no siblings: `scripts/browser-qa.mjs` takes
         `firstChild` and requires a single TEXT_NODE before it can census this line. -->
    <p class="name mono" :class="{ 'is-placeholder': isPlaceholder }" :data-testid="testid">{{ label }}</p>

    <p v-if="sizeText !== null" class="size mono" data-testid="picked-size">{{ sizeText }}</p>
  </div>
</template>

<style scoped>
/* Every colour below is a token from src/styles/tokens.css. Lengths are local on purpose:
   the scale is a rhythm, and a component's own box is not part of anyone else's rhythm.
   Nothing here animates -- the card is a static report, and a fade on an arrival would
   confirm nothing -- so there is no transition here to disable under
   `prefers-reduced-motion`. */
.card {
  display: flex;
  flex-direction: column;
  /* Children stretch to the card's content width, so the name and the size each occupy a
     full-width line of their own. */
  gap: var(--sp-1);
  min-width: 0;
  max-width: 100%;
  padding: var(--sp-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
}

/* `align-self: flex-start` is what keeps the 72px box 72px: without it the default
   `stretch` would widen both the thumbnail and the glyph to the whole card. */
.thumb,
.glyph {
  align-self: flex-start;
  width: 72px;
  /* An aspect ratio plus `max-width` is the whole containment story. A 4000x12 panorama
     or a 12x4000 strip would otherwise be laid out at its own proportions and blow the
     panel past a 390px viewport; `cover` crops it into the fixed box instead. The
     `max-width` is the second half: it bounds a box that is still growing, and it is what
     keeps a narrow panel from overflowing horizontally. */
  aspect-ratio: 1;
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: var(--bg-elev-2);
}

.thumb {
  /* `object-fit` here beats base.css's `max-width: 100%` + `height: auto`, which sizes an
     image by its own proportions. */
  object-fit: cover;
}

.glyph {
  color: var(--text-dim);
  /* The box is 72px and the drawing is a 24-unit grid, so the glyph is scaled to fit
     inside its own padding rather than overflowing the border box. */
  width: 72px;
  padding: var(--sp-3);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* The kind is told apart by colour, not by a second glyph vocabulary: a picture reads cyan,
   an archive neutral, anything else faint. */
.card[data-kind='image'] .glyph {
  color: var(--accent-2);
}

.card[data-kind='unknown'] .glyph {
  color: var(--text-faint);
}

.name {
  min-width: 0;
  max-width: 100%;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  /* A real file name is the opposite case to the placeholder: it may be arbitrarily long,
     so it wraps inside itself rather than pushing the panel past the viewport. */
  overflow-wrap: anywhere;
}

/* The placeholder is a fixed four-glyph string, so it must never break. The QA script
   fails on two lines here unconditionally, at 390px and at 1440px alike. */
.name.is-placeholder {
  white-space: nowrap;
}

.size {
  color: var(--text-faint);
  font-size: var(--fs-xs);
  /* Restated from `.mono` so the size column stays aligned even if this card is ever
     rendered without the shared utility layer. */
  font-variant-numeric: tabular-nums;
}
</style>
