/**
 * Settings for Poe's blog (/blog), a standard.site publication rendered from records on
 * a PDS. Read on every request like ../config.ts, so a changed env var applies on the
 * next call and tests can pass their own env.
 *
 *   BLOG_PUBLICATION_URI   the at://.../site.standard.publication/<rkey> to show. Default:
 *                          DEFAULT_PUBLICATION_URI. Its repo is where the posts are read.
 *                          Set but empty: no pin, and the blog uses the publication record
 *                          in BLOG_DID's repo whose `url` is BLOG_PUBLICATION_URL.
 *   BLOG_DID               the repo for that unpinned lookup. Default: Poe (poe.atpota.to).
 *   BLOG_PUBLICATION_URL   atpota.to's address for the blog. Default https://atpota.to/blog.
 *   BLOG_COMMENTS_DISABLED=1  kill switch: posts render without the comments section.
 *   BLOG_EMAIL_DISABLED=1  kill switch: no "subscribe by email" form (subscribe.ts). The form
 *                          only works for a publication with Leaflet's Newsletter Mode on.
 *   BLOG_HIDDEN_COMMENTS   comments to leave off the page: at:// URIs of pub.leaflet.comment
 *                          records, or DIDs to hide everything an account wrote. Separated
 *                          by commas, spaces or new lines. (Blocking an account as the
 *                          publication's owner on Bluesky hides it too; see discussion.ts.)
 *
 * A publication whose own `url` is elsewhere (poe.leaflet.pub for the dispatch) is shown
 * here as a copy: canonical links point at its url, and the /.well-known verification
 * file is only served for a publication whose url is BLOG_PUBLICATION_URL.
 *
 * The name and tagline shown before the publication record exists live in BLOG_COPY; once
 * the record exists its `name` and `description` win.
 *
 * What the blog reads from the repo:
 *   site.standard.publication  { name, description?, icon?, url }
 *   site.standard.document     { site: <the publication's at:// URI>, title, publishedAt,
 *                                path?: "/<slug>", description?, tags?, coverImage?,
 *                                bskyPostRef?, textContent?, content: { $type:
 *                                "pub.leaflet.content", pages: [pub.leaflet.pages.*] } }
 * A post is served at /blog<path> (or /blog/<rkey> without a path) once publishedAt has
 * passed. Without Leaflet content, textContent is shown as plain paragraphs.
 */

import type { Env } from '../config.js';

export const POE_DID = 'did:plc:6qw63oash3jfnpykvpbwnq5z';
export const POE_HANDLE = 'poe.atpota.to';
export const ATPOTATO_DID = 'did:plc:qntsxa2i4sb24noi45fx4np2';
/** "poe's atmosphere dispatch": made in Leaflet, in atpota.to's repo, url https://poe.leaflet.pub. */
export const DEFAULT_PUBLICATION_URI = `at://${ATPOTATO_DID}/site.standard.publication/3myar4h4pls2n`;
export const SITE_ORIGIN = 'https://atpota.to';
export const BLOG_PATH = '/blog';
export const DEFAULT_PUBLICATION_URL = `${SITE_ORIGIN}${BLOG_PATH}`;
/** Where the Vite build puts the page shell (shells/blog.html; clean URL on Vercel). */
export const SHELL_PATHS = ['/shells/blog', '/shells/blog.html'] as const;

export const BLOG_COPY = {
  /** Placeholder until the publication record names the blog. */
  name: "poe's atmosphere dispatch",
  tagline: "a weekly round up of what's happening in the atmosphere",
  emptyTitle: 'the first issue is still in the ground.',
  emptyText: 'follow poe on bluesky or grab the feed to catch it when it sprouts.',
} as const;

export interface BlogConfig {
  did: string;
  /** Pinned publication at:// URI, or null to look it up by URL. */
  publicationUri: string | null;
  /** Publication base URL without a trailing slash. */
  publicationUrl: string;
  commentsEnabled: boolean;
  emailEnabled: boolean;
  /** Comment at:// URIs and author DIDs from BLOG_HIDDEN_COMMENTS. */
  hiddenComments: ReadonlySet<string>;
}

const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9._:%-]+)$/;
const PUBLICATION_URI_RE = /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+)\/site\.standard\.publication\/([A-Za-z0-9._:~-]{1,512})$/;

export function isDid(value: string): boolean {
  return DID_RE.test(value);
}

/** "https://atpota.to/blog/" -> "https://atpota.to/blog"; null for anything but an https URL. */
export function normalizePublicationUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const COMMENT_URI_RE = /^at:\/\/did:[a-z]+:[a-zA-Z0-9._:%-]+\/pub\.leaflet\.comment\/[A-Za-z0-9._:~-]{1,512}$/;

/** BLOG_HIDDEN_COMMENTS: the comment URIs and DIDs in it; anything else is ignored. */
export function parseHiddenComments(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of (raw ?? '').split(/[\s,]+/)) {
    if (COMMENT_URI_RE.test(item) || isDid(item)) out.add(item);
  }
  return out;
}

function flag(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

export function readBlogConfig(env: Env): BlogConfig {
  const did = env.BLOG_DID?.trim();
  const raw = env.BLOG_PUBLICATION_URI?.trim();
  // Unset or unusable: the default pin. Set but empty: no pin.
  const pinned = raw === '' ? null : raw && PUBLICATION_URI_RE.test(raw) ? raw : DEFAULT_PUBLICATION_URI;
  const pinnedMatch = pinned ? PUBLICATION_URI_RE.exec(pinned) : null;
  return {
    did: pinnedMatch && isDid(pinnedMatch[1]!) ? pinnedMatch[1]! : did && isDid(did) ? did : POE_DID,
    publicationUri: pinnedMatch ? pinned : null,
    publicationUrl: normalizePublicationUrl(env.BLOG_PUBLICATION_URL) ?? DEFAULT_PUBLICATION_URL,
    commentsEnabled: !flag(env.BLOG_COMMENTS_DISABLED),
    emailEnabled: !flag(env.BLOG_EMAIL_DISABLED),
    hiddenComments: parseHiddenComments(env.BLOG_HIDDEN_COMMENTS),
  };
}
