import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DOCUMENT_NSID,
  GUIDES,
  guideUrl,
  PUBLICATION_NSID,
  publicationUri,
  SITE_ORIGIN,
  type GuideEntry,
} from './guides.js';
import { localBlob, markdownToLeaflet, type LocalBlob } from './leaflet-markdown.js';

/**
 * The guides' standard.site records, built from build/guides.ts and the markdown. Pure
 * apart from reading files, so `npm run publish:guides -- --dry-run` and the tests see
 * exactly what would be written.
 */

/**
 * Largest putRecord request body to send. The PDS caps JSON request bodies; 150 KiB is
 * the commonly cited figure but it is not documented (and auth is checked before size, so
 * it cannot be probed without signing in), so stay a little under it.
 */
export const RECORD_BUDGET_BYTES = 145_000;

export function requestBytes(r: Pick<PreparedRecord, 'collection' | 'rkey' | 'record'>): number {
  return new TextEncoder().encode(JSON.stringify({ repo: GUIDES.did, collection: r.collection, rkey: r.rkey, record: r.record })).length;
}

export interface PreparedRecord {
  collection: string;
  rkey: string;
  uri: string;
  record: Record<string, unknown>;
  /** Files to upload before writing the record. */
  blobs: LocalBlob[];
}

const rgb = (hex: string) => ({
  $type: 'site.standard.theme.color#rgb',
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

/** The site's light theme (src/styles/tokens.css), for readers that theme a publication. */
export const BASIC_THEME = {
  $type: 'site.standard.theme.basic',
  background: rgb('#F4EEDF'),
  foreground: rgb('#3D2F1B'),
  accent: rgb('#006837'),
  accentForeground: rgb('#FCF8EE'),
};

export function publicationRecord(root: string): PreparedRecord {
  const icon = localBlob(GUIDES.publication.icon, resolve(root, 'public'));
  return {
    collection: PUBLICATION_NSID,
    rkey: GUIDES.publication.rkey,
    uri: publicationUri(),
    record: {
      $type: PUBLICATION_NSID,
      name: GUIDES.publication.name,
      description: GUIDES.publication.description,
      url: GUIDES.publication.url,
      icon: icon.ref,
      basicTheme: BASIC_THEME,
      preferences: { showInDiscover: true },
    },
    blobs: [icon],
  };
}

export function documentRecord(root: string, guide: GuideEntry): PreparedRecord {
  const publicDir = resolve(root, 'public');
  const converted = markdownToLeaflet(readFileSync(resolve(root, guide.markdown), 'utf8'), {
    publicDir,
    base: '/guides/',
    origin: SITE_ORIGIN,
    pageUrl: guideUrl(guide),
  });
  const cover = localBlob(guide.cover, publicDir);
  const blobs = new Map(converted.blobs.map((b) => [b.ref.ref.$link, b]));
  blobs.set(cover.ref.ref.$link, cover);
  const prepared: PreparedRecord = {
    collection: DOCUMENT_NSID,
    rkey: guide.rkey,
    uri: `at://${GUIDES.did}/${DOCUMENT_NSID}/${guide.rkey}`,
    record: {
      $type: DOCUMENT_NSID,
      site: publicationUri(),
      path: `/${guide.slug}`,
      title: guide.title,
      description: guide.description,
      publishedAt: guide.publishedAt,
      tags: guide.tags,
      coverImage: cover.ref,
      contributors: guide.contributors.map(({ did, displayName, role }) => ({ did, displayName, role })),
      textContent: converted.text,
      content: converted.content,
    },
    blobs: [...blobs.values()],
  };
  // textContent (a plain-text copy for search) is optional: drop it before the blocks.
  if (requestBytes(prepared) > RECORD_BUDGET_BYTES) delete prepared.record.textContent;
  const bytes = requestBytes(prepared);
  if (bytes > RECORD_BUDGET_BYTES) {
    throw new Error(
      `[guides] ${guide.slug} is ${bytes} bytes as a record, over ${RECORD_BUDGET_BYTES}; split it or move pages into content.blobPages`,
    );
  }
  return prepared;
}

export function guideRecords(root: string): PreparedRecord[] {
  return [publicationRecord(root), ...GUIDES.documents.map((guide) => documentRecord(root, guide))];
}
