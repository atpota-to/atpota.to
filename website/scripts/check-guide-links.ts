/**
 * Checks every link and Bluesky account in the guides (build/guides.ts), so dead pages and
 * moved handles turn up before readers find them.
 *
 *   npm run check:links                      every guide
 *   npm run check:links -- path/to/file.md   just these files
 *
 * A web link fails on a network error or a 4xx/5xx answer. 401, 403 and 429 only warn,
 * since plenty of sites turn scripts away. A bsky.app/profile link, or an @handle in the
 * prose, fails unless Bluesky's AppView returns a profile that still has that handle
 * (bsky.app itself answers 200 for anything, so it can't be checked by status).
 * Code spans are skipped, so placeholders like `aturi.to/profile/yourbrand.com` are left alone.
 * Exits 1 when anything fails.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GUIDES } from '../build/guides.js';

type Fetch = typeof fetch;

export interface CheckDeps {
  fetch?: Fetch;
  log?: (line: string) => void;
  root?: string;
}

export interface Finding {
  level: 'ok' | 'warn' | 'fail';
  target: string;
  detail: string;
}

const APPVIEW = 'https://public.api.bsky.app';
const USER_AGENT = 'Mozilla/5.0 (compatible; atpotato-link-check; +https://atpota.to)';
const CONCURRENCY = 6;

/** Made-up handles the guides use as examples. */
export const EXAMPLE_HANDLES = new Set(['hannah.swifties.social']);

/** The http(s) URLs a markdown file links to and the @handles it mentions, each once, in order. */
export function findLinks(markdown: string): { urls: string[]; handles: string[] } {
  const text = markdown.replace(/`[^`\n]*`/g, '');
  const urls = new Set<string>();
  for (const m of text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) urls.add(m[1]!);
  const handles = new Set<string>();
  for (const m of text.matchAll(/(?<![\w/.@])@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
    const handle = m[1]!.toLowerCase();
    if (!EXAMPLE_HANDLES.has(handle)) handles.add(handle);
  }
  return { urls: [...urls], handles: [...handles] };
}

/** The handle or DID in a bsky.app profile link (or one of its posts, feeds, lists), else undefined. */
export function profileActor(url: string): string | undefined {
  const m = /^https:\/\/bsky\.app\/profile\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]!).toLowerCase() : undefined;
}

async function checkActor(doFetch: Fetch, actor: string): Promise<Finding> {
  const target = actor.startsWith('did:') ? actor : `@${actor}`;
  try {
    const res = await doFetch(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { handle?: string; message?: string };
    if (res.status === 200) {
      const handle = body.handle?.toLowerCase();
      if (!actor.startsWith('did:') && handle !== actor) return { level: 'fail', target, detail: `profile's handle is now ${handle}` };
      if (handle === 'handle.invalid') return { level: 'fail', target, detail: 'handle no longer verifies' };
      return { level: 'ok', target, detail: handle ?? '' };
    }
    if (res.status === 429 || res.status >= 500) return { level: 'warn', target, detail: `AppView answered ${res.status}` };
    return { level: 'fail', target, detail: body.message ?? `AppView answered ${res.status}` };
  } catch (error) {
    return { level: 'warn', target, detail: `AppView unreachable: ${(error as Error).message}` };
  }
}

async function checkUrl(doFetch: Fetch, url: string): Promise<Finding> {
  try {
    const res = await doFetch(url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    await res.body?.cancel();
    if (res.status < 400) return { level: 'ok', target: url, detail: String(res.status) };
    if (res.status === 401 || res.status === 403 || res.status === 429) return { level: 'warn', target: url, detail: `${res.status}, may only block scripts` };
    return { level: 'fail', target: url, detail: String(res.status) };
  } catch (error) {
    return { level: 'fail', target: url, detail: (error as Error).message };
  }
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

/** Checks one markdown file's links and handles. */
export async function checkMarkdown(markdown: string, doFetch: Fetch): Promise<Finding[]> {
  const { urls, handles } = findLinks(markdown);
  const actors = new Set(handles);
  const webUrls: string[] = [];
  for (const url of urls) {
    const actor = profileActor(url);
    if (actor) actors.add(actor);
    else webUrls.push(url);
  }
  const jobs: (() => Promise<Finding>)[] = [
    ...[...actors].map((a) => () => checkActor(doFetch, a)),
    ...webUrls.map((u) => () => checkUrl(doFetch, u)),
  ];
  return pool(jobs, CONCURRENCY, (job) => job());
}

export async function main(args: string[], deps: CheckDeps = {}): Promise<number> {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const log = deps.log ?? ((line: string) => console.log(line));
  const root = deps.root ?? process.cwd();
  const files = args.length > 0 ? args : GUIDES.documents.map((g) => g.markdown);

  let failures = 0;
  let warnings = 0;
  for (const file of files) {
    const findings = await checkMarkdown(readFileSync(resolve(root, file), 'utf8'), doFetch);
    const bad = findings.filter((f) => f.level !== 'ok');
    log(`${file}: ${findings.length} checked, ${bad.length ? `${bad.length} to look at` : 'all fine'}`);
    for (const f of bad) log(`  ${f.level === 'fail' ? 'FAIL' : 'warn'}  ${f.target}  (${f.detail})`);
    failures += findings.filter((f) => f.level === 'fail').length;
    warnings += findings.filter((f) => f.level === 'warn').length;
  }
  log(`${failures} failed, ${warnings} warnings`);
  return failures > 0 ? 1 : 0;
}
