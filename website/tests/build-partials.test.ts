import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyPartials, inlineSvg, markCurrentNav } from '../build/partials.js';

const opts = {
  partialsDir: fileURLToPath(new URL('../src/partials', import.meta.url)),
  assetsDir: fileURLToPath(new URL('../src/assets', import.meta.url)),
};

describe('partials plugin', () => {
  it('injects header and footer with inline currentColor wordmarks', () => {
    const html = applyPartials('<body data-page="home"><!-- @partial header --><main></main><!-- @partial footer --></body>', opts);
    expect(html).toContain('class="site-header"');
    expect(html).toContain('class="site-footer"');
    expect(html).not.toContain('@partial');
    expect(html).not.toContain('@svg');
    const wordmarks = html.match(/<svg class="wordmark" aria-hidden="true" focusable="false"[^>]*viewBox="0 0 874 218"/g);
    expect(wordmarks).toHaveLength(2);
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('data-poe-open');
    expect(html).toContain('data-theme-toggle');
  });

  it('marks the current nav link from body[data-page]', () => {
    const header = applyPartials('<body data-page="blog"><!-- @partial header --></body>', opts);
    expect(header).toMatch(/<a aria-current="page" class="site-nav__link" href="\/blog" data-nav="blog">/);
    expect(header.match(/aria-current/g)).toHaveLength(1);
    const weather = applyPartials('<body data-page="weather"><!-- @partial header --></body>', opts);
    expect(weather).toMatch(/<a aria-current="page" class="site-nav__link" href="\/weather" data-nav="weather">/);
    expect(weather.match(/aria-current/g)).toHaveLength(1);
    const home = applyPartials('<body data-page="home"><!-- @partial header --></body>', opts);
    expect(home).toMatch(/<a aria-current="page" class="site-header__brand" href="\/"[^>]*data-nav="home">/);
    expect(home.match(/aria-current/g)).toHaveLength(1);
    expect(home).not.toMatch(/class="site-nav__link" href="\/"/);
    const notFound = applyPartials('<body data-page="notfound"><!-- @partial header --></body>', opts);
    expect(notFound).not.toContain('aria-current');
    const guide = applyPartials('<body data-page="guide"><!-- @partial header --></body>', opts);
    expect(guide).not.toContain('aria-current');
    expect(guide).not.toContain('data-nav="guides"');
  });

  it('honours data-nav-current and never doubles aria-current', () => {
    const html = '<body data-page="home" data-nav-current="about"><a data-nav="home" href="/">h</a><a data-nav="about" aria-current="page" href="/#about">a</a></body>';
    const out = markCurrentNav(html);
    expect(out.match(/aria-current/g)).toHaveLength(1);
    expect(out).toContain('<a data-nav="home" href="/">h</a>');
  });

  it('rejects partial names and svg paths outside their folders', () => {
    expect(() => applyPartials('<!-- @partial nope -->', opts)).toThrow(/missing partial/);
    expect(() => applyPartials('<!-- @svg ../../package.svg -->', opts)).toThrow(/bad svg path|missing svg/);
  });

  it('adds attributes to an inline svg and strips xml prologs/comments', () => {
    expect(inlineSvg('<?xml version="1.0"?><!-- c --><svg viewBox="0 0 1 1"></svg>', 'class="x"')).toBe(
      '<svg class="x" aria-hidden="true" focusable="false" viewBox="0 0 1 1"></svg>',
    );
  });
});
