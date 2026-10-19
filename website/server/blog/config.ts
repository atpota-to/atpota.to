/**
 * Settings for Poe's blog (/blog), a standard.site publication rendered from records on
 * Poe's PDS. Read on every request like ../config.ts, so a changed env var applies on the
 * next call and tests can pass their own env.
 *
 *   BLOG_DID               whose repo holds the records. Default: Poe (poe.atpota.to).
 *   BLOG_PUBLICATION_URI   pin one at://.../site.standard.publication/<rkey>. Without it the
 *                          blog uses the publication record in that repo whose `url` is
 *                          BLOG_PUBLICATION_URL, so the page goes live as soon as Poe
 *                          creates the record, with no deploy.
 *   BLOG_PUBLICATION_URL   the publication's public address. Default https://atpota.to/blog.
 *
 * The name and tagline shown before the publication record exists live in BLOG_COPY; once
 * the record exists its `name` and `description` win.
 *
 * What the blog reads from the repo:
 *   site.standard.publication  { name, description?, icon?, url: "https://atpota.to/blog" }
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
export const SITE_ORIGIN = 'https://atpota.to';
export const BLOG_PATH = '/blog';
export const DEFAULT_PUBLICATION_URL = `${SITE_ORIGIN}${BLOG_PATH}`;
/** Where the Vite build puts the page shell (shells/blog.html; clean URL on Vercel). */
export const SHELL_PATHS = ['/shells/blog', '/shells/blog.html'] as const;

export const BLOG_COPY = {
  /** Placeholder until the publication record names the blog. */
  name: "poe's blog",
  tagline: "a weekly roundup of what's happening in the atmosphere, written by poe.",
  emptyTitle: 'the first issue is still in the ground.',
  emptyText: 'follow poe on bluesky or grab the feed to catch it when it sprouts.',
} as const;

export interface BlogConfig {
  did: string;
  /** Pinned publication at:// URI, or null to look it up by URL. */
  publicationUri: string | null;
  /** Publication base URL without a trailing slash. */
  publicationUrl: string;
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

export function readBlogConfig(env: Env): BlogConfig {
  const did = env.BLOG_DID?.trim();
  const pinned = env.BLOG_PUBLICATION_URI?.trim();
  const pinnedMatch = pinned ? PUBLICATION_URI_RE.exec(pinned) : null;
  return {
    did: did && isDid(did) ? did : pinnedMatch && isDid(pinnedMatch[1]!) ? pinnedMatch[1]! : POE_DID,
    publicationUri: pinnedMatch ? pinned! : null,
    publicationUrl: normalizePublicationUrl(env.BLOG_PUBLICATION_URL) ?? DEFAULT_PUBLICATION_URL,
  };
}
