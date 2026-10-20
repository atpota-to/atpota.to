/**
 * The two ways to subscribe to the dispatch, as markup shared by the index, the end of a
 * post and Leaflet signup blocks:
 *
 *   by email     Leaflet's embeddable subscribe form (publication settings -> Embeddable
 *                Subscribe Form). A plain GET form to leaflet.pub: the reader confirms their
 *                address there, and Leaflet sends them back to `redirect`. Works without
 *                JavaScript. Leaflet keeps the email list; atpota.to never sees the address.
 *   on bluesky   a site.standard.graph.subscription record in the reader's own repo, written
 *                by src/blog/ after a Bluesky sign-in. Hidden until that code runs.
 *
 * src/blog/ui.ts adds an "also subscribe with bluesky" box to the email form for a signed-in
 * reader who hasn't subscribed there yet, so one submit does both.
 */

import { escapeAttr, escapeHtml } from './html.js';

export const LEAFLET_EMAIL_LOGIN = 'https://leaflet.pub/api/auth/email-login';
/** Added to `redirect`, so the page can say the email subscription went through. */
export const EMAIL_RETURN_PARAM = 'subscribed';
export const EMAIL_RETURN_VALUE = 'email';

export const SUBSCRIBE_COPY = {
  emailLabel: 'your email',
  emailPlaceholder: 'you@example.com',
  emailButton: 'subscribe',
  emailFine: "sent via leaflet.pub, where you'll confirm.",
  bluesky: 'subscribe with bluesky',
  feed: 'copy the rss feed link',
} as const;

const FEED_ICON =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8"/><circle cx="6" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>';

/**
 * "rss" with its icon. src/blog/feed-copy.ts copies `url` (absolute, so it pastes into any
 * reader) and says so in a bubble; without JavaScript it's a plain link to the feed.
 */
export function feedLinkHtml(path: string, url: string): string {
  return (
    `<a class="blog-alt__link blog-feed" href="${escapeAttr(path)}" data-copy-feed="${escapeAttr(url)}" ` +
    `aria-label="${SUBSCRIBE_COPY.feed}" title="${SUBSCRIBE_COPY.feed}">${FEED_ICON}rss` +
    `<span class="blog-feed__bubble" data-copy-feed-bubble aria-hidden="true"></span>` +
    `<span class="visually-hidden" data-copy-feed-status aria-live="polite"></span></a>`
  );
}

/**
 * The quieter ways to keep up, as one line of text links under the email form:
 * "or subscribe with bluesky, follow poe, rss" ("or" only when a form is above it).
 * `items` are links or buttons with the blog-alt__link class; a hidden one (bluesky,
 * until src/blog/ runs) takes no space.
 */
export function altLinksHtml(items: readonly string[], afterForm = true): string {
  return `<p class="blog-alt">${afterForm ? '<span class="blog-alt__or">or</span>' : ''}${items.filter(Boolean).join('')}</p>`;
}

export interface EmailSignup {
  /** The publication's at:// URI. */
  publication: string;
  /** Absolute URL Leaflet sends the reader back to once they've confirmed. */
  redirect: string;
}

/**
 * Leaflet's `action` value: the JSON percent-encoded, exactly as its snippet has it (the
 * form encodes it once more on submit, and Leaflet decodes both).
 */
export function emailAction(publication: string): string {
  return encodeURIComponent(JSON.stringify({ action: 'subscribe', publication, source: { placement: 'embed' } }));
}

/** `url` with the return marker added, pointing at the form the reader used. */
export function emailRedirect(url: string, formId: string): string {
  const u = new URL(url);
  u.searchParams.set(EMAIL_RETURN_PARAM, EMAIL_RETURN_VALUE);
  u.hash = formId;
  return u.toString();
}

/** `id` must be unique on the page: the reader comes back to #id. */
export function emailFormHtml(signup: EmailSignup, id: string): string {
  return (
    `<form class="blog-email" id="${escapeAttr(id)}" action="${LEAFLET_EMAIL_LOGIN}" method="get" data-blog-email>` +
    `<input type="hidden" name="action" value="${escapeAttr(emailAction(signup.publication))}">` +
    `<input type="hidden" name="redirect" value="${escapeAttr(emailRedirect(signup.redirect, id))}">` +
    `<div class="blog-email__row">` +
    `<label class="blog-email__field"><span class="visually-hidden">${SUBSCRIBE_COPY.emailLabel}</span>` +
    `<input class="blog-email__input" type="email" name="email" placeholder="${SUBSCRIBE_COPY.emailPlaceholder}" autocomplete="email" required></label>` +
    `<button type="submit" class="btn btn--primary">${SUBSCRIBE_COPY.emailButton}</button>` +
    `</div>` +
    `<p class="blog-email__fine">${escapeHtml(SUBSCRIBE_COPY.emailFine)}</p>` +
    `</form>`
  );
}

/** The Bluesky subscribe button; src/blog/ reveals it and keeps its label current. */
export function blueskySubscribeHtml(className: string): string {
  return `<button type="button" class="${className}" data-blog-subscribe aria-pressed="false" hidden><span data-blog-subscribe-label>${SUBSCRIBE_COPY.bluesky}</span></button>`;
}
