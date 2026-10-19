/**
 * Blog pages (<body data-page="blog">, the index and every post). main.ts imports this
 * module and calls init() once: Bluesky sign-in, subscribe, recommend and comments, all
 * in src/blog/ui.ts. The OAuth library itself only loads when it is needed (auth.ts).
 */

import { mountBlog } from '../blog/ui';

export function init(): Promise<void> {
  return mountBlog();
}
