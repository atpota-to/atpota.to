/**
 * Numbers that roll, like an odometer (the weather report and the home page's weather
 * tile). When a number changes, each digit that changed turns on its own little reel to
 * the new one: up when the number went up, down when it went down, carrying round past 9
 * or 0 the way a real odometer does. A digit that comes or goes (99 to 100, say) grows or
 * shrinks into place, so the words beside it slide instead of jumping. Digits are
 * tabular, so a number only changes width when it gains or loses one.
 *
 * rollText rolls every number in a bit of text ("1 in 521 new records…", "(99.81%)") as
 * long as the words around them stay the same; different words just replace the old ones.
 *
 * The number itself is plain text, visually hidden: it's what screen readers read, what
 * textContent says and what gets copied. The reels beside it are decoration (aria-hidden)
 * drawn by CSS (components.css, .roll): each cell is empty and its digit a pseudo-element,
 * so they add no text of their own. Under reduced motion the digits just change.
 */

const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
/** How long a turn takes; components.css turns the reels over the same time. */
export const ROLL_MS = 800;
/** --ease-out (tokens.css), for the widths and the bars. */
export const ROLL_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** Each reel is 0–9 three times over and rests on the middle run, so a turn can carry past 9 or 0 either way. */
const REST = 10;

interface Cell {
  key: string;
  /** Where it sits: higher places first, then the point, then the decimals. */
  rank: number;
  char: string;
}

const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * A number's characters, each keyed by its place ("d0" the ones, "d1" the tens, "c3" the
 * comma before the hundreds, "dot", "f1" the tenths), so 99.8 and 100 line up by place.
 */
export function cellsOf(num: string): Cell[] {
  const [int = '', frac = ''] = num.split('.');
  const cells: Cell[] = [];
  let place = 0;
  for (let i = int.length - 1; i >= 0; i--) {
    const char = int[i]!;
    if (char === ',') cells.unshift({ key: `c${place}`, rank: 0.5 - place, char });
    else cells.unshift({ key: `d${place}`, rank: -place++, char });
  }
  if (num.includes('.')) cells.push({ key: 'dot', rank: 0.5, char: '.' });
  [...frac].forEach((char, k) => cells.push({ key: `f${k + 1}`, rank: 1.5 + k, char }));
  return cells;
}

function split(text: string): { words: string[]; numbers: string[] } {
  const words: string[] = [];
  const numbers: string[] = [];
  let at = 0;
  for (const m of text.matchAll(NUMBER_RE)) {
    words.push(text.slice(at, m.index));
    numbers.push(m[0]);
    at = m.index + m[0].length;
  }
  words.push(text.slice(at));
  return { words, numbers };
}

const valueOf = (num: string) => Number(num.replace(/,/g, ''));

export function motionOK(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The text each element was last given. */
const shown = new WeakMap<HTMLElement, string>();

/**
 * Sets `el` to `text`, rolling its numbers from the ones it shows now. `trend` (1 or -1)
 * says which way to turn every digit; by default each number turns the way it moved.
 */
export function rollText(el: HTMLElement, text: string, trend?: number): void {
  const last = shown.get(el);
  // someone else wrote here since, so start over
  const ours = last !== undefined && el.textContent === last;
  if (ours && last === text) return;
  shown.set(el, text);
  const next = split(text);
  const rolls = [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('roll'));
  const prev = ours ? split(last) : null;
  if (!prev || prev.words.join('\0') !== next.words.join('\0') || rolls.length !== next.numbers.length) {
    build(el, next);
    return;
  }
  const motion = motionOK();
  next.numbers.forEach((num, i) => {
    const was = prev.numbers[i]!;
    if (num !== was) turn(rolls[i]!, num, trend ?? Math.sign(valueOf(num) - valueOf(was)), motion);
  });
}

function build(el: HTMLElement, { words, numbers }: { words: string[]; numbers: string[] }): void {
  const doc = el.ownerDocument;
  const nodes: Node[] = [];
  words.forEach((w, i) => {
    if (w) nodes.push(doc.createTextNode(w));
    const num = numbers[i];
    if (num === undefined) return;
    const roll = doc.createElement('span');
    roll.className = 'roll';
    const said = doc.createElement('span');
    said.className = 'visually-hidden';
    said.textContent = num;
    const cells = doc.createElement('span');
    cells.className = 'roll__cells';
    cells.setAttribute('aria-hidden', 'true');
    cells.append(...cellsOf(num).map((c) => cell(doc, c, REST + Number(c.char))));
    roll.append(said, cells);
    nodes.push(roll);
  });
  el.replaceChildren(...nodes);
}

function cell(doc: Document, c: Cell, n: number): HTMLElement {
  const span = doc.createElement('span');
  span.className = isDigit(c.char) ? 'roll__c roll__c--d' : 'roll__c';
  span.dataset.c = c.char;
  span.dataset.key = c.key;
  span.dataset.rank = String(c.rank);
  if (isDigit(c.char)) span.style.setProperty('--n', String(n));
  return span;
}

/** How far a reel turns from one digit to another, carrying past 9 or 0 in the direction of travel. */
export function steps(from: number, to: number, dir: number): number {
  if (dir > 0) return (to - from + 10) % 10;
  if (dir < 0) return -((from - to + 10) % 10);
  return to - from;
}

function turn(roll: HTMLElement, num: string, dir: number, motion: boolean): void {
  const [said, host] = [...roll.children] as [HTMLElement, HTMLElement];
  said.textContent = num;
  const doc = roll.ownerDocument;
  const want = cellsOf(num);
  const live = [...host.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains('is-leaving'));
  const have = new Map(live.map((c) => [c.dataset.key!, c]));
  const keys = new Set(want.map((c) => c.key));
  const going = live.filter((c) => !keys.has(c.dataset.key!));
  const goingWidths = motion ? going.map((c) => c.getBoundingClientRect().width) : [];

  // Every reel back on its middle run, without turning (it shows the same digit), so the
  // turn below can carry either way; newcomers wait a line off, to roll in.
  host.classList.add('is-snapping');
  for (const c of live) if (isDigit(c.dataset.c!)) c.style.setProperty('--n', String(REST + Number(c.dataset.c)));
  const coming: HTMLElement[] = [];
  for (const w of want) {
    if (have.has(w.key)) continue;
    const fresh = cell(doc, w, REST + Number(w.char) - (dir || 1));
    const after = [...host.children].find((c) => Number((c as HTMLElement).dataset.rank) > w.rank) ?? null;
    host.insertBefore(fresh, after);
    coming.push(fresh);
  }
  void host.offsetWidth; // a style to turn from
  const comingWidths = motion ? coming.map((c) => c.getBoundingClientRect().width) : [];
  host.classList.remove('is-snapping');

  // (a key is always a digit, or always a comma or the point)
  for (const w of want) {
    const c = have.get(w.key);
    if (!c || !isDigit(w.char)) continue;
    const from = Number(c.dataset.c);
    c.dataset.c = w.char;
    c.style.setProperty('--n', String(REST + from + steps(from, Number(w.char), dir)));
  }
  for (const c of coming) if (isDigit(c.dataset.c!)) c.style.setProperty('--n', String(REST + Number(c.dataset.c)));

  going.forEach((c, i) => {
    if (!motion || typeof c.animate !== 'function') {
      c.remove();
      return;
    }
    c.classList.add('is-leaving');
    if (isDigit(c.dataset.c!)) c.style.setProperty('--n', String(REST + Number(c.dataset.c) + (dir || 1)));
    c.style.width = '0px';
    c.style.opacity = '0';
    const out = c.animate([{ width: `${goingWidths[i]}px`, opacity: 1 }, { width: '0px', opacity: 0 }], { duration: ROLL_MS, easing: ROLL_EASE });
    out.finished.then(
      () => c.remove(),
      () => c.remove(),
    );
  });
  if (motion) coming.forEach((c, i) => c.animate?.([{ width: '0px', opacity: 0 }, { width: `${comingWidths[i]}px`, opacity: 1 }], { duration: ROLL_MS, easing: ROLL_EASE }));
}
