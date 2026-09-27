import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 20000,
    // Guarded no-op outside jsdom; see that file for why it has to stay conditional.
    setupFiles: ['test/setup/jsdom.ts'],
    // vitest 4 REMOVED `environmentMatchGlobs`. Per-directory environments are now
    // declared as `projects`: each one sets `extends: true` to inherit the plugin, the
    // `@` alias and the shared options above, then overrides only what differs -- which
    // files it owns and which environment it runs in.
    //
    // The projects are named so `pnpm test:unit` / `test:component` / `fixtures` can
    // select them with `--project <name>`.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'evidence',
          environment: 'node',
          include: ['test/evidence/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'composable',
          environment: 'node',
          include: ['test/composable/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['test/component/**/*.spec.ts'],
        },
      },
    ],
  },
})
