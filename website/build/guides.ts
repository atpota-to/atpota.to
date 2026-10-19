/**
 * The guides as a standard.site publication (https://standard.site): one
 * site.standard.publication for /guides and one site.standard.document per guide, in
 * atpota.to's repo. The markdown in public/guides stays the source to edit; the records
 * are generated from it (build/leaflet-markdown.ts) and written by
 * `npm run publish:guides` (scripts/publish-guides.ts).
 *
 * The record keys are fixed here, so the site knows each record's at:// URI at build time
 * (the guide's <link rel="site.standard.document">, the /guides page, and
 * public/.well-known/site.standard.publication/guides) whether or not it has been
 * published yet. Changing DID or a key means republishing and rebuilding.
 */

export const SITE_ORIGIN = 'https://atpota.to';

export interface GuideEntry {
  /** URL segment under /guides, also the document's `path`. */
  slug: string;
  /** Record key (a TID, see build/atproto-ids.ts). */
  rkey: string;
  /** Markdown source, relative to the website root. */
  markdown: string;
  /** Page shell, relative to the website root. */
  html: string;
  title: string;
  /** One line under the title. */
  subtitle: string;
  /** The record's and the page's description. */
  description: string;
  /** When the guide first went up (commit 175bef2). */
  publishedAt: string;
  tags: string[];
  /** Cover image (public/), for previews in standard.site readers. */
  cover: string;
  contributors: { did: string; displayName: string; role: string; handle: string }[];
}

export interface GuidesConfig {
  did: string;
  handle: string;
  publication: { rkey: string; name: string; description: string; url: string; icon: string };
  documents: GuideEntry[];
}

export const GUIDES: GuidesConfig = {
  /** atpota.to, on pds.atpota.to */
  did: 'did:plc:qntsxa2i4sb24noi45fx4np2',
  handle: 'atpota.to',
  publication: {
    rkey: '3lrdzen52y223',
    name: 'atpotato guides',
    description: 'plain-language guides to bluesky and the atproto ecosystem, with screenshots.',
    url: `${SITE_ORIGIN}/guides`,
    /** Square icon (public/), at least 256px. */
    icon: '/atpotato-square.png',
  },
  documents: [
    {
      slug: 'bluesky-for-brands',
      rkey: '3lrdzen52y224',
      markdown: 'public/guides/how-to-use-bluesky-to-grow-your-brand.md',
      html: 'guides/bluesky-for-brands.html',
      title: 'How to use Bluesky to grow your brand',
      subtitle: 'A comprehensive guide for companies, communities, and creators',
      description:
        'A comprehensive guide for companies, communities, and creators looking to establish and grow their presence on Bluesky.',
      publishedAt: '2025-06-11T18:17:59.000Z',
      tags: ['bluesky', 'brands', 'guide'],
      cover: '/bsky-guide-og.png',
      contributors: [{ did: 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj', displayName: 'dame', role: 'author', handle: 'dame.is' }],
    },
  ],
};

export const PUBLICATION_NSID = 'site.standard.publication';
export const DOCUMENT_NSID = 'site.standard.document';

export function publicationUri(): string {
  return `at://${GUIDES.did}/${PUBLICATION_NSID}/${GUIDES.publication.rkey}`;
}

export function documentUri(guide: Pick<GuideEntry, 'rkey'>): string {
  return `at://${GUIDES.did}/${DOCUMENT_NSID}/${guide.rkey}`;
}

export function guideUrl(guide: Pick<GuideEntry, 'slug'>): string {
  return `${GUIDES.publication.url}/${guide.slug}`;
}

export function guideBySlug(slug: string): GuideEntry | undefined {
  return GUIDES.documents.find((g) => g.slug === slug);
}
