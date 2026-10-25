import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownToBlocks, inlineRichText, enrichBlocks, blocksText, draftRecord, metaProblems, linkable,
} from '../src/dispatch-markdown.js';

const PUB = 'at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n';
const POE = 'did:plc:6qw63oash3jfnpykvpbwnq5z';

/** What each facet covers, read back through UTF-8 the way Leaflet reads it. */
function covered(rich) {
  const bytes = Buffer.from(rich.plaintext, 'utf8');
  return (rich.facets ?? []).map((f) => ({
    text: bytes.subarray(f.index.byteStart, f.index.byteEnd).toString('utf8'),
    feature: f.features[0].$type.split('#')[1],
    ...(f.features[0].uri ? { uri: f.features[0].uri } : {}),
  }));
}

const types = (blocks) => blocks.map((b) => b.block.$type.replace('pub.leaflet.blocks.', ''));

test('inline marks become facets on the right bytes, after emoji and kaomoji', () => {
  const rich = inlineRichText('a face (ﾉ◕ヮ◕)ﾉ*:・ﾟ✧ then **bold**, *italic*, `app.bsky.feed.post`, ~~gone~~ and [a link](https://atpota.to/garden)');
  assert.equal(rich.plaintext, 'a face (ﾉ◕ヮ◕)ﾉ*:・ﾟ✧ then bold, italic, app.bsky.feed.post, gone and a link');
  assert.deepEqual(covered(rich), [
    { text: 'bold', feature: 'bold' },
    { text: 'italic', feature: 'italic' },
    { text: 'app.bsky.feed.post', feature: 'code' },
    { text: 'gone', feature: 'strikethrough' },
    { text: 'a link', feature: 'link', uri: 'https://atpota.to/garden' },
  ]);
});

test('a bold link carries both marks over the same words', () => {
  const rich = inlineRichText('**[pds moover](https://pdsmoover.com)** from bailey');
  assert.equal(rich.plaintext, 'pds moover from bailey');
  assert.deepEqual(covered(rich).sort((a, b) => a.feature.localeCompare(b.feature)), [
    { text: 'pds moover', feature: 'bold' },
    { text: 'pds moover', feature: 'link', uri: 'https://pdsmoover.com' },
  ]);
});

test('faces, snake_case and lone stars stay exactly as written', () => {
  for (const text of [
    'i nearly rolled off the roof (⊙_⊙;) and then (⊙_⊙;) again',
    'yay (ﾉ◕ヮ◕)ﾉ*:・ﾟ✧ and again (ﾉ◕ヮ◕)ﾉ*:・ﾟ✧',
    'shrug ¯\\_(ツ)_/¯ and ¯\\_(ツ)_/¯',
    'snake_case_names and 5 * 3 * 2 stay put',
  ]) {
    const rich = inlineRichText(text);
    assert.equal(rich.plaintext, text);
    assert.equal(rich.facets, undefined, text);
  }
});

test('bare links are linked without the sentence punctuation after them', () => {
  const rich = inlineRichText('see https://atpota.to/weather. or (https://aturi.to/explore) or https://x.com/a_(b)!');
  assert.deepEqual(covered(rich).map((c) => c.uri), [
    'https://atpota.to/weather', 'https://aturi.to/explore', 'https://x.com/a_(b)',
  ]);
});

test('a link that is not http(s) is left as text, with a note', () => {
  const notes = [];
  const rich = inlineRichText('[click](javascript:alert(1)) and [ok](at://did:plc:x/app.bsky.feed.post/1)', notes);
  assert.equal(rich.plaintext, 'click and ok');
  assert.equal(rich.facets, undefined);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /javascript:alert\(1\)/);
});

test('an escaped marker is literal, and an unclosed ** is noted', () => {
  const notes = [];
  assert.equal(inlineRichText('\\*not italic\\* and \\[not a link\\]', notes).plaintext, '*not italic* and [not a link]');
  inlineRichText('this **never closes', notes);
  assert.equal(notes.length, 1);
});

test('mentions are never made: an @handle is only text', () => {
  const rich = inlineRichText('thanks @pfrazee.com and [@bnewbold.net](https://bsky.app/profile/bnewbold.net)');
  assert.ok(covered(rich).every((c) => c.feature === 'link'));
  const { blocks } = markdownToBlocks('hi @someone.bsky.social');
  assert.equal(JSON.stringify(blocks).includes('Mention'), false);
});

test('the issue shape: headers, paragraphs, lists, a quote, a rule, the subscribe form and a card', () => {
  const md = [
    "welcome to issue two! once a week i read what builders posted",
    'and write it up.',
    '',
    '{{subscribe}}',
    '',
    "> **poe's atmosphere dispatch is sponsored by** [leaflet pro](https://leaflet.pub/)",
    '',
    '## what builders talked about',
    '',
    '**spaces.** daniel said it is close.',
    '',
    '- **one** with `a.b.c`',
    '  carried on',
    '- two',
    '  - nested',
    '',
    '- three, after a blank line',
    '',
    '1. first',
    '2. second',
    '',
    '---',
    '',
    '## atmospheric conditions',
    '',
    'https://atpota.to/weather',
    '',
    'see you next week (◕‿◕)',
  ].join('\n');
  const { blocks, notes, problems } = markdownToBlocks(md);
  assert.deepEqual(notes, []);
  assert.deepEqual(problems, []);
  assert.deepEqual(types(blocks), [
    'text', 'signup', 'blockquote', 'header', 'text', 'unorderedList', 'orderedList',
    'horizontalRule', 'header', 'website', 'text',
  ]);
  assert.equal(blocks[0].block.plaintext, 'welcome to issue two! once a week i read what builders posted and write it up.');
  assert.equal(blocks[3].block.level, 2);
  const list = blocks[5].block;
  assert.equal(list.children.length, 3);
  assert.equal(list.children[0].$type, 'pub.leaflet.blocks.unorderedList#listItem');
  assert.equal(list.children[0].content.plaintext, 'one with a.b.c carried on');
  assert.equal(list.children[1].children[0].content.plaintext, 'nested');
  assert.equal(blocks[6].block.children[1].$type, 'pub.leaflet.blocks.orderedList#listItem');
  assert.deepEqual(blocks[9].block, { $type: 'pub.leaflet.blocks.website', src: 'https://atpota.to/weather' });
});

test('a fenced block is a code block, untouched inside', () => {
  const { blocks } = markdownToBlocks('```json\n{ "**not": "bold**" }\n```\nafter');
  assert.deepEqual(blocks[0].block, { $type: 'pub.leaflet.blocks.code', plaintext: '{ "**not": "bold**" }', language: 'json' });
  assert.equal(blocks[1].block.plaintext, 'after');
});

test('an empty issue is a problem, not a document', () => {
  assert.deepEqual(markdownToBlocks('\n\n---\n').problems, ['the issue has no text']);
});

test('link cards are filled in: a Bluesky post embeds, a page gets its title', async () => {
  const { blocks } = markdownToBlocks([
    'https://bsky.app/profile/pfrazee.com/post/3mxwojfdnx22e',
    '',
    'https://atpota.to/weather',
    '',
    'https://down.example/page',
  ].join('\n'));
  const asked = [];
  const { blocks: filled, notes } = await enrichBlocks(blocks, {
    resolvePost: async (actor, rkey) => { asked.push([actor, rkey]); return { uri: `at://did:plc:pfrazee/app.bsky.feed.post/${rkey}`, cid: 'bafypost' }; },
    fetchPageMeta: async (url) => {
      if (url.includes('down')) throw new Error('HTTP 503');
      return { title: '  the atmosphere\n weather report ', description: 'live from my station' };
    },
  });
  assert.deepEqual(asked, [['pfrazee.com', '3mxwojfdnx22e']]);
  assert.deepEqual(filled.map((b) => b.block), [
    { $type: 'pub.leaflet.blocks.bskyPost', postRef: { uri: 'at://did:plc:pfrazee/app.bsky.feed.post/3mxwojfdnx22e', cid: 'bafypost' } },
    { $type: 'pub.leaflet.blocks.website', src: 'https://atpota.to/weather', title: 'the atmosphere weather report', description: 'live from my station' },
    { $type: 'pub.leaflet.blocks.website', src: 'https://down.example/page' },
  ]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /down\.example.*503/);
});

test('the record: Leaflet content, plain text, the publication, Poe as the byline', () => {
  const { blocks } = markdownToBlocks('hello **there**\n\n## a heading\n\n- an item\n\n{{subscribe}}\n\nhttps://atpota.to/weather');
  const record = draftRecord({ title: ' issue two ', description: 'what happened', tags: ['Atmosphere', '#dispatch', 'atmosphere'], blocks },
    { publicationUri: PUB, authorDid: POE });
  assert.equal(record.$type, 'site.standard.document');
  assert.equal(record.site, PUB);
  assert.equal(record.title, 'issue two');
  assert.deepEqual(record.tags, ['atmosphere', 'dispatch']);
  assert.equal(record.textContent, 'hello there\n\na heading\n\nan item');
  assert.equal(record.content.$type, 'pub.leaflet.content');
  assert.equal(record.content.pages[0].$type, 'pub.leaflet.pages.linearDocument');
  assert.deepEqual(record.contributors, [{ did: POE }]);
  assert.equal('publishedAt' in record, false);
  assert.equal(blocksText(blocks), record.textContent);
});

test('title, description and tags are checked', () => {
  assert.deepEqual(metaProblems({ title: 'ok', description: 'fine', tags: ['a'] }), []);
  assert.equal(metaProblems({ title: '  ' }).length, 1);
  assert.equal(metaProblems({ title: 'x'.repeat(201) }).length, 1);
  assert.equal(metaProblems({ title: 'ok', tags: 'nope' }).length, 1);
});

test('only absolute http(s) links without credentials are linkable', () => {
  assert.equal(linkable('https://atpota.to'), true);
  assert.equal(linkable('http://example.com/a'), true);
  assert.equal(linkable('https://user:pw@example.com'), false);
  assert.equal(linkable('javascript:alert(1)'), false);
  assert.equal(linkable('/relative'), false);
});
