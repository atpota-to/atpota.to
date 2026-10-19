import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Vercel runs api/*.ts as native ESM after compiling each file on its own, so local
// imports in api/ and server/ must name the compiled file: "../server/x.js", never
// "../server/x" or "../server/x.ts". Vite dev resolves all three, so this test is the
// only thing that catches the mistake before a deploy.
const root = fileURLToPath(new URL('..', import.meta.url));

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return /\.(ts|mts)$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });
}

const IMPORT_RE = /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

describe('api/ and server/ local imports', () => {
  const files = [...tsFiles(join(root, 'api')), ...tsFiles(join(root, 'server'))];

  it('finds the function entry points', () => {
    expect(files.some((f) => f.endsWith(join('api', 'poe.ts')))).toBe(true);
  });

  it.each(files.map((f) => [f.slice(root.length)]))('%s uses .js extensions for relative imports', (rel) => {
    const source = readFileSync(join(root, rel), 'utf8');
    const bad: string[] = [];
    for (const m of source.matchAll(IMPORT_RE)) {
      const typeOnly = Boolean(m[2]);
      const spec = m[3] ?? m[4]!;
      if (typeOnly) continue;
      if (!/\.(js|mjs|json)$/.test(spec)) bad.push(spec);
    }
    expect(bad, `relative imports without .js in ${rel}`).toEqual([]);
  });
});
