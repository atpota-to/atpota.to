/**
 * Blog pages (<body data-page="blog">, the index and every post). main.ts imports this
 * module and calls init() once: Bluesky sign-in, subscribe, recommend and comments, all
 * in src/blog/ui.ts, plus the rss buttons' copy-the-link (src/blog/feed-copy.ts) and the
 * apps to share a post from (src/blog/share.ts). The OAuth library itself only loads when
 * it is needed (auth.ts).
 */

import { initFeedCopy } from '../blog/feed-copy';
import { initShare } from '../blog/share';
import { mountBlog } from '../blog/ui';

export function init(): Promise<void> {
  initFeedCopy();
  initShare();
  return mountBlog();
}
