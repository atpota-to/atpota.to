import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests do not load the dev plugins or .env files.
// Default environment is node; DOM tests opt in per file with `// @vitest-environment jsdom`.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
