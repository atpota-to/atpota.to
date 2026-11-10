// voice-tells.js
// The sentence shapes that make a batch of Poe's writing read as machine-written.
//
// None of these is wrong once. "that's not a fanbase, that's a batch job" is a
// good line. One reply in five built that way is a tic, and a tic is how a
// reader works out they are talking to a machine: on 2026-09-25 somebody quoted
// one of Poe's closing lines back with "now that's an LLM-ism if i've ever seen
// one". So everything here is counted across a batch and read as a rate.
//
// The list comes from reading all 342 replies, 40 weather posts and 4 issues of
// the dispatch Poe had published by 2026-11-10. The voice rules in
// bot/agent/instructions.md and the skills describe the same shapes in words;
// this file is how to tell whether a change to those rules did anything.
//
// Pure: no db, no config, no network. tools/measure-voice.js feeds it.

// --- helpers ----------------------------------------------------------------

const FACE_AT_END = /\s*[|╰٩✧⊂ᕙʚ¯d]?[(（][^()A-Za-z0-9\n]{1,14}[)）][^\sA-Za-z0-9]*$/u;
const LINK_AT_END = /\s+\S*(?:\/|\.\.\.|…)\S*$/u;
const EMOJI_AT_END = /\s*[\p{Extended_Pictographic}️]+$/u;

/** The text without the face, link or emoji it ends on, so its last words can be read. */
export function withoutTrailer(text) {
  let t = String(text ?? '').trim();
  for (;;) {
    const next = t.replace(FACE_AT_END, '').replace(LINK_AT_END, '').replace(EMOJI_AT_END, '').trim();
    if (next === t) return t;
    t = next;
  }
}

/** Ends by asking the reader something. */
export function endsOnQuestion(text) {
  return withoutTrailer(text).endsWith('?');
}

/** The first word, lowercased, with a stretched "hiiii" or "ooooh" folded to one spelling. */
export function firstWord(text) {
  const word = String(text ?? '').trim().toLowerCase().match(/^[\p{L}']+/u)?.[0] ?? '';
  if (/^hi{2,}$/.test(word)) return 'hiiii';
  if (/^o+h+$/.test(word)) return 'oh';
  if (/^a+w+$/.test(word)) return 'aww';
  return word;
}

/** Sentences, roughly: enough to show the line a tell was found in. */
export function lines(text) {
  return String(text ?? '').split(/(?<=[.!?])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);
}

const regexTell = (key, label, re) => ({ key, label, re, test: (text) => re.test(text) });

// --- replies ----------------------------------------------------------------

// A thing explained by what it isn't. The strongest tell there is: about one
// reply in five in Poe's first week. Three wordings of one move. A short word
// before ", not" ("nope, not a thing i do") is an answer, not a contrast.
const CONTRAST = new RegExp([
  String.raw`(?<!\b(?:nope|no|yep|yes|ah|oh|well|sorry|fair|honestly)), not (?!yet\b|sure\b|me\b|really\b|bad\b|at all\b|here\b)`,
  String.raw`\bnot [^,.!?\n]{2,30}, (?:just|but|it'?s|that'?s|an?)\b`,
  String.raw`\b(?:isn'?t|is not) [^,.!?\n]{2,40}, it'?s\b`,
  String.raw`\bthat'?s not [^,.!?\n]{2,30}, that'?s\b`,
].join('|'), 'i');

export const REPLY_TELLS = [
  regexTell('contrast', 'explained by what it isn\'t (x, not y)', CONTRAST),
  regexTell('summing-up', '"that\'s the whole x" summing-up',
    /\bthat'?s (?:sort of |kind of |just )?(?:the|my) (?:whole|entire)\b|\b(?:the|my|your) (?:whole|entire) (?:point|trick|deal|game|job|test|story|idea)\b|\bthat'?s all of it\b|\bthe whole of (?:it|what)\b/i),
  regexTell('sincerity', 'sincerity words (honestly, genuinely, promise)',
    /\bhonest(?:ly)?\b|\bgenuinely\b|\btruly\b|\bpromise\b|\bto be (?:fair|honest)\b/i),
  regexTell('my-kind-of', '"my kind of" / "exactly the kind of"',
    /\bmy kind of\b|\bexactly (?:the|my) (?:kind|sort) of\b|\b(?:the|my) favou?rite kind\b|\bmy idea of a\b/i),
  regexTell('no-no-no', '"no x, no y, no z"',
    /\bno [\w' -]{1,25}, no [\w' -]{1,25}|\bnever \w+, never \w+/i),
  regexTell('signpost', 'signpost before the point (the catch: / my take:)',
    /\b(?:the (?:catch|twist|upside|downside|trade-?off|test|plan|blind spot|short version|simple version|difference|bigger lever)|my (?:take|guess|bet|read|vote|favou?rite (?:part|bit|find|detail))|one (?:caveat|nudge|tip|thing|more|small fix|small thing|hard rule|fun wrinkle|catch)|best bit|potato note|same story|heads up|fair warning|one-liner|here'?s (?:why|the thing|my))\b[^.!?\n]{0,40}:|\bthe (?:upside|downside|catch|twist|hard part) is\b/i),
  regexTell('praise', 'praises the question before answering',
    /^(?:o+h+[,!]? )?(?:(?:a |what a )?(?:good|great|fun|nice|lovely|excellent) (?:question|one)\b|i (?:love|like) this(?: one| question)?\b|i know this one\b)/i),
  regexTell('exclaimed-opener', 'opens on a short exclaimed reaction', /^[^.?\n]{1,40}!/u),
  regexTell('concession', 'concedes first (fair! / guilty!)', /^(?:ha,? )?(?:fair(?! warning)|guilty)\b/i),
  { key: 'question-back', label: 'ends on a question back', test: endsOnQuestion },
  regexTell('door-opener', 'leaves a door open (want me to / tell me when)',
    /\bwant me to\b|\bwant that\b|\b(?:tell|show|ping) me (?:when|if|once)\b|\bcome (?:tell|say|ask|peek|check|tap)\b|\bcome back (?:if|when|and)\b|\breport back\b|\bask me again\b|\bask away\b|\bask me anything\b|\blet me know\b|\bsay the word\b/i),
  regexTell('potato', 'says potato, spud or tuber', /\b(?:potato(?:es)?|spuds?|tubers?)\b/i),
  regexTell('diminutive', '"little" / "tiny"', /\b(?:little|tiny)\b/i),
];

// What tools/measure-voice.js counted before the list above existed, kept as it
// was so an old run and a new one can be compared.
const BALANCED = /[;,] (?:the |an |a |your |few|most|nobody|none)?[a-z]+ (?:is|are|does|do|moves|reads|can't|cannot|changes?|allows?|makes?)\b|\b\w+, not \w+\b|\bleast \w+, most \w+\b/i;
export const REPLY_STRUCTURE = [
  regexTell('balanced', 'balanced clauses', BALANCED),
  regexTell('any-question', 'questions asked back', /\?/),
  regexTell('self-justifying', 'self-justifying clause', /which is (how|why) i\b|so treat|rather than guessing/i),
  regexTell('ends-on-link', 'ending on a link', /https?:\/\/\S+\s*$/),
  { key: 'short', label: 'under 120 chars', test: (text) => text.length < 120 },
];

function count(texts, tells) {
  return tells.map(({ key, label, test }) => ({ key, label, count: texts.filter((t) => test(t)).length }));
}

/**
 * One batch of replies, each a whole answer (its posts joined).
 * `openers` is every first word used at least twice, most common first: the
 * skill asks for openers that vary, and this is where "oh" on a fifth of them
 * shows up.
 */
export function measureReplies(texts) {
  const t = texts.map((x) => String(x ?? '').trim()).filter(Boolean);
  const lens = t.map((x) => x.length).sort((a, b) => a - b);
  const words = new Map();
  for (const x of t) {
    const w = firstWord(x);
    if (w) words.set(w, (words.get(w) ?? 0) + 1);
  }
  return {
    n: t.length,
    structure: count(t, REPLY_STRUCTURE),
    tells: count(t, REPLY_TELLS),
    openers: [...words].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).map(([word, n]) => ({ word, count: n })),
    lengths: t.length ? { min: lens[0], median: lens[Math.floor(lens.length / 2)], max: lens.at(-1) } : null,
  };
}

/**
 * How many times two answers running in one thread both end on a question.
 * `threads` is a list of threads, each a list of Poe's answers oldest first.
 * Five in a row happened on 2026-10-15; each was a fine question on its own.
 */
export function questionRuns(threads) {
  let runs = 0;
  for (const answers of threads) {
    for (let i = 1; i < answers.length; i++) {
      if (endsOnQuestion(answers[i]) && endsOnQuestion(answers[i - 1])) runs++;
    }
  }
  return runs;
}

// --- weather posts ----------------------------------------------------------

const BULLET = /^[\p{Extended_Pictographic}️]+\s/u;

function paragraphs(text) {
  return String(text ?? '').trim().split(/\n\s*\n/u).map((p) => p.trim()).filter(Boolean);
}

/** The post's last paragraph when it's a line of Poe's own after the news: the quip. */
export function closingLine(text) {
  const parts = paragraphs(text);
  if (parts.length < 2) return null;
  const last = parts.at(-1);
  if (last.includes('\n') || BULLET.test(last)) return null;
  return last;
}

function hasBullets(text) {
  return String(text ?? '').split('\n').filter((l) => BULLET.test(l.trim())).length >= 2;
}

export const WEATHER_TELLS = [
  { key: 'closing-line', label: 'ends on a line of its own', test: (text) => closingLine(text) != null },
  { key: 'question', label: 'ends on a question to nobody', test: endsOnQuestion },
  { key: 'emoji-list', label: 'built as an emoji list', test: hasBullets },
  regexTell('blew-in', '"blew in"', /\bblew in\b/i),
  regexTell('on-the-roof', '"on the roof"', /\bon the roof\b/i),
  regexTell('somebody', '"somebody\'s..." guess', /\b(?:somebody|someone)(?:'s)?\b/i),
  regexTell('meanwhile', '"meanwhile"', /\bmeanwhile\b/i),
  regexTell('migration-wind', '"the migration wind"', /\bmigration wind\b/i),
];

/** A line with its numbers, app names and face taken out, so two posts built alike compare equal. */
export function skeleton(line) {
  return withoutTrailer(line).toLowerCase()
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/g, '<app>')
    .replace(/\d[\d,.:]*%?/g, '#')
    .replace(/[^\p{L}<>#' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function repeats(keys) {
  const seen = new Map();
  for (const k of keys) if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).map(([text, n]) => ({ text, count: n }));
}

/**
 * One batch of weather posts. `repeatedOpenings` and `repeatedClosers` are the
 * ones used more than once, by skeleton: "<app> just blew in" three times is
 * the template the skill says doesn't exist.
 */
export function measureWeather(texts) {
  const t = texts.map((x) => String(x ?? '').trim()).filter(Boolean);
  return {
    n: t.length,
    tells: count(t, WEATHER_TELLS),
    repeatedOpenings: repeats(t.map((x) => skeleton(x.split('\n')[0]).split(' ').slice(0, 4).join(' '))),
    repeatedClosers: repeats(t.map((x) => { const c = closingLine(x); return c ? skeleton(c) : null; })),
  };
}

// --- what's in the public repo ----------------------------------------------

/**
 * An account's posts, sorted into what the tells are counted over.
 *
 * `records` are com.atproto.repo.listRecords rows of app.bsky.feed.post. A reply
 * to somebody else starts an answer, and the account's own posts under it are
 * the rest of that answer, since one answer is split across up to three posts.
 * A top-level post with a card for the weather report is a weather post. The
 * rest (the dispatch's announcements, the hello post) is neither.
 *
 * `since` and `until` are ISO timestamps or dates, `until` exclusive.
 */
export function sortRepoPosts(records, did, { since = null, until = null } = {}) {
  const own = `at://${did}/`;
  const rows = records
    .map((r) => ({ uri: r?.uri, value: r?.value ?? {} }))
    .filter((r) => typeof r.uri === 'string' && typeof r.value.text === 'string')
    .sort((a, b) => String(a.value.createdAt).localeCompare(String(b.value.createdAt)));
  const answers = [];
  const weather = [];
  const holding = new Map();
  for (const { uri, value } of rows) {
    const at = String(value.createdAt ?? '');
    const parent = value.reply?.parent?.uri;
    if (typeof parent === 'string' && parent.startsWith(own)) {
      const answer = holding.get(parent);
      if (answer) { answer.text += `\n${value.text}`; holding.set(uri, answer); }
      continue;
    }
    if ((since && at < since) || (until && at >= until)) continue;
    if (parent) {
      const answer = { at, thread: value.reply?.root?.uri ?? parent, text: value.text };
      answers.push(answer);
      holding.set(uri, answer);
    } else if (/^https:\/\/[^/]+\/weather(?:[/?#]|$)/.test(value.embed?.external?.uri ?? '')) {
      weather.push({ at, text: value.text });
    }
  }
  return { answers, weather };
}

/** Answers grouped into their threads, each oldest first, for questionRuns. */
export function byThread(answers) {
  const threads = new Map();
  for (const a of [...answers].sort((x, y) => String(x.at).localeCompare(String(y.at)))) {
    if (!threads.has(a.thread)) threads.set(a.thread, []);
    threads.get(a.thread).push(a.text);
  }
  return [...threads.values()];
}

// --- reading the result ------------------------------------------------------

/** The lines that tripped one tell, for reading the examples behind a number. */
export function examples(texts, key, tells = [...REPLY_TELLS, ...REPLY_STRUCTURE, ...WEATHER_TELLS]) {
  const tell = tells.find((x) => x.key === key);
  if (!tell) return null;
  const out = [];
  for (const text of texts) {
    if (!tell.test(String(text ?? '').trim())) continue;
    // A tell about one sentence shows that sentence; a tell about the whole
    // answer (how it opens, how it ends) shows where it happened.
    const hit = tell.re && !tell.re.source.startsWith('^') ? lines(text).find((l) => tell.re.test(l)) : null;
    const whole = String(text).trim().replace(/\n+/g, ' / ');
    const cut = whole.length > 160;
    const atEnd = /question|closing/.test(key);
    out.push(hit ?? (!cut ? whole : atEnd ? `…${whole.slice(-160)}` : `${whole.slice(0, 160)}…`));
  }
  return out;
}

const pad = (label, width = 46) => label.padEnd(width);
const share = (n, of) => `${n} of ${of} (${of ? Math.round((n / of) * 100) : 0}%)`;

/** The printed report for a batch of replies, a line to a number. */
export function formatReplies(m, { runs = null } = {}) {
  if (!m.n) return ['  no replies to measure'];
  const out = [`  ${pad('replies')} ${m.n}`, ''];
  for (const s of m.structure) out.push(`  ${pad(s.label)} ${share(s.count, m.n)}`);
  out.push(`  ${pad('length')} min ${m.lengths.min}  median ${m.lengths.median}  max ${m.lengths.max}`);
  out.push(`  ${pad('spread')} ${m.lengths.max - m.lengths.min} chars between shortest and longest`, '');
  for (const s of m.tells) out.push(`  ${pad(`${s.label}`)} ${share(s.count, m.n)}  [${s.key}]`);
  if (runs != null) out.push(`  ${pad('question back twice running in a thread')} ${runs}`);
  if (m.openers.length) {
    out.push('', `  ${pad('first words used more than once')} ${m.openers.slice(0, 8).map((o) => `${o.word} ${o.count}`).join(', ')}`);
  }
  return out;
}

/** The printed report for a batch of weather posts. */
export function formatWeather(m) {
  if (!m.n) return ['  no weather posts to measure'];
  const out = [`  ${pad('weather posts')} ${m.n}`, ''];
  for (const s of m.tells) out.push(`  ${pad(s.label)} ${share(s.count, m.n)}  [${s.key}]`);
  for (const [title, list] of [['openings used more than once', m.repeatedOpenings], ['closing lines used more than once', m.repeatedClosers]]) {
    if (!list.length) continue;
    out.push('', `  ${title}`);
    for (const r of list.slice(0, 6)) out.push(`    ${r.count}x  ${r.text}`);
  }
  return out;
}
