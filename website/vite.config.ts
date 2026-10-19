import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { apiMiddleware } from './build/api-middleware.js';
import { guideMarkdown } from './build/guide-markdown.js';
import { partials } from './build/partials.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root,
  appType: 'mpa',
  publicDir: 'public',
  plugins: [
    partials({ partialsDir: r('./src/partials'), assetsDir: r('./src/assets') }),
    guideMarkdown({
      root,
      publicDir: r('./public'),
      pages: [
        {
          html: 'guides/bluesky-for-brands.html',
          markdown: 'public/guides/how-to-use-bluesky-to-grow-your-brand.md',
          base: '/guides/',
        },
      ],
    }),
    apiMiddleware(),
  ],
  // Same-origin only, like production (keeps CORS preflights reaching api/*.ts in dev).
  server: { cors: false },
  preview: { cors: false },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        home: r('./index.html'),
        guide: r('./guides/bluesky-for-brands.html'),
        // Filled per request by api/blog.ts (server/blog/shell.ts); not a page of its own.
        blog: r('./shells/blog.html'),
        notfound: r('./404.html'),
      },
    },
  },
});
