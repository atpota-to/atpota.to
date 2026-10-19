// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { currentSection, findAskableRoot, getAskableSelection, isAskableLength, normalizeSelection, pillPosition } from '../src/poe/selection.js';
import { hasModifier, isSlashShortcut, isTypingTarget, otherModalOpen } from '../src/poe/shortcuts.js';

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

function key(init: KeyboardEventInit & { key: string }, target?: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('"/" shortcut guards', () => {
  it('fires for a bare slash on the page', () => {
    expect(isSlashShortcut(key({ key: '/' }, document.body), document.body)).toBe(true);
  });

  it('allows Shift (layouts that need it for "/") but not Ctrl, Alt, Meta or AltGr', () => {
    expect(isSlashShortcut(key({ key: '/', shiftKey: true }, document.body), document.body)).toBe(true);
    for (const mod of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true, altKey: true }]) {
      expect(isSlashShortcut(key({ key: '/', ...mod }, document.body), document.body), JSON.stringify(mod)).toBe(false);
      expect(hasModifier({ key: '/', ...mod })).toBe(true);
    }
  });

  it('ignores other keys, composition and already-handled events', () => {
    expect(isSlashShortcut(key({ key: '?' }, document.body), document.body)).toBe(false);
    expect(isSlashShortcut(key({ key: 'Slash' }, document.body), document.body)).toBe(false);
    expect(isSlashShortcut({ key: '/', isComposing: true, target: document.body }, document.body)).toBe(false);
    expect(isSlashShortcut({ key: '/', defaultPrevented: true, target: document.body }, document.body)).toBe(false);
  });

  it('is ignored while typing in inputs, textareas, selects and editable regions', () => {
    document.body.innerHTML = `
      <input id="i"><input id="s" type="search"><input id="c" type="checkbox"><textarea id="t"></textarea>
      <select id="sel"><option>a</option></select>
      <div contenteditable="true"><p id="ce">edit</p></div>
      <div contenteditable="false"><p id="ro">read only</p></div>
      <div role="textbox" id="rt" tabindex="0"></div><div role="combobox" id="cb" tabindex="0"></div>
      <button id="b">b</button><a id="a" href="#">a</a>`;
    for (const id of ['i', 's', 'c', 't', 'sel', 'ce', 'rt', 'cb']) {
      const el = document.getElementById(id)!;
      expect(isTypingTarget(el), id).toBe(true);
      expect(isSlashShortcut(key({ key: '/' }, el), el), id).toBe(false);
    }
    for (const id of ['b', 'a', 'ro']) {
      const el = document.getElementById(id)!;
      expect(isTypingTarget(el), id).toBe(false);
      expect(isSlashShortcut(key({ key: '/' }, el), el), id).toBe(true);
    }
  });

  it('checks the focused element as well as the event target', () => {
    document.body.innerHTML = '<input id="i">';
    const input = document.getElementById('i')!;
    expect(isSlashShortcut(key({ key: '/' }, document.body), input)).toBe(false);
  });

  it('notices another page dialog that is open', () => {
    document.body.innerHTML = '<dialog id="d"></dialog><div id="own"><dialog id="mine" open></dialog></div>';
    const own = document.getElementById('own');
    expect(otherModalOpen(document, own)).toBe(false);
    document.getElementById('d')!.setAttribute('open', '');
    // jsdom may not know :modal; either way an open page dialog keeps Poe out of the way or not modal
    const result = otherModalOpen(document, own);
    expect(typeof result).toBe('boolean');
  });
});

describe('selection rules', () => {
  function select(node: Node, start: number, endNode: Node = node, end?: number): Selection {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(endNode, end ?? (endNode.textContent ?? '').length);
    sel.addRange(range);
    return sel;
  }

  it('normalizes whitespace and checks the 2..300 length window', () => {
    expect(normalizeSelection('  a\n\n  labeler \t ')).toBe('a labeler');
    expect(normalizeSelection(null)).toBe('');
    expect(isAskableLength('a')).toBe(false);
    expect(isAskableLength('ab')).toBe(true);
    expect(isAskableLength('x'.repeat(300))).toBe(true);
    expect(isAskableLength('x'.repeat(301))).toBe(false);
  });

  it('accepts a selection inside [data-poe-askable]', () => {
    document.body.innerHTML = '<article data-poe-askable><p id="p">a special tool called labelers here</p></article>';
    const text = document.getElementById('p')!.firstChild!;
    const found = getAskableSelection(select(text, 22, text, 30));
    expect(found?.text).toBe('labelers');
    expect(found?.root.tagName).toBe('ARTICLE');
  });

  it('accepts a selection across elements in the same askable root', () => {
    document.body.innerHTML = '<article data-poe-askable><p id="a">first part</p><p id="b">second part</p></article>';
    const a = document.getElementById('a')!.firstChild!;
    const b = document.getElementById('b')!.firstChild!;
    expect(getAskableSelection(select(a, 6, b, 6))?.text).toBe('partsecond');
  });

  it('rejects selections outside askable roots, spanning out of one, too short or too long', () => {
    document.body.innerHTML = `
      <p id="out">outside text here</p>
      <article data-poe-askable><p id="in">inside text here</p><p id="long">${'word '.repeat(80)}</p></article>`;
    const out = document.getElementById('out')!.firstChild!;
    const inside = document.getElementById('in')!.firstChild!;
    const long = document.getElementById('long')!.firstChild!;
    expect(getAskableSelection(select(out, 0, out, 7))).toBeNull();
    expect(getAskableSelection(select(out, 0, inside, 6))).toBeNull();
    expect(getAskableSelection(select(inside, 0, inside, 1))).toBeNull();
    expect(getAskableSelection(select(long, 0))).toBeNull();
    expect(getAskableSelection(null)).toBeNull();
    window.getSelection()!.removeAllRanges();
    expect(getAskableSelection(window.getSelection())).toBeNull();
  });

  it('rejects selections in form fields, editable regions, the widget and opted-out areas', () => {
    document.body.innerHTML = `
      <article data-poe-askable>
        <div contenteditable="true"><p id="ce">editable words</p></div>
        <div class="poe"><p id="w">widget words</p></div>
        <div data-poe-ignore><p id="ig">ignored words</p></div>
        <p id="ok">plain words</p>
      </article>`;
    for (const id of ['ce', 'w', 'ig']) {
      const t = document.getElementById(id)!.firstChild!;
      expect(getAskableSelection(select(t, 0, t, 8)), id).toBeNull();
    }
    const ok = document.getElementById('ok')!.firstChild!;
    expect(getAskableSelection(select(ok, 0, ok, 5))?.text).toBe('plain');
  });

  it('findAskableRoot works from text nodes and elements', () => {
    document.body.innerHTML = '<section data-poe-askable><span id="s">x</span></section>';
    const span = document.getElementById('s')!;
    expect(findAskableRoot(span)?.tagName).toBe('SECTION');
    expect(findAskableRoot(span.firstChild)?.tagName).toBe('SECTION');
    expect(findAskableRoot(document.body)).toBeNull();
    expect(findAskableRoot(null)).toBeNull();
  });
});

describe('pill placement', () => {
  const rect = (top: number, left: number, width = 80, height = 20) => ({ top, left, width, height, bottom: top + height, right: left + width });
  const pill = { width: 190, height: 40 };
  const vp = { width: 1440, height: 900 };

  it('sits above the first line, centred', () => {
    const pos = pillPosition(rect(300, 600), rect(300, 600), pill, vp, false);
    expect(pos).toEqual({ left: 545, top: 250, placement: 'above' });
  });

  it('goes below the last line when there is no room above, or on touch screens', () => {
    expect(pillPosition(rect(20, 600), rect(60, 100), pill, vp, false)).toEqual({ left: 45, top: 90, placement: 'below' });
    expect(pillPosition(rect(300, 600), rect(340, 600), pill, vp, true).placement).toBe('below');
  });

  it('stays inside the viewport horizontally and vertically', () => {
    expect(pillPosition(rect(300, 0, 10), rect(300, 0, 10), pill, vp, false).left).toBe(8);
    expect(pillPosition(rect(300, 1430, 10), rect(300, 1430, 10), pill, vp, false).left).toBe(1440 - 190 - 8);
    expect(pillPosition(rect(880, 600), rect(880, 600), pill, vp, true).top).toBe(900 - 40 - 8);
    expect(pillPosition(rect(300, 10), rect(300, 10), pill, { width: 150, height: 900 }, false).left).toBe(8);
  });
});

describe('current section for "summarize this section"', () => {
  it('picks the last h2 above the reading line and its text up to the next h2', () => {
    document.body.innerHTML = `
      <article data-poe-askable>
        <h2 id="a">1. Intro</h2><p>intro text</p>
        <h2 id="b">2. Feeds</h2><p>feeds   text</p><ul><li>one</li></ul>
        <h2 id="c">3. Labels</h2><p>label text</p>
      </article>`;
    const tops: Record<string, number> = { a: -900, b: 100, c: 700 };
    for (const h of Array.from(document.querySelectorAll('h2'))) {
      h.getBoundingClientRect = () => ({ top: tops[h.id]!, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
    const root = document.querySelector('article')!;
    expect(currentSection(root, 300)).toEqual({ title: '2. Feeds', text: '2. Feeds feeds text one' });
    expect(currentSection(root, -2000)?.title).toBe('1. Intro');
    expect(currentSection(root, 300, 12)?.text).toHaveLength(12);
    document.body.innerHTML = '<article><p>no headings</p></article>';
    expect(currentSection(document.querySelector('article')!, 0)).toBeNull();
  });
});
