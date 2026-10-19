// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isSafeHttps, matchAllowedLink, parseBlocks, renderAnswer, splitTrailingFace } from '../src/poe/render.js';

function render(text: string, links: string[] = []) {
  const host = document.createElement('div');
  const result = renderAnswer(text, links, document);
  host.appendChild(result.fragment);
  return { host, ...result };
}

function anchors(host: Element): HTMLAnchorElement[] {
  return Array.from(host.querySelectorAll('a'));
}

const DANGEROUS_TAGS = 'script, img, iframe, svg, style, object, embed, form, input, button, video, audio, link, meta, base, math, template';

describe('render: structure', () => {
  it('turns blank-line paragraphs into <p> and single newlines into <br>', () => {
    const { host } = render('first line\nsecond line\n\nnext para');
    const ps = host.querySelectorAll('p');
    expect(ps).toHaveLength(2);
    expect(ps[0]!.childNodes[1]!.nodeName).toBe('BR');
    expect(ps[0]!.textContent).toBe('first linesecond line');
    expect(ps[1]!.textContent).toBe('next para');
    expect(host.children).toHaveLength(2);
  });

  it('turns "- " lines into a list, also right after a paragraph line', () => {
    const { host } = render('three things:\n- one\n- two `x`\n- three\n\nafter');
    expect(host.children[0]!.tagName).toBe('P');
    const ul = host.children[1]!;
    expect(ul.tagName).toBe('UL');
    expect(Array.from(ul.children).map((li) => li.textContent)).toEqual(['one', 'two x', 'three']);
    expect(ul.querySelector('code')!.textContent).toBe('x');
    expect(host.children[2]!.textContent).toBe('after');
  });

  it('joins an indented continuation line onto its list item', () => {
    const { host } = render('- a long item\n  that wraps\n- next');
    expect(Array.from(host.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a long item that wraps', 'next']);
  });

  it('renders inline code as text, never as markup or a link', () => {
    const { host } = render('use `<b>app.bsky.feed.post</b>` and `https://aturi.to`', ['https://aturi.to']);
    const codes = host.querySelectorAll('code');
    expect(codes[0]!.textContent).toBe('<b>app.bsky.feed.post</b>');
    expect(codes[0]!.children).toHaveLength(0);
    expect(codes[1]!.textContent).toBe('https://aturi.to');
    expect(anchors(host)).toHaveLength(0);
  });

  it('keeps an unmatched backtick literal', () => {
    let { host } = render('a ` lone backtick');
    expect(host.querySelector('code')).toBeNull();
    expect(host.textContent).toBe('a ` lone backtick');
    ({ host } = render('empty `` pair'));
    expect(host.querySelector('code')).toBeNull();
    expect(host.textContent).toBe('empty `` pair');
  });

  it('renders ``` fences as <pre><code> text, dropping the language tag', () => {
    const text = 'the record:\n\n```json\n{"$type": "app.bsky.feed.post",\n  "text": "<script>alert(1)</script> https://aturi.to"}\n```\n\nthat is it';
    const { host } = render(text, ['https://aturi.to']);
    const pre = host.querySelector('pre')!;
    expect(pre.firstElementChild!.tagName).toBe('CODE');
    expect(pre.textContent).toBe('{"$type": "app.bsky.feed.post",\n  "text": "<script>alert(1)</script> https://aturi.to"}');
    expect(pre.querySelector('a, script')).toBeNull();
    expect(host.lastElementChild!.textContent).toBe('that is it');
  });

  it('treats an unclosed fence as code to the end', () => {
    const { host } = render('look:\n```\nline 1\n- not a list');
    expect(host.querySelector('pre')!.textContent).toBe('line 1\n- not a list');
    expect(host.querySelector('ul')).toBeNull();
  });

  it('leaves markdown it does not support as literal text', () => {
    const { host } = render('# heading\n\n**bold** _it_ [text](https://evil.example) > quote | table |');
    expect(host.querySelector('h1, strong, em, blockquote, table')).toBeNull();
    expect(host.textContent).toContain('# heading');
    expect(host.textContent).toContain('**bold** _it_ [text](');
    expect(anchors(host)).toHaveLength(0);
  });

  it('parseBlocks handles CRLF and stray whitespace lines', () => {
    expect(parseBlocks('a\r\nb\r\n   \r\nc')).toEqual([
      { kind: 'p', lines: ['a', 'b'] },
      { kind: 'p', lines: ['c'] },
    ]);
  });
});

describe('render: XSS', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    "<a href='javascript:alert(1)'>click</a>",
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<style>body{display:none}</style>',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<template><script>alert(1)</script></template>',
    '<!-- comment --><b onmouseover=alert(1)>hi</b>',
  ];

  for (const payload of payloads) {
    it(`renders ${JSON.stringify(payload.slice(0, 40))} as text`, () => {
      const { host } = render(`hi ${payload}\n\n- ${payload}\n\n\`${payload}\``);
      expect(host.querySelector(DANGEROUS_TAGS)).toBeNull();
      expect(anchors(host)).toHaveLength(0);
      for (const node of Array.from(host.querySelectorAll('*'))) {
        for (const attr of Array.from(node.attributes)) {
          expect(attr.name.startsWith('on')).toBe(false);
        }
      }
      expect(host.textContent).toContain(payload);
    });
  }

  it('never produces javascript:, data: or vbscript: links, even when the links set contains them', () => {
    const evil = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'JaVaScRiPt:alert(1)'];
    const { host } = render(evil.join(' and '), evil);
    expect(anchors(host)).toHaveLength(0);
    expect(host.textContent).toContain('javascript:alert(1)');
  });

  it('builds anchors with only href/target/rel/class attributes', () => {
    const url = 'https://aturi.to/at/did:plc:abc/app.bsky.feed.post/3k';
    const { host } = render(`see ${url}`, [url]);
    const a = anchors(host)[0]!;
    expect(a.getAttributeNames().sort()).toEqual(['class', 'href', 'rel', 'target']);
    expect(a.getAttribute('href')).toBe(url);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
    expect(a.textContent).toBe(url);
  });
});

describe('render: links', () => {
  it('links a bare https URL only when it is in the links set', () => {
    const { host, links } = render('one https://aturi.to/explore and two https://bsky.app/profile/x', ['https://aturi.to/explore']);
    expect(anchors(host).map((a) => a.getAttribute('href'))).toEqual(['https://aturi.to/explore']);
    expect(links).toEqual(['https://aturi.to/explore']);
    const grey = host.querySelector('.poe-url')!;
    expect(grey.textContent).toBe('https://bsky.app/profile/x');
    expect(grey.tagName).toBe('SPAN');
  });

  it('trims trailing sentence punctuation before matching', () => {
    const url = 'https://bsky.app/profile/atpota.to';
    for (const tail of ['.', ',', ';', ':', '!', '?', ')', ').', '!?']) {
      const { host } = render(`(see ${url}${tail}`, [url]);
      const a = anchors(host);
      expect(a, tail).toHaveLength(1);
      expect(a[0]!.getAttribute('href')).toBe(url);
      expect(host.textContent).toBe(`(see ${url}${tail}`);
    }
  });

  it('keeps a closing paren that is really part of an allowed URL', () => {
    const url = 'https://en.wikipedia.org/wiki/Potato_(disambiguation)';
    const { host } = render(`read ${url}.`, [url]);
    expect(anchors(host)[0]!.getAttribute('href')).toBe(url);
  });

  it('requires an exact match: no prefixes, extensions, case changes or trailing slashes', () => {
    const allowed = ['https://aturi.to/explore/atpota.to'];
    const cases = [
      'https://aturi.to/explore',
      'https://aturi.to/explore/atpota.to/extra',
      'https://ATURI.to/explore/atpota.to',
      'https://aturi.to/explore/atpota.to/',
      'https://aturi.to/explore/atpota.to?x=1',
      'https://aturi.to/explore/atpota.to#frag',
    ];
    for (const url of cases) {
      const { host } = render(url, allowed);
      expect(anchors(host), url).toHaveLength(0);
    }
  });

  it('does not link lookalike hosts', () => {
    const allowed = ['https://bsky.app/profile/atpota.to', 'https://aturi.to/'];
    const lookalikes = [
      'https://bsky.app.evil.com/profile/atpota.to',
      'https://bsky-app.com/profile/atpota.to',
      'https://bsky.app@evil.com/profile/atpota.to',
      'https://evil.com/https://bsky.app/profile/atpota.to',
      'https://bѕky.app/profile/atpota.to', // Cyrillic s
      'https://aturi.to.evil.com/',
      'https://xn--bky-mcd.app/profile/atpota.to',
    ];
    for (const url of lookalikes) {
      const { host } = render(`go to ${url}`, allowed);
      expect(anchors(host), url).toHaveLength(0);
    }
  });

  it('refuses http, credentials, non-ASCII hosts and odd hosts even when they are in the set', () => {
    const urls = [
      'http://aturi.to/',
      'https://user:pass@aturi.to/',
      'https://user@aturi.to/',
      'https://bѕky.app/',
      'https://localhost/',
      'https://[::1]/',
    ];
    const { host } = render(urls.join(' '), urls);
    expect(anchors(host)).toHaveLength(0);
    for (const url of urls) expect(isSafeHttps(url), url).toBe(false);
    expect(isSafeHttps('https://aturi.to/')).toBe(true);
    expect(isSafeHttps('https://example.com:8443/x')).toBe(true);
  });

  it('links at most 3 URLs per answer; the rest stay grey text', () => {
    const urls = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3', 'https://d.example/4', 'https://e.example/5'];
    const { host, links } = render(urls.join('\n'), urls);
    expect(anchors(host)).toHaveLength(3);
    expect(links).toEqual(urls.slice(0, 3));
    expect(Array.from(host.querySelectorAll('.poe-url')).map((s) => s.textContent)).toEqual(urls.slice(3));
  });

  it('counts the same URL twice toward the limit (each occurrence is an anchor)', () => {
    const url = 'https://aturi.to/';
    const { host } = render(`${url} ${url} ${url} ${url}`, [url]);
    expect(anchors(host)).toHaveLength(3);
  });

  it('keeps at:// URIs and DIDs as code, never links', () => {
    const uri = 'at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.bsky.feed.post/3l3qo2vuowo2b';
    const { host } = render(`the post is ${uri}, by did:plc:ewvi7nxzyoun6zhxrhs64oiz.`, [uri]);
    expect(anchors(host)).toHaveLength(0);
    const ids = Array.from(host.querySelectorAll('code.poe-id')).map((c) => c.textContent);
    expect(ids).toEqual([uri, 'did:plc:ewvi7nxzyoun6zhxrhs64oiz']);
    expect(host.textContent).toBe(`the post is ${uri}, by did:plc:ewvi7nxzyoun6zhxrhs64oiz.`);
  });

  it('does not treat a scheme glued to a word as a URL or DID', () => {
    const { host } = render('candid:plc:abc and chat://x and xhttps://aturi.to', ['https://aturi.to']);
    expect(host.querySelector('code, a, .poe-url')).toBeNull();
  });

  it('matchAllowedLink tries the raw match, then strips punctuation one char at a time', () => {
    const set = new Set(['https://x.example/a', 'https://x.example/b)']);
    expect(matchAllowedLink('https://x.example/a).', set)).toBe('https://x.example/a');
    expect(matchAllowedLink('https://x.example/b).', set)).toBe('https://x.example/b)');
    expect(matchAllowedLink('https://x.example/c', set)).toBeNull();
  });

  it('handles a links set of any iterable and ignores junk', () => {
    const { host } = render('https://aturi.to/', new Set(['https://aturi.to/']) as unknown as string[]);
    expect(anchors(host)).toHaveLength(1);
  });
});

describe('render: kaomoji', () => {
  it('wraps a trailing ◕ face in aria-hidden and leaves it out of the plain text', () => {
    const { host, plain } = render('labelers are neat (◕‿◕)');
    const face = host.querySelector('.poe-face')!;
    expect(face.getAttribute('aria-hidden')).toBe('true');
    expect(face.textContent).toBe('(◕‿◕)');
    expect(plain).toBe('labelers are neat');
    expect(host.querySelector('p')!.lastChild).toBe(face);
  });

  it('handles the face vocabulary from the instructions', () => {
    for (const face of ['(◕‿◕)', '(◕ᗜ◕)', '✧(◕ᗜ◕)✧', '(◕‿◕)ノ', '(◕‿◕)つ', '(◕‿◕;)', '(◕﹏◕)']) {
      const { host } = render(`here you go ${face}`);
      expect(host.querySelector('[aria-hidden="true"]')!.textContent, face).toBe(face);
    }
  });

  it('keeps glued letters visible', () => {
    expect(splitTrailingFace('thanks(◕‿◕)')).toEqual(['thanks', '(◕‿◕)']);
    const { host } = render('thanks(◕‿◕)');
    expect(host.querySelector('.poe-face')!.textContent).toBe('(◕‿◕)');
    expect(host.textContent).toBe('thanks (◕‿◕)');
  });

  it('hides only the face in a Japanese sentence with no spaces, and keeps the sentence for the live region', () => {
    const sentence = 'ラベラーは投稿やアカウントにラベルを付けるサービスです。詳しくはガイドの第三章を見てね';
    for (const end of ['', '。', '！']) {
      const { host, plain } = render(`第一段。\n\n${sentence}${end}(◕‿◕)`);
      const faces = host.querySelectorAll('.poe-face');
      expect(faces).toHaveLength(1);
      expect(faces[0]!.textContent).toBe('(◕‿◕)');
      expect(faces[0]!.getAttribute('aria-hidden')).toBe('true');
      expect(plain).toBe(`第一段。\n\n${sentence}${end}`);
    }
    expect(splitTrailingFace('見てね(◕‿◕)')).toEqual(['見てね', '(◕‿◕)']);
    expect(splitTrailingFace('見てね。(◕‿◕)')).toEqual(['見てね。', '(◕‿◕)']);
    expect(splitTrailingFace('見てね✧(◕ᗜ◕)✧')).toEqual(['見てね', '✧(◕ᗜ◕)✧']);
    expect(splitTrailingFace('見てね（◕‿◕）')).toEqual(['見てね', '（◕‿◕）']);
  });

  it('keeps Cyrillic, Hangul and accented words glued to the face visible', () => {
    expect(splitTrailingFace('спасибо(◕‿◕)')).toEqual(['спасибо', '(◕‿◕)']);
    expect(splitTrailingFace('고마워요(◕‿◕)')).toEqual(['고마워요', '(◕‿◕)']);
    expect(splitTrailingFace('merci café(◕‿◕)')).toEqual(['merci café', '(◕‿◕)']);
    expect(splitTrailingFace('ok!(◕‿◕)')).toEqual(['ok!', '(◕‿◕)']);
    expect(render('merci café(◕‿◕)').plain).toBe('merci café');
    // a bare face without brackets still splits
    expect(splitTrailingFace('done ◕‿◕')).toEqual(['done ', '◕‿◕']);
    expect(splitTrailingFace('done!◕‿◕')).toEqual(['done!', '◕‿◕']);
  });

  it('never hides a long run of text as a face', () => {
    expect(splitTrailingFace('見てね(◕‿◕)ですね、ありがとうございました')).toBeNull();
    expect(render('見てね(◕‿◕)ですね、ありがとうございました').host.querySelector('.poe-face')).toBeNull();
  });

  it('works on a face alone on the last line and at the end of a list', () => {
    let r = render('done!\n(◕ᗜ◕)');
    expect(r.host.querySelectorAll('p')).toHaveLength(1);
    expect(r.host.querySelector('br')).toBeNull();
    expect(r.host.querySelector('.poe-face')!.textContent).toBe('(◕ᗜ◕)');
    r = render('- one\n- two (◕‿◕)');
    expect(r.host.querySelector('li:last-child .poe-face')).not.toBeNull();
  });

  it('does not hide faces that are not trailing, or inside code', () => {
    expect(render('(◕‿◕) hello there').host.querySelector('.poe-face')).toBeNull();
    expect(render('`(◕‿◕)`').host.querySelector('.poe-face')).toBeNull();
    expect(render('```\n(◕‿◕)\n```').host.querySelector('.poe-face')).toBeNull();
    expect(render('see https://x.example/◕').host.querySelector('.poe-face')).toBeNull();
  });
});

describe('render: unicode and size', () => {
  it('keeps emoji, RTL, combining marks and astral characters intact', () => {
    const text = 'émoji 🥔 ok, עברית, 𝓯𝓪𝓷𝓬𝔂, é, zero​width';
    const { host } = render(text);
    expect(host.textContent).toBe(text);
  });

  it('renders very long text quickly and caps it', () => {
    const long = `${'word '.repeat(30_000)}https://aturi.to/`;
    const started = performance.now();
    const { host } = render(long, ['https://aturi.to/']);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(host.textContent!.length).toBeLessThanOrEqual(20_001);
    expect(host.textContent!.endsWith('…')).toBe(true);
  });

  it('survives pathological input without catastrophic backtracking', () => {
    const nasty = ['`'.repeat(5000), 'https://'.repeat(3000), 'did:a:'.repeat(3000), '- '.repeat(5000), '((((('.repeat(2000) + '◕'];
    for (const text of nasty) {
      const started = performance.now();
      render(text, ['https://aturi.to/']);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  it('renders empty and non-string input as nothing', () => {
    expect(render('').host.childNodes).toHaveLength(0);
    expect(renderAnswer(undefined as unknown as string, [], document).plain).toBe('');
  });

  it('produces readable plain text for the live region', () => {
    const { plain } = render('first `code`\n\n- a\n- b https://aturi.to/ (◕‿◕)', ['https://aturi.to/']);
    expect(plain).toBe('first code\n\na\nb https://aturi.to/');
  });
});
