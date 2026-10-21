/**
 * The two ways to subscribe to the dispatch, as markup shared by the index, the end of a
 * post and Leaflet signup blocks:
 *
 *   by email     Leaflet's embeddable subscribe form (publication settings -> Embeddable
 *                Subscribe Form). A plain GET form to leaflet.pub: the reader confirms their
 *                address there, and Leaflet sends them back to LEAFLET_RETURN_PATH on
 *                atpota.to, which forwards them to the page they came from (see
 *                emailReturnLocation). Works without JavaScript, landing on the index then.
 *                Leaflet keeps the email list; atpota.to never sees the address.
 *                Leaflet's address goes on the button (formaction), not the form: Safari reads
 *                a lone email field in a form posting to ".../auth/email-login" as a sign-in,
 *                puts the cursor in it as the page loads and offers saved passwords.
 *   on bluesky   a site.standard.graph.subscription record in the reader's own repo, written
 *                by src/blog/ after a Bluesky sign-in. Hidden until that code runs.
 *
 * src/blog/ui.ts adds an "also subscribe with bluesky" box to the email form for a signed-in
 * reader who hasn't subscribed there yet, so one submit does both (or just bluesky, with the
 * email left empty). While the box is there, the bluesky link under that form steps aside.
 */

import { BLOG_PATH, SITE_ORIGIN } from './config.js';
import { escapeAttr, escapeHtml } from './html.js';

export const LEAFLET_EMAIL_LOGIN = 'https://leaflet.pub/api/auth/email-login';
/** Added on the way back from Leaflet, so the page can say the email subscription went through. */
export const EMAIL_RETURN_PARAM = 'subscribed';
export const EMAIL_RETURN_VALUE = 'email';

/**
 * Once the reader has confirmed, Leaflet doesn't send them to `redirect` itself: it sends
 * them to this path on redirect's site, with a token only Leaflet can read (its own custom
 * domains take a sign-in there). atpota.to answers it (handler.ts, view=email-return).
 */
export const LEAFLET_RETURN_PATH = '/receive_auth_callback';
/**
 * The page to go back to, set by src/blog/ui.ts as an email form goes to Leaflet: the
 * form's `redirect` (path and #form), percent-encoded. Only sent to LEAFLET_RETURN_PATH.
 */
export const EMAIL_RETURN_COOKIE = 'blog_email_return';

export const SUBSCRIBE_COPY = {
  emailLabel: 'your email',
  emailPlaceholder: 'you@example.com',
  emailButton: 'subscribe',
  emailFine: "sent by leaflet.pub. you'll confirm there first.",
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
 * until src/blog/ runs, and while the form's own bluesky box stands in for it) takes no space.
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

/**
 * `url` pointing at the form the reader used. No return marker: Leaflet's "back" link on
 * its confirm page goes here too, before anything is confirmed.
 */
export function emailRedirect(url: string, formId: string): string {
  const u = new URL(url);
  u.hash = formId;
  return u.toString();
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Where LEAFLET_RETURN_PATH sends a reader back from Leaflet: the blog page in their
 * EMAIL_RETURN_COOKIE, else the index's form; with the return marker. Same-site path only.
 */
export function emailReturnLocation(cookieHeader: string | null): string {
  let back = new URL(`${BLOG_PATH}#subscribe`, SITE_ORIGIN);
  const saved = readCookie(cookieHeader, EMAIL_RETURN_COOKIE);
  if (saved) {
    try {
      const u = new URL(decodeURIComponent(saved), SITE_ORIGIN);
      if (u.origin === SITE_ORIGIN && (u.pathname === BLOG_PATH || u.pathname.startsWith(`${BLOG_PATH}/`))) back = u;
    } catch {
      // malformed: the index it is
    }
  }
  back.searchParams.set(EMAIL_RETURN_PARAM, EMAIL_RETURN_VALUE);
  return `${back.pathname}${back.search}${back.hash}`;
}

/** Clears EMAIL_RETURN_COOKIE once it has been used. */
export const EMAIL_RETURN_COOKIE_CLEARED = `${EMAIL_RETURN_COOKIE}=; Path=${LEAFLET_RETURN_PATH}; Max-Age=0; Secure; SameSite=Lax`;

/** `id` must be unique on the page: the reader comes back to #id. */
export function emailFormHtml(signup: EmailSignup, id: string): string {
  return (
    `<form class="blog-email" id="${escapeAttr(id)}" method="get" data-blog-email>` +
    `<input type="hidden" name="action" value="${escapeAttr(emailAction(signup.publication))}">` +
    `<input type="hidden" name="redirect" value="${escapeAttr(emailRedirect(signup.redirect, id))}">` +
    `<div class="blog-email__row">` +
    `<label class="blog-email__field"><span class="visually-hidden">${SUBSCRIBE_COPY.emailLabel}</span>` +
    `<input class="blog-email__input" type="email" name="email" placeholder="${SUBSCRIBE_COPY.emailPlaceholder}" autocomplete="email" aria-describedby="${escapeAttr(id)}-fine" required></label>` +
    `<button type="submit" class="btn btn--primary" formaction="${LEAFLET_EMAIL_LOGIN}">${SUBSCRIBE_COPY.emailButton}</button>` +
    `</div>` +
    `<p class="blog-email__fine" id="${escapeAttr(id)}-fine">${escapeHtml(SUBSCRIBE_COPY.emailFine)}</p>` +
    `</form>`
  );
}

/** The Bluesky subscribe button; src/blog/ reveals it and keeps its label current. */
export function blueskySubscribeHtml(className: string): string {
  return `<button type="button" class="${className}" data-blog-subscribe aria-pressed="false" hidden><span data-blog-subscribe-label>${SUBSCRIBE_COPY.bluesky}</span></button>`;
}
