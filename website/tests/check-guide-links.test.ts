import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLinks, main, profileActor } from '../scripts/check-guide-links.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };

describe('findLinks', () => {
  it('collects link targets and @handles once each, skipping code spans, examples and emails', () => {
    const md = [
      'See [Graze](https://graze.social) and [Graze again](https://graze.social).',
      'The CEO is @toni.bsky.team, and @npr.org (plus @ mentions and @someone).',
      'Try `aturi.to/profile/yourbrand.com` or `@not.checked`, like @hannah.swifties.social.',
      'Write to support@bsky.app or open [a profile](https://bsky.app/profile/bart.gov).',
    ].join('\n');
    expect(findLinks(md)).toEqual({
      urls: ['https://graze.social', 'https://bsky.app/profile/bart.gov'],
      handles: ['toni.bsky.team', 'npr.org'],
    });
  });

  it('finds the handle or DID behind bsky.app profile links', () => {
    expect(profileActor('https://bsky.app/profile/Boston.gov')).toBe('boston.gov');
    expect(profileActor('https://bsky.app/profile/did:plc:abc/post/3k')).toBe('did:plc:abc');
    expect(profileActor('https://bsky.app/starter-pack/boston.gov/3l')).toBeUndefined();
  });
});

describe('main', () => {
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.includes('getProfile?actor=moved.example')) return json(200, { handle: 'elsewhere.example' });
    if (url.includes('getProfile?actor=gone.example')) return json(400, { message: 'Profile not found' });
    if (url.includes('getProfile?actor=')) return json(200, { handle: decodeURIComponent(url.split('actor=')[1]!) });
    if (url === 'https://blocked.example/') return new Response('', { status: 403 });
    if (url === 'https://dead.example/') return new Response('', { status: 404 });
    if (url === 'https://down.example/') throw new Error('fetch failed');
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  const run = async (markdown: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'links-'));
    writeFileSync(join(dir, 'guide.md'), markdown);
    const lines: string[] = [];
    const code = await main(['guide.md'], { fetch: fakeFetch, log: (l) => lines.push(l), root: dir });
    return { code, out: lines.join('\n') };
  };

  it('is wired as an npm script', () => {
    expect(pkg.scripts['check:links']).toBe('node scripts/run.mjs scripts/check-guide-links.ts');
  });

  it('passes when every link loads and every handle still matches its profile', async () => {
    const { code, out } = await run('[a](https://ok.example/) and @fine.example, [p](https://bsky.app/profile/fine.example)');
    expect(code).toBe(0);
    expect(out).toContain('2 checked, all fine');
  });

  it('fails on dead pages, missing profiles and moved handles, and only warns on 403', async () => {
    const { code, out } = await run(
      '[a](https://dead.example/) [b](https://down.example/) [c](https://blocked.example/) @gone.example [d](https://bsky.app/profile/moved.example)',
    );
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL {2}https:\/\/dead\.example\/ {2}\(404\)/);
    expect(out).toMatch(/FAIL {2}https:\/\/down\.example\/ {2}\(fetch failed\)/);
    expect(out).toMatch(/warn {2}https:\/\/blocked\.example\/ {2}\(403/);
    expect(out).toContain('FAIL  @gone.example  (Profile not found)');
    expect(out).toContain("FAIL  @moved.example  (profile's handle is now elsewhere.example)");
    expect(out).toContain('4 failed, 1 warnings');
  });
});
