import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { apiMiddleware } from './build/api-middleware.js';
import { guideMarkdown } from './build/guide-markdown.js';
import { GUIDES } from './build/guides.js';
import { guidesSite } from './build/guides-site.js';
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
      pages: GUIDES.documents.map((g) => ({ html: g.html, markdown: g.markdown, base: '/guides/' })),
    }),
    guidesSite({ root }),
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
        guides: r('./guides/index.html'),
        guide: r('./guides/bluesky-for-brands.html'),
        garden: r('./garden/index.html'),
        weather: r('./weather/index.html'),
        settings: r('./settings/index.html'),
        // Filled per request by api/blog.ts (server/blog/shell.ts); not a page of its own.
        blog: r('./shells/blog.html'),
        notfound: r('./404.html'),
      },
    },
  },
});
