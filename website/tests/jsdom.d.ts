// jsdom ships no types and the tests only construct documents with it, so declare
// just that instead of adding @types/jsdom.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { contentType?: string; url?: string });
    readonly window: Window & typeof globalThis;
  }
}
