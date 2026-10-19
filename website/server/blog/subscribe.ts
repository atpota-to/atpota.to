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
  emailButton: 'subscribe by email',
  emailFine: "leaflet.pub sends the emails. you'll confirm your address there, then come right back.",
  bluesky: 'subscribe with bluesky',
} as const;

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
