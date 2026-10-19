/**
 * /blog/feed.xml: an Atom feed of the newest posts, full text included, so the newsletter
 * also works in a feed reader. Embeds render as plain link cards here (no AppView
 * lookups for twenty posts at once).
 */

import { SITE_ORIGIN } from './config.js';
import { escapeHtml } from './html.js';
import { FEED_PATH, docUrl, profileUrl, type SiteInfo } from './pages.js';
import type { BlogDocument } from './records.js';

export const FEED_ENTRIES = 20;

/** XML-safe text: escaped, with characters XML 1.0 forbids removed. */
export function xml(value: string): string {
  return escapeHtml(value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')).replace(/"/g, '&quot;');
}

export interface FeedEntry {
  doc: BlogDocument;
  /** Rendered post body (HTML). */
  html: string;
}

export function atomFeed(site: SiteInfo, entries: readonly FeedEntry[], now: string): string {
  const updated = entries.reduce((latest, e) => {
    const t = e.doc.updatedAt ?? e.doc.publishedAt;
    return t > latest ? t : latest;
  }, entries[0]?.doc.publishedAt ?? now);
  const author = site.handle === 'poe.atpota.to' ? 'poe' : site.handle;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${xml(site.name)}</title>`,
    `  <subtitle>${xml(site.tagline)}</subtitle>`,
    `  <link href="${xml(`${SITE_ORIGIN}${FEED_PATH}`)}" rel="self" type="application/atom+xml"/>`,
    `  <link href="${xml(site.url)}" rel="alternate" type="text/html"/>`,
    `  <id>${xml(site.publication?.uri ?? site.url)}</id>`,
    `  <updated>${xml(updated)}</updated>`,
    `  <author><name>${xml(author)}</name><uri>${xml(profileUrl(site.handle))}</uri></author>`,
    `  <icon>${xml(`${SITE_ORIGIN}/favicon.png`)}</icon>`,
  ];
  for (const { doc, html } of entries) {
    const url = docUrl(site, doc);
    lines.push(
      `  <entry xml:base="${xml(url)}">`,
      `    <title>${xml(doc.title)}</title>`,
      `    <link href="${xml(url)}" rel="alternate" type="text/html"/>`,
      `    <id>${xml(doc.uri)}</id>`,
      `    <published>${xml(doc.publishedAt)}</published>`,
      `    <updated>${xml(doc.updatedAt ?? doc.publishedAt)}</updated>`,
      ...(doc.description ? [`    <summary>${xml(doc.description)}</summary>`] : []),
      ...doc.tags.map((t) => `    <category term="${xml(t)}"/>`),
      `    <content type="html">${xml(html)}</content>`,
      '  </entry>',
    );
  }
  lines.push('</feed>', '');
  return lines.join('\n');
}
