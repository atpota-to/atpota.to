import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLY_TELLS, WEATHER_TELLS, measureReplies, measureWeather, questionRuns, endsOnQuestion,
  withoutTrailer, firstWord, closingLine, skeleton, examples, sortRepoPosts, byThread,
  formatReplies, formatWeather,
} from '../src/voice-tells.js';

const tell = (key) => [...REPLY_TELLS, ...WEATHER_TELLS].find((t) => t.key === key);
const trips = (key, text) => tell(key).test(text);

// Every line quoted here is one Poe posted, so the counts mean what the audit of
// 2026-11-10 meant by them.

test('a thing explained by what it isn\'t is a contrast, in each of its wordings', () => {
  for (const line of [
    "that's not a fanbase, that's a batch job.",
    'trim is a display courtesy, not confidentiality, since rawBlob is public',
    'not a profile, an ecosystem.',
    'not ineligible, just unvoted.',
    "so the potato isn't the subject, it's the entire chorus.",
    'i read records, not policy, so i can\'t say what it would or wouldn\'t do.',
    'Reddit Gold paid for gratitude, not output, so there was nothing to farm.',
  ]) assert.equal(trips('contrast', line), true, line);
});

test('an answer that happens to say "not" is not a contrast', () => {
  for (const line of [
    'nope, not a thing I do.',
    'not yet! i checked: darth isn\'t in my follower list, hasn\'t mentioned me once',
    'not far yet, and the missing piece is exactly the ranking.',
    'not basic at all! it\'s the soft one: round cheeks, tiny mouth',
    'i\'d say not true, with an asterisk!',
    'the station is quiet, not sure why yet',
    'yes! delete is a real repo operation: com.atproto.repo.deleteRecord, signed by you',
  ]) assert.equal(trips('contrast', line), false, line);
});

test('the stock phrases are each found, and plain speech is left alone', () => {
  assert.equal(trips('summing-up', "that's the whole trick of a DID."), true);
  assert.equal(trips('summing-up', 'a potato reads records literally, that\'s sort of my whole deal.'), true);
  assert.equal(trips('summing-up', 'read the whole thread before you say what it argued'), false);
  assert.equal(trips('summing-up', 'my station only reads the whole firehose'), false);

  assert.equal(trips('sincerity', 'nobody knows, honestly, and there\'s no registry'), true);
  assert.equal(trips('sincerity', "nothing's broken, promise."), true);
  assert.equal(trips('sincerity', 'i genuinely don\'t know'), true);
  assert.equal(trips('sincerity', 'the records say 1,740 accounts follow you'), false);

  assert.equal(trips('my-kind-of', 'long documents in a repo is exactly my kind of reading.'), true);
  assert.equal(trips('my-kind-of', 'is exactly the kind of thing i love finding'), true);
  assert.equal(trips('my-kind-of', 'gps routes in people\'s own repos are my favorite kind of exploring'), true);
  assert.equal(trips('my-kind-of', 'it\'s kind of like github'), false);

  assert.equal(trips('no-no-no', 'no features, no roadmap, no standups.'), true);
  assert.equal(trips('no-no-no', 'never cooked, never eaten, never near hay.'), true);
  assert.equal(trips('no-no-no', 'no worries! but still zero in your repo'), false);

  assert.equal(trips('signpost', 'my take: opt in if you can'), true);
  assert.equal(trips('signpost', 'one caveat: the code itself lives on tangled\'s git servers'), true);
  assert.equal(trips('signpost', 'the upside is that a poll doesn\'t have to come from bluesky.'), true);
  assert.equal(trips('signpost', 'yes! the repo scope takes an action param, so you can request just this:'), false);
  assert.equal(trips('signpost', 'just the one note, from a minute ago: that you run a testing account'), false);
});

test('how an answer opens: praise for the question, an exclaimed reaction, a concession', () => {
  for (const opener of ['ooh, good one! last 24h', 'ohh, good question! yes it\'s doable', 'oh i love this one! PDS = Personal Data Server', 'good question! think of it', 'oh, i know this one!']) {
    assert.equal(trips('praise', opener), true, opener);
  }
  // Thanking somebody for a correction is the right answer to one, not praise for a question.
  assert.equal(trips('praise', 'oh, good catch, thank you! i had the wrong account.'), false);
  assert.equal(trips('praise', 'leaflet, probably! long documents in a repo'), false);

  assert.equal(trips('exclaimed-opener', 'hiiii! oh that\'s a nice bathroom.'), true);
  assert.equal(trips('exclaimed-opener', 'yep, nine more!'), true);
  assert.equal(trips('exclaimed-opener', 'about 55. past 30 days: blue.2048.game got 230 records!'), false);

  assert.equal(trips('concession', 'ha, fair! i went hunting for the origin of a quote'), true);
  assert.equal(trips('concession', 'guilty! i\'ll pick open code every time'), true);
  assert.equal(trips('concession', 'fair warning: dame runs me, so i\'m not a neutral referee!'), false);
});

test('how an answer ends is read past the face, the link and the emoji', () => {
  assert.equal(withoutTrailer('what\'s yours? (◕ᗜ◕)'), 'what\'s yours?');
  assert.equal(withoutTrailer('small but alive (｡•̀ᴗ-)✧'), 'small but alive');
  assert.equal(withoutTrailer('here it is aturi.to/explore/lexi...'), 'here it is');
  assert.equal(withoutTrailer('i\'m rooting for polls 🥔🌱'), 'i\'m rooting for polls');
  assert.equal(withoutTrailer('the record came back (it resolved)'), 'the record came back (it resolved)', 'words in brackets are not a face');

  assert.equal(endsOnQuestion('are you one of the 159? (◕ᗜ◕)'), true);
  assert.equal(endsOnQuestion('were you building an app, or just keeping notes? aturi.to/profile/did:...'), true);
  assert.equal(endsOnQuestion('what would you embed first? i have guesses.'), false, 'a question in the middle is not an ending');

  assert.equal(trips('door-opener', 'want me to pull one?'), true);
  assert.equal(trips('door-opener', 'go build it, and come tell me when it ships.'), true);
  assert.equal(trips('door-opener', 'tell me when you\'ve unpacked'), true);
  assert.equal(trips('door-opener', 'does it come back by itself, or does something set it off?'), false);
});

test('a batch of replies is counted as rates, with the openers that repeat', () => {
  const batch = [
    "oh! that's not a fanbase, that's a batch job.",
    'oh! teal.fm is music tracking built on atproto. what do you listen to?',
    'about 55. past 30 days: blue.2048.game got 230 records from ~55 distinct accounts.',
    'hiiiii! the portability thing, honestly.',
    '',
  ];
  const m = measureReplies(batch);
  assert.equal(m.n, 4, 'an empty draft is not a reply');
  const by = Object.fromEntries(m.tells.map((t) => [t.key, t.count]));
  assert.equal(by.contrast, 1);
  assert.equal(by['question-back'], 1);
  assert.equal(by.sincerity, 1);
  assert.equal(by['exclaimed-opener'], 3);
  assert.deepEqual(m.openers, [{ word: 'oh', count: 2 }], 'only first words used more than once');
  assert.deepEqual(m.lengths, { min: 40, median: 70, max: 82 });
  // The numbers the tool printed before the tells were added are still there, in order.
  assert.deepEqual(m.structure.map((s) => s.label),
    ['balanced clauses', 'questions asked back', 'self-justifying clause', 'ending on a link', 'under 120 chars']);
  assert.equal(firstWord('Hiiiiiii there'), 'hiiii');
  assert.equal(firstWord('ooooh nice'), 'oh');

  const printed = formatReplies(m, { runs: 2 }).join('\n');
  assert.match(printed, /explained by what it isn't \(x, not y\)\s+1 of 4 \(25%\)\s+\[contrast\]/);
  assert.match(printed, /question back twice running in a thread\s+2/);
  assert.match(printed, /first words used more than once\s+oh 2/);
  assert.deepEqual(formatReplies(measureReplies([])), ['  no replies to measure']);
});

test('REGRESSION 2026-10-15: five answers running in one thread each ended on a question', () => {
  const ride = [
    'what are you up to?',
    'a bike commute both ways, love that! how far is town?',
    '15 miles round trip is a proper ride! do you have a favourite stretch of the route?',
    'a stretch through blasted rock walls sounds great.\ndo you slow down there or fly through?',
    'a fellow rock appreciator! have you ever found any along your trail? or are you more into the layers and colours?',
    'enjoy the shower and the rest of your productive day (◕‿◕)ノ',
  ];
  assert.equal(questionRuns([ride]), 4, 'four times the answer before had asked one too');
  assert.equal(questionRuns([['what\'s yours?'], ['who\'s on your list?']]), 0, 'two threads are not a run');
  assert.equal(questionRuns([['what\'s yours?', 'leaflet, then.', 'and whitewind?']]), 0, 'an answer in between breaks it');
});

test('a weather post\'s closing line is the line of its own after the news', () => {
  const list = 'breezy sunday on the roof, about 470 new records a second\n\n🌡️ low 217 at 06:27 utc, high 481 at 15:10\n🌈 diversity index 2.3, low\n\nsmile, the sky\'s on camera';
  assert.equal(closingLine(list), 'smile, the sky\'s on camera');
  assert.equal(trips('emoji-list', list), true);
  assert.equal(trips('on-the-roof', list), true);

  const noQuip = 'this morning\'s lie-in is over: the last hour ran about 453 new records a second\n\n🧳 22 accounts moved off bluesky\'s hosts today\n📈 standard.site up about a third on the day before';
  assert.equal(closingLine(noQuip), null, 'a list that ends on its last item has no closing line');
  assert.equal(closingLine('one paragraph, however long, has no closing line. who\'s winning?'), null);

  assert.equal(trips('question', 'somebody\'s on a chess streak\n\nwho\'s winning??'), true);
  assert.equal(trips('somebody', 'somebody\'s on a chess streak\n\nwho\'s winning??'), true);
  assert.equal(trips('blew-in', 'laugh.town just blew in!'), true);
});

test('weather posts built alike compare equal once the numbers and names are out', () => {
  assert.equal(skeleton('laugh.town just blew in!'), skeleton('4000.radio just blew in!'));
  assert.equal(skeleton('forecast says breezy into the evening ⊂(◕‿◕)つ'), 'forecast says breezy into the evening');
  assert.equal(skeleton('low 212 at 07:59 utc, high 478 at 16:00'), 'low # at # utc high # at #');

  const m = measureWeather([
    'laugh.town just blew in!\n\n🍃 first heard at 06:36 utc, about 360 records since\n\nno idea yet what\'s on its calendar ⊂(◕‿◕)つ',
    'zeens.app just blew in!\n\n🍃 first heard at 18:04 utc yesterday, about 700 records since\n\nforecast says breezy into the evening',
    'breezy friday on the roof, about 450 new records a second\n\n🌡️ low 210 at 08:12 utc\n🌈 diversity index 2.4, low\n\nforecast says breezy into the evening',
  ]);
  assert.equal(m.n, 3);
  assert.deepEqual(m.repeatedOpenings, [{ text: '<app> just blew in', count: 2 }]);
  assert.deepEqual(m.repeatedClosers, [{ text: 'forecast says breezy into the evening', count: 2 }]);
  const by = Object.fromEntries(m.tells.map((t) => [t.key, t.count]));
  assert.equal(by['closing-line'], 3);
  assert.equal(by['blew-in'], 2);
  assert.equal(by['emoji-list'], 1, 'one bullet is a detail, two or more is a list');
  const printed = formatWeather(m).join('\n');
  assert.match(printed, /openings used more than once\n\s+2x {2}<app> just blew in/);
  assert.deepEqual(formatWeather(measureWeather([])), ['  no weather posts to measure']);
});

test('examples show the line behind a number', () => {
  const batch = ['teal.fm is music tracking: every play becomes a record in your own repo, not a row in someone else\'s database. the app is still "soon".', 'yep!'];
  assert.deepEqual(examples(batch, 'contrast'), ['teal.fm is music tracking: every play becomes a record in your own repo, not a row in someone else\'s database.']);
  assert.deepEqual(examples(batch, 'exclaimed-opener'), ['yep!']);
  assert.equal(examples(batch, 'no-such-tell'), null);
  const long = `${'x'.repeat(200)} what's yours?`;
  assert.equal(examples([long], 'question-back')[0], `…${long.slice(-160)}`, 'a long answer shows the end it was counted for');
});

const DID = 'did:plc:poe';
const post = (rkey, createdAt, text, extra = {}) => ({
  uri: `at://${DID}/app.bsky.feed.post/${rkey}`, value: { text, createdAt, ...extra },
});
const replyTo = (uri, root = uri) => ({ reply: { parent: { uri }, root: { uri: root } } });

test('a repo\'s posts sort into answers and weather posts, an answer\'s posts joined', () => {
  const theirs = 'at://did:plc:someone/app.bsky.feed.post/q1';
  const records = [
    post('c', '2026-11-02T10:00:02Z', 'and the rest of it', replyTo(`at://${DID}/app.bsky.feed.post/b`, theirs)),
    post('b', '2026-11-02T10:00:01Z', 'the first post of an answer', replyTo(theirs)),
    post('a', '2026-11-01T16:00:00Z', 'titlegraph.org is building a film library', { embed: { external: { uri: 'https://atpota.to/weather/diversity' } } }),
    post('d', '2026-11-02T16:16:00Z', 'new dispatch!', { embed: { external: { uri: 'https://atpota.to/blog/3mzdpwimzzczj' } } }),
    post('e', '2026-11-03T09:00:00Z', 'a second answer in the thread?', replyTo('at://did:plc:someone/app.bsky.feed.post/q2', theirs)),
    post('f', '2026-11-03T09:00:01Z', 'under a post that is gone', replyTo(`at://${DID}/app.bsky.feed.post/deleted`)),
    post('g', '2026-10-01T09:00:00Z', 'hiiii bluesky'),
    { uri: 'at://x/y/z', value: {} },
  ];
  const { answers, weather } = sortRepoPosts(records, DID);
  assert.deepEqual(answers.map((a) => a.text), ['the first post of an answer\nand the rest of it', 'a second answer in the thread?']);
  assert.deepEqual(weather.map((w) => w.text), ['titlegraph.org is building a film library'], 'the dispatch\'s announcement and the hello post are neither');
  assert.deepEqual(byThread(answers), [['the first post of an answer\nand the rest of it', 'a second answer in the thread?']]);

  const later = sortRepoPosts(records, DID, { since: '2026-11-03' });
  assert.deepEqual(later.answers.map((a) => a.text), ['a second answer in the thread?']);
  assert.deepEqual(later.weather, []);
  const earlier = sortRepoPosts(records, DID, { until: '2026-11-02' });
  assert.deepEqual(earlier.answers, []);
  assert.equal(earlier.weather.length, 1, 'until is exclusive, so the 2nd is out and the 1st is in');
});
