/**
 * Publishes one issue of poe's atmosphere dispatch: a markdown file becomes a
 * site.standard.document in atpota.to's repo, under the dispatch publication that
 * Leaflet created. /blog shows it within its cache time (5 minutes), and it is shaped
 * like the documents Leaflet writes itself, so poe.leaflet.pub can show it too.
 *
 *   npm run publish:dispatch -- issue.md --dry-run            show the record, touch nothing
 *   npm run publish:dispatch -- issue.md --dry-run --out x    also save it as JSON
 *   ATP_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run publish:dispatch -- issue.md
 *   ... -- issue.md --rkey 3mabc...                           update an issue already published
 *   ... -- issue.md --rkey 3mabc... --bsky-post <post url>    link its announcement post
 *
 * The file is the dispatch pipeline's final.md (bot/scripts/dispatch-demo.ts): a
 * "# title" line, an italic description line, then the body. Edit it by hand first if
 * you like; what is in the file is what gets published.
 *
 * Writing is the approval. Nothing else publishes an issue until the automated review
 * loop exists (agent-spec/12-weekly-dispatch.md). ATP_IDENTIFIER defaults to atpota.to;
 * use an app password, never the main one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTid, tidFromTime } from '../build/atproto-ids.js';
import { RECORD_BUDGET_BYTES } from '../build/guide-records.js';
import { markdownToLeaflet } from '../build/leaflet-markdown.js';
import { ATPOTATO_DID, DEFAULT_PUBLICATION_URI, POE_DID } from '../server/blog/config.js';
import { pdsFor, sameRecord, xrpc, type PublishDeps } from './publish-guides.js';

type Fetch = typeof fetch;

const COLLECTION = 'site.standard.document';
/** The dispatch publication's own url, where Leaflet serves each issue at /<rkey>. */
export const DISPATCH_URL = 'https://poe.leaflet.pub';
export const TAGS = ['atmosphere', 'dispatch'];

export interface Issue {
  title: string;
  description: string;
  body: string;
}

/** "# title", then "*description*", then the body. */
export function parseIssue(markdown: string): Issue {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => l.trim() !== '');
  const title = /^#\s+(.+)$/.exec(lines[at] ?? '')?.[1]?.trim();
  if (!title) throw new Error('the issue must start with a "# title" line');
  const next = lines.findIndex((l, i) => i > at && l.trim() !== '');
  const description = /^\*(.+)\*$/.exec(lines[next]?.trim() ?? '')?.[1]?.trim();
  if (!description) throw new Error('the line after the title must be the description in *italics*');
  const body = lines.slice(next + 1).join('\n').trim();
  if (!body) throw new Error('the issue has no body');
  return { title, description, body };
}

export interface DispatchRecordOptions {
  root: string;
  rkey: string;
  publishedAt: string;
  bskyPostRef?: { uri: string; cid: string };
}

/** The document, built offline, so --dry-run and the tests see exactly what is written. */
export function dispatchRecord(issue: Issue, opts: DispatchRecordOptions): Record<string, unknown> {
  const converted = markdownToLeaflet(issue.body, {
    publicDir: resolve(opts.root, 'public'),
    base: '/blog/',
    origin: 'https://atpota.to',
    pageUrl: `${DISPATCH_URL}/${opts.rkey}`,
  });
  if (converted.blobs.length) throw new Error('images are not supported in the dispatch yet; remove them from the issue');
  return {
    $type: COLLECTION,
    site: DEFAULT_PUBLICATION_URI,
    // Leaflet's own documents use their record key as the path.
    path: `/${opts.rkey}`,
    title: issue.title,
    description: issue.description,
    publishedAt: opts.publishedAt,
    tags: TAGS,
    contributors: [{ did: POE_DID }],
    textContent: converted.text,
    content: converted.content,
    ...(opts.bskyPostRef ? { bskyPostRef: opts.bskyPostRef } : {}),
  };
}

function arg(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at !== -1 ? args[at + 1] : undefined;
}

/** An at:// post URI or a bsky.app post URL, as { uri, cid } from the public AppView. */
async function postRef(doFetch: Fetch, input: string): Promise<{ uri: string; cid: string }> {
  let uri = input.trim();
  const web = /^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/.exec(uri);
  if (web) {
    let repo = web[1]!;
    if (!repo.startsWith('did:')) {
      const res = await xrpc<{ did?: string }>(doFetch,
        `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(repo)}`);
      if (!res.body?.did) throw new Error(`could not resolve ${repo}`);
      repo = res.body.did;
    }
    uri = `at://${repo}/app.bsky.feed.post/${web[2]}`;
  }
  if (!/^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[^/]+$/.test(uri)) throw new Error(`not a post: ${input}`);
  const res = await xrpc<{ posts?: { uri: string; cid: string }[] }>(doFetch,
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`);
  const post = res.body?.posts?.[0];
  if (!post?.cid) throw new Error(`could not find the post ${uri}`);
  return { uri: post.uri, cid: post.cid };
}

export async function main(args: string[], deps: PublishDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const root = deps.root ?? process.cwd();
  const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!file) {
    log('usage: npm run publish:dispatch -- <issue.md> [--dry-run [--out x.json]] [--rkey <tid>] [--at <iso date>] [--bsky-post <url>]');
    return 2;
  }

  let issue: Issue;
  try {
    issue = parseIssue(readFileSync(resolve(file), 'utf8'));
  } catch (error) {
    log(String((error as Error).message ?? error));
    return 1;
  }

  const rkeyArg = arg(args, 'rkey');
  if (rkeyArg && !isTid(rkeyArg)) {
    log(`--rkey must be a record key like 3mabc..., not ${rkeyArg}`);
    return 1;
  }
  const publishedAt = arg(args, 'at') ?? now().toISOString();
  if (Number.isNaN(Date.parse(publishedAt))) {
    log(`--at must be a date, not ${publishedAt}`);
    return 1;
  }
  // A new issue's key comes from its publish time, like a Leaflet document's.
  const rkey = rkeyArg ?? tidFromTime(Date.parse(publishedAt));
  const uri = `at://${ATPOTATO_DID}/${COLLECTION}/${rkey}`;

  let record: Record<string, unknown>;
  try {
    const bskyPost = arg(args, 'bsky-post');
    record = dispatchRecord(issue, { root, rkey, publishedAt, bskyPostRef: bskyPost ? await postRef(doFetch, bskyPost) : undefined });
  } catch (error) {
    log(String((error as Error).message ?? error));
    return 1;
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ repo: ATPOTATO_DID, collection: COLLECTION, rkey, record })).length;
  log(`${dryRun ? 'dry run: ' : ''}"${issue.title}"  ${uri}  ${(bytes / 1024).toFixed(1)} KB`);
  if (bytes > RECORD_BUDGET_BYTES) {
    log(`too big: the PDS takes about ${RECORD_BUDGET_BYTES / 1000} KB per record; shorten the issue`);
    return 1;
  }

  if (dryRun) {
    const out = arg(args, 'out');
    if (out) {
      writeFileSync(resolve(out), JSON.stringify({ uri, record }, null, 2));
      log(`wrote ${out}`);
    }
    return 0;
  }

  const password = env.ATP_APP_PASSWORD?.trim();
  if (!password) {
    log('set ATP_APP_PASSWORD (an app password for atpota.to), or pass --dry-run');
    return 1;
  }
  const identifier = env.ATP_IDENTIFIER?.trim() || 'atpota.to';
  try {
    const pds = await pdsFor(doFetch, ATPOTATO_DID);

    // Without --rkey this is a new issue. Refuse if one with the same title is already
    // published, so a second run cannot post the issue twice.
    const existing = await xrpc<{ records?: { uri: string; value: Record<string, unknown> }[] }>(doFetch,
      `${pds}/xrpc/com.atproto.repo.listRecords?repo=${ATPOTATO_DID}&collection=${COLLECTION}&limit=100`);
    const twin = existing.body?.records?.find((r) => r.value.site === DEFAULT_PUBLICATION_URI && r.value.title === issue.title);
    if (!rkeyArg && twin) {
      log(`already published as ${twin.uri}; pass --rkey ${twin.uri.split('/').pop()} to update it`);
      return 1;
    }

    const session = await xrpc<{ accessJwt?: string; did?: string; message?: string }>(doFetch, `${pds}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    if (session.status !== 200 || !session.body?.accessJwt) {
      log(`sign-in failed (${session.status}): ${session.body?.message ?? 'no message'}`);
      return 1;
    }
    if (session.body.did !== ATPOTATO_DID) {
      log(`signed in as ${session.body.did}, but the dispatch lives in ${ATPOTATO_DID}; nothing written`);
      return 1;
    }

    const current = await xrpc<{ value?: Record<string, unknown> }>(doFetch,
      `${pds}/xrpc/com.atproto.repo.getRecord?repo=${ATPOTATO_DID}&collection=${COLLECTION}&rkey=${rkey}`);
    const before = current.status === 200 ? current.body?.value : undefined;
    if (before && sameRecord(before, record)) {
      log(`unchanged  ${uri}`);
    } else {
      // An update keeps the first publishedAt, so the issue does not jump in the list.
      const toWrite = before
        ? { ...record, publishedAt: before.publishedAt ?? record.publishedAt, updatedAt: now().toISOString() }
        : record;
      const put = await xrpc<{ message?: string }>(doFetch, `${pds}/xrpc/com.atproto.repo.putRecord`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.body.accessJwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: ATPOTATO_DID, collection: COLLECTION, rkey, record: toWrite }),
      });
      if (put.status !== 200) throw new Error(`writing ${uri} failed (${put.status}): ${put.body?.message ?? ''}`);
      log(`${before ? 'updated   ' : 'published '} ${uri}`);
    }
  } catch (error) {
    log(String((error as Error)?.message ?? error));
    return 1;
  }

  log('');
  log('check it (the blog caches for up to 5 minutes):');
  log(`  https://atpota.to/blog/${rkey}`);
  log(`  ${DISPATCH_URL}/${rkey}`);
  log(`  https://aturi.to/profile/${ATPOTATO_DID}/${COLLECTION}/${rkey}`);
  if (!arg(args, 'bsky-post')) {
    log('');
    log('after posting the announcement from @poe.atpota.to, link it:');
    log(`  npm run publish:dispatch -- ${file} --rkey ${rkey} --bsky-post <post url>`);
  }
  return 0;
}
