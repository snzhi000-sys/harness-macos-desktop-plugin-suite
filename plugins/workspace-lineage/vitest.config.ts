import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      'react': fileURLToPath(new URL('../../node_modules/.pnpm/node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('../../node_modules/.pnpm/node_modules/react-dom', import.meta.url)),
      '@deepseek-ai/dsh-client-runtime/client': fileURLToPath(new URL(
        '../../packages/client/runtime/src/client/index.ts', import.meta.url,
      )),
      '@deepseek-ai/dsh-client-test-runtime': fileURLToPath(new URL(
        '../../packages/test-support/client-runtime/lib/index.js', import.meta.url,
      )),
      '@deepseek-ai/dsh-client-web-react': fileURLToPath(new URL(
        '../../packages/client/web-react/lib/index.js', import.meta.url,
      )),
      '@deepseek-ai/dsh-client-ui-workspace/client': fileURLToPath(new URL(
        './src/client/index.ts', import.meta.url,
      )),
      '@deepseek-ai/dsh-client-ui-workspace/invariant': fileURLToPath(new URL(
        './src/invariant.ts', import.meta.url,
      )),
      '@deepseek-ai/dsh-client-ui-workspace': fileURLToPath(new URL(
        './src/index.ts', import.meta.url,
      )),
      '@deepseek-ai/dsh-client-locale/client': fileURLToPath(new URL(
        '../../packages/client/locale/src/client/index.ts', import.meta.url,
      )),
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL(
        '../../packages/client/ui-primitives/src/index.ts', import.meta.url,
      )),
      '@deepseek-ai/dsh-client-locale/src/locales/zh.ts': fileURLToPath(new URL(
        '../../packages/client/locale/src/locales/zh.ts', import.meta.url,
      )),
      '@testing-library/react': fileURLToPath(new URL(
        '../../node_modules/@testing-library/react/dist/index.js', import.meta.url,
      )),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.{ts,tsx}'],
  },
})
