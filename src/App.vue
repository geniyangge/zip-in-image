<script setup lang="ts">
/**
 * The application shell: it names the product, states the mechanism once in plain
 * Chinese, shows the three steps, and hosts exactly one of the two panels at a time.
 *
 * The shell owns no domain logic. `MergePanel` and `ExtractPanel` are finished, are
 * green on their own, and each owns its own empty state, status pill and downloads --
 * so nothing below reaches into them, and nothing below re-states what they say.
 */
import { onMounted, ref } from 'vue'

import AppTabs from '@/components/AppTabs.vue'
import ExtractPanel from '@/components/ExtractPanel.vue'
import MergePanel from '@/components/MergePanel.vue'

/**
 * The `id` is the contract the rest of the page is written against: the tab button is
 * `tab-<id>`, the tabpanel is `panel-<id>`, and the browser QA script addresses the
 * buttons by those ids. A third tab would be a one-line change here.
 */
const TABS = [
  { id: 'disguise', label: '伪装' },
  { id: 'extract', label: '还原' },
] as const

/** 伪装 is first: a visitor arrives wanting to hide a file, not to recover one. */
const activeTab = ref<string>('disguise')

/**
 * index.html already carries the title so the very first paint is correct. Setting it
 * again on mount is what keeps it correct for the shell itself -- a mount that never
 * went through index.html (a spec, an embed) would otherwise inherit whatever title
 * happened to be there.
 */
const TITLE = '图片隐写 · 压缩包伪装'

onMounted(() => {
  document.title = TITLE
})
</script>

<template>
  <div class="shell">
    <header class="masthead">
      <p class="eyebrow">ZIP 隐写 · 浏览器本地运行</p>
      <h1 class="brand">图片隐写 <span class="brand-tail">· 压缩包伪装</span></h1>
      <p class="mechanism" data-testid="shell-mechanism">
        把 ZIP 压缩包原样拼在图片字节之后 ——<span class="keep-together">打开是图片，改后缀就是压缩包。</span>
      </p>
      <p class="privacy" data-testid="shell-privacy">
        <span class="tag">本地</span>全程在浏览器里完成，文件不会上传到任何服务器。
      </p>
    </header>

    <!-- Static by design: three facts about the mechanism, not a carousel. A carousel
         here would be three more pieces of state to keep honest for copy that never
         changes, and would hide two thirds of the answer behind a control. -->
    <section class="howto" aria-label="工作原理">
      <ol class="steps">
        <li class="step">
          <span class="step-n mono">01</span>
          <span class="step-text">
            <span class="step-label">选图</span>
            <span class="step-note">任意浏览器能显示的图片</span>
          </span>
        </li>
        <li class="step">
          <span class="step-n mono">02</span>
          <span class="step-text">
            <span class="step-label">选压缩包</span>
            <span class="step-note">一个 ZIP 压缩包</span>
          </span>
        </li>
        <li class="step">
          <span class="step-n mono">03</span>
          <span class="step-text">
            <span class="step-label">合成</span>
            <span class="step-note">改后缀即成压缩包</span>
          </span>
        </li>
      </ol>
    </section>

    <main class="workbench">
      <AppTabs v-model="activeTab" :tabs="TABS" />

      <!-- Both containers stay in the DOM so every tab's `aria-controls` always resolves
           to a real element even while its panel is torn down. The panel COMPONENT is
           `v-if`'d, not `v-show`'d: switching tabs must DESTROY the other panel, so a
           half-finished merge can never ride silently into a later extraction. The
           panels dispose their own object URLs in `onUnmounted`, so destroying them here
           is all the cleanup either of them needs. -->
      <div
        id="panel-disguise"
        class="panel-slot"
        role="tabpanel"
        aria-labelledby="tab-disguise"
        :hidden="activeTab !== 'disguise'"
      >
        <MergePanel v-if="activeTab === 'disguise'" />
      </div>
      <div
        id="panel-extract"
        class="panel-slot"
        role="tabpanel"
        aria-labelledby="tab-extract"
        :hidden="activeTab !== 'extract'"
      >
        <ExtractPanel v-if="activeTab === 'extract'" />
      </div>
    </main>

    <footer class="colophon">
      <p>合成结果是标准的「带前缀」压缩包，原理与自解压包相同：图片字节在前，ZIP 在后。</p>
      <p>个别严格的解压工具可能拒绝打开这类文件；完整说明见 README。</p>
    </footer>
  </div>
</template>

<style scoped>
/* One centred column for the whole page. The panels provide the only two-column
   moments; the shell never splits, because a split shell at 390px is a horizontal
   scrollbar. `min-height: 100dvh` plus `margin-top: auto` on the footer parks the
   colophon at the bottom of a short viewport without a fixed-height column. */
.shell {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  width: 100%;
  max-width: 58rem;
  min-height: 100vh;
  min-height: 100dvh;
  margin-inline: auto;
  padding: var(--sp-6) var(--sp-4) var(--sp-5);
}

.masthead {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.eyebrow {
  color: var(--text-faint);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--ls-wide);
}

.brand {
  font-size: var(--fs-2xl);
}

/* The product name is one phrase, so the second half sits a step back rather than
   competing with the first. */
.brand-tail {
  color: var(--text-faint);
}

/* The one sentence that answers "what does this actually do?". Sized under the panel
   heading that follows it, because each panel explains its own half in more detail. */
.mechanism {
  color: var(--text-dim);
  font-size: var(--fs-md);
}

/* Chinese has no spaces, so a line break may land anywhere -- including inside 图片 or
   压缩包, which is how the payload of this sentence ends up cut in half. Holding the
   clause together costs nothing: it is short enough to sit on a line of its own at
   390px and still fits inline beside the lead-in on a desktop. */
.keep-together {
  white-space: nowrap;
}

.privacy {
  color: var(--text-faint);
  font-size: var(--fs-sm);
}

/* The second signal role for --accent-2, next to focus: "this stays on your machine".
   The chip carries the word 本地, so the hue is never the only thing being said. */
.tag {
  display: inline-flex;
  align-items: center;
  margin-right: var(--sp-2);
  padding: 0 var(--sp-2);
  border: 1px solid var(--accent-2-line);
  border-radius: var(--r-sm);
  background: var(--accent-2-soft);
  color: var(--accent-2);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--ls-wide);
  white-space: nowrap;
}

/* Recessed, not elevated: the strip is background information, the panel below it is
   the working surface. Depth carries that hierarchy, so the strip gets a well and a
   hairline while the panel keeps the shadow and the edge highlight. */
.howto {
  padding: var(--sp-4) var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.steps {
  display: grid;
  /* One row on a desktop, one column on a phone. The track floor is a column width
     rather than a spacing step, so it is a rem value and not a token. */
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: var(--sp-3) var(--sp-5);
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  min-width: 0;
}

.step-n {
  color: var(--accent-2);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--ls-wide);
}

.step-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.step-label {
  color: var(--text);
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
}

.step-note {
  color: var(--text-faint);
  font-size: var(--fs-xs);
}

.workbench {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 0;
}

/* `min-width: 0` (not a px value) so a wide child -- a long filename, one of the
   panels' auto-fit grids -- shrinks inside the column instead of pushing the whole page
   sideways at 390px. */
.panel-slot {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* One layout invariant the shell owns, and nothing else. `FieldRow` puts its label and
   its control on one grid row, which at 390px leaves the extract panel's offset field
   and its 应用 button about 194px to share. Flexbox shrinks both in proportion to their
   basis; the button has no minimum, so it loses enough to wrap and renders 应 / 用 down
   two lines. `white-space: nowrap` is the whole fix: it removes the break opportunity,
   which raises the button's automatic minimum size to its full label width, so the
   offset field -- which does have a real `min-width` -- absorbs the shrink instead.

   Scoped to `.btn` on purpose. A button label is one short verb phrase that must never
   break; a filename and a panel title must. The panels were written before the shell
   existed and cannot know the viewport, which is why the correction lives out here. */
.panel-slot :deep(.btn) {
  white-space: nowrap;
}

.colophon {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-top: auto;
  padding-top: var(--sp-4);
  border-top: 1px solid var(--line);
  color: var(--text-faint);
  font-size: var(--fs-xs);
}

/* The phone rule. Each panel carries its own `padding: var(--space-5)`, so the shell's
   side padding is the only lever left at 390px -- and trimming it buys back the ~14px
   the extract panel's offset row needs to keep its field and its button on one line. */
@media (max-width: 480px) {
  .shell {
    gap: var(--sp-5);
    padding: var(--sp-5) var(--sp-3) var(--sp-4);
  }

  .howto {
    padding: var(--sp-3);
  }
}
</style>
